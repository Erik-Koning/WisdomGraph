/**
 * Crash idempotency (spec §5.2, decision 12) through a real engine: an
 * event whose batch lands but whose `done` mark fails is run again on the
 * backoff schedule, reuses the proposal persisted on its row (the model is
 * not called twice), and leaves the store exactly as one clean run would
 * — deterministic ids, true upserts, and patches that recognise the event
 * they already carry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deterministicId } from "../ids";
import type { StoredEventPatch, SubjectRef } from "../ports";
import type { HintRecord, TopicNode, TurnEvent } from "../types";
import type { Proposal } from "../schema/proposal";
import { MemoryStore, type MemoryStoreSnapshot } from "../store/memory";
import { WisdomGraphEngine } from "../engine";
import { CollectingLogger, FakeClock, FakeLlm } from "../../testing/fakes";
import { fixtureFeedback, fixtureTurn, advisorFixture } from "../../testing/fixtures";
import { unparseableProposal } from "./extract";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const GATED = "Stop adding disclaimers please, and always use bullets.";

/** A memory store whose next `done` mark fails once: the crash between `applyBatch` and `updateEvent(done)`. */
class CrashingStore extends MemoryStore {
  crashOnDone = false;
  override async updateEvent(tenantId: string | null, id: string, patch: StoredEventPatch): Promise<void> {
    if (this.crashOnDone && patch.status === "done") {
      this.crashOnDone = false;
      throw new Error("crashed after apply");
    }
    return super.updateEvent(tenantId, id, patch);
  }
}

function world(llm: FakeLlm) {
  const clock = new FakeClock();
  const fixture = advisorFixture({ clock });
  const store = new CrashingStore({ clock });
  store.load(fixture.store.snapshot());
  const logger = new CollectingLogger();
  const graph = new WisdomGraphEngine({ store, categories: fixture.categories, clock, logger, llm });
  const bySlot = (slot: string): HintRecord => fixture.hints.find((h) => h.slot === slot && h.status === "active") as HintRecord;
  return { graph, store, clock, logger, fixture, bySlot };
}

/** The graph rows, in a shape two stores can be compared in: ids, not versions or subject-level bookkeeping. */
function graphOf(snapshot: MemoryStoreSnapshot): { nodes: TopicNode[]; hints: HintRecord[]; audit: string[] } {
  const subject = snapshot.subjects.find((s) => s.subjectId === "rm_42");
  const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    nodes: byId(subject?.nodes ?? []),
    hints: byId(subject?.hints ?? []),
    audit: byId(snapshot.audit.filter((a) => a.subjectId === "rm_42")).map((a) => JSON.stringify(a)),
  };
}

function proposalFor(w: ReturnType<typeof world>): Proposal {
  return {
    ops: [
      { op: "add_hint", nodePath: "/consult_advice", slot: "format.headline", value: "short headline", text: "Likes a short headline before the detail.", kind: "style", lane: "responseStyle", scope: "category", priority: 60, confidence: 0.7, rationale: "new" },
      { op: "add_hint", nodePath: "/", slot: "format.lists", value: "bullets max 5", text: "Prefers bullet points; at most 5 per answer.", kind: "style", lane: "responseStyle", scope: "global", priority: 70, confidence: 0.9, rationale: "restated → reinforce" },
      { op: "add_hint", nodePath: "/", slot: "tone", value: "formal", text: "Prefers a formal tone in email drafts.", kind: "preference", lane: "responseStyle", scope: "global", priority: 55, confidence: 0.7, rationale: "new value → supersede (inferred over inferred)" },
      { op: "add_hint", nodePath: "/", slot: "region.default", value: "usa", text: "Defaults to US markets when the region is not stated.", kind: "fact", lane: "preRoute", scope: "global", priority: 80, confidence: 0.6, rationale: "approved holder → pending challenger" },
      {
        op: "create_node",
        parentPath: "/consult_kyp",
        slug: "etfs",
        title: "ETFs",
        description: "Exchange-traded fund questions.",
        keywords: ["etf", "index fund"],
        hints: [{ slot: "etf.default", value: "broad index", text: "Prefers broad index ETFs for new money.", kind: "preference", lane: "agent", scope: "category", priority: 60, confidence: 0.7, rationale: "recurs" }],
        rationale: "recurs and has no node",
      },
      { op: "update_hint", hintId: w.bySlot("disclaimers").id, text: "Omits regulatory disclaimers unless the user asks for them explicitly.", rationale: "inferred rewording of an explicit hint → pending challenger" },
      { op: "retire_hint", hintId: w.bySlot("greeting").id, reason: "obsolete", rationale: "no longer true" },
      { op: "set_property", nodePath: "/consult_market_analyst", key: "region.default", value: "CA" },
    ],
  };
}

const turnOf = (w: ReturnType<typeof world>): TurnEvent =>
  fixtureTurn("rm_42", "turn_crash", {
    runId: "run_crash",
    userText: GATED,
    assistantText: "Understood.",
    agentsUsed: ["consult_advice"],
    appliedHintIds: [w.bySlot("format.lists").id],
    at: "2026-01-01T00:00:00.000Z",
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("crash between applyBatch and updateEvent(done) (§5.2)", () => {
  it("the replay reuses the stored proposal — the model is called once — and the store converges on the single-run result", async () => {
    vi.useFakeTimers();
    // The clean run: same fixture, same clock, same proposal, no crash.
    const cleanLlm = new FakeLlm();
    const clean = world(cleanLlm);
    cleanLlm.push({ purpose: "extract", reply: proposalFor(clean), sticky: true });
    await clean.graph.ingest(turnOf(clean), { waitFor: "processed" });
    expect(cleanLlm.calls).toHaveLength(1);
    const expected = graphOf(clean.store.snapshot());
    expect(expected.hints.some((h) => h.id === deterministicId("h", null, "rm_42", "turn_crash", 0))).toBe(true);

    // The crashing run.
    const llm = new FakeLlm();
    const w = world(llm);
    llm.push({ purpose: "extract", reply: proposalFor(w), sticky: true });
    w.store.crashOnDone = true;
    const receipt = w.graph.ingest(turnOf(w), { waitFor: "processed" });
    await vi.advanceTimersByTimeAsync(0);
    const failed = await w.store.getEvent(null, "turn_crash");
    expect(failed).toMatchObject({ status: "failed", attempts: 1, error: "Error: crashed after apply" });
    expect(failed?.proposal).toEqual(proposalFor(w));
    // The batch landed before the crash.
    expect(graphOf(w.store.snapshot())).toEqual(expected);
    expect(llm.calls).toHaveLength(1);

    // Backoff: the replay runs against rows that already carry the event.
    w.clock.tick(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(receipt).resolves.toEqual({ eventId: "turn_crash", status: "processed" });
    expect(llm.calls).toHaveLength(1);
    expect(w.graph.stats()).toMatchObject({ llmCalls: 1, processed: 1, failed: 0 });
    const done = await w.store.getEvent(null, "turn_crash");
    // `result.accepted` counts what the replay had left to do (nothing but the proposal's ops); the rows are what must agree.
    expect(done).toMatchObject({ status: "done", attempts: 2, result: { rejected: [] } });
    expect(graphOf(w.store.snapshot())).toEqual(expected);

    // Every counter moved exactly once; every rewrite happened exactly once.
    const lists = w.bySlot("format.lists");
    expect(await w.store.getHint(ref, lists.id)).toMatchObject({ applied: lists.applied + 1, reinforcements: lists.reinforcements + 1, contradictions: 0 });
    expect((await w.store.getHint(ref, lists.id))?.provenance.eventIds.filter((id) => id === "turn_crash")).toHaveLength(1);
    const disclaimers = w.bySlot("disclaimers");
    // An inferred rewording of what the user said is a pending challenger (§6.1): the explicit row keeps its text and its counters.
    expect(await w.store.getHint(ref, disclaimers.id)).toMatchObject({ reinforcements: disclaimers.reinforcements, contradictions: disclaimers.contradictions, text: disclaimers.text, status: "active" });
    expect(await w.store.getHint(ref, deterministicId("h", null, "rm_42", "turn_crash", 5))).toMatchObject({ status: "pending", supersedes: disclaimers.id, source: "inferred", text: "Omits regulatory disclaimers unless the user asks for them explicitly." });
    expect(await w.store.getHint(ref, w.bySlot("tone").id)).toMatchObject({ status: "superseded" });
    expect(await w.store.getHint(ref, w.bySlot("greeting").id)).toMatchObject({ status: "retired", retiredReason: "obsolete" });
    const region = w.bySlot("region.default");
    expect(await w.store.getHint(ref, region.id)).toMatchObject({ status: "active", approval: "approved", contradictions: 1 });
    const challenger = await w.store.getHint(ref, deterministicId("h", null, "rm_42", "turn_crash", 3));
    expect(challenger).toMatchObject({ status: "pending", supersedes: region.id });
    const data = await w.store.loadSnapshot(ref);
    const etfs = data?.nodes.find((n) => n.path === "/consult_kyp/etfs");
    expect(etfs).toMatchObject({ id: deterministicId("n", null, "rm_42", "/consult_kyp/etfs"), stats: { activeHints: 1 } });
    expect(data?.nodes.find((n) => n.path === "/consult_market_analyst")?.properties).toEqual({ "region.default": "CA" });
    const auditIds = (await w.store.listAudit(ref, 100)).map((a) => a.id);
    expect(new Set(auditIds).size).toBe(auditIds.length);
    await w.graph.close();
    await clean.graph.close();
  });

  it("two unusable replies are remembered on the row: the replay makes no model call, repeats the verdict, and writes no second audit row", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlm([{ reply: "garbage" }, { reply: "{ nope" }]);
    const w = world(llm);
    // Were the replay to call again, it would get a real proposal and the graph would change.
    llm.push({ purpose: "extract", reply: proposalFor(w), sticky: true });
    w.store.crashOnDone = true;
    const receipt = w.graph.ingest(turnOf(w), { waitFor: "processed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await w.store.getEvent(null, "turn_crash")).toMatchObject({ status: "failed", attempts: 1, proposal: unparseableProposal() });
    expect(llm.calls).toHaveLength(2);
    const once = graphOf(w.store.snapshot());
    expect(once.audit.filter((a) => a.includes('"op.rejected"'))).toHaveLength(1);

    w.clock.tick(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(receipt).resolves.toEqual({ eventId: "turn_crash", status: "processed" });
    expect(llm.calls).toHaveLength(2);
    expect(await w.store.getEvent(null, "turn_crash")).toMatchObject({ status: "done", attempts: 2, proposal: unparseableProposal(), result: { rejected: [{ op: "*", reason: "unparseable" }] } });
    expect(graphOf(w.store.snapshot())).toEqual(once);
    expect(await w.store.getHint(ref, deterministicId("h", null, "rm_42", "turn_crash", 0))).toBeNull();
    expect(w.graph.stats()).toMatchObject({ llmCalls: 2, processed: 1, failed: 0 });
    await w.graph.close();
  });

  it("a row re-queued for drain() with its proposal stored is processed with zero model calls", async () => {
    const llm = new FakeLlm();
    const w = world(llm);
    llm.push({ purpose: "extract", reply: proposalFor(w), sticky: true });
    await w.graph.ingest(turnOf(w), { waitFor: "processed" });
    expect(llm.calls).toHaveLength(1);
    const before = graphOf(w.store.snapshot());
    // Simulate a worker that died after apply: the row is pending again, proposal still on it.
    await w.store.updateEvent(null, "turn_crash", { status: "pending" });
    await expect(w.graph.maintenance.drain()).resolves.toEqual({ processed: 1, failed: 0 });
    expect(llm.calls).toHaveLength(1);
    expect(await w.store.getEvent(null, "turn_crash")).toMatchObject({ status: "done", attempts: 2, proposal: proposalFor(w) });
    expect(graphOf(w.store.snapshot())).toEqual(before);
    // A third time, for good measure.
    await w.store.updateEvent(null, "turn_crash", { status: "pending" });
    await expect(w.graph.maintenance.drain()).resolves.toEqual({ processed: 1, failed: 0 });
    expect(graphOf(w.store.snapshot())).toEqual(before);
    expect(w.graph.stats().llmCalls).toBe(1);
  });

  it("feedback extraction replays the same way: the correction lands once", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlm();
    const w = world(llm);
    const disclaimers = w.bySlot("disclaimers");
    await w.graph.ingest(fixtureTurn("rm_42", "turn_fb", { runId: "run_fb", appliedHintIds: [disclaimers.id], userText: "hi", assistantText: "hello" }), { waitFor: "processed" });
    llm.push({
      purpose: "extract",
      sticky: true,
      reply: { ops: [{ op: "update_hint", hintId: disclaimers.id, value: "never", text: "Never adds regulatory disclaimers.", confidence: 0.95, rationale: "corrected" }] },
    });
    w.store.crashOnDone = true;
    const receipt = w.graph.ingest(fixtureFeedback("rm_42", "fb_crash", { runId: "run_fb", signal: "correction", text: "No: never add disclaimers." }), { waitFor: "processed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await w.store.getEvent(null, "fb_crash")).toMatchObject({ status: "failed", attempts: 1 });
    const once = w.store.snapshot();
    w.clock.tick(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(receipt).resolves.toEqual({ eventId: "fb_crash", status: "processed" });
    expect(llm.calls).toHaveLength(1);
    expect(graphOf(w.store.snapshot())).toEqual(graphOf(once));
    expect(await w.store.getHint(ref, disclaimers.id)).toMatchObject({ value: "never", text: "Never adds regulatory disclaimers.", source: "explicit", confidence: 0.95 });
    expect((await w.store.getHint(ref, disclaimers.id))?.provenance.eventIds.filter((id) => id === "fb_crash")).toHaveLength(1);
    await w.graph.close();
  });
});
