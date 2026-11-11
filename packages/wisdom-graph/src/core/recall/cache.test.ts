/**
 * The cache is checked against the clock, not the wall: every window is a
 * FakeClock tick, every load a counted loader, so hit / stale / miss /
 * negative and the in-flight rules (dedupe, continuation, detachment on
 * invalidate, the load timeout against a loader that ignores its signal)
 * are asserted exactly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPolicy } from "../policy";
import { noopLogger, type SubjectRef } from "../ports";
import { CollectingLogger, FakeClock } from "../../testing/fakes";
import { compileSnapshot, emptySnapshotData, type SubjectSnapshot } from "../graph/snapshot";
import { CACHE_DEFAULTS, CONTINUITY_RING, LruMap, SnapshotCache, cacheKey, describeError } from "./cache";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const other: SubjectRef = { tenantId: null, subjectId: "rm_7" };

function snapshotOf(subject: SubjectRef, exists = true, clock = new FakeClock()): SubjectSnapshot {
  return compileSnapshot(exists ? emptySnapshotData(subject) : null, defaultPolicy, noopLogger, { ref: subject, categories: [], clock });
}

/** A loader that counts its calls and resolves with a fresh snapshot. */
function counted(subject: SubjectRef, opts: { exists?: boolean; fail?: unknown; hang?: boolean } = {}) {
  const calls: AbortSignal[] = [];
  const loader = (signal: AbortSignal): Promise<SubjectSnapshot> => {
    calls.push(signal);
    if (opts.fail !== undefined) return Promise.reject(opts.fail);
    if (opts.hang) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return Promise.resolve(snapshotOf(subject, opts.exists ?? true));
  };
  return { loader, calls };
}

function cacheWith(clock: FakeClock, over: Partial<ConstructorParameters<typeof SnapshotCache>[0]> = {}): SnapshotCache {
  return new SnapshotCache({ clock, ttlMs: 100, staleTtlMs: 500, negativeTtlMs: 30, ...over });
}

describe("LruMap", () => {
  it("evicts the least recently used entry past capacity, and get() counts as use", () => {
    const lru = new LruMap<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect(lru.keys()).toEqual(["a", "c"]);
    expect(lru.has("b")).toBe(false);
  });

  it("peek() does not touch recency", () => {
    const lru = new LruMap<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.peek("a")).toBe(1);
    lru.set("c", 3);
    expect(lru.keys()).toEqual(["b", "c"]);
  });

  it("keeps at least one entry whatever the capacity", () => {
    const lru = new LruMap<number>(0);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.keys()).toEqual(["b"]);
  });
});

describe("cacheKey", () => {
  it("treats a null tenant and an empty tenant as the same subject", () => {
    expect(cacheKey({ tenantId: null, subjectId: "rm_42" })).toBe(cacheKey({ tenantId: "", subjectId: "rm_42" }));
    expect(cacheKey({ tenantId: "acme", subjectId: "rm_42" })).toBe("acme|rm_42");
  });
});

describe("SnapshotCache — windows", () => {
  it("applies the spec defaults and refuses a negative window", () => {
    const cache = new SnapshotCache({ clock: new FakeClock(), ttlMs: -1 });
    expect(cache.ttlMs).toBe(CACHE_DEFAULTS.ttlMs);
    expect(cache.staleTtlMs).toBe(CACHE_DEFAULTS.staleTtlMs);
    expect(cache.negativeTtlMs).toBe(CACHE_DEFAULTS.negativeTtlMs);
    expect(cache.loadTimeoutMs).toBe(CACHE_DEFAULTS.loadTimeoutMs);
  });

  it("misses on an unknown subject", () => {
    expect(cacheWith(new FakeClock()).lookup(ref)).toEqual({ state: "miss" });
  });

  it("serves a hit while fresh, stale until staleTtlMs, then misses and forgets the entry", () => {
    const clock = new FakeClock();
    const cache = cacheWith(clock);
    const snapshot = snapshotOf(ref);
    cache.set(ref, snapshot);
    expect(cache.lookup(ref)).toEqual({ state: "hit", snapshot });
    clock.tick(99);
    expect(cache.lookup(ref).state).toBe("hit");
    clock.tick(1);
    expect(cache.lookup(ref)).toEqual({ state: "stale", snapshot });
    clock.tick(399);
    expect(cache.lookup(ref).state).toBe("stale");
    clock.tick(1);
    expect(cache.lookup(ref)).toEqual({ state: "miss" });
    expect(cache.has(ref)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("honours a per-entry ttl (the shared subject's ttlMs × 4)", () => {
    const clock = new FakeClock();
    const cache = cacheWith(clock);
    cache.set(ref, snapshotOf(ref), { ttlMs: 400 });
    clock.tick(399);
    expect(cache.lookup(ref).state).toBe("hit");
    clock.tick(1);
    expect(cache.lookup(ref).state).toBe("stale");
  });

  it("honours an explicit ttl for a negative entry too (a configured shared subject with no rows)", () => {
    const clock = new FakeClock();
    const cache = cacheWith(clock);
    cache.set(ref, snapshotOf(ref, false), { ttlMs: 400 });
    clock.tick(399);
    expect(cache.lookup(ref).state).toBe("hit");
    clock.tick(1);
    expect(cache.lookup(ref).state).toBe("miss");
  });

  it("keeps a negative entry fresh for negativeTtlMs and never serves it stale", () => {
    const clock = new FakeClock();
    const cache = cacheWith(clock);
    const virtual = snapshotOf(ref, false);
    expect(virtual.exists).toBe(false);
    cache.set(ref, virtual);
    clock.tick(29);
    expect(cache.lookup(ref)).toEqual({ state: "hit", snapshot: virtual });
    clock.tick(1);
    expect(cache.lookup(ref)).toEqual({ state: "miss" });
  });

  it("evicts the least recently used subject past maxSubjects", () => {
    const clock = new FakeClock();
    const cache = cacheWith(clock, { maxSubjects: 2 });
    cache.set(ref, snapshotOf(ref));
    cache.set(other, snapshotOf(other));
    cache.lookup(ref);
    cache.set({ tenantId: null, subjectId: "rm_9" }, snapshotOf({ tenantId: null, subjectId: "rm_9" }));
    expect(cache.has(ref)).toBe(true);
    expect(cache.has(other)).toBe(false);
    expect(cache.size).toBe(2);
  });
});

describe("SnapshotCache — loads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads through the loader with a signal, stores the result, and returns it", async () => {
    const cache = cacheWith(new FakeClock());
    const { loader, calls } = counted(ref);
    const snapshot = await cache.load(ref, loader);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(AbortSignal);
    expect(cache.lookup(ref)).toEqual({ state: "hit", snapshot });
    expect(cache.inflight(ref)).toBeUndefined();
  });

  it("dedupes concurrent loads of one key into a single loader call", async () => {
    const cache = cacheWith(new FakeClock());
    const { loader, calls } = counted(ref);
    const first = cache.load(ref, loader);
    const second = cache.load(ref, loader);
    expect(second).toBe(first);
    expect(cache.inflight(ref)).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("keeps separate keys separate", async () => {
    const cache = cacheWith(new FakeClock());
    const one = counted(ref);
    const two = counted(other);
    await Promise.all([cache.load(ref, one.loader), cache.load(other, two.loader)]);
    expect(one.calls).toHaveLength(1);
    expect(two.calls).toHaveLength(1);
    expect(cache.size).toBe(2);
  });

  it("rejects every waiter on failure, logs store.error once, and lets the key load again", async () => {
    const logger = new CollectingLogger();
    const cache = cacheWith(new FakeClock(), { logger });
    const failing = counted(ref, { fail: new Error("db down") });
    const first = cache.load(ref, failing.loader);
    const second = cache.load(ref, failing.loader);
    await expect(first).rejects.toThrow("db down");
    await expect(second).rejects.toThrow("db down");
    const errors = logger.find({ level: "error", msg: "store.error" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.obj).toMatchObject({ lib: "wisdom-graph", subjectId: "rm_42", method: "loadSnapshot", error: "Error: db down" });
    expect(cache.has(ref)).toBe(false);
    const working = counted(ref);
    await cache.load(ref, working.loader);
    expect(working.calls).toHaveLength(1);
    expect(cache.lookup(ref).state).toBe("hit");
  });

  it("turns a loader that throws synchronously into a rejection", async () => {
    const cache = cacheWith(new FakeClock());
    await expect(
      cache.load(ref, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
  });

  it("a load abandoned by its caller still warms the entry (continuation)", async () => {
    const cache = cacheWith(new FakeClock());
    let resolve: (s: SubjectSnapshot) => void = () => undefined;
    const slow = new Promise<SubjectSnapshot>((r) => {
      resolve = r;
    });
    const started = cache.load(ref, () => slow);
    // The caller walks away; the load finishes later.
    const snapshot = snapshotOf(ref);
    resolve(snapshot);
    await started;
    expect(cache.lookup(ref)).toEqual({ state: "hit", snapshot });
  });

  it("refresh() starts one background load, dedupes with an inflight one, and replaces the entry", async () => {
    const clock = new FakeClock();
    const cache = cacheWith(clock);
    const old = snapshotOf(ref);
    cache.set(ref, old);
    const { loader, calls } = counted(ref);
    cache.refresh(ref, loader);
    cache.refresh(ref, loader);
    expect(calls).toHaveLength(1);
    expect(cache.lookup(ref)).toEqual({ state: "hit", snapshot: old });
    await cache.settled();
    const refreshed = cache.lookup(ref);
    expect(refreshed.state).toBe("hit");
    if (refreshed.state !== "miss") expect(refreshed.snapshot).not.toBe(old);
  });

  it("refresh() swallows a failure after logging it", async () => {
    const logger = new CollectingLogger();
    const cache = cacheWith(new FakeClock(), { logger });
    cache.refresh(ref, counted(ref, { fail: new Error("flaky") }).loader);
    await cache.settled();
    expect(logger.find({ msg: "store.error" })).toHaveLength(1);
  });

  it("a load that started before invalidate() does not populate the entry, and a fresh load does", async () => {
    const cache = cacheWith(new FakeClock());
    let resolve: (s: SubjectSnapshot) => void = () => undefined;
    const stale = cache.load(ref, () => new Promise((r) => (resolve = r)));
    cache.invalidate(ref);
    expect(cache.inflight(ref)).toBeUndefined();
    resolve(snapshotOf(ref));
    await stale;
    expect(cache.has(ref)).toBe(false);
    const fresh = counted(ref);
    await cache.load(ref, fresh.loader);
    expect(cache.lookup(ref).state).toBe("hit");
  });

  it("invalidate() with no subject drops every entry and detaches every inflight load", async () => {
    const cache = cacheWith(new FakeClock());
    cache.set(ref, snapshotOf(ref));
    const pending = cache.load(other, counted(other).loader);
    cache.invalidate();
    expect(cache.size).toBe(0);
    expect(cache.inflight(other)).toBeUndefined();
    await pending;
    expect(cache.has(other)).toBe(false);
  });

  it("settled() resolves once nothing is in flight, and at once when nothing is", async () => {
    const cache = cacheWith(new FakeClock());
    await cache.settled();
    const { loader } = counted(ref);
    void cache.load(ref, loader);
    await cache.settled();
    expect(cache.inflight(ref)).toBeUndefined();
    expect(cache.lookup(ref).state).toBe("hit");
  });

  it("abandons a load after loadTimeoutMs with a TimeoutError so the key can be loaded again", async () => {
    vi.useFakeTimers();
    const logger = new CollectingLogger();
    const cache = cacheWith(new FakeClock(), { logger, loadTimeoutMs: 1_000 });
    const hung = counted(ref, { hang: true });
    const load = cache.load(ref, hung.loader);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(load).rejects.toMatchObject({ name: "TimeoutError" });
    expect(logger.find({ msg: "store.error" })).toHaveLength(1);
    const working = counted(ref);
    await cache.load(ref, working.loader);
    expect(working.calls).toHaveLength(1);
  });

  it("releases the key at loadTimeoutMs even when the loader ignores its signal and never settles", async () => {
    vi.useFakeTimers();
    const logger = new CollectingLogger();
    const cache = cacheWith(new FakeClock(), { logger, loadTimeoutMs: 1_000 });
    let calls = 0;
    const deaf = (): Promise<SubjectSnapshot> => {
      calls += 1;
      return new Promise(() => undefined);
    };
    const load = cache.load(ref, deaf);
    expect(cache.load(ref, deaf)).toBe(load);
    expect(cache.pending).toBe(1);
    let settled = false;
    const waiting = cache.settled().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(load).rejects.toMatchObject({ name: "TimeoutError" });
    await waiting;
    expect(settled).toBe(true);
    expect(cache.inflight(ref)).toBeUndefined();
    expect(cache.pending).toBe(0);
    expect(logger.find({ msg: "store.error" })).toHaveLength(1);
    void cache.load(ref, deaf).catch(() => undefined);
    expect(calls).toBe(2);
  });

  it("close() settles a load whose loader ignores the signal, and settled() returns", async () => {
    const cache = cacheWith(new FakeClock());
    const load = cache.load(ref, () => new Promise(() => undefined));
    const waiting = cache.settled();
    cache.close();
    await expect(load).rejects.toThrow("SnapshotCache closed");
    await waiting;
    expect(cache.pending).toBe(0);
  });

  it("an invalidated load is still waited for by settled(), and never lands after close()", async () => {
    const cache = cacheWith(new FakeClock());
    let resolve: (s: SubjectSnapshot) => void = () => undefined;
    const orphan = cache.load(ref, () => new Promise((r) => (resolve = r)));
    cache.invalidate(ref);
    expect(cache.inflight(ref)).toBeUndefined();
    expect(cache.pending).toBe(1);
    let settled = false;
    const waiting = cache.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    cache.close();
    resolve(snapshotOf(ref));
    await orphan.catch(() => undefined);
    await waiting;
    expect(settled).toBe(true);
    expect(cache.has(ref)).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.pending).toBe(0);
  });

  it("keeps no per-key state once a load has settled: a subject loaded and invalidated leaves nothing behind", async () => {
    const cache = cacheWith(new FakeClock(), { maxSubjects: 8 });
    for (let i = 0; i < 1_000; i += 1) {
      const subject: SubjectRef = { tenantId: null, subjectId: `s${i}` };
      await cache.load(subject, counted(subject).loader);
      cache.invalidate(subject);
    }
    expect(cache.size).toBe(0);
    expect(cache.pending).toBe(0);
  });

  it("close() aborts loads in flight, empties the cache, and refuses new loads with a cache.closed warning", async () => {
    const logger = new CollectingLogger();
    const cache = cacheWith(new FakeClock(), { logger });
    cache.set(other, snapshotOf(other));
    const hung = counted(ref, { hang: true });
    const load = cache.load(ref, hung.loader);
    cache.close();
    await expect(load).rejects.toThrow("SnapshotCache closed");
    expect(cache.size).toBe(0);
    const refused = counted(ref);
    await expect(cache.load(ref, refused.loader)).rejects.toThrow("SnapshotCache closed");
    expect(refused.calls).toHaveLength(0);
    const warnings = logger.find({ level: "warn", msg: "cache.closed" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toMatchObject({ lib: "wisdom-graph", op: "recall", subjectId: "rm_42", method: "loadSnapshot", error: "Error: SnapshotCache closed" });
  });
});

describe("SnapshotCache — continuity ring", () => {
  it("remembers topics newest first, without repeats, up to CONTINUITY_RING", () => {
    const cache = cacheWith(new FakeClock());
    expect(cache.recentPaths(ref)).toEqual([]);
    cache.remember(ref, ["/a", "/b"]);
    cache.remember(ref, ["/c", "/a"]);
    expect(cache.recentPaths(ref)).toEqual(["/c", "/a", "/b"]);
    for (let i = 0; i < 20; i += 1) cache.remember(ref, [`/n${i}`]);
    const ring = cache.recentPaths(ref);
    expect(ring).toHaveLength(CONTINUITY_RING);
    expect(ring[0]).toBe("/n19");
    expect(ring).not.toContain("/c");
  });

  it("ignores an empty topic and keeps the ring across invalidate()", () => {
    const cache = cacheWith(new FakeClock());
    cache.remember(ref, ["/a"]);
    cache.remember(ref, []);
    cache.invalidate(ref);
    cache.invalidate();
    expect(cache.recentPaths(ref)).toEqual(["/a"]);
  });
});

describe("describeError", () => {
  it("renders errors, strings and other values as text only", () => {
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeError("plain")).toBe("plain");
    expect(describeError(42)).toBe("42");
  });
});
