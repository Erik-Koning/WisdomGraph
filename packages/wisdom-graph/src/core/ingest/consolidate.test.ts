/**
 * The short-term pass (spec §5.7) through a real engine over the memory
 * store: near-duplicates fold into the survivor with their provenance and
 * counters, supersession chains point at their end, well-used captured
 * hints mature, feedback-beaten inferred hints go, nodes learn the words
 * their hints share, empty nodes are retired, and the subject's counter is
 * reset — by `maintenance.consolidate()` and, unasked, by the ledger once
 * `consolidateEveryEvents` events have landed or a node has overflowed.
 * Every rule is checked on rows read back from the store, and the pass is
 * shown to write nothing the second time.
 */
import { describe, expect, it } from "vitest";
import type { DeepPartial, PolicyConfig } from "../policy";
import { VersionConflictError, type LlmPort, type StoreOp, type SubjectRef } from "../ports";
import type { HintRecord, HintStatus } from "../types";
import { cacheKey } from "../recall/cache";
import { MemoryStore } from "../store/memory";
import { WisdomGraphEngine } from "../engine";
import { CapturingTracer, CollectingLogger, FakeClock, FakeLlm, FaultyStore } from "../../testing/fakes";
import { SIA_CHAIN_IDS, fixtureHint, fixtureNode, fixtureTurn, advisorFixture } from "../../testing/fixtures";
import { CONSOLIDATE_ACTOR, recurringValueWords } from "./consolidate";

const DAY_MS = 86_400_000;
const SUBJECT = "rm_42";

interface SetupOptions {
  policy?: DeepPartial<PolicyConfig>;
  llm?: LlmPort;
  /** A store already loaded with the fixture, when a test needs its own subclass. */
  inner?: MemoryStore;
  clock?: FakeClock;
}

function setup(over: SetupOptions = {}) {
  const clock = over.clock ?? new FakeClock();
  const fixture = advisorFixture({ clock });
  const inner = over.inner ?? fixture.store;
  const store = new FaultyStore(inner);
  const logger = new CollectingLogger();
  const tracer = new CapturingTracer();
  const graph = new WisdomGraphEngine({
    store,
    categories: fixture.categories,
    clock,
    logger,
    tracer,
    ...(over.policy !== undefined ? { policy: over.policy } : {}),
    ...(over.llm !== undefined ? { llm: over.llm } : {}),
  });
  const ref: SubjectRef = { tenantId: null, subjectId: SUBJECT };
  const bySlot = (slot: string): HintRecord => fixture.hints.find((h) => h.slot === slot && h.status === "active") as HintRecord;
  const hint = (id: string) => inner.getHint(ref, id);
  const node = async (path: string) => (await inner.loadSnapshot(ref))?.nodes.find((n) => n.path === path);
  const nodeRow = (path: string) => inner.snapshot().subjects.find((s) => s.subjectId === SUBJECT)?.nodes.find((n) => n.path === path);
  const audit = async (action: string) => (await inner.listAudit(ref, 500)).filter((a) => a.action === action);
  const counter = async () => (await inner.loadSnapshot(ref))?.eventsSinceConsolidation;
  const daysAgo = (days: number): string => new Date(clock.now() - days * DAY_MS).toISOString();
  const consolidate = (opts?: { llm?: boolean }) => graph.maintenance.consolidate(SUBJECT, opts);
  return { graph, inner, store, logger, tracer, clock, fixture, ref, bySlot, hint, node, nodeRow, audit, counter, daysAgo, consolidate };
}

const patch = (hintId: string, p: Extract<StoreOp, { op: "patchHint" }>["patch"]): StoreOp => ({ op: "patchHint", hintId, patch: p });

describe("consolidate(): merging duplicates (§5.7)", () => {
  it("merges Jaccard ≥ 0.8 duplicates on a node into the higher-confidence hint with unioned provenance and summed counters, then writes nothing the second time", async () => {
    const w = setup();
    const a = fixtureHint(
      w.ref,
      {
        id: "h_dup_a", nodePath: "/consult_advice", slot: "answer.length", value: "under 150 words", text: "Keeps answers under 150 words.",
        scope: "category", lane: "responseStyle", kind: "style", source: "inferred", confidence: 0.9, priority: 60, reinforcements: 2, applied: 4,
        provenance: { originEventId: "e1", eventIds: ["e1", "e2"], runIds: ["r1"], extractor: { kind: "llm" } },
        lastReinforcedAt: w.daysAgo(5),
      },
      w.daysAgo(20),
    );
    const b = fixtureHint(
      w.ref,
      {
        id: "h_dup_b", nodePath: "/consult_advice", slot: "length.answers", value: "under 150 words always", text: "Keeps answers under 150 words always.",
        scope: "category", lane: "responseStyle", kind: "style", source: "inferred", confidence: 0.7, priority: 70, reinforcements: 3, applied: 1,
        provenance: { originEventId: "e2", eventIds: ["e2", "e3"], runIds: ["r2"], extractor: { kind: "llm" } },
        lastReinforcedAt: w.daysAgo(1), lastAppliedAt: w.daysAgo(2),
      },
      w.daysAgo(10),
    );
    await w.inner.applyBatch(w.ref, [{ op: "upsertHint", hint: a }, { op: "upsertHint", hint: b }]);

    const report = await w.consolidate();
    // Merges run before promotions: the survivor's summed reinforcements are what promote it.
    expect(report).toMatchObject({ subjectId: SUBJECT, merged: 1, promoted: 1, retired: 0, opsRejected: 0, usedLlm: false });
    expect(await w.hint(b.id)).toMatchObject({ status: "retired", retiredReason: "merged" });
    const survivor = await w.hint(a.id);
    expect(survivor).toMatchObject({
      status: "active",
      confidence: 0.9,
      priority: 70,
      reinforcements: 5,
      applied: 5,
      maturity: "consolidated",
      lastReinforcedAt: b.lastReinforcedAt,
      lastAppliedAt: b.lastAppliedAt,
    });
    expect(survivor?.provenance).toMatchObject({ originEventId: "e1", eventIds: ["e1", "e2", "e3"], runIds: ["r1", "r2"] });
    // The two rows were upserted without touching the node's count; the pass recounts from what the node will hold.
    expect((await w.node("/consult_advice"))?.stats.activeHints).toBe(4);
    const merged = await w.audit("hint.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ actor: CONSOLIDATE_ACTOR, hintId: a.id, nodePath: "/consult_advice", detail: { merged: b.id, reinforcements: 5 } });
    expect((await w.audit("hint.retired"))[0]).toMatchObject({ actor: CONSOLIDATE_ACTOR, hintId: b.id, detail: { reason: "merged", into: a.id } });

    const again = await w.consolidate();
    expect(again).toMatchObject({ merged: 0, promoted: 0, retired: 0, opsAccepted: 0 });
    expect(await w.hint(a.id)).toEqual(survivor);
    expect(await w.audit("hint.merged")).toHaveLength(1);
  });

  it("treats one slot+value at global and category scope on one node as a duplicate and keeps the narrower scope; texts below the threshold stay apart", async () => {
    const w = setup();
    const narrow = w.bySlot("jargon"); // category, inferred, 0.6
    const wide = fixtureHint(w.ref, {
      id: "h_jargon_global", nodePath: "/consult_advice", slot: "jargon", value: "plain english", text: "Uses plain English throughout.",
      scope: "global", lane: "responseStyle", kind: "style", source: "inferred", confidence: 0.95, reinforcements: 1,
    });
    // 0.71 with `summary.actions` on the same node: kept.
    const recap = fixtureHint(w.ref, {
      id: "h_recap", nodePath: "/consult_meetings", slot: "recap.actions", value: "three items", text: "Limits meeting recaps to three action items.",
      scope: "agent", agent: "consult_meetings", kind: "constraint",
    });
    await w.inner.applyBatch(w.ref, [{ op: "upsertHint", hint: wide }, { op: "upsertHint", hint: recap }]);

    expect(await w.consolidate()).toMatchObject({ merged: 1 });
    expect(await w.hint(wide.id)).toMatchObject({ status: "retired", retiredReason: "merged" });
    expect(await w.hint(narrow.id)).toMatchObject({ status: "active", scope: "category", confidence: 0.95, reinforcements: 1 });
    expect(await w.hint(recap.id)).toMatchObject({ status: "active" });
    expect(await w.hint(w.bySlot("summary.actions").id)).toMatchObject({ status: "active" });
  });

  it("never merges two approved hints, and keeps the approved or human-stated copy when one is", async () => {
    const w = setup();
    const approvedA = fixtureHint(w.ref, { id: "h_app_a", nodePath: "/consult_kyp", slot: "kyp.a", value: "a", text: "Keeps answers under 150 words.", scope: "category", approval: "approved", confidence: 0.5 });
    const approvedB = fixtureHint(w.ref, { id: "h_app_b", nodePath: "/consult_kyp", slot: "kyp.b", value: "b", text: "Keeps answers under 150 words always.", scope: "category", approval: "approved", confidence: 0.9 });
    const inferred = fixtureHint(w.ref, { id: "h_inf", nodePath: "/consult_newsroom", slot: "news.a", value: "a", text: "Keeps answers under 150 words.", scope: "category", source: "inferred", confidence: 0.99 });
    const explicit = fixtureHint(w.ref, { id: "h_exp", nodePath: "/consult_newsroom", slot: "news.b", value: "b", text: "Keeps answers under 150 words always.", scope: "category", source: "explicit", confidence: 0.5 });
    await w.inner.applyBatch(w.ref, [approvedA, approvedB, inferred, explicit].map((hint) => ({ op: "upsertHint", hint }) as const));

    expect(await w.consolidate()).toMatchObject({ merged: 1 });
    expect(await w.hint(approvedA.id)).toMatchObject({ status: "active" });
    expect(await w.hint(approvedB.id)).toMatchObject({ status: "active" });
    expect(await w.hint(inferred.id)).toMatchObject({ status: "retired", retiredReason: "merged" });
    expect(await w.hint(explicit.id)).toMatchObject({ status: "active", confidence: 0.99 });
  });
});

describe("consolidate(): promotion, retirement, chains, keywords, node GC", () => {
  it("promotes captured hints with applied ≥ consolidatedMinApplied or reinforcements ≥ 1 to consolidated", async () => {
    const w = setup();
    const length = w.bySlot("format.length");
    const holdings = w.bySlot("routing.holdings");
    const tone = w.bySlot("tone");
    await w.inner.applyBatch(w.ref, [patch(length.id, { applied: { add: 3 } }), patch(holdings.id, { reinforcements: { add: 1 } }), patch(tone.id, { applied: { add: 2 } })]);

    expect(await w.consolidate()).toMatchObject({ promoted: 2, merged: 0, retired: 0 });
    expect((await w.hint(length.id))?.maturity).toBe("consolidated");
    expect((await w.hint(holdings.id))?.maturity).toBe("consolidated");
    expect((await w.hint(tone.id))?.maturity).toBe("captured");
    const promoted = await w.audit("hint.promoted");
    expect(promoted.map((a) => a.hintId).sort()).toEqual([length.id, holdings.id].sort());
    expect(promoted[0]).toMatchObject({ actor: CONSOLIDATE_ACTOR, detail: { from: "captured", to: "consolidated" } });

    // The threshold is the policy's.
    const lenient = setup({ policy: { promotion: { consolidatedMinApplied: 2 } } });
    await lenient.inner.applyBatch(lenient.ref, [patch(lenient.bySlot("tone").id, { applied: { add: 2 } })]);
    expect(await lenient.consolidate()).toMatchObject({ promoted: 1 });
    expect((await lenient.hint(lenient.bySlot("tone").id))?.maturity).toBe("consolidated");
  });

  it("retires inferred hints whose confidence fell below retireConfidenceBelow and leaves explicit ones to a human", async () => {
    const w = setup();
    const tone = w.bySlot("tone"); // inferred
    const timing = w.bySlot("cpp_oas.timing"); // explicit
    const rootBefore = (await w.node("/"))?.stats.activeHints ?? 0;
    await w.inner.applyBatch(w.ref, [patch(tone.id, { confidence: 0.2 }), patch(timing.id, { confidence: 0.2 })]);

    expect(await w.consolidate()).toMatchObject({ retired: 1, merged: 0 });
    expect(await w.hint(tone.id)).toMatchObject({ status: "retired", retiredReason: "feedback" });
    expect(await w.hint(timing.id)).toMatchObject({ status: "active", confidence: 0.2 });
    expect((await w.audit("hint.retired"))[0]).toMatchObject({ actor: CONSOLIDATE_ACTOR, hintId: tone.id, nodePath: "/", detail: { reason: "feedback", confidence: 0.2, below: 0.3 } });
    expect((await w.node("/"))?.stats.activeHints).toBe(rootBefore - 1);

    // Every inferred active hint under a raised floor goes; the explicit ones never do.
    const strict = setup({ policy: { feedback: { retireConfidenceBelow: 0.7 } } });
    const inferredBelow = strict.fixture.hints.filter((h) => h.status === "active" && h.source === "inferred" && h.approval !== "approved" && h.confidence < 0.7);
    expect(inferredBelow.length).toBeGreaterThan(1);
    expect(await strict.consolidate()).toMatchObject({ retired: inferredBelow.length });
    for (const h of inferredBelow) expect((await strict.hint(h.id))?.status).toBe("retired");
    for (const h of strict.fixture.hints.filter((x) => x.status === "active" && x.source === "explicit")) expect((await strict.hint(h.id))?.status).toBe("active");
  });

  it("folds supersession chains so every superseded row points at the chain's end", async () => {
    const w = setup();
    const v2 = w.bySlot("format.length");
    const v3 = fixtureHint(w.ref, { id: "h_length_v3", nodePath: "/", slot: "format.length", value: "under 100 words", text: "Keeps answers under 100 words.", lane: "responseStyle", kind: "style", supersedes: v2.id });
    await w.inner.applyBatch(w.ref, [patch(v2.id, { status: "superseded", supersededBy: v3.id }), { op: "upsertHint", hint: v3 }]);

    await w.consolidate();
    expect(await w.hint(SIA_CHAIN_IDS.superseded)).toMatchObject({ status: "superseded", supersededBy: v3.id });
    expect(await w.hint(v2.id)).toMatchObject({ status: "superseded", supersededBy: v3.id });
    expect(await w.hint(v3.id)).toMatchObject({ status: "active", supersedes: v2.id });
    const folded = await w.audit("hint.folded");
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ actor: CONSOLIDATE_ACTOR, hintId: SIA_CHAIN_IDS.superseded, detail: { from: v2.id, to: v3.id } });
    expect(w.logger.find({ msg: "consolidate.done" })[0]?.obj).toMatchObject({ folded: 1 });

    await w.consolidate();
    expect(await w.audit("hint.folded")).toHaveLength(1);
    expect(w.logger.find({ msg: "consolidate.done" })[1]?.obj).toMatchObject({ folded: 0 });
  });

  it("teaches a node the words that recur across its hints' values, once", async () => {
    const w = setup();
    const before = (await w.node("/consult_advice/retirement"))?.keywords ?? [];
    await w.consolidate();
    // "25 years" and "15 years" share a word the node did not know; "always mention" is one hint's and is not learned.
    const after = (await w.node("/consult_advice/retirement"))?.keywords;
    expect(after).toEqual([...before, "years"]);
    expect(after).not.toContain("mention");
    expect((await w.audit("node.keywords"))[0]).toMatchObject({ actor: CONSOLIDATE_ACTOR, nodePath: "/consult_advice/retirement", detail: { added: ["years"] } });

    await w.consolidate();
    expect((await w.node("/consult_advice/retirement"))?.keywords).toEqual(after);
    expect(await w.audit("node.keywords")).toHaveLength(1);

    // The rule itself: recurrence across distinct values, stems compared, known keywords and stopwords skipped, most recurrent first.
    const node = fixtureNode(w.ref, "/consult_kyp/x", { keywords: ["english"] });
    expect(recurringValueWords(node, ["plain english", "plain text only", "english only", "plainly said"])).toEqual(["plain"]);
    expect(recurringValueWords(fixtureNode(w.ref, "/consult_kyp/y"), ["plain english", "plain text", "english only"])).toEqual(["english", "plain"]);
  });

  it("retires empty, childless, unlocked nodes older than nodeGcDays and leaves the rest", async () => {
    const w = setup();
    const gics = fixtureHint(w.ref, { nodePath: "/consult_kyp/gics", slot: "gic.term", value: "laddered", text: "Prefers laddered GICs for short-term cash.", scope: "category", status: "pending" });
    await w.inner.applyBatch(w.ref, [
      { op: "upsertNode", node: fixtureNode(w.ref, "/consult_kyp/etfs", { title: "ETFs" }, w.daysAgo(40)) },
      { op: "upsertNode", node: fixtureNode(w.ref, "/consult_kyp/bonds", { title: "Bonds" }, w.daysAgo(10)) },
      { op: "upsertNode", node: fixtureNode(w.ref, "/consult_kyp/gics", { title: "GICs" }, w.daysAgo(40)) },
      { op: "upsertNode", node: fixtureNode(w.ref, "/consult_kyp/old", { title: "Old" }, w.daysAgo(40)) },
      { op: "upsertNode", node: fixtureNode(w.ref, "/consult_kyp/old/child", { title: "Old child" }, w.daysAgo(40)) },
      { op: "upsertHint", hint: gics },
    ]);

    await w.consolidate();
    expect(w.logger.find({ msg: "consolidate.done" })[0]?.obj).toMatchObject({ nodesRetired: 3 });
    // Deepest first: the child goes, and its parent is then judged empty on its own age.
    for (const path of ["/consult_kyp/etfs", "/consult_kyp/old/child", "/consult_kyp/old"]) expect(w.nodeRow(path)?.status).toBe("retired");
    for (const path of ["/consult_kyp/bonds", "/consult_kyp/gics", "/consult_knowledge", "/consult_kyp"]) expect(w.nodeRow(path)?.status).toBe("active");
    expect((await w.audit("node.retired")).map((a) => a.nodePath).sort()).toEqual(["/consult_kyp/etfs", "/consult_kyp/old", "/consult_kyp/old/child"]);
    expect((await w.audit("node.retired"))[0]).toMatchObject({ actor: CONSOLIDATE_ACTOR, detail: { reason: "empty", nodeGcDays: 30 } });
    // A retired node is no longer loaded for recall or ingest.
    expect((await w.inner.loadSnapshot(w.ref))?.nodes.map((n) => n.path)).not.toContain("/consult_kyp/etfs");

    const eager = setup({ policy: { ingest: { nodeGcDays: 5 } } });
    await eager.inner.applyBatch(eager.ref, [{ op: "upsertNode", node: fixtureNode(eager.ref, "/consult_kyp/bonds", { title: "Bonds" }, eager.daysAgo(10)) }]);
    await eager.consolidate();
    expect(eager.nodeRow("/consult_kyp/bonds")?.status).toBe("retired");
  });
});

describe("consolidate(): the counter, the report and the triggers", () => {
  it("resets the subject's counter, reports the pass, logs consolidate.done and ends its span; a subject with no rows gets nothing written", async () => {
    const w = setup();
    expect(await w.counter()).toBe(3);
    const report = await w.consolidate();
    // The fixture is tidy: nothing to merge, promote or retire; the one graph op teaches /consult_advice/retirement the word its hints share.
    expect(report).toEqual({ subjectId: SUBJECT, merged: 0, promoted: 0, retired: 0, opsAccepted: 1, opsRejected: 0, usedLlm: false });
    expect(await w.counter()).toBe(0);
    expect(w.inner.snapshot().subjects.find((s) => s.subjectId === SUBJECT)?.lastConsolidatedAt).toBe(w.clock.iso());
    const done = w.logger.find({ level: "info", msg: "consolidate.done" });
    expect(done).toHaveLength(1);
    expect(done[0]?.obj).toMatchObject({ lib: "wisdom-graph", op: "consolidate", tenantId: null, subjectId: SUBJECT, merged: 0, promoted: 0, retired: 0, opsAccepted: 1, folded: 0, nodesRetired: 0, usedLlm: false, elapsedMs: 0 });
    const span = w.tracer.named("wisdom.consolidate")[0];
    expect(span).toMatchObject({ ended: true, attrs: { "wisdom.merged": 0, "wisdom.promoted": 0, "wisdom.retired": 0, "wisdom.ops_accepted": 1, "wisdom.used_llm": false, "wisdom.elapsed_ms": 0 } });
    // The next recall reloads: the pass invalidated the subject.
    expect((await w.graph.recall({ subjectId: SUBJECT, text: "RRIF withdrawals", budgetMs: 1_000 })).meta.cache).toBe("miss");

    const writes = w.store.calls.length;
    expect(await w.graph.maintenance.consolidate("rm_nobody")).toEqual({ subjectId: "rm_nobody", merged: 0, promoted: 0, retired: 0, opsAccepted: 0, opsRejected: 0, usedLlm: false });
    expect(w.store.calls.slice(writes).map((c) => c.method)).toEqual(["loadSnapshot"]);
    expect(await w.inner.loadSnapshot({ tenantId: null, subjectId: "rm_nobody" })).toBeNull();
    // A name with no rows is not a subject a nameless maintain() should keep sweeping; the one with rows is.
    expect(w.graph.ctx.subjects.has("rm_nobody")).toBe(false);
    expect(w.graph.ctx.subjects.has(SUBJECT)).toBe(true);
    const sweep = w.store.calls.length;
    await w.graph.maintenance.maintain();
    expect(w.store.calls.slice(sweep).filter((c) => c.method === "loadSnapshot")).toHaveLength(1);
  });

  it("runs by itself, inside the ingest lane, once consolidateEveryEvents events have landed for the subject", async () => {
    const w = setup({ policy: { ingest: { consolidateEveryEvents: 4 } } });
    const turn = (id: string) => fixtureTurn(SUBJECT, id, { userText: "hello", assistantText: "hi" });
    // The fixture's counter stands at 3: this event is the fourth.
    await expect(w.graph.ingest(turn("turn_1"), { waitFor: "processed" })).resolves.toEqual({ eventId: "turn_1", status: "processed" });
    expect(await w.counter()).toBe(0);
    expect(w.logger.find({ msg: "consolidate.due" })[0]?.obj).toMatchObject({ eventId: "turn_1", counter: 4, overflow: [] });
    expect(w.logger.find({ msg: "consolidate.done" })).toHaveLength(1);
    expect((await w.inner.getEvent(null, "turn_1"))?.status).toBe("done");

    for (const id of ["turn_2", "turn_3", "turn_4"]) await w.graph.ingest(turn(id), { waitFor: "processed" });
    expect(await w.counter()).toBe(3);
    expect(w.logger.find({ msg: "consolidate.done" })).toHaveLength(1);
    await w.graph.ingest(turn("turn_5"), { waitFor: "processed" });
    expect(await w.counter()).toBe(0);
    expect(w.logger.find({ msg: "consolidate.done" })).toHaveLength(2);

    // Feedback counts too.
    for (const id of ["fb_1", "fb_2", "fb_3"]) await w.graph.ingest({ type: "feedback", id, runId: "run_7", subjectId: SUBJECT, signal: "up" }, { waitFor: "processed" });
    expect(await w.counter()).toBe(3);
    await w.graph.ingest({ type: "feedback", id: "fb_4", runId: "run_7", subjectId: SUBJECT, signal: "up" }, { waitFor: "processed" });
    expect(await w.counter()).toBe(0);
    expect(w.logger.find({ msg: "consolidate.done" })).toHaveLength(3);

    // The default period is 20; a non-positive one disables the counter trigger.
    const quiet = setup();
    await quiet.graph.ingest(turn("turn_q"), { waitFor: "processed" });
    expect(await quiet.counter()).toBe(4);
    expect(quiet.logger.find({ msg: "consolidate.done" })).toEqual([]);
    const off = setup({ policy: { ingest: { consolidateEveryEvents: 0 } } });
    for (const id of ["a", "b", "c", "d", "e"]) await off.graph.ingest(turn(`turn_${id}`), { waitFor: "processed" });
    expect(await off.counter()).toBe(8);
    expect(off.logger.find({ msg: "consolidate.due" })).toEqual([]);
  });

  it("runs by itself when an extraction leaves a node over maxActiveHintsPerNode, and remembers the node for the model pass", async () => {
    const llm = new FakeLlm([
      {
        purpose: "extract",
        reply: {
          ops: [
            { op: "add_hint", nodePath: "/consult_advice", slot: "format.headline", value: "short headline", text: "Likes a short headline before the detail.", kind: "style", lane: "responseStyle", scope: "category", priority: 60, confidence: 0.7, rationale: "r" },
          ],
        },
      },
    ]);
    const w = setup({ llm, policy: { caps: { maxActiveHintsPerNode: 3 } } });
    expect((await w.node("/consult_advice"))?.stats.activeHints).toBe(3);
    await w.graph.ingest(fixtureTurn(SUBJECT, "turn_over"), { waitFor: "processed" });
    expect(llm.calls).toHaveLength(1);
    expect((await w.node("/consult_advice"))?.stats.activeHints).toBe(4);
    expect(w.logger.find({ msg: "consolidate.due" })[0]?.obj).toMatchObject({ eventId: "turn_over", counter: 4, overflow: ["/consult_advice"] });
    expect(w.logger.find({ msg: "consolidate.done" })).toHaveLength(1);
    expect(await w.counter()).toBe(0);
    // The ingest trigger runs the rule pass only; the overflow waits for the model pass.
    expect(w.graph.ctx.flagged.get(cacheKey(w.ref))).toEqual(new Set(["/consult_advice"]));
    expect(w.logger.find({ msg: "consolidate.done" })[0]?.obj).toMatchObject({ usedLlm: false });
  });

  it("a pass that fails after an event is logged and never fails the event", async () => {
    class PassFailingStore extends MemoryStore {
      failPassLoads = 0;
      override async loadSnapshot(ref: SubjectRef, opts?: { signal?: AbortSignal; statuses?: HintStatus[] }) {
        // Only the passes load retired rows; the ingest lane's own loads go through.
        if (this.failPassLoads > 0 && opts?.statuses?.includes("retired")) {
          this.failPassLoads -= 1;
          throw new Error("pass load failed");
        }
        return super.loadSnapshot(ref, opts);
      }
    }
    const clock = new FakeClock();
    const inner = new PassFailingStore({ clock });
    inner.load(advisorFixture({ clock }).store.snapshot());
    const w = setup({ inner, clock, policy: { ingest: { consolidateEveryEvents: 4 } } });
    inner.failPassLoads = 1;
    await expect(w.graph.ingest(fixtureTurn(SUBJECT, "turn_1", { userText: "hello", assistantText: "hi" }), { waitFor: "processed" })).resolves.toEqual({ eventId: "turn_1", status: "processed" });
    expect((await w.inner.getEvent(null, "turn_1"))?.status).toBe("done");
    expect(w.logger.find({ level: "error", msg: "consolidate.error" })[0]?.obj).toMatchObject({ eventId: "turn_1", error: "Error: pass load failed" });
    expect(await w.counter()).toBe(4);
    // Called directly, the same failure is the caller's.
    inner.failPassLoads = 1;
    await expect(w.consolidate()).rejects.toThrow("pass load failed");
    expect(w.tracer.named("wisdom.consolidate").at(-1)).toMatchObject({ ended: true, exceptions: [expect.any(Error)] });
  });

  it("a version conflict re-plans against a fresh load and applies once more; a second conflict propagates", async () => {
    class RacingStore extends MemoryStore {
      races = 0;
      override async applyBatch(ref: SubjectRef, ops: StoreOp[], opts?: { expectVersion?: number; signal?: AbortSignal }) {
        if (this.races > 0 && opts?.expectVersion !== undefined) {
          this.races -= 1;
          // Another writer lands first: the subject's version moves under the pass.
          await super.applyBatch(ref, [{ op: "consolidationCounter", action: "increment" }]);
        }
        return super.applyBatch(ref, ops, opts);
      }
    }
    const clock = new FakeClock();
    const inner = new RacingStore({ clock });
    inner.load(advisorFixture({ clock }).store.snapshot());
    const w = setup({ inner, clock });
    inner.races = 1;
    expect(await w.consolidate()).toMatchObject({ opsAccepted: 1 });
    expect(w.store.calls.filter((c) => c.method === "applyBatch")).toHaveLength(2);
    expect(w.store.calls.filter((c) => c.method === "loadSnapshot")).toHaveLength(2);
    expect(await w.counter()).toBe(0);
    expect((await w.node("/consult_advice/retirement"))?.keywords).toContain("years");

    inner.races = 2;
    await expect(w.consolidate()).rejects.toBeInstanceOf(VersionConflictError);
  });
});
