/**
 * Feedback arithmetic and targeting as pure functions over the advisor
 * fixture: `up` adds and reinforces, `down` multiplies and counts, the
 * §6.1 thresholds retire inferred hints and send explicit ones to review,
 * and `target` selects exactly the hints spec §5.4 says.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { defaultPolicy } from "../policy";
import { noopLogger, type StoreOp, type SubjectRef } from "../ports";
import type { FeedbackEvent, HintRecord, TurnEvent } from "../types";
import { compileSnapshot, type SubjectSnapshot } from "../graph/snapshot";
import { MemoryStore } from "../store/memory";
import { FakeClock } from "../../testing/fakes";
import { fixtureFeedback, fixtureTurn, advisorFixture } from "../../testing/fixtures";
import { alreadyApplied, applyFeedback, appliedHints, eventAudit, targetedHints } from "./feedback";

interface World {
  store: MemoryStore;
  ref: SubjectRef;
  clock: FakeClock;
  categories: ReturnType<typeof advisorFixture>["categories"];
  hints: HintRecord[];
  snapshot: SubjectSnapshot;
  bySlot: (slot: string) => HintRecord;
  refresh: () => Promise<SubjectSnapshot>;
}

async function world(): Promise<World> {
  const clock = new FakeClock();
  const fixture = advisorFixture({ clock });
  const ref: SubjectRef = { tenantId: null, subjectId: fixture.subjectId };
  const compile = async (): Promise<SubjectSnapshot> =>
    compileSnapshot(await fixture.store.loadSnapshot(ref), defaultPolicy, noopLogger, { ref, categories: fixture.categories, clock });
  const w: World = {
    store: fixture.store,
    ref,
    clock,
    categories: fixture.categories,
    hints: fixture.hints,
    snapshot: await compile(),
    bySlot: (slot) => fixture.hints.find((h) => h.slot === slot && h.status === "active") as HintRecord,
    refresh: async () => {
      w.snapshot = await compile();
      return w.snapshot;
    },
  };
  return w;
}

/** The op patching `hintId`, or undefined. */
function patchFor(ops: StoreOp[], hintId: string): Extract<StoreOp, { op: "patchHint" }> | undefined {
  return ops.find((op): op is Extract<StoreOp, { op: "patchHint" }> => op.op === "patchHint" && op.hintId === hintId);
}

function audits(ops: StoreOp[]): Extract<StoreOp, { op: "audit" }>["entry"][] {
  return ops.filter((op): op is Extract<StoreOp, { op: "audit" }> => op.op === "audit").map((op) => op.entry);
}

describe("targeting (§5.4 step 2)", () => {
  let w: World;
  let turn: TurnEvent;
  let ids: Record<string, string>;
  beforeEach(async () => {
    w = await world();
    ids = {
      lists: w.bySlot("format.lists").id, // global · responseStyle · explicit 0.9
      disclaimers: w.bySlot("disclaimers").id, // agent consult_advice · agent lane · explicit 0.9
      tone: w.bySlot("tone").id, // global · responseStyle · inferred 0.6
      horizon: w.bySlot("horizon.default").id, // category · agent lane · explicit 0.85 (every agent's bucket)
      kyp: w.bySlot("kyp.first").id, // agent consult_kyp · agent lane
      region: w.bySlot("region.default").id, // global · preRoute · approved 0.95
      holdings: w.bySlot("routing.holdings").id, // global · preRoute · inferred 0.55
    };
    turn = fixtureTurn(w.ref.subjectId, "turn_fb", {
      runId: "run_fb",
      appliedHintIds: [ids.lists, ids.disclaimers, ids.tone, ids.horizon, ids.kyp, ids.region, ids.holdings, "h_unknown", ids.lists] as string[],
    });
  });

  it("appliedHints keeps the turn's order, drops unknown ids and repeats, and reads only active records", () => {
    const superseded = w.hints.find((h) => h.status === "superseded") as HintRecord;
    const applied = appliedHints({ ...turn, appliedHintIds: [...(turn.appliedHintIds ?? []), superseded.id] }, w.snapshot);
    expect(applied.map((h) => h.id)).toEqual([ids.lists, ids.disclaimers, ids.tone, ids.horizon, ids.kyp, ids.region, ids.holdings]);
    expect(appliedHints(null, w.snapshot)).toEqual([]);
    expect(appliedHints(fixtureTurn(w.ref.subjectId, "t0"), w.snapshot)).toEqual([]);
  });

  const table: { target: FeedbackEvent["target"] | undefined; expected: string[] }[] = [
    { target: undefined, expected: ["lists", "disclaimers", "tone", "horizon", "kyp", "region", "holdings"] },
    { target: "response", expected: ["lists", "tone", "region", "holdings"] },
    { target: "agent:consult_advice", expected: ["disclaimers", "horizon"] },
    { target: "agent:consult_kyp", expected: ["horizon", "kyp"] },
    { target: "agent:consult_newsroom", expected: ["horizon"] },
    { target: "tool:holdings", expected: [] },
  ];
  it.each(table)("target $target selects $expected", ({ target, expected }) => {
    const selected = targetedHints({ target }, turn, w.snapshot).map((h) => h.id);
    expect(selected).toEqual(expected.map((k) => ids[k]));
  });

  it("an unanchored event targets nothing whatever the target says", () => {
    expect(targetedHints({ target: undefined }, null, w.snapshot)).toEqual([]);
    expect(targetedHints({ target: "response" }, null, w.snapshot)).toEqual([]);
  });
});

describe("up (§5.4 step 3)", () => {
  it("adds upConfidenceDelta capped at 1, counts a reinforcement, resets lastReinforcedAt and appends provenance", async () => {
    const w = await world();
    const lists = w.bySlot("format.lists");
    const region = w.bySlot("region.default");
    const turn = fixtureTurn(w.ref.subjectId, "turn_up", { runId: "run_up", appliedHintIds: [lists.id, region.id] });
    const event = fixtureFeedback(w.ref.subjectId, "fb_up", { runId: "run_up", signal: "up", at: "2026-01-02T00:00:00.000Z" });
    const ops = applyFeedback(event, turn, w.snapshot, defaultPolicy);

    expect(patchFor(ops, lists.id)?.patch).toEqual({
      confidence: 0.95,
      reinforcements: { add: 1 },
      lastReinforcedAt: "2026-01-02T00:00:00.000Z",
      provenance: { appendEventId: "fb_up", appendRunId: "run_up" },
    });
    expect(patchFor(ops, region.id)?.patch.confidence).toBe(1);
    const rows = audits(ops);
    expect(rows.map((a) => a.action)).toEqual(["hint.reinforced", "hint.reinforced"]);
    expect(rows[0]).toMatchObject({ actor: "system:feedback", hintId: lists.id, nodePath: "/", eventId: "fb_up", at: "2026-01-02T00:00:00.000Z", detail: { signal: "up", from: 0.9, to: 0.95 } });
    expect(ops.filter((op) => op.op === "patchHint")).toHaveLength(2);

    // Applying the ops leaves the store as the patches say.
    await w.store.applyBatch(w.ref, ops);
    expect(await w.store.getHint(w.ref, lists.id)).toMatchObject({ confidence: 0.95, reinforcements: 4, lastReinforcedAt: "2026-01-02T00:00:00.000Z" });
    expect((await w.store.getHint(w.ref, lists.id))?.provenance.eventIds.at(-1)).toBe("fb_up");
  });

  it("is deterministic: the same event yields the same ops and audit ids, and different events differ", async () => {
    const w = await world();
    const lists = w.bySlot("format.lists");
    const turn = fixtureTurn(w.ref.subjectId, "turn_up", { runId: "run_up", appliedHintIds: [lists.id] });
    const event = fixtureFeedback(w.ref.subjectId, "fb_up", { runId: "run_up", signal: "up", at: "2026-01-02T00:00:00.000Z" });
    const first = applyFeedback(event, turn, w.snapshot, defaultPolicy);
    expect(applyFeedback(event, turn, w.snapshot, defaultPolicy)).toEqual(first);
    const other = applyFeedback({ ...event, id: "fb_other" }, turn, w.snapshot, defaultPolicy);
    expect(audits(other)[0]?.id).not.toBe(audits(first)[0]?.id);
    const row = eventAudit(w.ref, { eventId: "e", seq: 0, at: "2026-01-01T00:00:00.000Z", actor: "a", action: "x" });
    expect(row.op === "audit" ? row.entry.id : "").toMatch(/^a_[0-9a-f]{16}$/);
  });

  it("uses the snapshot's compile instant when the event carries no `at`", async () => {
    const w = await world();
    const lists = w.bySlot("format.lists");
    const turn = fixtureTurn(w.ref.subjectId, "turn_up", { runId: "run_up", appliedHintIds: [lists.id] });
    const ops = applyFeedback(fixtureFeedback(w.ref.subjectId, "fb_up", { runId: "run_up" }), turn, w.snapshot, defaultPolicy);
    expect(patchFor(ops, lists.id)?.patch.lastReinforcedAt).toBe(new Date(w.clock.now()).toISOString());
  });
});

describe("down (§5.4 step 4, §6.1 items 3–4)", () => {
  it("multiplies by downFactor per source and counts a contradiction; nothing else on the first thumb", async () => {
    const w = await world();
    const lists = w.bySlot("format.lists");
    const tone = w.bySlot("tone");
    const turn = fixtureTurn(w.ref.subjectId, "turn_d", { runId: "run_d", appliedHintIds: [lists.id, tone.id] });
    const ops = applyFeedback(fixtureFeedback(w.ref.subjectId, "fb_d", { runId: "run_d", signal: "down" }), turn, w.snapshot, defaultPolicy);
    expect(patchFor(ops, lists.id)?.patch).toEqual({ confidence: 0.72, contradictions: { add: 1 }, provenance: { appendEventId: "fb_d", appendRunId: "run_d" } });
    expect(patchFor(ops, tone.id)?.patch).toEqual({ confidence: 0.36, contradictions: { add: 1 }, provenance: { appendEventId: "fb_d", appendRunId: "run_d" } });
    expect(audits(ops).map((a) => a.action)).toEqual(["hint.contradicted", "hint.contradicted"]);
    expect(audits(ops)[1]?.detail).toEqual({ signal: "down", from: 0.6, to: 0.36, contradictions: 1 });
  });

  it("retires an inferred hint once its confidence drops below retireConfidenceBelow (feedback)", async () => {
    const w = await world();
    const tone = w.bySlot("tone");
    const turn = fixtureTurn(w.ref.subjectId, "turn_d", { runId: "run_d", appliedHintIds: [tone.id] });
    const down = (id: string): StoreOp[] => applyFeedback(fixtureFeedback(w.ref.subjectId, id, { runId: "run_d", signal: "down" }), turn, w.snapshot, defaultPolicy);
    await w.store.applyBatch(w.ref, down("fb_1"));
    await w.refresh();
    expect(w.snapshot.recordsById.get(tone.id)?.confidence).toBe(0.36);
    const second = down("fb_2");
    expect(patchFor(second, tone.id)?.patch).toMatchObject({ confidence: 0.216, status: "retired", retiredReason: "feedback" });
    expect(audits(second).map((a) => a.action)).toEqual(["hint.contradicted", "hint.retired"]);
    expect(audits(second)[1]?.detail).toEqual({ reason: "feedback" });
    await w.store.applyBatch(w.ref, second);
    expect(await w.store.getHint(w.ref, tone.id)).toMatchObject({ status: "retired", retiredReason: "feedback", contradictions: 2 });
  });

  it("retires an inferred hint at contradictionsToRetire even while its confidence holds (contradicted)", async () => {
    const w = await world();
    const tone = w.bySlot("tone");
    await w.store.applyBatch(w.ref, [{ op: "patchHint", hintId: tone.id, patch: { confidence: 1, contradictions: { add: 2 } } }]);
    await w.refresh();
    const turn = fixtureTurn(w.ref.subjectId, "turn_d", { runId: "run_d", appliedHintIds: [tone.id] });
    const ops = applyFeedback(fixtureFeedback(w.ref.subjectId, "fb_3", { runId: "run_d", signal: "down" }), turn, w.snapshot, defaultPolicy);
    expect(patchFor(ops, tone.id)?.patch).toMatchObject({ confidence: 0.6, status: "retired", retiredReason: "contradicted" });
    expect(audits(ops)[1]).toMatchObject({ action: "hint.retired", detail: { reason: "contradicted" } });
  });

  it("an explicit hint is never retired: contradictions flag it for review while active, low confidence moves it to pending", async () => {
    const w = await world();
    const lists = w.bySlot("format.lists");
    const turn = fixtureTurn(w.ref.subjectId, "turn_d", { runId: "run_d", appliedHintIds: [lists.id] });
    const down = (id: string): StoreOp[] => applyFeedback(fixtureFeedback(w.ref.subjectId, id, { runId: "run_d", signal: "down" }), turn, w.snapshot, defaultPolicy);
    const confidences: number[] = [];
    const flags: string[][] = [];
    for (let i = 1; i <= 5; i += 1) {
      const ops = down(`fb_${i}`);
      const patch = patchFor(ops, lists.id)?.patch;
      confidences.push(patch?.confidence ?? Number.NaN);
      flags.push(audits(ops).map((a) => `${a.action}${a.detail.reason !== undefined ? `:${String(a.detail.reason)}` : ""}`));
      if (i === 3) expect(patch).toMatchObject({ needsReview: true });
      if (i === 3) expect(patch?.status).toBeUndefined();
      if (i === 5) expect(patch).toMatchObject({ needsReview: true, status: "pending" });
      await w.store.applyBatch(w.ref, ops);
      await w.refresh();
      if (i < 5) {
        expect(w.snapshot.recordsById.get(lists.id)?.status).toBe("active");
      }
    }
    expect(confidences).toEqual([0.72, 0.576, 0.4608, 0.36864, 0.294912]);
    expect(flags).toEqual([
      ["hint.contradicted"],
      ["hint.contradicted"],
      ["hint.contradicted", "hint.needs-review:contradictions"],
      ["hint.contradicted", "hint.needs-review:contradictions"],
      ["hint.contradicted", "hint.needs-review:confidence"],
    ]);
    expect(await w.store.getHint(w.ref, lists.id)).toMatchObject({ status: "pending", needsReview: true, contradictions: 5, approval: "auto" });
  });

  it("honours a target: `agent:consult_advice` leaves the response-style hint alone", async () => {
    const w = await world();
    const lists = w.bySlot("format.lists");
    const disclaimers = w.bySlot("disclaimers");
    const turn = fixtureTurn(w.ref.subjectId, "turn_d", { runId: "run_d", appliedHintIds: [lists.id, disclaimers.id] });
    const ops = applyFeedback(fixtureFeedback(w.ref.subjectId, "fb_d", { runId: "run_d", signal: "down", target: "agent:consult_advice" }), turn, w.snapshot, defaultPolicy);
    expect(patchFor(ops, lists.id)).toBeUndefined();
    expect(patchFor(ops, disclaimers.id)?.patch.confidence).toBe(0.72);
  });
});

describe("replay (§5.2)", () => {
  it("a target that already carries the event id gets no patch and no audit row, so the same event applied twice moves nothing twice", async () => {
    const w = await world();
    const lists = w.bySlot("format.lists");
    const tone = w.bySlot("tone");
    const ids = (ops: StoreOp[]): string[] => ops.filter((op): op is Extract<StoreOp, { op: "patchHint" }> => op.op === "patchHint").map((op) => op.hintId);
    const turn = fixtureTurn(w.ref.subjectId, "turn_r", { runId: "run_r", appliedHintIds: [lists.id, tone.id] });
    const up = fixtureFeedback(w.ref.subjectId, "fb_r_up", { runId: "run_r", signal: "up" });
    const first = applyFeedback(up, turn, w.snapshot, defaultPolicy);
    expect(ids(first)).toEqual([lists.id, tone.id]);
    expect(alreadyApplied(lists, "fb_r_up")).toBe(false);
    await w.store.applyBatch(w.ref, first);
    await w.refresh();
    expect(alreadyApplied(w.snapshot.recordsById.get(lists.id) as HintRecord, "fb_r_up")).toBe(true);
    expect(applyFeedback(up, turn, w.snapshot, defaultPolicy)).toEqual([]);
    await w.store.applyBatch(w.ref, applyFeedback(up, turn, w.snapshot, defaultPolicy));
    expect(await w.store.getHint(w.ref, lists.id)).toMatchObject({ confidence: 0.95, reinforcements: lists.reinforcements + 1 });

    // A different event still moves them; after a partial apply only the untouched target is patched.
    const down = fixtureFeedback(w.ref.subjectId, "fb_r_down", { runId: "run_r", signal: "down" });
    expect(ids(applyFeedback(down, turn, w.snapshot, defaultPolicy))).toEqual([lists.id, tone.id]);
    await w.store.applyBatch(w.ref, [{ op: "patchHint", hintId: lists.id, patch: { provenance: { appendEventId: "fb_r_down" } } }]);
    await w.refresh();
    const rest = applyFeedback(down, turn, w.snapshot, defaultPolicy);
    expect(ids(rest)).toEqual([tone.id]);
    expect(audits(rest).map((a) => a.hintId)).toEqual([tone.id]);
    expect(targetedHints(down, turn, w.snapshot).map((h) => h.id)).toEqual([lists.id, tone.id]);
  });
});

describe("no-op signals", () => {
  it("comment and correction produce no ops here; tool targets and unanchored events produce none for any signal", async () => {
    const w = await world();
    const lists = w.bySlot("format.lists");
    const turn = fixtureTurn(w.ref.subjectId, "turn_c", { runId: "run_c", appliedHintIds: [lists.id] });
    for (const signal of ["comment", "correction"] as const) {
      expect(applyFeedback(fixtureFeedback(w.ref.subjectId, "fb_c", { runId: "run_c", signal, text: "too long" }), turn, w.snapshot, defaultPolicy)).toEqual([]);
    }
    expect(applyFeedback(fixtureFeedback(w.ref.subjectId, "fb_t", { runId: "run_c", signal: "up", target: "tool:holdings" }), turn, w.snapshot, defaultPolicy)).toEqual([]);
    expect(applyFeedback(fixtureFeedback(w.ref.subjectId, "fb_u", { runId: "run_c", signal: "down" }), null, w.snapshot, defaultPolicy)).toEqual([]);
  });
});
