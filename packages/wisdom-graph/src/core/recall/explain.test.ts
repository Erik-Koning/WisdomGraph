/**
 * `explain()` is the human-facing view, so it is checked for what a viewer
 * reads: the nested tree, the `why` sentences, the pending and retired
 * lists, the ledger and audit tails, and a dry-run trace that must equal a
 * real recall on the same rows — the one place a divergence between the
 * viewer and the hot path would be invisible otherwise.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy } from "../policy";
import type { EngineStats, HintRecord } from "../types";
import { CapturingTracer, CollectingLogger, FakeClock } from "../../testing/fakes";
import { SIA_CHAIN_IDS, advisorFixture } from "../../testing/fixtures";
import { LruMap, SnapshotCache } from "./cache";
import { recall, type RecallContext } from "./recall";
import { explain, whyOf } from "./explain";

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

function harness(over: Partial<RecallContext> = {}) {
  const clock = new FakeClock();
  const fixture = advisorFixture({ clock });
  const logger = new CollectingLogger();
  const ctx: RecallContext = {
    store: fixture.store,
    policy: defaultPolicy,
    categories: fixture.categories,
    tenantId: null,
    sharedSubjectId: fixture.sharedSubjectId,
    cache: new SnapshotCache({ clock, logger }),
    clock,
    logger,
    tracer: new CapturingTracer(),
    queryVectors: new LruMap<number[]>(256),
    stats: zeroStats(),
    ...over,
  };
  return { ctx, fixture, clock, logger };
}

const bySlot = (hints: readonly HintRecord[], slot: string): HintRecord => {
  const found = hints.find((h) => h.slot === slot);
  if (!found) throw new Error(`no fixture hint for slot ${slot}`);
  return found;
};

describe("explain() — tree and lists (§10.3)", () => {
  it("nests the active nodes from '/' with children in path order and every node's live hints", async () => {
    const { ctx, fixture } = harness();
    const explanation = await explain(ctx, fixture.subjectId);
    expect(explanation.subjectId).toBe(fixture.subjectId);
    expect(explanation.tenantId).toBeNull();
    expect(explanation.generatedAt).toBe(new Date(ctx.clock.now()).toISOString());
    expect(explanation.tree).toHaveLength(1);
    const root = explanation.tree[0];
    expect(root?.node.path).toBe("/");
    expect("virtual" in (root?.node ?? {})).toBe(false);
    const categories = root?.children.map((c) => c.node.path) ?? [];
    expect(categories).toEqual([...categories].sort());
    expect(categories).toHaveLength(8);
    const advice = root?.children.find((c) => c.node.path === "/consult_advice");
    expect(advice?.children.map((c) => c.node.path)).toEqual(["/consult_advice/reporting", "/consult_advice/retirement"]);
    const retirement = advice?.children.find((c) => c.node.path === "/consult_advice/retirement");
    expect(retirement?.children.map((c) => c.node.path)).toEqual(["/consult_advice/retirement/withdrawals"]);
    expect(advice?.hints.map((h) => h.hint.slot).sort()).toEqual(["disclaimers", "disclosure.fees", "jargon"]);
    expect(root?.hints.every((h) => h.hint.status === "active")).toBe(true);
    expect(root?.hints.map((h) => h.hint.slot)).not.toContain("format.emoji");
  });

  it("lists pending hints apart, retired and superseded ones only with includeRetired, and counts them in stats", async () => {
    const { ctx, fixture } = harness();
    const plain = await explain(ctx, fixture.subjectId);
    expect(plain.pendingApproval.map((h) => h.hint.slot)).toEqual(["index.default"]);
    expect(plain.retired).toEqual([]);
    const activeHints = fixture.hints.filter((h) => h.status === "active").length;
    expect(plain.stats).toMatchObject({ nodes: 15, activeHints, pending: 1, retired: 2 });
    expect(plain.stats.slots).toEqual([...new Set(fixture.hints.filter((h) => h.status === "active").map((h) => h.slot))].sort());

    const full = await explain(ctx, fixture.subjectId, { includeRetired: true });
    expect(full.retired.map((h) => h.hint.id).sort()).toEqual([SIA_CHAIN_IDS.superseded, bySlot(fixture.hints, "format.emoji").id].sort());
    const superseded = full.retired.find((h) => h.hint.id === SIA_CHAIN_IDS.superseded);
    expect(superseded?.why).toContain(`superseded by ${SIA_CHAIN_IDS.active}`);
    const decayed = full.retired.find((h) => h.hint.slot === "format.emoji");
    expect(decayed?.why).toContain("retired (decayed)");
  });

  it("restricts the tree to topicPath and returns no tree for an unknown path", async () => {
    const { ctx, fixture } = harness();
    const scoped = await explain(ctx, fixture.subjectId, { topicPath: "/consult_advice" });
    expect(scoped.tree.map((n) => n.node.path)).toEqual(["/consult_advice"]);
    expect(scoped.tree[0]?.children).toHaveLength(2);
    const none = await explain(ctx, fixture.subjectId, { topicPath: "/nowhere" });
    expect(none.tree).toEqual([]);
  });

  it("shows the recent ledger and the audit tail, newest first", async () => {
    const { ctx, fixture } = harness();
    const explanation = await explain(ctx, fixture.subjectId);
    expect(explanation.recentEvents).toEqual([{ id: "turn_run_7", kind: "turn", runId: "run_7", at: expect.any(String), status: "done", accepted: 1, rejected: 0 }]);
    expect(explanation.audit.map((a) => a.id)).toEqual(["audit_2", "audit_1"]);
  });

  it("marks events whose text retention has scrubbed (§10.4) and leaves the rest unmarked", async () => {
    const { ctx, fixture } = harness();
    const ref = { tenantId: null, subjectId: fixture.subjectId };
    expect(await fixture.store.scrubEvents(ref, {})).toBe(1);
    const explanation = await explain(ctx, fixture.subjectId);
    expect(explanation.recentEvents).toHaveLength(1);
    expect(explanation.recentEvents[0]).toMatchObject({ id: "turn_run_7", status: "done", scrubbedAt: expect.any(String) });
    expect((await explain(ctx, "rm_new")).recentEvents).toEqual([]);
  });

  it("reads the store directly with every status and never through the cache", async () => {
    const { ctx, fixture } = harness();
    await explain(ctx, fixture.subjectId);
    expect(ctx.cache.has({ tenantId: null, subjectId: fixture.subjectId })).toBe(false);
  });

  it("works for a subject with no rows: the virtual tree to browse, and stats that count nothing stored", async () => {
    const { ctx } = harness();
    const explanation = await explain(ctx, "rm_new");
    expect(explanation.tree[0]?.children).toHaveLength(8);
    expect(explanation.stats).toEqual({ nodes: 0, activeHints: 0, pending: 0, retired: 0, slots: [] });
    expect(explanation.recentEvents).toEqual([]);
    expect(explanation.audit).toEqual([]);
  });
});

describe("explain() — why strings and suppression", () => {
  it("renders the §10.3 sentence: source · scope · approval · counts · decay", async () => {
    const { ctx, fixture } = harness();
    const explanation = await explain(ctx, fixture.subjectId);
    const advice = explanation.tree[0]?.children.find((c) => c.node.path === "/consult_advice");
    const disclaimers = advice?.hints.find((h) => h.hint.slot === "disclaimers");
    expect(disclaimers?.why).toMatch(/^explicit · agent-scoped \(consult_advice\) · auto · reinforced 3× · applied 17× · decay \d\.\d\d$/);
    expect(disclaimers?.decayWeight).toBeGreaterThan(0.9);
    expect(disclaimers?.effectiveScore).toBeCloseTo(0.82 * 0.9 * (disclaimers?.decayWeight ?? 0) * 0.9 * 1, 10);

    const region = explanation.tree[0]?.hints.find((h) => h.hint.slot === "region.default");
    const approvedAt = region?.hint.provenance.approval?.at.slice(0, 10);
    expect(region?.why).toBe(`explicit · global · approved by rm_admin on ${approvedAt} · reinforced 4× · applied 30× · decay 1.00`);
    expect(region?.decayWeight).toBe(1);

    const review = advice?.hints.find((h) => h.hint.slot === "disclosure.fees");
    expect(review?.why).toContain("needs review");
    const pending = explanation.pendingApproval[0];
    expect(pending?.why).toContain("inferred · category-scoped (/consult_market_analyst/canada) · auto · pending");
  });

  it("names the winner of a slot conflict for the client being explained, and no conflict otherwise", async () => {
    const { ctx, fixture } = harness();
    const forClient = await explain(ctx, fixture.subjectId, { clientId: "client_A" });
    const retirement = forClient.tree[0]?.children.find((c) => c.node.path === "/consult_advice")?.children.find((c) => c.node.path === "/consult_advice/retirement");
    const category = retirement?.hints.find((h) => h.hint.scope === "category" && h.hint.slot === "horizon.default");
    const client = retirement?.hints.find((h) => h.hint.scope === "client" && h.hint.slot === "horizon.default");
    expect(client?.suppressedBy).toBeNull();
    expect(category?.suppressedBy).toEqual({ hintId: client?.hint.id, rule: "scope" });
    expect(category?.why).toContain(`suppressed by ${client?.hint.id} (scope)`);
    expect(client?.why).toContain("client-scoped (client_A)");

    const anyone = await explain(ctx, fixture.subjectId);
    const again = anyone.tree[0]?.children.find((c) => c.node.path === "/consult_advice")?.children.find((c) => c.node.path === "/consult_advice/retirement");
    expect(again?.hints.find((h) => h.hint.scope === "category" && h.hint.slot === "horizon.default")?.suppressedBy).toBeNull();
  });

  it("whyOf covers every lifecycle wording", () => {
    const { fixture } = harness();
    const base = bySlot(fixture.hints, "tone");
    expect(whyOf({ ...base, status: "pending", supersedes: "h_old" }, 0.5, null)).toContain("pending (challenges h_old)");
    expect(whyOf({ ...base, status: "retired" }, 0.5, null)).toContain(" · retired · ");
    expect(whyOf({ ...base, status: "superseded" }, 0.5, null)).toContain(" · superseded · ");
    expect(whyOf({ ...base, approval: "rejected" }, 0.5, null)).toContain(" · rejected · ");
    expect(whyOf({ ...base, approval: "approved" }, 0.5, null)).toContain(" · approved · ");
    expect(whyOf({ ...base, scope: "client", clientId: "c9" }, 0.5, { hintId: "h_w", rule: "approval" })).toMatch(/client-scoped \(c9\).*suppressed by h_w \(approval\)$/);
  });
});

describe("explain() — dry-run trace", () => {
  it("attaches a trace whose recall equals a real recall on the same snapshot", async () => {
    const { ctx, fixture } = harness();
    const explanation = await explain(ctx, fixture.subjectId, { text: RETIREMENT, clientId: "client_A" });
    const trace = explanation.trace;
    expect(trace).toBeDefined();
    const real = await recall(ctx, { subjectId: fixture.subjectId, clientId: "client_A", text: RETIREMENT, budgetMs: 1_000 });
    expect(real.meta.status).toBe("ok");
    expect(trace?.topic).toEqual(real.topic);
    expect(trace?.recall.topic).toEqual(real.topic);
    expect(trace?.recall.charter).toEqual(real.charter);
    expect(trace?.recall.preRoute).toEqual(real.preRoute);
    expect(trace?.recall.agentHints).toEqual(real.agentHints);
    expect(trace?.recall.responseStyle).toEqual(real.responseStyle);
    expect(trace?.recall.provenance).toEqual(real.provenance);
    expect(trace?.recall.meta).toMatchObject({ status: "ok", cache: "none", refined: false, classifier: real.meta.classifier });
    expect(trace?.candidates.length).toBeGreaterThan(0);
    const outcomes = new Set(trace?.candidates.map((c) => c.outcome));
    expect(outcomes.has("kept")).toBe(true);
    expect(trace?.candidates.filter((c) => c.outcome === "kept").map((c) => c.hintId).sort()).toEqual([...real.provenance].sort());
    expect(trace?.candidates.filter((c) => c.outcome === "suppressed").map((c) => c.hintId).sort()).toEqual(real.charter.suppressed.map((s) => s.hintId).sort());
    for (const candidate of trace?.candidates ?? []) {
      if (candidate.outcome === "suppressed") expect(candidate.rule).toBeDefined();
      if (candidate.outcome === "dropped") expect(candidate.reason).toBeDefined();
    }
  });

  it("does not remember the dry run as the subject's topic", async () => {
    const { ctx, fixture } = harness();
    await explain(ctx, fixture.subjectId, { text: RETIREMENT });
    expect(ctx.cache.recentPaths({ tenantId: null, subjectId: fixture.subjectId })).toEqual([]);
  });

  it("omits the trace when no text is given", async () => {
    const { ctx, fixture } = harness();
    const explanation = await explain(ctx, fixture.subjectId);
    expect("trace" in explanation).toBe(false);
  });
});
