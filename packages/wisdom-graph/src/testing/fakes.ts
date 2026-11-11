/**
 * fakes.ts — deterministic stand-ins for every injected port.
 *
 * The library's guarantees are about time and failure ("resolves within the
 * budget", "never rejects when the model hangs"), which cannot be tested
 * against real ports. Each fake here is scriptable in exactly the dimension
 * the tests need — a model that replies, delays, hangs until aborted or
 * throws; an embedding that is a pure function of its input; a clock that
 * only moves when told — and records what was asked of it so a test can
 * assert on calls rather than on side effects.
 *
 * `FakeLlm` plays its script in order: the first unconsumed step whose
 * `purpose` and `match` fit is used once and retired, so a retry test can
 * script "garbage, then valid JSON". A step marked `sticky` answers every
 * time. With no step left to match, the reply is `{"ops":[]}` — the
 * extractor's "nothing worth remembering" — so a test that never scripts a
 * model still runs the whole ingest path.
 *
 * `FaultyStore` is the port fake for storage: it wraps any real store and
 * fails, hangs or corrupts on command, so the never-reject guarantees can be
 * tested against a store that misbehaves in exactly one way at a time while
 * everything else stays real.
 */

import { fnv1a32 } from "../core/ids";
import type {
  ClockPort,
  EmbeddingPort,
  GraphSnapshotData,
  LeaseQuery,
  LlmPort,
  LoggerPort,
  SpanLike,
  StoreOp,
  StorePort,
  StoredEvent,
  StoredEventBody,
  StoredEventPatch,
  SubjectRef,
  TracerPort,
} from "../core/ports";
import type { AuditEntry, EventStatus, HintRecord, HintStatus, TurnEvent } from "../core/types";

// ── LLM ──────────────────────────────────────────────────────────────────────

export type FakeLlmStep = {
  /** Tested against the prompt. */
  match?: RegExp;
  purpose?: "extract" | "consolidate";
  /** Objects are `JSON.stringify`ed. */
  reply: string | object;
  delayMs?: number;
  /** Never settle until `opts.signal` aborts (then reject with its reason). */
  hang?: boolean;
  /** Reject with this value (after `delayMs`, if any). */
  throws?: unknown;
  /** Keep the step after it is used instead of consuming it. */
  sticky?: boolean;
};

export type FakeLlmOptions = Parameters<LlmPort["complete"]>[1];

/** The reply when no step matches. */
export const EMPTY_PROPOSAL = '{"ops":[]}';

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Resolve after `ms`, or reject as soon as `signal` aborts. Never settles when `ms` is undefined and there is no signal. */
function wait(ms: number | undefined, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (ms !== undefined) {
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
    }
  });
}

export class FakeLlm implements LlmPort {
  readonly calls: { prompt: string; opts: FakeLlmOptions }[] = [];
  private readonly script: FakeLlmStep[];

  constructor(script: FakeLlmStep[] = []) {
    this.script = [...script];
  }

  push(step: FakeLlmStep): void {
    this.script.push(step);
  }

  /** Steps not yet consumed. */
  get pending(): number {
    return this.script.length;
  }

  async complete(prompt: string, opts: FakeLlmOptions = {}): Promise<string> {
    this.calls.push({ prompt, opts });
    const index = this.script.findIndex(
      (step) =>
        (step.purpose === undefined || step.purpose === opts.purpose) &&
        // `search`, not `test`: it ignores `lastIndex`, so a /g or /y regex matches the same way on every call.
        (step.match === undefined || prompt.search(step.match) !== -1),
    );
    const step = index === -1 ? undefined : this.script[index];
    if (!step) return EMPTY_PROPOSAL;
    if (!step.sticky) this.script.splice(index, 1);
    if (step.hang) await wait(undefined, opts.signal);
    else if (step.delayMs !== undefined) await wait(step.delayMs, opts.signal);
    if (step.throws !== undefined) throw step.throws;
    return typeof step.reply === "string" ? step.reply : JSON.stringify(step.reply);
  }
}

// ── Embeddings ───────────────────────────────────────────────────────────────

/**
 * Hashed bag-of-words: each token adds ±1 to the bucket its hash selects, and
 * the vector is L2-normalised. Two texts sharing words are close, and the
 * same text always maps to the same vector, which is all the re-rank tests
 * need. The empty text is the zero vector (it has no direction to normalise).
 */
export function hashedBagOfWords(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    const hash = fnv1a32(token);
    const bucket = hash % dimensions;
    const sign = fnv1a32(`${token}#sign`) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 ? vector : vector.map((x) => x / norm);
}

export class FakeEmbedding implements EmbeddingPort {
  readonly calls: string[][] = [];
  readonly dimensions: number;
  private readonly delayMs: number | undefined;
  private readonly throws: unknown;

  constructor(dimensions = 64, opts: { delayMs?: number; throws?: unknown } = {}) {
    this.dimensions = dimensions;
    this.delayMs = opts.delayMs;
    this.throws = opts.throws;
  }

  async embed(texts: string[], opts: { signal?: AbortSignal } = {}): Promise<number[][]> {
    this.calls.push([...texts]);
    if (this.delayMs !== undefined || opts.signal?.aborted) await wait(this.delayMs ?? 0, opts.signal);
    if (this.throws !== undefined) throw this.throws;
    return texts.map((text) => hashedBagOfWords(text, this.dimensions));
  }
}

// ── Clock ────────────────────────────────────────────────────────────────────

/** 2026-01-01T00:00:00Z — a fixed, recognisable origin for every test. */
export const FAKE_CLOCK_EPOCH = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;

export class FakeClock implements ClockPort {
  private current: number;

  constructor(startMs: number = FAKE_CLOCK_EPOCH) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** The current instant as ISO-8601, for building rows. */
  iso(): string {
    return new Date(this.current).toISOString();
  }

  tick(ms: number): void {
    this.current += ms;
  }

  advanceDays(days: number): void {
    this.current += days * DAY_MS;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

// ── Logger ───────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEntry = { level: LogLevel; obj: object; msg?: string };

export class CollectingLogger implements LoggerPort {
  readonly entries: LogEntry[] = [];

  debug(obj: object, msg?: string): void {
    this.record("debug", obj, msg);
  }

  info(obj: object, msg?: string): void {
    this.record("info", obj, msg);
  }

  warn(obj: object, msg?: string): void {
    this.record("warn", obj, msg);
  }

  error(obj: object, msg?: string): void {
    this.record("error", obj, msg);
  }

  /** Entries at one level, or with one message. */
  find(where: { level?: LogLevel; msg?: string }): LogEntry[] {
    return this.entries.filter((e) => (where.level === undefined || e.level === where.level) && (where.msg === undefined || e.msg === where.msg));
  }

  clear(): void {
    this.entries.length = 0;
  }

  private record(level: LogLevel, obj: object, msg?: string): void {
    this.entries.push(msg === undefined ? { level, obj } : { level, obj, msg });
  }
}

// ── Tracer ───────────────────────────────────────────────────────────────────

export type CapturedSpan = {
  name: string;
  attrs: Record<string, unknown>;
  events: unknown[];
  exceptions: unknown[];
  ended: boolean;
};

export class CapturingTracer implements TracerPort {
  readonly spans: CapturedSpan[] = [];

  startSpan(name: string, opts: { attributes?: Record<string, string | number | boolean> } = {}): SpanLike {
    const span: CapturedSpan = { name, attrs: { ...opts.attributes }, events: [], exceptions: [], ended: false };
    this.spans.push(span);
    return {
      setAttribute: (key, value) => {
        span.attrs[key] = value;
      },
      addEvent: (eventName, attrs) => {
        span.events.push(attrs === undefined ? { name: eventName } : { name: eventName, attrs });
      },
      recordException: (e) => {
        span.exceptions.push(e);
      },
      end: () => {
        span.ended = true;
      },
    };
  }

  /** Spans with this name, in start order. */
  named(name: string): CapturedSpan[] {
    return this.spans.filter((s) => s.name === name);
  }
}

// ── Faulty store ─────────────────────────────────────────────────────────────

export type FaultyStoreMode = {
  /** Reject these methods before the inner store sees them. */
  throwOn?: (keyof StorePort)[];
  /** Never settle these methods until the call's `signal` aborts; a method without a signal hangs for good. */
  hangOn?: (keyof StorePort)[];
  /** Hand back hint rows that fail validation: even rows lack `slot`, odd rows carry `confidence: 7`. */
  corruptRows?: boolean;
  /** What `throwOn` rejects with; default a fresh `Error("FaultyStore: <method> failed")` per call. */
  error?: unknown;
};

export type FaultyStoreCall = { method: keyof StorePort; args: unknown[] };

/** Rows `compileSnapshot` must drop: the port's type cannot express "not a HintRecord", which is the point. */
function corruptHints(snapshot: GraphSnapshotData): GraphSnapshotData {
  const hints = snapshot.hints.map((hint, index) => {
    if (index % 2 === 1) return { ...hint, confidence: 7 };
    const { slot, ...withoutSlot } = hint;
    void slot;
    return withoutSlot as HintRecord;
  });
  return { ...snapshot, hints };
}

/**
 * A `StorePort` that forwards to `inner` except where `mode` says otherwise.
 * Every call is recorded in `calls`, so a test can also assert what the
 * engine asked of its store — for instance that a recall never writes.
 */
export class FaultyStore implements StorePort {
  readonly calls: FaultyStoreCall[] = [];
  /** Present only when the inner store implements it, so the engine's feature check stays honest. */
  readonly searchNodesByEmbedding?: (ref: SubjectRef, vector: number[], limit: number) => Promise<{ nodeId: string; score: number }[]>;
  private readonly inner: StorePort;
  private readonly mode: FaultyStoreMode;

  constructor(inner: StorePort, mode: FaultyStoreMode = {}) {
    this.inner = inner;
    this.mode = mode;
    const search = inner.searchNodesByEmbedding?.bind(inner);
    if (search) {
      this.searchNodesByEmbedding = (ref, vector, limit) =>
        this.run("searchNodesByEmbedding", [ref, vector, limit], undefined, () => search(ref, vector, limit));
    }
  }

  private async run<T>(method: keyof StorePort, args: unknown[], signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
    this.calls.push({ method, args });
    if (this.mode.throwOn?.includes(method)) throw this.mode.error ?? new Error(`FaultyStore: ${method} failed`);
    // `wait` with no duration only ever rejects (on abort), so a hung call settles exactly when its signal says.
    if (this.mode.hangOn?.includes(method)) await wait(undefined, signal);
    return call();
  }

  loadSnapshot(ref: SubjectRef, opts?: { signal?: AbortSignal; statuses?: HintStatus[] }): Promise<GraphSnapshotData | null> {
    return this.run("loadSnapshot", [ref, opts], opts?.signal, async () => {
      const snapshot = await this.inner.loadSnapshot(ref, opts);
      return snapshot !== null && this.mode.corruptRows ? corruptHints(snapshot) : snapshot;
    });
  }

  applyBatch(ref: SubjectRef, ops: StoreOp[], opts?: { expectVersion?: number; signal?: AbortSignal }): Promise<{ version: number }> {
    return this.run("applyBatch", [ref, ops, opts], opts?.signal, () => this.inner.applyBatch(ref, ops, opts));
  }

  getHint(ref: SubjectRef, hintId: string): Promise<HintRecord | null> {
    return this.run("getHint", [ref, hintId], undefined, () => this.inner.getHint(ref, hintId));
  }

  deleteHint(ref: SubjectRef, hintId: string): Promise<boolean> {
    return this.run("deleteHint", [ref, hintId], undefined, () => this.inner.deleteHint(ref, hintId));
  }

  deleteSubject(ref: SubjectRef): Promise<void> {
    return this.run("deleteSubject", [ref], undefined, () => this.inner.deleteSubject(ref));
  }

  claimEvent(tenantId: string | null, ev: StoredEventBody): Promise<"claimed" | "duplicate"> {
    return this.run("claimEvent", [tenantId, ev], undefined, () => this.inner.claimEvent(tenantId, ev));
  }

  leaseEvents(q: LeaseQuery): Promise<StoredEvent[]> {
    return this.run("leaseEvents", [q], undefined, () => this.inner.leaseEvents(q));
  }

  updateEvent(tenantId: string | null, id: string, patch: StoredEventPatch): Promise<void> {
    return this.run("updateEvent", [tenantId, id, patch], undefined, () => this.inner.updateEvent(tenantId, id, patch));
  }

  getEvent(tenantId: string | null, id: string): Promise<StoredEvent | null> {
    return this.run("getEvent", [tenantId, id], undefined, () => this.inner.getEvent(tenantId, id));
  }

  getTurn(ref: SubjectRef, runId: string): Promise<TurnEvent | null> {
    return this.run("getTurn", [ref, runId], undefined, () => this.inner.getTurn(ref, runId));
  }

  listEvents(ref: SubjectRef, q: { limit: number; statuses?: EventStatus[] }): Promise<StoredEvent[]> {
    return this.run("listEvents", [ref, q], undefined, () => this.inner.listEvents(ref, q));
  }

  scrubEvents(ref: SubjectRef, opts?: { olderThan?: string }): Promise<number> {
    return this.run("scrubEvents", [ref, opts], undefined, () => this.inner.scrubEvents(ref, opts));
  }

  listAudit(ref: SubjectRef, limit: number): Promise<AuditEntry[]> {
    return this.run("listAudit", [ref, limit], undefined, () => this.inner.listAudit(ref, limit));
  }

  purge(q: { tenantId: string | null; eventsOlderThan?: string; auditOlderThan?: string }): Promise<{ events: number; audit: number }> {
    return this.run("purge", [q], undefined, () => this.inner.purge(q));
  }
}
