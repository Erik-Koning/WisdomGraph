/**
 * The engine is checked as the consumer sees it: construction fails loudly
 * on bad configuration, the recall side works end to end over the fixture,
 * the governance calls (forget, approve) leave the store and the audit in
 * the state spec §10.4 describes, and the noop engine satisfies the whole
 * interface with empty answers.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy } from "./policy";
import type { HintRecord, Recall, RecallRequest, WisdomGraph } from "./types";
import type { SubjectRef } from "./ports";
import { CapturingTracer, CollectingLogger, FakeClock, FaultyStore } from "../testing/fakes";
import { fixtureHint, advisorCategories, advisorFixture } from "../testing/fixtures";
import { MemoryStore } from "./store/memory";
import { CACHE_DEFAULTS } from "./recall/cache";
import { WisdomGraphEngine, createNoopWisdomGraph, createWisdomGraph } from "./engine";

const RETIREMENT = "How should we sequence RRIF withdrawals for a retiree with a large TFSA?";

function setup(over: { latencyMs?: number; tracer?: CapturingTracer } = {}) {
  const clock = new FakeClock();
  const fixture = advisorFixture({ clock });
  let inner: MemoryStore = fixture.store;
  if (over.latencyMs !== undefined) {
    inner = new MemoryStore({ latencyMs: over.latencyMs, clock });
    inner.load(fixture.store.snapshot());
  }
  const store = new FaultyStore(inner);
  const logger = new CollectingLogger();
  const graph = createWisdomGraph({ store, categories: fixture.categories, clock, logger, tracer: over.tracer, sharedSubjectId: fixture.sharedSubjectId });
  const ref: SubjectRef = { tenantId: null, subjectId: fixture.subjectId };
  return { graph, store, inner, fixture, clock, logger, ref };
}

const request = (over: Partial<RecallRequest> = {}): RecallRequest => ({ subjectId: "rm_42", text: RETIREMENT, budgetMs: 1_000, ...over });

describe("createWisdomGraph — construction", () => {
  it("throws TypeError for missing options, a store without loadSnapshot, or categories that are not an array", () => {
    // Malformed on purpose: construction is the boundary under test.
    expect(() => createWisdomGraph(undefined as unknown as Parameters<typeof createWisdomGraph>[0])).toThrow(TypeError);
    expect(() => createWisdomGraph({ store: {} as unknown as MemoryStore, categories: [] })).toThrow(TypeError);
    expect(() => createWisdomGraph({ store: new MemoryStore(), categories: "x" as unknown as [] })).toThrow(TypeError);
  });

  it("throws TypeError for an invalid category configuration at construction, not on the hot path", () => {
    expect(() => createWisdomGraph({ store: new MemoryStore(), categories: [{ name: "consult_advice", keywords: [] }, { name: "consult_advice", keywords: [] }] })).toThrow(TypeError);
    expect(() => createWisdomGraph({ store: new MemoryStore(), categories: [{ name: "direct", keywords: [] }] })).toThrow(TypeError);
    expect(() => createWisdomGraph({ store: new MemoryStore(), categories: [{ name: "consult_advice", keywords: [], patterns: ["(a+)+"] }] })).toThrow(TypeError);
    expect(() => createWisdomGraph({ store: new MemoryStore(), categories: [{ name: "Bad Name", keywords: [] }] })).toThrow(TypeError);
  });

  it("returns a WisdomGraphEngine bound to one tenant with the merged policy", () => {
    const graph = createWisdomGraph({ store: new MemoryStore(), categories: advisorCategories(), tenantId: "acme", policy: { caps: { maxHintsPerLane: 3 } } });
    expect(graph).toBeInstanceOf(WisdomGraphEngine);
    const engine = graph as WisdomGraphEngine;
    expect(engine.ctx.tenantId).toBe("acme");
    expect(engine.ctx.policy.caps.maxHintsPerLane).toBe(3);
    expect(engine.ctx.policy.caps.totalTokens).toBe(defaultPolicy.caps.totalTokens);
    expect(engine.ctx.sharedSubjectId).toBeNull();
  });
});

describe("createWisdomGraph — cache options", () => {
  it("passes the four §2.7 windows to the cache and nothing else: loadTimeoutMs stays the cache's own", () => {
    // A variable rather than a literal, so an extra key reaches the constructor the way an untyped spread once let it.
    const cache = { ttlMs: 5, staleTtlMs: 50, negativeTtlMs: 7, maxSubjects: 3, loadTimeoutMs: 1 };
    const engine = new WisdomGraphEngine({ store: new MemoryStore(), categories: advisorCategories(), cache });
    expect(engine.ctx.cache).toMatchObject({ ttlMs: 5, staleTtlMs: 50, negativeTtlMs: 7, loadTimeoutMs: CACHE_DEFAULTS.loadTimeoutMs });
    const defaults = new WisdomGraphEngine({ store: new MemoryStore(), categories: advisorCategories() });
    const { maxSubjects, ...windows } = CACHE_DEFAULTS;
    void maxSubjects;
    expect(defaults.ctx.cache).toMatchObject(windows);
  });
});

describe("createWisdomGraph — recall side", () => {
  it("recalls end to end, exposes compile() with the engine's caps, and counts in stats()", async () => {
    const { graph } = setup();
    const result = await graph.recall(request());
    expect(result.meta).toMatchObject({ status: "ok", cache: "miss" });
    expect(result.charter.entries.length).toBeGreaterThan(0);
    const artifact = graph.compile(result.charter, "agent", { agent: "consult_advice" });
    expect(artifact.text).toContain('<<wisdom-hints lane="agent" agent="consult_advice">>');
    expect(artifact.hintIds.length).toBeGreaterThan(0);
    const capped = createWisdomGraph({ store: new MemoryStore(), categories: advisorCategories(), policy: { caps: { maxHintsPerLane: 1 } } });
    expect(capped.compile(result.charter, "responseStyle").hintIds).toHaveLength(1);
    expect(graph.stats()).toMatchObject({ recalls: 1, cacheMisses: 1, cacheHits: 0, recallEmpty: 0 });
  });

  it("refine() returns the input without an embeddings port", async () => {
    const { graph } = setup();
    const base = await graph.recall(request());
    expect(await graph.refine(base, request())).toBe(base);
  });

  it("invalidate() forces the next recall to reload; warm() loads without a recall and joins a load in flight", async () => {
    const { graph, store } = setup({ latencyMs: 60 });
    // Only the advisor's loads: the shared subject is loaded on its own key.
    const loads = (): number => store.calls.filter((c) => c.method === "loadSnapshot" && (c.args[0] as SubjectRef).subjectId === "rm_42").length;
    const first = await graph.recall(request({ budgetMs: 10 }));
    expect(first.meta.reason).toBe("store-timeout");
    await graph.maintenance.warm("rm_42");
    expect(loads()).toBe(1);
    expect((await graph.recall(request())).meta.cache).toBe("hit");
    await graph.maintenance.warm("rm_42");
    expect(loads()).toBe(1);
    graph.invalidate("rm_42");
    expect((await graph.recall(request())).meta.cache).toBe("miss");
    graph.invalidate();
    expect((await graph.recall(request())).meta.cache).toBe("miss");
    expect(graph.stats()).toMatchObject({ recalls: 4, recallEmpty: 1, cacheMisses: 3, cacheHits: 1 });
  });

  it("ingest is wired to the ledger: a valid event is recorded and processed, invalid input is rejected, and neither rejects", async () => {
    const { graph, inner } = setup();
    // `run_7` is the fixture's stored turn: the feedback anchors at once instead of waiting for it.
    await expect(graph.ingest({ type: "feedback", id: "fb_1", runId: "run_7", subjectId: "rm_42", signal: "up" }, { waitFor: "processed" })).resolves.toEqual({
      eventId: "fb_1",
      status: "processed",
    });
    expect(await inner.getEvent(null, "fb_1")).toMatchObject({ status: "done" });
    await expect(graph.ingest(null as unknown as Parameters<WisdomGraph["ingest"]>[0])).resolves.toMatchObject({ status: "rejected" });
    expect(graph.stats()).toMatchObject({ ingested: 1, processed: 1, queueDepth: 0 });
  });

  it("drain() over an empty ledger reports nothing; the passes are wired and report over the fixture; flush() and close() resolve", async () => {
    const { graph, fixture } = setup();
    await expect(graph.maintenance.drain()).resolves.toEqual({ processed: 0, failed: 0 });
    await expect(graph.maintenance.consolidate("rm_42")).resolves.toMatchObject({ subjectId: "rm_42", usedLlm: false, merged: 0 });
    const active = fixture.hints.filter((h) => h.status === "active").length;
    await expect(graph.maintenance.maintain({ subjectId: "rm_42" })).resolves.toMatchObject({ subjectId: "rm_42", examined: active, elapsedMs: 0 });
    await expect(graph.maintenance.maintain()).resolves.not.toHaveProperty("subjectId");
    await graph.flush();
    await graph.close();
    await graph.close();
  });

  it("recall after close() is empty/store-error and logged, never a rejection", async () => {
    const { graph, logger, store } = setup();
    await graph.close();
    const before = store.calls.length;
    const result = await graph.recall(request());
    expect(result.meta).toMatchObject({ status: "empty", reason: "store-error", cache: "miss" });
    expect(store.calls.length).toBe(before);
    const warnings = logger.find({ level: "warn", msg: "cache.closed" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toMatchObject({ subjectId: "rm_42", method: "loadSnapshot" });
    expect(graph.stats()).toMatchObject({ recalls: 1, recallEmpty: 1 });
  });

  it("explain() is wired to the engine's context", async () => {
    const { graph, fixture } = setup();
    const explanation = await graph.explain(fixture.subjectId, { text: RETIREMENT });
    expect(explanation.tree[0]?.node.path).toBe("/");
    expect(explanation.trace?.recall.meta.status).toBe("ok");
  });
});

describe("forget (§10.4)", () => {
  it("forget(subject, hint) leaves no row, adds a tombstone, audits hint.forgotten, invalidates the cache, and is idempotent", async () => {
    const { graph, inner, fixture, ref, store } = setup();
    const target = fixture.hints.find((h) => h.slot === "disclaimers") as HintRecord;
    const before = await graph.recall(request());
    expect(before.charter.entries.map((h) => h.id)).toContain(target.id);

    await graph.forget(fixture.subjectId, target.id, { actor: "rm_42", reason: "wrong" });
    expect(await inner.getHint(ref, target.id)).toBeNull();
    const data = await inner.loadSnapshot(ref);
    expect(data?.tombstones).toContain(target.id);
    const audit = await inner.listAudit(ref, 10);
    const forgotten = audit.filter((a) => a.action === "hint.forgotten");
    expect(forgotten).toHaveLength(1);
    expect(forgotten[0]).toMatchObject({ actor: "human:rm_42", hintId: target.id, subjectId: fixture.subjectId, detail: { reason: "wrong" } });

    const after = await graph.recall(request());
    expect(after.meta.cache).toBe("miss");
    expect(after.charter.entries.map((h) => h.id)).not.toContain(target.id);

    await graph.forget(fixture.subjectId, target.id);
    expect((await inner.listAudit(ref, 10)).filter((a) => a.action === "hint.forgotten")).toHaveLength(1);
    expect(store.calls.filter((c) => c.method === "applyBatch")).toHaveLength(2);
  });

  it("a forgotten hint cannot be resurrected by a replayed write", async () => {
    const { graph, inner, fixture, ref } = setup();
    const target = fixture.hints.find((h) => h.slot === "disclaimers") as HintRecord;
    await graph.forget(fixture.subjectId, target.id);
    await inner.applyBatch(ref, [{ op: "upsertHint", hint: target }]);
    expect(await inner.getHint(ref, target.id)).toBeNull();
  });

  it("forget(subject) with no hint uses the system actor and forget(subject) alone leaves zero rows", async () => {
    const { graph, inner, fixture, ref } = setup();
    const target = fixture.hints.find((h) => h.slot === "tone") as HintRecord;
    await graph.forget(fixture.subjectId, target.id);
    expect((await inner.listAudit(ref, 10)).find((a) => a.action === "hint.forgotten")?.actor).toBe("system:forget");

    await graph.forget(fixture.subjectId);
    expect(await inner.loadSnapshot(ref, { statuses: ["pending", "active", "superseded", "retired"] })).toBeNull();
    expect(await inner.listEvents(ref, { limit: 10 })).toEqual([]);
    expect(await inner.listAudit(ref, 10)).toEqual([]);
    await graph.forget(fixture.subjectId);
    const recalled = await graph.recall(request());
    expect(recalled.meta.status).toBe("ok");
    expect(recalled.charter.entries.map((h) => h.scope)).not.toContain("agent");
  });
});

describe("approve (§10.4)", () => {
  async function challenger(setupResult: ReturnType<typeof setup>): Promise<{ old: HintRecord; pending: HintRecord }> {
    const { inner, fixture, ref } = setupResult;
    const old = fixture.hints.find((h) => h.slot === "tone") as HintRecord;
    const pending = fixtureHint(ref, {
      id: "h_tone_v2",
      nodePath: "/",
      slot: "tone",
      value: "crisp direct",
      text: "Prefers crisp, direct email drafts.",
      lane: "responseStyle",
      kind: "preference",
      source: "inferred",
      status: "pending",
      supersedes: old.id,
    });
    await inner.applyBatch(ref, [{ op: "upsertHint", hint: pending }]);
    return { old, pending };
  }

  it("approved: retires the superseded hint, activates the challenger as approved, and writes the audit rows", async () => {
    const s = setup();
    const { old, pending } = await challenger(s);
    await s.graph.recall(request());
    await s.graph.approve(s.fixture.subjectId, pending.id, { status: "approved", by: "rm_admin", note: "confirmed" });

    const superseded = await s.inner.getHint(s.ref, old.id);
    expect(superseded).toMatchObject({ status: "superseded", supersededBy: pending.id });
    const approved = await s.inner.getHint(s.ref, pending.id);
    expect(approved).toMatchObject({ status: "active", approval: "approved", needsReview: false, supersedes: old.id });
    expect(approved?.provenance.approval).toMatchObject({ by: "rm_admin", at: new Date(s.clock.now()).toISOString(), note: "confirmed" });

    const audit = await s.inner.listAudit(s.ref, 10);
    expect(audit.find((a) => a.action === "hint.approved")).toMatchObject({ actor: "human:rm_admin", hintId: pending.id, nodePath: "/", detail: { note: "confirmed", supersedes: old.id } });
    expect(audit.find((a) => a.action === "hint.superseded")).toMatchObject({ actor: "human:rm_admin", hintId: old.id, detail: { by: pending.id } });

    const after: Recall = await s.graph.recall(request());
    expect(after.meta.cache).toBe("miss");
    const ids = after.charter.entries.map((h) => h.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(old.id);
    // One batch for the whole decision: the supersession, the approval and both audit rows commit together.
    expect(s.store.calls.filter((c) => c.method === "applyBatch")).toHaveLength(1);
  });

  it("rejected: retires the hint with approval rejected and audits hint.rejected", async () => {
    const s = setup();
    const { old, pending } = await challenger(s);
    await s.graph.approve(s.fixture.subjectId, pending.id, { status: "rejected", by: "rm_admin" });
    expect(await s.inner.getHint(s.ref, pending.id)).toMatchObject({ status: "retired", approval: "rejected", retiredReason: "rejected" });
    expect(await s.inner.getHint(s.ref, old.id)).toMatchObject({ status: "active" });
    const audit = await s.inner.listAudit(s.ref, 10);
    expect(audit.find((a) => a.action === "hint.rejected")).toMatchObject({ actor: "human:rm_admin", hintId: pending.id, detail: {} });
    expect(audit.find((a) => a.action === "hint.superseded")).toBeUndefined();
  });

  it("approving an active hint marks it approved without touching any other row", async () => {
    const s = setup();
    const target = s.fixture.hints.find((h) => h.slot === "disclaimers") as HintRecord;
    await s.graph.approve(s.fixture.subjectId, target.id, { status: "approved", by: "compliance" });
    expect(await s.inner.getHint(s.ref, target.id)).toMatchObject({ status: "active", approval: "approved" });
    const explanation = await s.graph.explain(s.fixture.subjectId);
    const advice = explanation.tree[0]?.children.find((c) => c.node.path === "/consult_advice");
    expect(advice?.hints.find((h) => h.hint.id === target.id)?.why).toContain("approved by compliance");
  });

  it("rejects an unknown hint and a hint that is no longer decidable", async () => {
    const s = setup();
    await expect(s.graph.approve(s.fixture.subjectId, "h_missing", { status: "approved", by: "x" })).rejects.toThrow("not found");
    const retired = s.fixture.hints.find((h) => h.status === "retired") as HintRecord;
    await expect(s.graph.approve(s.fixture.subjectId, retired.id, { status: "approved", by: "x" })).rejects.toThrow("retired");
  });
});

describe("createNoopWisdomGraph (§2.7)", () => {
  it("satisfies WisdomGraph with empty results on every call", async () => {
    const graph: WisdomGraph = createNoopWisdomGraph();
    const result = await graph.recall(request({ requestId: "req_noop" }));
    expect(result.meta).toMatchObject({ requestId: "req_noop", status: "empty", cache: "none" });
    expect(result.charter.entries).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(await graph.refine(result, request())).toBe(result);
    await expect(graph.ingest({ type: "feedback", id: "fb_1", runId: "run_1", subjectId: "rm_42", signal: "up" })).resolves.toEqual({ eventId: "fb_1", status: "recorded" });
    const explanation = await graph.explain("rm_42");
    expect(explanation).toMatchObject({ subjectId: "rm_42", tenantId: null, tree: [], pendingApproval: [], retired: [], recentEvents: [], audit: [] });
    expect(explanation.stats).toEqual({ nodes: 0, activeHints: 0, pending: 0, retired: 0, slots: [] });
    await expect(graph.forget("rm_42")).resolves.toBeUndefined();
    await expect(graph.approve("rm_42", "h_1", { status: "approved", by: "x" })).resolves.toBeUndefined();
    expect(graph.compile(result.charter, "preRoute")).toMatchObject({ text: "", hintIds: [] });
    graph.invalidate();
    await expect(graph.maintenance.drain()).resolves.toEqual({ processed: 0, failed: 0 });
    await expect(graph.maintenance.consolidate("rm_42")).resolves.toMatchObject({ subjectId: "rm_42", usedLlm: false });
    await expect(graph.maintenance.maintain()).resolves.toMatchObject({ examined: 0 });
    await expect(graph.maintenance.warm("rm_42")).resolves.toBeUndefined();
    await graph.flush();
    await graph.close();
    expect(graph.stats()).toMatchObject({ recalls: 1, recallEmpty: 1, ingested: 0 });
  });
});
