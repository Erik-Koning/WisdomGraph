/**
 * recall/cache.ts — the one store round-trip recall is allowed, amortised.
 *
 * A recall costs one `loadSnapshot` on a miss and nothing on a hit (spec
 * §4). This cache is what turns that into "1–3 ms typical": one compiled
 * `SubjectSnapshot` per subject, keyed by `${tenantId ?? ""}|${subjectId}`,
 * with three windows and one queue per key.
 *
 *   - **Fresh** (age < `ttlMs`): served as a hit.
 *   - **Stale** (age < `staleTtlMs`): served immediately *and* refreshed in
 *     the background, so a subject that is queried steadily never pays the
 *     round-trip on the request path — the consumer's Lane A must answer in
 *     150 ms and a store's tail latency is not its problem.
 *   - **Negative** (`loadSnapshot` returned `null`): a new advisor has no
 *     rows, and asking again on every turn would make the first day of an
 *     account the slowest. The virtual snapshot is cached for the short
 *     `negativeTtlMs` — short, because the subject's first ingest is about
 *     to create rows and the writer invalidates only its own process.
 *
 * Loads are **deduped per key**: concurrent recalls for one subject share
 * one promise, and a recall that abandons the load at its deadline leaves
 * the load running so it can warm the entry for the next request — Lane B,
 * arriving two seconds later, is the usual beneficiary. That is also why
 * the store is given a cache-owned signal rather than any recall's: a
 * store that rejects on abort (Postgres races the signal, §7.3) would
 * otherwise throw away a result nobody cancelled on purpose. The signal
 * aborts only on `close()` or after `loadTimeoutMs`, and the loader is
 * *raced* against it rather than awaited: a store that ignores the signal
 * and never settles (a consumer's port, a driver that cannot cancel) still
 * releases the key at `loadTimeoutMs`, so `settled()`, `flush()` and
 * `close()` cannot hang on it.
 *
 * Every load carries its own record. `invalidate()` detaches the record
 * from its key, so the load cannot write a pre-write snapshot over the top
 * of the invalidation, but the load is still tracked until it settles:
 * `settled()` waits for detached loads too, and nothing lands in a closed
 * cache. Per-key state lives only as long as a load does, so a process
 * that ingests for a million subjects keeps a million of nothing.
 *
 * The continuity ring — the last eight topics the subject asked about, an
 * input to the classifier's tie-breaker (§4.2 step 3) — lives beside the
 * entries rather than inside them, so an invalidation after an ingest does
 * not make the next turn forget what the conversation was about.
 */

import type { ClockPort, LoggerPort, SubjectRef } from "../ports";
import { noopLogger } from "../ports";
import type { SubjectSnapshot } from "../graph/snapshot";
import { raceSignal, timeoutError } from "./deadline";

export interface SnapshotCacheOptions {
  clock: ClockPort;
  logger?: LoggerPort;
  /** 30 000 */
  ttlMs?: number;
  /** 300 000 */
  staleTtlMs?: number;
  /** 10 000 */
  negativeTtlMs?: number;
  /** 256 */
  maxSubjects?: number;
  /** 30 000 — an inflight load older than this is abandoned so the key can be loaded again. */
  loadTimeoutMs?: number;
}

export const CACHE_DEFAULTS = Object.freeze({
  ttlMs: 30_000,
  staleTtlMs: 300_000,
  negativeTtlMs: 10_000,
  maxSubjects: 256,
  loadTimeoutMs: 30_000,
});

/** Topics remembered per subject for the classifier's continuity bonus (§4.2 step 3). */
export const CONTINUITY_RING = 8;

/** The cache key of a subject: null and "" are the same tenant (§7.1). */
export function cacheKey(ref: SubjectRef): string {
  return `${ref.tenantId ?? ""}|${ref.subjectId}`;
}

export type CacheLookup = { state: "hit" | "stale"; snapshot: SubjectSnapshot } | { state: "miss" };

/** Produces the snapshot for a key; the signal is the cache's, not a request's. */
export type SnapshotLoader = (signal: AbortSignal) => Promise<SubjectSnapshot>;

interface Entry {
  snapshot: SubjectSnapshot;
  freshUntil: number;
  staleUntil: number;
}

/** One load, from `loader()` to settlement; `detached` once `invalidate()` has disowned its result. */
interface Inflight {
  promise: Promise<SubjectSnapshot>;
  detached: boolean;
}

/** A positive number or the default: a caller cannot configure a window away by mistake. */
function windowMs(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Let a timer not hold the process open where the runtime supports it; a no-op elsewhere. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle: unknown = timer;
  if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") handle.unref();
}

/**
 * A bounded map with least-recently-used eviction; `get` counts as use.
 * Used for the snapshot entries, the continuity rings and the query-vector
 * cache, which all want "keep the last N" and nothing more.
 */
export class LruMap<V> {
  private readonly map = new Map<string, V>();

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** The value, moved to most-recently-used. */
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** The value without touching its recency. */
  peek(key: string): V | undefined {
    return this.map.get(key);
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > Math.max(1, this.capacity)) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

export class SnapshotCache {
  readonly ttlMs: number;
  readonly staleTtlMs: number;
  readonly negativeTtlMs: number;
  readonly loadTimeoutMs: number;
  private readonly clock: ClockPort;
  private readonly logger: LoggerPort;
  private readonly entries: LruMap<Entry>;
  private readonly rings: LruMap<string[]>;
  /** The load a key dedupes onto. */
  private readonly loads = new Map<string, Inflight>();
  /** Every load not yet settled, detached ones included — what `settled()` waits for. */
  private readonly running = new Set<Inflight>();
  private readonly closer = new AbortController();

  constructor(opts: SnapshotCacheOptions) {
    this.clock = opts.clock;
    this.logger = opts.logger ?? noopLogger;
    this.ttlMs = windowMs(opts.ttlMs, CACHE_DEFAULTS.ttlMs);
    this.staleTtlMs = windowMs(opts.staleTtlMs, CACHE_DEFAULTS.staleTtlMs);
    this.negativeTtlMs = windowMs(opts.negativeTtlMs, CACHE_DEFAULTS.negativeTtlMs);
    this.loadTimeoutMs = windowMs(opts.loadTimeoutMs, CACHE_DEFAULTS.loadTimeoutMs);
    const capacity = Math.max(1, Math.floor(windowMs(opts.maxSubjects, CACHE_DEFAULTS.maxSubjects)));
    this.entries = new LruMap<Entry>(capacity);
    this.rings = new LruMap<string[]>(capacity);
  }

  /** Cached subjects (fresh or stale), not counting loads in flight. */
  get size(): number {
    return this.entries.size;
  }

  /** Loads in flight, detached ones included; the only per-load state the cache keeps. */
  get pending(): number {
    return this.running.size;
  }

  /** True when the key has an entry, whatever its age. */
  has(ref: SubjectRef): boolean {
    return this.entries.has(cacheKey(ref));
  }

  /**
   * Fresh → hit, within the stale window → stale, otherwise (or when
   * negative and past its window) → miss.
   */
  lookup(ref: SubjectRef): CacheLookup {
    const key = cacheKey(ref);
    const entry = this.entries.get(key);
    if (entry === undefined) return { state: "miss" };
    const now = this.clock.now();
    if (now < entry.freshUntil) return { state: "hit", snapshot: entry.snapshot };
    if (now < entry.staleUntil) return { state: "stale", snapshot: entry.snapshot };
    this.entries.delete(key);
    return { state: "miss" };
  }

  /**
   * Store a compiled snapshot. A snapshot of a subject with no rows
   * (`exists === false`) is a negative entry: fresh for `negativeTtlMs` by
   * default and never served stale. `ttlMs` overrides the fresh window for
   * this entry whichever kind it is: the shared subject is kept at
   * `ttlMs × 4` present or not, because a configured organisation subject
   * that has no rows yet is not about to be written by the next turn the
   * way a new advisor's is, and re-probing it every `negativeTtlMs` would
   * put its round-trip on the primary's path that often.
   */
  set(ref: SubjectRef, snapshot: SubjectSnapshot, opts: { ttlMs?: number } = {}): void {
    const now = this.clock.now();
    const fallback = snapshot.exists ? this.ttlMs : this.negativeTtlMs;
    const ttl = opts.ttlMs === undefined ? fallback : windowMs(opts.ttlMs, fallback);
    const freshUntil = now + ttl;
    const staleUntil = snapshot.exists ? Math.max(freshUntil, now + this.staleTtlMs) : freshUntil;
    this.entries.set(cacheKey(ref), { snapshot, freshUntil, staleUntil });
  }

  /** The load in flight for the key, if any — what a caller that lost its race can still await. */
  inflight(ref: SubjectRef): Promise<SubjectSnapshot> | undefined {
    return this.loads.get(cacheKey(ref))?.promise;
  }

  /**
   * Load the key through `loader`, deduped: a load already in flight is
   * returned as is. The loader is raced against the cache's signal, so it
   * rejects with the `TimeoutError` at `loadTimeoutMs` or the close reason
   * whether or not the store honoured the signal. The result is stored on
   * success unless the key was invalidated or the cache closed meanwhile;
   * a failure is logged once as `store.error` and rejected to every caller
   * awaiting it. The returned promise is marked handled, so a caller that
   * stops waiting leaves no unhandled rejection. After `close()` every load
   * is refused and logged as `cache.closed`: a recall on a closed engine
   * degrades to `empty` like any other failure, and a failure that is never
   * logged is one the operator cannot find.
   */
  load(ref: SubjectRef, loader: SnapshotLoader, opts: { ttlMs?: number } = {}): Promise<SubjectSnapshot> {
    const key = cacheKey(ref);
    const existing = this.loads.get(key);
    if (existing !== undefined) return existing.promise;
    if (this.closer.signal.aborted) {
      const reason: unknown = this.closer.signal.reason;
      this.logger.warn(
        { lib: "wisdom-graph", op: "recall", tenantId: ref.tenantId, subjectId: ref.subjectId, method: "loadSnapshot", error: describeError(reason) },
        "cache.closed",
      );
      return Promise.reject(reason);
    }

    const controller = new AbortController();
    const onClose = (): void => controller.abort(this.closer.signal.reason);
    this.closer.signal.addEventListener("abort", onClose, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError(this.loadTimeoutMs)), this.loadTimeoutMs);
    unrefTimer(timer);

    let started: Promise<SubjectSnapshot>;
    try {
      started = loader(controller.signal);
    } catch (e) {
      started = Promise.reject(e);
    }
    const record: Inflight = { promise: started, detached: false };
    const tracked: Promise<SubjectSnapshot> = raceSignal(started, { signal: controller.signal })
      .then((outcome) => {
        // No timer is given to the race, so `timeout` cannot occur; the deadline's own error is the honest stand-in.
        if (outcome.status === "timeout") throw timeoutError(this.loadTimeoutMs);
        if (outcome.status !== "fulfilled") throw outcome.reason;
        if (!record.detached && !this.closer.signal.aborted) this.set(ref, outcome.value, opts);
        return outcome.value;
      })
      .catch((error: unknown) => {
        this.logger.error(
          { lib: "wisdom-graph", op: "recall", tenantId: ref.tenantId, subjectId: ref.subjectId, method: "loadSnapshot", error: describeError(error) },
          "store.error",
        );
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        this.closer.signal.removeEventListener("abort", onClose);
        this.running.delete(record);
        if (this.loads.get(key) === record) this.loads.delete(key);
      });
    record.promise = tracked;
    tracked.catch(() => undefined);
    this.running.add(record);
    this.loads.set(key, record);
    return tracked;
  }

  /** Start a background load unless one is in flight; the outcome lands in the entry (or the log). */
  refresh(ref: SubjectRef, loader: SnapshotLoader, opts: { ttlMs?: number } = {}): void {
    if (this.loads.has(cacheKey(ref))) return;
    void this.load(ref, loader, opts).catch(() => undefined);
  }

  /** Resolves once no load is in flight, detached ones included; never rejects. Every load settles by `loadTimeoutMs` or `close()`. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running].map((r) => r.promise));
  }

  /**
   * Drop one subject's entry, or every entry. A load in flight for a dropped
   * key finishes — `settled()` still waits for it — but does not populate
   * the entry, and the key can be loaded again at once. Continuity rings
   * survive: an ingest changes what a subject knows, not what it was
   * talking about.
   */
  invalidate(ref?: SubjectRef): void {
    const keys = ref === undefined ? [...this.entries.keys(), ...this.loads.keys()] : [cacheKey(ref)];
    for (const key of new Set(keys)) {
      this.entries.delete(key);
      const load = this.loads.get(key);
      if (load !== undefined) {
        load.detached = true;
        this.loads.delete(key);
      }
    }
  }

  /** Remember the topics of a recall, newest first, at most `CONTINUITY_RING`. */
  remember(ref: SubjectRef, paths: readonly string[]): void {
    if (paths.length === 0) return;
    const key = cacheKey(ref);
    const previous = this.rings.peek(key) ?? [];
    const ring: string[] = [];
    for (const path of [...paths, ...previous]) {
      if (!ring.includes(path)) ring.push(path);
      if (ring.length >= CONTINUITY_RING) break;
    }
    this.rings.set(key, ring);
  }

  /** The subject's remembered topics, newest first. */
  recentPaths(ref: SubjectRef): readonly string[] {
    return this.rings.peek(cacheKey(ref)) ?? [];
  }

  /** Abort every load in flight and forget everything; the cache is unusable afterwards. */
  close(): void {
    if (!this.closer.signal.aborted) this.closer.abort(new Error("SnapshotCache closed"));
    this.entries.clear();
    this.rings.clear();
    this.loads.clear();
  }
}

/** A loggable, text-only rendering of an error: never the object, which may carry a query or a row. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : String(error);
}
