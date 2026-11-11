/**
 * The recall pipeline is tested the way the consumer will use it: against
 * the advisor fixture, with real budgets on a slow or faulty store, a
 * pre-aborted signal, a cold and a warm cache. Each acceptance bullet of
 * spec §11.2 (recall row) is one test; the never-reject property is a
 * seeded randomised run over faults, budgets, aborts and malformed input.
 */
import { describe, expect, it, vi } from "vitest";
import { defaultPolicy, mergePolicy } from "../policy";
import type { EngineStats, NeutralMessage, Recall, RecallRequest, StorePort } from "../index";
import type { SubjectRef } from "../ports";
import { fnv1a32Hex } from "../ids";
import { CapturingTracer, CollectingLogger, FakeClock, FakeEmbedding, FaultyStore, hashedBagOfWords } from "../../testing/fakes";
import { labelledQueries, advisorCategories, advisorFixture } from "../../testing/fixtures";
import { MemoryStore } from "../store/memory";
import { LruMap, SnapshotCache, type SnapshotCacheOptions } from "./cache";
import {
  MAX_QUERY_CHARS,
  SHARED_TTL_FACTOR,
  emptyRecall,
  normaliseRequest,
  recall,
  refine,
  trimTurns,
  type RecallContext,
} from "./recall";

const SUBJECT = "rm_42";
const SHARED = "org_shared";
const MARKETS = "How is the TSX index doing after the Bank of Canada rate decision?";
const RETIREMENT = "How should we sequence RRIF withdrawals for a retiree with a large TFSA?";

function zeroStats(): EngineStats {
  return {
    recalls: 0,
    recallEmpty: 0,
    recallPartial: 0,
    cacheHits: 0,
    cacheMisses: 0,
    ingested: 0,
    duplicates: 0,
    processed: 0,
    failed: 0,
    llmCalls: 0,
    opsAccepted: 0,
    opsRejected: 0,
    queueDepth: 0,
  };
}

interface Harness {
  ctx: RecallContext;
  store: FaultyStore;
  logger: CollectingLogger;
  tracer: CapturingTracer;
  clock: FakeClock;
  ref: SubjectRef;
}

/** A pipeline context over the fixture (optionally copied into a slow store), wrapped in a call-recording FaultyStore. */
function harness(over: Partial<RecallContext> & { latencyMs?: number; cacheOptions?: Partial<SnapshotCacheOptions>; withEmbeddings?: boolean } = {}): Harness {
  const clock = over.clock instanceof FakeClock ? over.clock : new FakeClock();
  const fixture = advisorFixture({ clock });
  let inner: MemoryStore = fixture.store;
  if (over.latencyMs !== undefined || over.withEmbeddings) {
    inner = new MemoryStore({ latencyMs: over.latencyMs ?? 0, clock });
    const snapshot = fixture.store.snapshot();
    if (over.withEmbeddings) {
      for (const subject of snapshot.subjects) {
        for (const node of subject.nodes) {
          if (node.path === "/") continue;
          node.embedding = hashedBagOfWords(`${node.title} ${node.description} ${node.keywords.join(" ")}`, 64);
        }
      }
    }
    inner.load(snapshot);
  }
  const store = new FaultyStore(inner);
  const logger = new CollectingLogger();
  const tracer = new CapturingTracer();
  const { latencyMs, cacheOptions, withEmbeddings, ...rest } = over;
  void latencyMs;
  void withEmbeddings;
  const ctx: RecallContext = {
    store,
    policy: defaultPolicy,
    categories: fixture.categories,
    tenantId: null,
    sharedSubjectId: null,
    cache: new SnapshotCache({ clock, logger, ...(cacheOptions ?? {}) }),
    clock,
    logger,
    tracer,
    queryVectors: new LruMap<number[]>(256),
    stats: zeroStats(),
    ...rest,
  };
  return { ctx, store, logger, tracer, clock, ref: { tenantId: null, subjectId: SUBJECT } };
}

function request(over: Partial<RecallRequest> = {}): RecallRequest {
  return { subjectId: SUBJECT, text: RETIREMENT, budgetMs: 1_000, ...over };
}

const loads = (h: Harness): number => h.store.calls.filter((c) => c.method === "loadSnapshot").length;

/** Every object reachable from `value` is frozen, and nothing reachable is a function or a promise. */
function assertPlainAndFrozen(value: unknown, path = "recall"): void {
  if (typeof value === "function") throw new Error(`${path} is a function`);
  if (value instanceof Promise) throw new Error(`${path} is a promise`);
  if (value === null || typeof value !== "object") return;
  if (!Object.isFrozen(value)) throw new Error(`${path} is not frozen`);
  for (const [key, child] of Object.entries(value)) assertPlainAndFrozen(child, `${path}.${key}`);
}

/** Deterministic PRNG (mulberry32), so a failing randomised run reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("emptyRecall (§2.8)", () => {
  it("is a frozen, serialisable Recall with no hints and the given reason", () => {
    const empty = emptyRecall({ subjectId: "rm_1", clientId: "c1", requestId: "req_1" }, "budget");
    assertPlainAndFrozen(empty);
    expect(empty.meta).toMatchObject({ requestId: "req_1", status: "empty", reason: "budget", cache: "none", classifier: "none", refined: false });
    expect(empty.charter).toMatchObject({ subjectId: "rm_1", clientId: "c1", topicPath: "/", entries: [], approvalMix: "none", tokenEstimate: 0 });
    expect(empty.topic).toEqual({ category: "direct", agents: [], confidence: 0, nodePaths: [], method: "none" });
    expect(empty.provenance).toEqual([]);
    expect(JSON.parse(JSON.stringify(empty))).toEqual(empty);
  });

  it("generates a request id when the request has none and tolerates no request at all", () => {
    const a = emptyRecall();
    const b = emptyRecall({ subjectId: "rm_1" });
    expect(a.meta.requestId).not.toBe(b.meta.requestId);
    expect(a.charter.subjectId).toBe("");
    expect(a.meta.reason).toBeUndefined();
    expect(b.charter.clientId).toBeNull();
  });
});

describe("step 1 — validate and normalise", () => {
  it("truncates text to 2 000 chars and keeps the last two user turns plus tool-bearing messages", () => {
    const turns: NeutralMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "two" },
      { role: "assistant", content: "a2", toolCalls: [{ name: "holdings", args: {} }] },
      { role: "tool", content: "{}", name: "holdings" },
      { role: "system", content: "sys" },
      { role: "user", content: "three" },
    ];
    const normalised = normaliseRequest(request({ text: "x".repeat(3_000), recentTurns: turns, clientId: undefined }), "req");
    expect(normalised.text).toHaveLength(MAX_QUERY_CHARS);
    expect(normalised.recentTurns.map((t) => t.content)).toEqual(["two", "a2", "{}", "three"]);
    expect(normalised.clientId).toBeNull();
    expect(normalised.approvedOnly).toBe(false);
    expect(normalised.refine).toBe(false);
    expect(trimTurns(undefined)).toEqual([]);
  });

  it("returns empty/invalid-request and logs recall.invalid with the issues", async () => {
    const h = harness();
    const result = await recall(h.ctx, request({ subjectId: "", budgetMs: -1 }));
    expect(result.meta).toMatchObject({ status: "empty", reason: "invalid-request", cache: "none" });
    const warned = h.logger.find({ level: "warn", msg: "recall.invalid" });
    expect(warned).toHaveLength(1);
    expect(warned[0]?.obj).toMatchObject({ lib: "wisdom-graph", op: "recall", issues: expect.arrayContaining([expect.objectContaining({ path: "/subjectId" })]) });
    expect(loads(h)).toBe(0);
  });

  it("returns empty/aborted on a pre-aborted signal without touching the store", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await recall(h.ctx, request({ signal: controller.signal }));
    expect(result.meta).toMatchObject({ status: "empty", reason: "aborted" });
    expect(loads(h)).toBe(0);
  });

  it("returns empty/aborted when the caller aborts during the store load", async () => {
    const h = harness({ latencyMs: 200 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await recall(h.ctx, request({ signal: controller.signal, budgetMs: 2_000 }));
    expect(result.meta).toMatchObject({ status: "empty", reason: "aborted", cache: "miss" });
  });
});

describe("step 2 — snapshot, budget and cache (§11.2 recall row)", () => {
  it("MemoryStore latency 500 + budget 150 → empty/store-timeout at the budget, then the cache is warm", async () => {
    const h = harness({ latencyMs: 500 });
    const startedAt = performance.now();
    const result = await recall(h.ctx, request({ budgetMs: 150 }));
    const elapsed = performance.now() - startedAt;
    // The outer net fires at 155 ms; the slack above it is timer jitter under CI load, never the store's 500 ms.
    expect(elapsed).toBeGreaterThanOrEqual(145);
    expect(elapsed).toBeLessThanOrEqual(250);
    expect(result.meta).toMatchObject({ status: "empty", reason: "store-timeout", cache: "miss" });
    assertPlainAndFrozen(result);
    expect(h.ctx.cache.inflight(h.ref)).toBeDefined();
    await h.ctx.cache.settled();
    const again = await recall(h.ctx, request({ budgetMs: 150 }));
    expect(again.meta).toMatchObject({ status: "ok", cache: "hit" });
    expect(again.charter.entries.length).toBeGreaterThan(0);
    expect(loads(h)).toBe(1);
  });

  it("FaultyStore throwing on loadSnapshot → empty/store-error and a logged error", async () => {
    const h = harness();
    const faulty = new FaultyStore(h.store, { throwOn: ["loadSnapshot"] });
    const ctx: RecallContext = { ...h.ctx, store: faulty };
    const result = await recall(ctx, request());
    expect(result.meta).toMatchObject({ status: "empty", reason: "store-error", cache: "miss" });
    const errors = h.logger.find({ level: "error", msg: "store.error" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.obj).toMatchObject({ method: "loadSnapshot", subjectId: SUBJECT });
    expect(ctx.stats).toMatchObject({ recalls: 1, recallEmpty: 1, cacheMisses: 1 });
  });

  it("budgetMs 0 serves a cache hit, and is store-timeout on a cold cache even against an instant store", async () => {
    const h = harness();
    const cold = await recall(h.ctx, request({ budgetMs: 0 }));
    expect(cold.meta).toMatchObject({ status: "empty", reason: "store-timeout", cache: "miss" });
    // The abandoned load still warms the cache: the next zero-budget recall is a hit without a second load.
    await h.ctx.cache.settled();
    const hit = await recall(h.ctx, request({ budgetMs: 0 }));
    expect(hit.meta).toMatchObject({ status: "ok", cache: "hit" });
    expect(hit.charter.entries.length).toBeGreaterThan(0);
    expect(loads(h)).toBe(1);
  });

  it("issues zero store writes and, on a cache hit, zero store calls", async () => {
    const h = harness();
    const inner = h.store;
    const writes: (keyof StorePort)[] = ["applyBatch", "deleteHint", "deleteSubject", "claimEvent", "leaseEvents", "updateEvent", "scrubEvents", "purge"];
    const spies = writes.map((method) => vi.spyOn(inner, method));
    await recall(h.ctx, request());
    await recall(h.ctx, request({ text: MARKETS, clientId: "client_A", approvedOnly: true }));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(h.store.calls.map((c) => c.method)).toEqual(["loadSnapshot"]);
    const before = h.store.calls.length;
    const hit = await recall(h.ctx, request());
    expect(hit.meta.cache).toBe("hit");
    expect(h.store.calls.length).toBe(before);
  });

  it("serves a stale entry immediately and refreshes it in the background", async () => {
    const h = harness();
    await recall(h.ctx, request());
    h.clock.tick(h.ctx.cache.ttlMs + 1);
    const stale = await recall(h.ctx, request());
    expect(stale.meta).toMatchObject({ status: "ok", cache: "stale" });
    expect(stale.charter.entries.length).toBeGreaterThan(0);
    expect(h.ctx.cache.inflight(h.ref)).toBeDefined();
    await h.ctx.cache.settled();
    expect(loads(h)).toBe(2);
    expect(h.ctx.cache.lookup(h.ref).state).toBe("hit");
    expect(h.ctx.stats).toMatchObject({ cacheHits: 1, cacheMisses: 1 });
  });

  it("negative-caches an unknown subject and still classifies it against the virtual categories", async () => {
    const h = harness({ sharedSubjectId: SHARED });
    const req = request({ subjectId: "rm_new", text: MARKETS });
    const first = await recall(h.ctx, req);
    expect(first.meta).toMatchObject({ status: "ok", cache: "miss" });
    expect(first.topic.category).toBe("consult_market_analyst");
    expect(first.topic.agents).toContain("consult_market_analyst");
    // The organisation's approved charter reaches a brand-new advisor.
    expect(first.preRoute.map((hint) => hint.slot)).toContain("performance.asof");
    const before = loads(h);
    const second = await recall(h.ctx, req);
    expect(second.meta.cache).toBe("hit");
    expect(loads(h)).toBe(before);
    h.clock.tick(h.ctx.cache.negativeTtlMs + 1);
    const third = await recall(h.ctx, req);
    expect(third.meta.cache).toBe("miss");
  });

  it("drops invalid rows and records them on the charter as invalid-row", async () => {
    const h = harness();
    const ctx: RecallContext = { ...h.ctx, store: new FaultyStore(h.store, { corruptRows: true }) };
    const result = await recall(ctx, request());
    expect(result.meta.status).toBe("ok");
    expect(result.charter.dropped.some((d) => d.reason === "invalid-row")).toBe(true);
    expect(h.logger.find({ msg: "snapshot.invalid-row" }).length).toBeGreaterThan(0);
  });
});

describe("shared subject (§4.2 step 2)", () => {
  it("adds the shared subject's approved hints and never its unapproved ones", async () => {
    const h = harness({ sharedSubjectId: SHARED });
    const result = await recall(h.ctx, request({ text: MARKETS }));
    expect(result.meta.status).toBe("ok");
    const slots = result.charter.entries.map((hint) => hint.slot);
    expect(slots).toContain("performance.asof");
    expect(slots).not.toContain("format.numbers");
    expect(result.charter.suppressed.map((s) => s.rule)).not.toContain("shared-subject");
  });

  it("a shared-subject miss never delays the primary beyond 50 ms: partial/budget, then ok once warm", async () => {
    const h = harness({ latencyMs: 100, sharedSubjectId: SHARED });
    const startedAt = performance.now();
    const result = await recall(h.ctx, request({ budgetMs: 1_000 }));
    expect(performance.now() - startedAt).toBeLessThan(400);
    expect(result.meta).toMatchObject({ status: "partial", reason: "budget", cache: "miss" });
    expect(result.charter.entries.length).toBeGreaterThan(0);
    expect(result.charter.entries.map((hint) => hint.slot)).not.toContain("performance.asof");
    await h.ctx.cache.settled();
    const again = await recall(h.ctx, request({ budgetMs: 1_000 }));
    expect(again.meta).toMatchObject({ status: "ok", cache: "hit" });
    expect(again.charter.entries.map((hint) => hint.slot)).toContain("performance.asof");
    expect(h.ctx.stats.recallPartial).toBe(1);
  });

  it("negative-caches a configured shared subject with no rows for ttlMs × 4, not negativeTtlMs", async () => {
    const h = harness({ sharedSubjectId: "org_missing" });
    const sharedLoads = (): number =>
      h.store.calls.filter((c) => c.method === "loadSnapshot" && (c.args[0] as SubjectRef).subjectId === "org_missing").length;
    expect((await recall(h.ctx, request())).meta.status).toBe("ok");
    expect(sharedLoads()).toBe(1);
    h.clock.tick(h.ctx.cache.negativeTtlMs + 1);
    expect((await recall(h.ctx, request())).meta.status).toBe("ok");
    expect(sharedLoads()).toBe(1);
    h.clock.tick(h.ctx.cache.ttlMs * SHARED_TTL_FACTOR);
    expect((await recall(h.ctx, request())).meta.status).toBe("ok");
    expect(sharedLoads()).toBe(2);
  });

  it("is ignored when the shared subject is the subject being recalled", async () => {
    const h = harness({ sharedSubjectId: SUBJECT });
    const result = await recall(h.ctx, request());
    expect(result.meta.status).toBe("ok");
    expect(loads(h)).toBe(1);
  });
});

describe("steps 3–7 — classification, candidates, charter", () => {
  it("classifies, fills the lanes, and records the topic in the continuity ring", async () => {
    const h = harness();
    const result = await recall(h.ctx, request({ clientId: "client_A" }));
    expect(result.meta).toMatchObject({ status: "ok", cache: "miss", classifier: "keyword", refined: false });
    expect(result.topic.category).toBe("consult_advice");
    expect(result.topic.nodePaths[0]).toMatch(/^\/consult_advice/);
    expect(result.charter.topicPath).toBe(result.topic.nodePaths[0]);
    expect(result.provenance).toEqual(result.charter.entries.map((hint) => hint.id));
    expect(result.charter.entries.map((hint) => hint.slot)).toContain("disclaimers");
    expect(Object.keys(result.agentHints)).toContain("consult_advice");
    expect(result.charter.approvalMix).toBe("mixed");
    expect(h.ctx.cache.recentPaths(h.ref)).toEqual([...result.topic.nodePaths]);
    assertPlainAndFrozen(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("approvedOnly assembles a charter from approved hints only", async () => {
    const h = harness({ sharedSubjectId: SHARED });
    const result = await recall(h.ctx, request({ approvedOnly: true }));
    expect(result.charter.entries.length).toBeGreaterThan(0);
    expect(result.charter.entries.every((hint) => hint.approval === "approved")).toBe(true);
    expect(result.charter.approvalMix).toBe("approved-only");
  });

  it("uses the previous user turn for continuity of topic", async () => {
    const h = harness();
    const result = await recall(h.ctx, request({ text: "and what about the minimums?", recentTurns: [{ role: "user", content: RETIREMENT }] }));
    expect(result.topic.category).toBe("consult_advice");
  });

  it("accepts a custom tokenizer for the caps", async () => {
    const h = harness({ tokenizer: () => 1_000 });
    const result = await recall(h.ctx, request());
    expect(result.charter.entries).toEqual([]);
    expect(result.charter.dropped.some((d) => d.reason === "budget")).toBe(true);
  });
});

describe("embedding re-rank (§4.2 step 3)", () => {
  it("re-ranks inside recall when refine is set, a port and node embeddings exist, and budget remains", async () => {
    const h = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64) });
    const result = await recall(h.ctx, request({ text: MARKETS, refine: true, budgetMs: 1_000 }));
    expect(result.meta).toMatchObject({ status: "ok", refined: true, classifier: "embedding" });
    expect(result.topic.category).toBe("consult_market_analyst");
    const again = await recall(h.ctx, request({ text: MARKETS, refine: true, budgetMs: 1_000 }));
    expect(again.meta.refined).toBe(true);
    expect((h.ctx.embeddings as FakeEmbedding).calls).toHaveLength(1);
  });

  it("reports partial/budget when the re-rank was requested but the budget is too small", async () => {
    const h = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64) });
    const result = await recall(h.ctx, request({ refine: true, budgetMs: defaultPolicy.classify.embedMinBudgetMs }));
    expect(result.meta).toMatchObject({ status: "partial", reason: "budget", refined: false, classifier: "keyword" });
    expect(result.charter.entries.length).toBeGreaterThan(0);
  });

  it("keeps the keyword result when the port fails, and is ok without a port or embeddings", async () => {
    const failing = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64, { throws: new Error("quota") }) });
    const failed = await recall(failing.ctx, request({ refine: true }));
    expect(failed.meta).toMatchObject({ status: "ok", refined: false, classifier: "keyword" });
    expect(failing.logger.find({ msg: "embedding.error" })).toHaveLength(1);
    const noPort = await recall(harness({ withEmbeddings: true }).ctx, request({ refine: true }));
    expect(noPort.meta).toMatchObject({ status: "ok", refined: false });
    const noVectors = await recall(harness({ embeddings: new FakeEmbedding(64) }).ctx, request({ refine: true }));
    expect(noVectors.meta).toMatchObject({ status: "ok", refined: false });
  });
});

describe("refine() (§4.2 step 3, §2.7)", () => {
  it("re-ranks with FakeEmbedding when budget remains and re-runs steps 4–7 on the cached snapshot", async () => {
    const h = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64) });
    const base = await recall(h.ctx, request({ text: MARKETS, requestId: "req_base" }));
    expect(base.meta.refined).toBe(false);
    const refined = await refine(h.ctx, base, request({ text: MARKETS, requestId: "req_base", refine: true }));
    expect(refined).not.toBe(base);
    expect(refined.meta).toMatchObject({ requestId: "req_base", status: "ok", refined: true, classifier: "embedding", cache: "hit" });
    expect(refined.topic.method).toBe("embedding");
    expect(refined.charter.entries.length).toBeGreaterThan(0);
    assertPlainAndFrozen(refined);
    expect(h.store.calls.filter((c) => c.method === "loadSnapshot")).toHaveLength(1);
  });

  it("serves a stale entry at once and refreshes it in the background, as recall does", async () => {
    const h = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64), latencyMs: 20 });
    const base = await recall(h.ctx, request({ text: MARKETS }));
    h.clock.tick(h.ctx.cache.ttlMs + 1);
    const refined = await refine(h.ctx, base, request({ text: MARKETS, refine: true }));
    expect(refined).not.toBe(base);
    expect(refined.meta).toMatchObject({ status: "ok", refined: true, cache: "stale" });
    expect(h.ctx.cache.inflight(h.ref)).toBeDefined();
    await h.ctx.cache.settled();
    expect(loads(h)).toBe(2);
    expect(h.ctx.cache.lookup(h.ref).state).toBe("hit");
  });

  it("returns the input unchanged without a port, without a cached snapshot, or without node embeddings", async () => {
    const withPortNoVectors = harness({ embeddings: new FakeEmbedding(64) });
    const base = await recall(withPortNoVectors.ctx, request());
    expect(await refine(withPortNoVectors.ctx, base, request())).toBe(base);

    const noPort = harness({ withEmbeddings: true });
    const base2 = await recall(noPort.ctx, request());
    expect(await refine(noPort.ctx, base2, request())).toBe(base2);

    const cold = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64) });
    const base3 = await recall(cold.ctx, request());
    cold.ctx.cache.invalidate();
    expect(await refine(cold.ctx, base3, request())).toBe(base3);
  });

  it("returns the input unchanged on a failure, a pre-aborted signal, a small budget, or a timeout", async () => {
    const failing = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64, { throws: new Error("down") }) });
    const base = await recall(failing.ctx, request());
    expect(await refine(failing.ctx, base, request())).toBe(base);

    const aborted = new AbortController();
    aborted.abort();
    const fine = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64) });
    const base2 = await recall(fine.ctx, request());
    expect(await refine(fine.ctx, base2, request(), { signal: aborted.signal })).toBe(base2);
    expect(await refine(fine.ctx, base2, request(), { budgetMs: 100 })).toBe(base2);
    expect(await refine(fine.ctx, base2, request({ subjectId: "" }))).toBe(base2);

    const slow = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64, { delayMs: 2_000 }) });
    const base3 = await recall(slow.ctx, request());
    const startedAt = performance.now();
    expect(await refine(slow.ctx, base3, request(), { budgetMs: 400 })).toBe(base3);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("never rejects even when handed garbage", async () => {
    const h = harness({ withEmbeddings: true, embeddings: new FakeEmbedding(64) });
    const base = await recall(h.ctx, request());
    // Deliberately malformed input: the never-reject contract is the point of the test.
    const garbage = null as unknown as RecallRequest;
    expect(await refine(h.ctx, base, garbage)).toBe(base);
  });
});

describe("observability (§10)", () => {
  it("wisdom.recall and its child spans carry the §10.2 attributes and are ended", async () => {
    const h = harness();
    await recall(h.ctx, request({ requestId: "req_9", budgetMs: 250 }));
    const [root] = h.tracer.named("wisdom.recall");
    expect(root?.ended).toBe(true);
    expect(root?.attrs).toMatchObject({
      "wisdom.request_id": "req_9",
      "wisdom.subject_hash": fnv1a32Hex(SUBJECT),
      "wisdom.budget_ms": 250,
      "wisdom.status": "ok",
      "wisdom.cache": "miss",
      "wisdom.classifier": "keyword",
      "wisdom.category": "consult_advice",
      "wisdom.partial": false,
    });
    expect(root?.attrs["wisdom.hint_count"]).toBeGreaterThan(0);
    expect(typeof root?.attrs["wisdom.elapsed_ms"]).toBe("number");
    for (const name of ["wisdom.recall.snapshot", "wisdom.recall.classify", "wisdom.recall.assemble"]) {
      const [span] = h.tracer.named(name);
      expect(span?.ended, name).toBe(true);
      expect(span?.attrs, name).toMatchObject({ "wisdom.budget_ms": 250, "wisdom.cache": "miss", "wisdom.partial": false });
      expect(typeof span?.attrs["wisdom.elapsed_ms"], name).toBe("number");
    }
    expect(h.tracer.named("wisdom.recall.snapshot")[0]?.attrs["wisdom.node_count"]).toBeGreaterThan(0);
    expect(h.tracer.named("wisdom.recall.assemble")[0]?.attrs["wisdom.candidate_count"]).toBeGreaterThan(0);
  });

  it("logs recall.done with the §10.1 fields: info on a miss, debug on a plain hit", async () => {
    const h = harness();
    await recall(h.ctx, request({ requestId: "req_log" }));
    const [miss] = h.logger.find({ msg: "recall.done" });
    expect(miss?.level).toBe("info");
    expect(miss?.obj).toMatchObject({
      lib: "wisdom-graph",
      op: "recall",
      tenantId: null,
      subjectId: SUBJECT,
      requestId: "req_log",
      status: "ok",
      cache: "miss",
      classifier: "keyword",
      category: "consult_advice",
    });
    const line = miss?.obj as Record<string, unknown>;
    expect(Array.isArray(line.agents)).toBe(true);
    expect(Array.isArray(line.hintIds)).toBe(true);
    expect(typeof line.suppressed).toBe("number");
    expect(typeof line.dropped).toBe("number");
    expect(typeof line.elapsedMs).toBe("number");
    await recall(h.ctx, request());
    expect(h.logger.find({ msg: "recall.done" })[1]?.level).toBe("debug");
  });

  it("ends every child span and records the exception on the step and the root when a step throws", async () => {
    const h = harness({
      tokenizer: () => {
        throw new Error("tokenizer down");
      },
    });
    const result = await recall(h.ctx, request());
    expect(result.meta).toMatchObject({ status: "empty", reason: "error", cache: "miss" });
    expect(h.logger.find({ level: "error", msg: "recall.error" })).toHaveLength(1);
    expect(h.tracer.spans.map((s) => s.name)).toEqual(["wisdom.recall", "wisdom.recall.snapshot", "wisdom.recall.classify", "wisdom.recall.assemble"]);
    for (const span of h.tracer.spans) expect(span.ended, span.name).toBe(true);
    expect(h.tracer.named("wisdom.recall")[0]?.exceptions).toHaveLength(1);
    expect(h.tracer.named("wisdom.recall.assemble")[0]?.exceptions).toHaveLength(1);
    expect(typeof h.tracer.named("wisdom.recall.assemble")[0]?.attrs["wisdom.elapsed_ms"]).toBe("number");
    expect(h.tracer.named("wisdom.recall.snapshot")[0]?.exceptions).toHaveLength(0);
    expect(h.tracer.named("wisdom.recall")[0]?.attrs).toMatchObject({ "wisdom.status": "empty", "wisdom.cache": "miss" });
  });

  it("still resolves when the tracer throws at the root span and the logger throws too (must-have 2)", async () => {
    const h = harness();
    const broken = {
      startSpan: (): never => {
        throw new Error("tracer boom");
      },
    };
    const loud = {
      info: (): never => {
        throw new Error("log");
      },
      warn: (): never => {
        throw new Error("log");
      },
      error: (): never => {
        throw new Error("log");
      },
    };
    const ctx: RecallContext = { ...h.ctx, tracer: broken, logger: loud };
    const result = await recall(ctx, request());
    expect(result.meta).toMatchObject({ status: "empty", reason: "error", cache: "none" });
    expect(ctx.stats.recalls).toBe(1);
    const poisoned = { subjectId: SUBJECT, text: RETIREMENT, get budgetMs(): number { throw new Error("poison"); } } as RecallRequest;
    await expect(refine(ctx, result, poisoned)).resolves.toBe(result);
  });

  it("records the exception on the root span and returns empty/error when the tracer's child span throws", async () => {
    const h = harness();
    const broken = {
      startSpan: (name: string) => {
        if (name === "wisdom.recall.classify") throw new Error("tracer down");
        return h.tracer.startSpan(name);
      },
    };
    const result = await recall({ ...h.ctx, tracer: broken }, request());
    expect(result.meta).toMatchObject({ status: "empty", reason: "error", cache: "miss" });
    expect(h.logger.find({ level: "error", msg: "recall.error" })).toHaveLength(1);
    expect(h.tracer.named("wisdom.recall")[0]?.ended).toBe(true);
    expect(h.tracer.named("wisdom.recall")[0]?.exceptions).toHaveLength(1);
    expect(h.tracer.named("wisdom.recall.snapshot")[0]?.ended).toBe(true);
  });

  it("counts recalls, empties, partials, hits and misses", async () => {
    const h = harness();
    await recall(h.ctx, request());
    await recall(h.ctx, request());
    await recall(h.ctx, request({ subjectId: "" }));
    expect(h.ctx.stats).toMatchObject({ recalls: 3, recallEmpty: 1, recallPartial: 0, cacheHits: 1, cacheMisses: 1 });
  });
});

describe("step 3 — the surface's category hint (§4.2 step 3)", () => {
  it("surface lifts the configured category when the engine maps it, and is inert without a map", async () => {
    const h = harness({ surfaceCategories: { client_sheet: "consult_client_intelligence" } });
    const plain = await recall(h.ctx, request({ text: "hello" }));
    expect(plain.topic).toMatchObject({ category: "direct", method: "none" });
    const sheet = await recall(h.ctx, request({ text: "hello", surface: "client_sheet" }));
    expect(sheet.topic).toMatchObject({ category: "consult_client_intelligence", method: "category-hint" });
    expect(sheet.topic.agents).toContain("consult_client_intelligence");
    const unmapped = await recall(h.ctx, request({ text: "hello", surface: "portfolio" }));
    expect(unmapped.topic).toMatchObject({ category: "direct", method: "none" });
    const { surfaceCategories, ...none } = h.ctx;
    void surfaceCategories;
    const bare = await recall(none, request({ text: "hello", surface: "client_sheet" }));
    expect(bare.topic).toMatchObject({ category: "direct", method: "none" });
  });
});

describe("never-reject property (§11.3)", () => {
  it("1 000 randomised runs never reject and always return a frozen, JSON-clean Recall", async () => {
    const random = prng(20260907);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const queries = labelledQueries().map((q) => q.text);
    const subjects = [SUBJECT, "rm_new", SHARED, "rm_other"];
    const budgets = [0, 1, 2, 5, 10, 20];
    const h = harness({ sharedSubjectId: SHARED, cacheOptions: { loadTimeoutMs: 15, ttlMs: 40, staleTtlMs: 80, negativeTtlMs: 10 }, embeddings: new FakeEmbedding(64) });
    const mode: { throwOn?: (keyof StorePort)[]; hangOn?: (keyof StorePort)[]; corruptRows?: boolean } = {};
    const ctx: RecallContext = { ...h.ctx, store: new FaultyStore(h.store, mode), policy: mergePolicy({ recall: { includePending: true } }) };
    const writes = ["applyBatch", "deleteHint", "deleteSubject", "claimEvent", "leaseEvents", "updateEvent", "scrubEvents", "purge"];

    const makeRequest = (): RecallRequest => {
      const roll = random();
      if (roll < 0.05) return null as unknown as RecallRequest; // malformed on purpose
      if (roll < 0.1) return { subjectId: pick(subjects), text: 5, budgetMs: "x" } as unknown as RecallRequest; // wrong types on purpose
      const controller = new AbortController();
      const abortRoll = random();
      if (abortRoll < 0.05) controller.abort();
      else if (abortRoll < 0.15) setTimeout(() => controller.abort(), Math.floor(random() * 5));
      return {
        subjectId: pick(subjects),
        clientId: random() < 0.3 ? "client_A" : null,
        text: pick(queries),
        budgetMs: pick(budgets),
        signal: controller.signal,
        approvedOnly: random() < 0.2,
        refine: random() < 0.3,
        ...(random() < 0.3 ? { recentTurns: [{ role: "user" as const, content: pick(queries) }] } : {}),
      };
    };

    let done = 0;
    const reasons = new Set<string>();
    for (let batch = 0; batch < 40; batch += 1) {
      const fault = random();
      delete mode.throwOn;
      delete mode.hangOn;
      delete mode.corruptRows;
      if (fault < 0.15) mode.throwOn = ["loadSnapshot"];
      else if (fault < 0.25) mode.hangOn = ["loadSnapshot"];
      else if (fault < 0.3) mode.corruptRows = true;
      if (random() < 0.2) ctx.cache.invalidate();
      if (random() < 0.3) h.clock.tick(Math.floor(random() * 50));
      const results = await Promise.all(Array.from({ length: 25 }, () => recall(ctx, makeRequest())));
      for (const result of results) {
        assertPlainAndFrozen(result);
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        expect(["ok", "partial", "empty"]).toContain(result.meta.status);
        expect(typeof result.meta.requestId).toBe("string");
        if (result.meta.reason !== undefined) reasons.add(result.meta.reason);
        done += 1;
      }
    }
    expect(done).toBe(1_000);
    expect(ctx.stats.recalls).toBe(1_000);
    expect(h.store.calls.filter((c) => writes.includes(c.method))).toEqual([]);
    expect(reasons.has("invalid-request")).toBe(true);
    expect(reasons.has("store-error")).toBe(true);
    await ctx.cache.settled();
  }, 60_000);
});

describe("classification stays sane over the fixture", () => {
  it("routes the labelled queries with ≥ 90 % category accuracy through the whole pipeline", async () => {
    const h = harness();
    const rows = labelledQueries();
    let right = 0;
    for (const row of rows) {
      const result = await recall(h.ctx, request({ text: row.text }));
      if (result.topic.category === row.category) right += 1;
      h.ctx.cache.remember(h.ref, []);
    }
    expect(right / rows.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe("categories from the configuration", () => {
  it("classifies a new subject with the configured categories only", async () => {
    const h = harness();
    const ctx: RecallContext = { ...h.ctx, categories: advisorCategories().slice(0, 2) };
    const result: Recall = await recall(ctx, request({ subjectId: "rm_blank", text: MARKETS }));
    expect(result.meta.status).toBe("ok");
    expect(["direct", "consult_client_intelligence", "consult_advice"]).toContain(result.topic.category);
  });
});
