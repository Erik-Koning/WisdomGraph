/**
 * The model-backed consolidation pass (spec §5.7, decision 30) through a
 * real engine: it runs only with an `LlmPort` and only over nodes that are
 * over cap or were flagged; each node becomes a `kind: "consolidate"` row
 * that the ledger leases, retries on the backoff schedule, replays from
 * its stored proposal and hands to `drain()` like any turn; its ops —
 * `merge_hints`, `move_hint`, `split_node`, `merge_nodes`, `alias_slot` —
 * land with the §5.7 semantics, locked targets are refused, and an alias
 * written by the pass canonicalises the slots of later proposals. A hint a
 * human approved is never retired by any of those ops: a merge over one
 * waits for a human as a pending challenger, a collision that would fold
 * one away refuses the op (§5.6, §10.4).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deterministicId } from "../ids";
import type { DeepPartial, PolicyConfig } from "../policy";
import type { LlmPort, StoredEvent, StoredEventPatch, SubjectRef } from "../ports";
import type { HintRecord } from "../types";
import { cacheKey } from "../recall/cache";
import { MemoryStore } from "../store/memory";
import { WisdomGraphEngine } from "../engine";
import { CollectingLogger, FakeClock, FakeLlm, FaultyStore } from "../../testing/fakes";
import { fixtureHint, fixtureTurn, advisorFixture } from "../../testing/fixtures";
import { flagOverflow } from "./ingest";
import { CONSOLIDATE_LLM_ACTOR } from "./consolidate";
import { CONSOLIDATION_PROMPT_VERSION, RETRY_PREFIX } from "./prompts";
import { unparseableProposal } from "./extract";

const SUBJECT = "rm_42";
const REPORTING = "/consult_advice/reporting";

interface SetupOptions {
  llm?: LlmPort;
  policy?: DeepPartial<PolicyConfig>;
  inner?: MemoryStore;
  clock?: FakeClock;
}

function setup(over: SetupOptions = {}) {
  const clock = over.clock ?? new FakeClock();
  const fixture = advisorFixture({ clock });
  const inner = over.inner ?? fixture.store;
  const store = new FaultyStore(inner);
  const logger = new CollectingLogger();
  const graph = new WisdomGraphEngine({
    store,
    categories: fixture.categories,
    clock,
    logger,
    ...(over.llm !== undefined ? { llm: over.llm } : {}),
    ...(over.policy !== undefined ? { policy: over.policy } : {}),
  });
  const ref: SubjectRef = { tenantId: null, subjectId: SUBJECT };
  const bySlot = (slot: string): HintRecord => fixture.hints.find((h) => h.slot === slot && h.status === "active") as HintRecord;
  const hint = (id: string) => inner.getHint(ref, id);
  const node = async (path: string) => (await inner.loadSnapshot(ref))?.nodes.find((n) => n.path === path);
  const nodeRow = (path: string) => inner.snapshot().subjects.find((s) => s.subjectId === SUBJECT)?.nodes.find((n) => n.path === path);
  const audit = async (action: string) => (await inner.listAudit(ref, 500)).filter((a) => a.action === action);
  const rows = async (): Promise<StoredEvent[]> => (await inner.listEvents(ref, { limit: 100 })).filter((r) => r.event.type === "consolidate");
  const flag = (...paths: string[]): void => flagOverflow(graph.ctx, ref, paths);
  const consolidate = () => graph.maintenance.consolidate(SUBJECT, { llm: true });
  return { graph, inner, store, logger, clock, fixture, ref, bySlot, hint, node, nodeRow, audit, rows, flag, consolidate };
}

type World = ReturnType<typeof setup>;

/** The one merge every test can agree on: the two reporting-style hints become one. */
function mergeProposal(w: World) {
  return {
    ops: [
      {
        op: "merge_hints",
        hintIds: [w.bySlot("format.tables").id, w.bySlot("returns.units").id],
        slot: "report.format",
        value: "tables and percentages",
        text: "Reports returns in percentages and wants a table when comparing more than two funds.",
        rationale: "one preference",
      },
    ],
  };
}

/** The graph rows in a comparable shape: ids and content, not subject-level bookkeeping. */
function graphRows(inner: MemoryStore) {
  const subject = inner.snapshot().subjects.find((s) => s.subjectId === SUBJECT);
  const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { nodes: byId(subject?.nodes ?? []), hints: byId(subject?.hints ?? []) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("when the model pass runs (§5.7)", () => {
  it("does nothing without an LlmPort, nothing when no node is over cap or flagged, and one row per flagged node otherwise", async () => {
    const silent = setup();
    silent.flag(REPORTING);
    expect(await silent.consolidate()).toMatchObject({ usedLlm: false, opsAccepted: 1, opsRejected: 0 });
    expect(await silent.rows()).toEqual([]);

    const llm = new FakeLlm();
    const w = setup({ llm });
    expect(await w.consolidate()).toMatchObject({ usedLlm: false });
    expect(llm.calls).toHaveLength(0);
    expect(await w.rows()).toEqual([]);

    w.flag(REPORTING);
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 0 });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.opts).toMatchObject({ purpose: "consolidate", json: true });
    expect(llm.calls[0]?.prompt).toContain(`# Graph consolidation (${CONSOLIDATION_PROMPT_VERSION})`);
    expect(llm.calls[0]?.prompt).toContain(`## Node under review\n${REPORTING}\n`);
    expect(llm.calls[0]?.prompt).toContain(w.bySlot("format.tables").id);
    const [row] = await w.rows();
    expect(row).toMatchObject({ status: "done", attempts: 1, event: { type: "consolidate", subjectId: SUBJECT, nodePath: REPORTING, at: w.clock.iso() }, proposal: { ops: [] }, result: { accepted: 0, rejected: [] } });
    expect(row?.event.id).toBe(deterministicId("c", null, SUBJECT, REPORTING, w.clock.now()));
    expect(w.graph.stats()).toMatchObject({ llmCalls: 1, ingested: 1, processed: 1 });
    // The flag was consumed by the pass that acted on it.
    expect(await w.consolidate()).toMatchObject({ usedLlm: false });
    expect(llm.calls).toHaveLength(1);
    expect(await w.rows()).toHaveLength(1);
    // A flag for a node that is not active is dropped, not run.
    w.flag("/consult_kyp/nothing");
    expect(await w.consolidate()).toMatchObject({ usedLlm: false });
    expect(await w.rows()).toHaveLength(1);
  });

  it("runs over a node whose active hints exceed maxActiveHintsPerNode, and from maintain() when a model exists", async () => {
    const llm = new FakeLlm();
    const over = setup({ llm, policy: { caps: { maxActiveHintsPerNode: 9 } } });
    // The root holds ten active hints; every other node is within the cap.
    expect(over.fixture.hints.filter((h) => h.status === "active" && h.nodePath === "/")).toHaveLength(10);
    expect(await over.consolidate()).toMatchObject({ usedLlm: true });
    expect((await over.rows()).map((r) => r.event.type === "consolidate" && r.event.nodePath)).toEqual(["/"]);
    expect(llm.calls[0]?.prompt).toContain("## Node under review\n/\n");

    const llm2 = new FakeLlm();
    const w = setup({ llm: llm2 });
    expect(await w.graph.maintenance.maintain({ subjectId: SUBJECT })).toMatchObject({ merged: 0 });
    expect(llm2.calls).toHaveLength(0);
    llm2.push({ purpose: "consolidate", reply: mergeProposal(w) });
    w.flag(REPORTING);
    expect(await w.graph.maintenance.maintain({ subjectId: SUBJECT })).toMatchObject({ merged: 1 });
    expect(llm2.calls).toHaveLength(1);
    expect((await w.rows())[0]).toMatchObject({ status: "done", result: { accepted: 1, rejected: [] } });
    expect(await w.hint(w.bySlot("format.tables").id)).toMatchObject({ status: "retired", retiredReason: "merged" });
  });

  it("a flag the pass could not act on is kept: an abort mid-pass gives it back and the next pass runs it", async () => {
    const inner = new FakeLlm();
    const controller = new AbortController();
    // The first node's model call aborts the pass; the second node is never reached.
    const llm: LlmPort = {
      complete: (prompt, opts) => {
        controller.abort();
        return inner.complete(prompt, opts);
      },
    };
    const w = setup({ llm });
    w.flag(REPORTING, "/consult_kyp");
    expect(await w.graph.maintenance.consolidate(SUBJECT, { llm: true, signal: controller.signal })).toMatchObject({ usedLlm: true });
    expect(inner.calls).toHaveLength(1);
    expect((await w.rows()).map((r) => r.event.type === "consolidate" && r.event.nodePath)).toEqual([REPORTING]);
    expect([...(w.graph.ctx.flagged.get(cacheKey(w.ref)) ?? [])]).toEqual(["/consult_kyp"]);

    w.clock.tick(1);
    expect(await w.consolidate()).toMatchObject({ usedLlm: true });
    expect(inner.calls).toHaveLength(2);
    // `listEvents` is newest first: the flagged node's row is the later one.
    expect((await w.rows()).map((r) => r.event.type === "consolidate" && r.event.nodePath)).toEqual(["/consult_kyp", REPORTING]);
    expect(w.graph.ctx.flagged.get(cacheKey(w.ref))).toBeUndefined();
  });
});

describe("the consolidate row is a ledger row (decision 30)", () => {
  it("a model failure puts the row on the backoff schedule; the retry finishes it", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlm([{ purpose: "consolidate", reply: "", throws: new Error("model down") }]);
    const w = setup({ llm });
    llm.push({ purpose: "consolidate", reply: mergeProposal(w) });
    w.flag(REPORTING);

    const pending = w.consolidate();
    await vi.advanceTimersByTimeAsync(0);
    const [failed] = await w.rows();
    expect(failed).toMatchObject({ status: "failed", attempts: 1, error: "Error: model down", retryAt: new Date(w.clock.now() + 1_000).toISOString() });
    expect(failed?.proposal).toBeUndefined();
    expect(failed?.leaseUntil).toBeUndefined();
    expect(w.logger.find({ level: "warn", msg: "ingest.retry" })[0]?.obj).toMatchObject({ eventId: failed?.event.id, attempts: 1 });
    expect(w.graph.stats()).toMatchObject({ llmCalls: 1, queueDepth: 1 });

    w.clock.tick(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ usedLlm: true, merged: 1, opsRejected: 0 });
    expect(llm.calls).toHaveLength(2);
    const [done] = await w.rows();
    expect(done).toMatchObject({ status: "done", attempts: 2, result: { accepted: 1, rejected: [] }, proposal: mergeProposal(w) });
    expect(w.graph.stats()).toMatchObject({ llmCalls: 2, processed: 1, failed: 0, queueDepth: 0 });
    expect(w.logger.find({ msg: "ingest.processed" })[0]?.obj).toMatchObject({ eventId: done?.event.id, kind: "consolidate", extracted: true, opsAccepted: 1, attempts: 2 });
  });

  it("a crash between apply and done replays from the stored proposal: one model call, and the rows converge", async () => {
    vi.useFakeTimers();
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
    const clock = new FakeClock();
    const inner = new CrashingStore({ clock });
    inner.load(advisorFixture({ clock }).store.snapshot());
    const llm = new FakeLlm();
    const w = setup({ llm, inner, clock });
    llm.push({ purpose: "consolidate", reply: mergeProposal(w) });
    const tables = w.bySlot("format.tables");
    const units = w.bySlot("returns.units");
    w.flag(REPORTING);
    inner.crashOnDone = true;

    const pending = w.consolidate();
    await vi.advanceTimersByTimeAsync(0);
    const [failed] = await w.rows();
    expect(failed).toMatchObject({ status: "failed", attempts: 1, error: "Error: crashed after apply", proposal: mergeProposal(w) });
    // The batch landed before the crash.
    expect(await w.hint(tables.id)).toMatchObject({ status: "retired", retiredReason: "merged" });
    const landed = graphRows(inner);

    w.clock.tick(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    // The pass did call the model — once, in the attempt that crashed; the replay reused what that attempt stored.
    expect(await pending).toMatchObject({ usedLlm: true, merged: 1 });
    expect(llm.calls).toHaveLength(1);
    expect((await w.rows())[0]).toMatchObject({ status: "done", attempts: 2, result: { accepted: 1, rejected: [] } });
    expect(graphRows(inner)).toEqual(landed);
    const mergedId = deterministicId("h", null, SUBJECT, failed?.event.id ?? "", 0);
    expect(await w.hint(mergedId)).toMatchObject({ status: "active", slot: "report.format" });
    expect(graphRows(inner).hints.filter((h) => h.slot === "report.format")).toHaveLength(1);
    expect(await w.hint(units.id)).toMatchObject({ status: "retired", retiredReason: "merged" });
    const auditIds = (await w.inner.listAudit(w.ref, 100)).map((a) => a.id);
    expect(new Set(auditIds).size).toBe(auditIds.length);
    expect(w.graph.stats()).toMatchObject({ llmCalls: 1, processed: 1, failed: 0 });
  });

  it("an unfinished row is leased by drain() on any engine and finished without a second model call", async () => {
    const llm = new FakeLlm();
    const w = setup({ llm });
    llm.push({ purpose: "consolidate", reply: mergeProposal(w) });
    w.flag(REPORTING);
    await w.consolidate();
    const [row] = await w.rows();
    const before = graphRows(w.inner);
    // A worker that died after apply: pending again, the proposal still on the row.
    await w.inner.updateEvent(null, row?.event.id ?? "", { status: "pending" });

    const other = new FakeLlm([{ purpose: "consolidate", sticky: true, reply: { ops: [{ op: "merge_nodes", fromPath: REPORTING, intoPath: "/consult_advice", rationale: "would show if the model were asked" }] } }]);
    const second = new WisdomGraphEngine({ store: w.inner, categories: w.fixture.categories, clock: w.clock, llm: other });
    await expect(second.maintenance.drain()).resolves.toEqual({ processed: 1, failed: 0 });
    expect(other.calls).toHaveLength(0);
    expect((await w.rows())[0]).toMatchObject({ status: "done", attempts: 2, proposal: mergeProposal(w) });
    expect(graphRows(w.inner)).toEqual(before);
    expect(w.nodeRow(REPORTING)?.status).toBe("active");
    await second.close();
  });

  it("two engines at one instant claim one row: the second finds it a duplicate and skips the node; a later instant is a new row", async () => {
    const llm1 = new FakeLlm();
    const w = setup({ llm: llm1 });
    llm1.push({ purpose: "consolidate", reply: mergeProposal(w) });
    const llm2 = new FakeLlm();
    const logger2 = new CollectingLogger();
    const second = new WisdomGraphEngine({ store: w.inner, categories: w.fixture.categories, clock: w.clock, llm: llm2, logger: logger2 });
    w.flag(REPORTING);
    flagOverflow(second.ctx, w.ref, [REPORTING]);

    expect(await w.consolidate()).toMatchObject({ usedLlm: true, merged: 1 });
    expect(await second.maintenance.consolidate(SUBJECT, { llm: true })).toMatchObject({ usedLlm: false, merged: 0 });
    expect(llm2.calls).toHaveLength(0);
    expect(await w.rows()).toHaveLength(1);
    expect(logger2.find({ msg: "consolidate.duplicate" })[0]?.obj).toMatchObject({ nodePath: REPORTING });

    w.clock.tick(1);
    flagOverflow(second.ctx, w.ref, [REPORTING]);
    expect(await second.maintenance.consolidate(SUBJECT, { llm: true })).toMatchObject({ usedLlm: true });
    expect(llm2.calls).toHaveLength(1);
    expect(await w.rows()).toHaveLength(2);
    await second.close();
  });

  it("a row for a node that is no longer active is finished with an empty proposal and no model call", async () => {
    const llm = new FakeLlm([{ purpose: "consolidate", sticky: true, reply: { ops: [{ op: "alias_slot", from: "a.b", to: "c.d", rationale: "r" }] } }]);
    const w = setup({ llm });
    await w.inner.claimEvent(null, { type: "consolidate", id: "c_gone", subjectId: SUBJECT, nodePath: "/consult_kyp/nothing", at: w.clock.iso() });
    await expect(w.graph.maintenance.drain()).resolves.toEqual({ processed: 1, failed: 0 });
    expect(llm.calls).toHaveLength(0);
    expect(await w.inner.getEvent(null, "c_gone")).toMatchObject({ status: "done", proposal: { ops: [], notes: expect.stringContaining("not active") }, result: { accepted: 0, rejected: [] } });
    expect(w.logger.find({ msg: "consolidate.node-gone" })).toHaveLength(1);
    expect((await w.inner.loadSnapshot(w.ref))?.slotAliases).not.toHaveProperty("a.b");
  });

  it("two unusable replies end the row with the unparseable verdict, remembered so a replay makes no call", async () => {
    const llm = new FakeLlm([
      { purpose: "consolidate", reply: "garbage" },
      { purpose: "consolidate", reply: "{ nope" },
    ]);
    const w = setup({ llm });
    llm.push({ purpose: "consolidate", sticky: true, reply: mergeProposal(w) });
    w.flag(REPORTING);
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 1, merged: 0 });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.prompt).toContain(RETRY_PREFIX);
    const [row] = await w.rows();
    expect(row).toMatchObject({ status: "done", proposal: unparseableProposal(), result: { accepted: 0, rejected: [{ op: "*", reason: "unparseable" }] } });
    expect((await w.audit("op.rejected"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, eventId: row?.event.id, detail: { op: "*", reason: "unparseable" } });
    expect(await w.hint(w.bySlot("format.tables").id)).toMatchObject({ status: "active" });

    await w.inner.updateEvent(null, row?.event.id ?? "", { status: "pending" });
    await expect(w.graph.maintenance.drain()).resolves.toEqual({ processed: 1, failed: 0 });
    expect(llm.calls).toHaveLength(2);
    expect(await w.audit("op.rejected")).toHaveLength(1);
  });
});

describe("consolidation op semantics (§5.7)", () => {
  it("merge_hints retires the inputs as merged and creates one hint with unioned provenance, max confidence and summed counters", async () => {
    const llm = new FakeLlm();
    const w = setup({ llm });
    llm.push({ purpose: "consolidate", reply: mergeProposal(w) });
    const tables = w.bySlot("format.tables");
    const units = w.bySlot("returns.units");
    w.flag(REPORTING);
    const report = await w.consolidate();
    expect(report).toMatchObject({ usedLlm: true, merged: 1, opsRejected: 0 });
    const [row] = await w.rows();
    const eventId = row?.event.id ?? "";
    for (const h of [tables, units]) {
      expect(await w.hint(h.id)).toMatchObject({ status: "retired", retiredReason: "merged" });
      expect((await w.hint(h.id))?.provenance.eventIds).toContain(eventId);
    }
    const merged = await w.hint(deterministicId("h", null, SUBJECT, eventId, 0));
    expect(merged).toMatchObject({
      nodePath: REPORTING,
      slot: "report.format",
      value: "tables and percentages",
      text: "Reports returns in percentages and wants a table when comparing more than two funds.",
      kind: tables.kind,
      lane: "responseStyle",
      scope: "category",
      source: "explicit",
      status: "active",
      approval: "auto",
      maturity: "consolidated",
      priority: Math.max(tables.priority, units.priority),
      confidence: Math.max(tables.confidence, units.confidence),
      reinforcements: tables.reinforcements + units.reinforcements,
      applied: tables.applied + units.applied,
      contradictions: 0,
      lastReinforcedAt: tables.lastReinforcedAt,
      createdAt: w.clock.iso(),
    });
    expect(merged?.provenance).toEqual({
      originEventId: "ev_fixture",
      eventIds: [...new Set([...tables.provenance.eventIds, ...units.provenance.eventIds, eventId])],
      runIds: [],
      extractor: { kind: "llm", promptVersion: CONSOLIDATION_PROMPT_VERSION },
    });
    expect((await w.node(REPORTING))?.stats).toEqual({ activeHints: 2, lastIngestAt: w.clock.iso() });
    const created = await w.audit("hint.created");
    expect(created[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, eventId, hintId: merged?.id, detail: { via: "merge_hints", merged: [tables.id, units.id] } });
    // The merged hint is what recall now renders.
    const recall = await w.graph.recall({ subjectId: SUBJECT, text: "Write the quarterly performance report for the client", budgetMs: 1_000 });
    const ids = recall.charter.entries.map((h) => h.id);
    expect(ids).toContain(merged?.id);
    expect(ids).not.toContain(tables.id);
  });

  it("move_hint re-parents a hint and appends the row's event to its provenance", async () => {
    const jargon0 = setup().bySlot("jargon");
    const llm = new FakeLlm([{ purpose: "consolidate", reply: { ops: [{ op: "move_hint", hintId: jargon0.id, nodePath: REPORTING, rationale: "about reports" }] } }]);
    const w = setup({ llm });
    const advice = (await w.node("/consult_advice"))?.stats.activeHints ?? 0;
    w.flag("/consult_advice");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 0 });
    const [row] = await w.rows();
    const reporting = await w.node(REPORTING);
    expect(await w.hint(jargon0.id)).toMatchObject({ status: "active", nodePath: REPORTING, nodeId: reporting?.id, slot: "jargon" });
    expect((await w.hint(jargon0.id))?.provenance.eventIds).toEqual([...jargon0.provenance.eventIds, row?.event.id]);
    expect((await w.node("/consult_advice"))?.stats.activeHints).toBe(advice - 1);
    expect(reporting?.stats.activeHints).toBe(4);
    expect((await w.audit("hint.moved"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, hintId: jargon0.id, nodePath: REPORTING, detail: { via: "move_hint", from: "/consult_advice" } });
  });

  it("split_node creates the children under the node and moves the listed hints into them", async () => {
    const seed = setup();
    const timing = seed.bySlot("cpp_oas.timing");
    const horizon = seed.bySlot("horizon.default");
    const llm = new FakeLlm([
      {
        purpose: "consolidate",
        reply: {
          ops: [
            {
              op: "split_node",
              nodePath: "/consult_advice/retirement",
              children: [
                { slug: "timing", title: "CPP and OAS timing", description: "When to start government benefits.", keywords: ["cpp", "oas", "timing"], hintIds: [timing.id] },
                { slug: "horizon", title: "Projection horizon", description: "How far projections run.", keywords: ["horizon", "projection"], hintIds: [horizon.id] },
              ],
              rationale: "two topics",
            },
          ],
        },
      },
    ]);
    const w = setup({ llm });
    w.flag("/consult_advice/retirement");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 0 });
    const [row] = await w.rows();
    for (const [slug, hint] of [["timing", timing], ["horizon", horizon]] as const) {
      const path = `/consult_advice/retirement/${slug}`;
      const child = await w.node(path);
      expect(child).toMatchObject({ id: deterministicId("n", null, SUBJECT, path), parentPath: "/consult_advice/retirement", level: 3, locked: false, status: "active", stats: { activeHints: 1, lastIngestAt: w.clock.iso() } });
      expect(await w.hint(hint.id)).toMatchObject({ status: "active", nodePath: path, nodeId: child?.id });
    }
    expect(await w.hint(seed.fixture.hints.find((h) => h.slot === "horizon.default" && h.scope === "client")?.id ?? "")).toMatchObject({ nodePath: "/consult_advice/retirement" });
    expect((await w.node("/consult_advice/retirement"))?.stats.activeHints).toBe(1);
    expect((await w.audit("node.created")).map((a) => a.nodePath).sort()).toEqual(["/consult_advice/retirement/horizon", "/consult_advice/retirement/timing"]);
    expect((await w.audit("node.created"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, eventId: row?.event.id });
    // The new children classify.
    const explanation = await w.graph.explain(SUBJECT);
    const retirement = explanation.tree[0]?.children.find((c) => c.node.path === "/consult_advice")?.children.find((c) => c.node.path === "/consult_advice/retirement");
    expect(retirement?.children.map((c) => c.node.path).sort()).toEqual(["/consult_advice/retirement/horizon", "/consult_advice/retirement/timing", "/consult_advice/retirement/withdrawals"]);
  });

  it("merge_nodes moves the source's hints into the target and marks the source merged; a later add on the old path lands on the target", async () => {
    const llm = new FakeLlm([{ purpose: "consolidate", reply: { ops: [{ op: "merge_nodes", fromPath: "/consult_advice/retirement/withdrawals", intoPath: "/consult_advice/retirement", rationale: "same topic" }] } }]);
    const w = setup({ llm });
    const rrif = w.bySlot("rrif.minimums");
    const spouse = w.bySlot("spouse.accounts");
    const retirementBefore = (await w.node("/consult_advice/retirement"))?.stats.activeHints ?? 0;
    w.flag("/consult_advice/retirement");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, merged: 1, opsRejected: 0 });
    const retirement = await w.node("/consult_advice/retirement");
    for (const h of [rrif, spouse]) expect(await w.hint(h.id)).toMatchObject({ status: "active", nodePath: "/consult_advice/retirement", nodeId: retirement?.id });
    expect(retirement?.stats.activeHints).toBe(retirementBefore + 2);
    const withdrawals = await w.node("/consult_advice/retirement/withdrawals");
    expect(withdrawals).toMatchObject({ status: "merged", mergedInto: "/consult_advice/retirement" });
    expect((await w.audit("node.merged"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, nodePath: "/consult_advice/retirement/withdrawals", detail: { into: "/consult_advice/retirement" } });

    llm.push({
      purpose: "extract",
      reply: { ops: [{ op: "add_hint", nodePath: "/consult_advice/retirement/withdrawals", slot: "withdrawal.order", value: "tfsa last", text: "Prefers to draw from the TFSA last.", kind: "preference", lane: "agent", scope: "category", priority: 60, confidence: 0.7, rationale: "r" }] },
    });
    await w.graph.ingest(fixtureTurn(SUBJECT, "turn_after"), { waitFor: "processed" });
    expect((await w.inner.getEvent(null, "turn_after"))?.result?.rejected).toEqual([]);
    expect(await w.hint(deterministicId("h", null, SUBJECT, "turn_after", 0))).toMatchObject({ status: "active", nodePath: "/consult_advice/retirement", nodeId: retirement?.id });
    // The merged node is never a recall target.
    const explanation = await w.graph.explain(SUBJECT);
    const paths = JSON.stringify(explanation.tree);
    expect(paths).not.toContain("/consult_advice/retirement/withdrawals");
  });

  it("alias_slot writes the alias, re-slots active hints (retiring one that would collide), and canonicalises later proposals", async () => {
    const llm = new FakeLlm([{ purpose: "consolidate", reply: { ops: [{ op: "alias_slot", from: "digest.count", to: "digest.size", rationale: "one dimension" }] } }]);
    const w = setup({ llm });
    const size = w.bySlot("digest.size"); // agent consult_newsroom; 0.67 Jaccard with the two rows below, so the rule pass keeps them apart
    const free = fixtureHint(w.ref, { id: "h_digest_cat", nodePath: "/consult_newsroom", slot: "digest.count", value: "five stories", text: "Keeps each newsroom digest to five stories.", scope: "category", kind: "constraint" });
    const collides = fixtureHint(w.ref, { id: "h_digest_agent", nodePath: "/consult_newsroom", slot: "digest.count", value: "five stories", text: "Keeps each newsroom digest to five stories.", scope: "agent", agent: "consult_newsroom", kind: "constraint" });
    await w.inner.applyBatch(w.ref, [{ op: "upsertHint", hint: free }, { op: "upsertHint", hint: collides }]);
    w.flag("/consult_newsroom");

    expect(await w.consolidate()).toMatchObject({ usedLlm: true, merged: 0, opsRejected: 0 });
    const [row] = await w.rows();
    expect((await w.inner.loadSnapshot(w.ref))?.slotAliases).toMatchObject({ "digest.count": "digest.size" });
    expect(await w.hint(free.id)).toMatchObject({ status: "active", slot: "digest.size", scope: "category" });
    expect(await w.hint(collides.id)).toMatchObject({ status: "retired", retiredReason: "merged", slot: "digest.count" });
    expect(await w.hint(size.id)).toMatchObject({ status: "active", slot: "digest.size" });
    expect((await w.audit("slot.aliased"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, eventId: row?.event.id, detail: { from: "digest.count", to: "digest.size" } });
    expect((await w.audit("hint.retired"))[0]).toMatchObject({ hintId: collides.id, detail: { reason: "merged", into: size.id, via: "alias_slot" } });
    expect((await w.node("/consult_newsroom"))?.stats.activeHints).toBe(2);

    // A later proposal that still uses the old slot name reinforces the re-slotted hint instead of creating a second holder.
    llm.push({
      purpose: "extract",
      reply: { ops: [{ op: "add_hint", nodePath: "/consult_newsroom", slot: "digest.count", value: "five stories", text: "Keeps each newsroom digest to five stories.", kind: "constraint", lane: "agent", scope: "category", priority: 60, confidence: 0.8, rationale: "r" }] },
    });
    await w.graph.ingest(fixtureTurn(SUBJECT, "turn_alias", { userText: "Always cap the digest at five stories.", assistantText: "Understood." }), { waitFor: "processed" });
    expect(llm.calls).toHaveLength(2);
    expect(await w.hint(deterministicId("h", null, SUBJECT, "turn_alias", 0))).toBeNull();
    expect(await w.hint(free.id)).toMatchObject({ status: "active", slot: "digest.size", reinforcements: 1 });
    expect((await w.hint(free.id))?.provenance.eventIds).toContain("turn_alias");
    expect(w.logger.find({ msg: "proposal.rewritten" })[0]?.obj).toMatchObject({ eventId: "turn_alias", from: "add_hint", to: "reinforce_hint", target: free.id });
    const slots = graphRows(w.inner).hints.filter((h) => h.status === "active" && h.nodePath === "/consult_newsroom").map((h) => h.slot);
    expect(slots).not.toContain("digest.count");
  });

  it("locked-node targets are rejected with a reason and audited; hints on locked nodes may still move", async () => {
    const seed = setup();
    const tone = seed.bySlot("tone");
    const llm = new FakeLlm([
      {
        purpose: "consolidate",
        reply: {
          ops: [
            { op: "merge_nodes", fromPath: "/consult_kyp", intoPath: "/consult_advice", rationale: "r" },
            { op: "split_node", nodePath: "/", children: [{ slug: "misc", title: "Misc", description: "d", keywords: [], hintIds: [tone.id] }], rationale: "r" },
            { op: "merge_nodes", fromPath: "/consult_advice/retirement", intoPath: "/consult_advice/retirement/withdrawals", rationale: "r" },
            { op: "move_hint", hintId: tone.id, nodePath: "/consult_kyp", rationale: "hints may move onto a category" },
          ],
        },
      },
    ]);
    const w = setup({ llm });
    w.flag("/consult_advice");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 3, merged: 0 });
    const [row] = await w.rows();
    expect(row?.result).toEqual({
      accepted: 1,
      rejected: [
        { op: "merge_nodes", reason: "locked" },
        { op: "split_node", reason: "locked" },
        { op: "merge_nodes", reason: "cycle" },
      ],
    });
    expect(w.logger.find({ level: "warn", msg: "proposal.rejected" }).map((e) => (e.obj as { reason: string }).reason)).toEqual(["locked", "locked", "cycle"]);
    const rejected = await w.audit("op.rejected");
    expect(rejected).toHaveLength(3);
    expect(rejected[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, eventId: row?.event.id });
    for (const path of ["/consult_kyp", "/consult_advice/retirement", "/consult_advice/retirement/withdrawals"]) expect((await w.node(path))?.status).toBe("active");
    expect(await w.node("/misc")).toBeUndefined();
    expect(await w.hint(tone.id)).toMatchObject({ status: "active", nodePath: "/consult_kyp" });
  });

  it("merge_nodes into a locked category is accepted: the category only gains hints, as it would from an add_hint, and its own rows are untouched", async () => {
    const llm = new FakeLlm([{ purpose: "consolidate", reply: { ops: [{ op: "merge_nodes", fromPath: "/consult_advice/retirement", intoPath: "/consult_advice", rationale: "too thin to stand alone" }] } }]);
    const w = setup({ llm });
    const subtree = w.fixture.hints.filter((h) => h.status === "active" && h.nodePath.startsWith("/consult_advice/retirement"));
    const own = w.fixture.hints.filter((h) => h.status === "active" && h.nodePath === "/consult_advice");
    expect(subtree).toHaveLength(5);
    const categoryBefore = await w.node("/consult_advice");
    w.flag("/consult_advice/retirement");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, merged: 1, opsRejected: 0 });
    const [row] = await w.rows();
    expect(row?.result).toEqual({ accepted: 1, rejected: [] });
    const category = await w.node("/consult_advice");
    expect(category).toMatchObject({ status: "active", locked: true, title: categoryBefore?.title, stats: { activeHints: (categoryBefore?.stats.activeHints ?? 0) + subtree.length } });
    for (const h of subtree) expect(await w.hint(h.id)).toMatchObject({ status: "active", nodePath: "/consult_advice", nodeId: category?.id, slot: h.slot, value: h.value });
    for (const h of own) expect(await w.hint(h.id)).toMatchObject({ status: "active", nodePath: "/consult_advice", version: h.version });
    // The whole subtree is folded: the port cannot re-path a node, so the child is marked merged into the category too.
    expect(await w.node("/consult_advice/retirement")).toMatchObject({ status: "merged", mergedInto: "/consult_advice" });
    expect(await w.node("/consult_advice/retirement/withdrawals")).toMatchObject({ status: "merged", mergedInto: "/consult_advice" });
    expect((await w.audit("node.merged")).map((a) => a.nodePath).sort()).toEqual(["/consult_advice/retirement", "/consult_advice/retirement/withdrawals"]);
    expect(await w.audit("op.rejected")).toEqual([]);
  });

  it("a forgotten hint cannot be merged back: the op is rejected as unknown and the id stays gone", async () => {
    const llm = new FakeLlm();
    const w = setup({ llm });
    llm.push({ purpose: "consolidate", reply: mergeProposal(w) });
    const units = w.bySlot("returns.units");
    await w.graph.forget(SUBJECT, units.id);
    w.flag(REPORTING);
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 1, merged: 0 });
    expect((await w.rows())[0]?.result).toEqual({ accepted: 0, rejected: [{ op: "merge_hints", reason: "unknown-hint" }] });
    expect(await w.hint(units.id)).toBeNull();
    expect(await w.hint(w.bySlot("format.tables").id)).toMatchObject({ status: "active" });
  });
});

describe("approved hints through the model pass (§5.6, §10.4)", () => {
  it("merge_hints over an approved hint keeps it active and stores the merge as a pending challenger; a human approving that is what retires the original", async () => {
    const seed = setup();
    const region = seed.bySlot("region.default"); // approved, on "/"
    const currency = seed.bySlot("currency.default"); // auto, on "/"
    const llm = new FakeLlm([
      {
        purpose: "consolidate",
        reply: { ops: [{ op: "merge_hints", hintIds: [region.id, currency.id], slot: "market.default", value: "canada cad", text: "Defaults to Canadian markets and CAD unless another region or currency is named.", rationale: "one default" }] },
      },
    ]);
    const w = setup({ llm });
    const rootBefore = (await w.node("/"))?.stats.activeHints ?? 0;
    w.flag("/");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, merged: 1, opsRejected: 0 });
    const [row] = await w.rows();
    const eventId = row?.event.id ?? "";
    expect(row?.result).toEqual({ accepted: 1, rejected: [] });
    // The approved row is untouched: active, approved, this event nowhere in its provenance.
    expect(await w.hint(region.id)).toMatchObject({ status: "active", approval: "approved", slot: "region.default", value: "canada", provenance: region.provenance });
    expect(await w.hint(currency.id)).toMatchObject({ status: "retired", retiredReason: "merged" });
    const mergedId = deterministicId("h", null, SUBJECT, eventId, 0);
    const merged = await w.hint(mergedId);
    expect(merged).toMatchObject({
      status: "pending",
      approval: "auto",
      supersedes: region.id,
      nodePath: "/",
      slot: "market.default",
      value: "canada cad",
      source: "explicit",
      confidence: Math.max(region.confidence, currency.confidence),
      reinforcements: region.reinforcements + currency.reinforcements,
      applied: region.applied + currency.applied,
    });
    expect(merged?.provenance).toMatchObject({ supersedes: region.id, originEventId: region.provenance.originEventId });
    expect(merged?.provenance.eventIds).toEqual([...new Set([...region.provenance.eventIds, ...currency.provenance.eventIds, eventId])]);
    expect((await w.node("/"))?.stats.activeHints).toBe(rootBefore - 1);
    expect(w.logger.find({ msg: "proposal.rewritten" })[0]?.obj).toMatchObject({ eventId, from: "merge_hints", to: "add_hint", reason: "challenger", target: region.id });
    expect((await w.audit("hint.created"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, eventId, hintId: mergedId, detail: { via: "merge_hints", status: "pending", challenges: region.id, merged: [currency.id] } });
    expect((await w.audit("hint.retired")).map((a) => a.hintId)).toEqual([currency.id]);
    // Recall still renders the approved hint and never the pending merge; explain() puts the merge in front of a human.
    const recall = await w.graph.recall({ subjectId: SUBJECT, text: "How are the big Canadian banks trading this morning?", budgetMs: 1_000 });
    const ids = recall.charter.entries.map((h) => h.id);
    expect(ids).toContain(region.id);
    expect(ids).not.toContain(mergedId);
    expect((await w.graph.explain(SUBJECT)).pendingApproval.map((p) => p.hint.id)).toContain(mergedId);

    // A replay converges without a second model call.
    const before = graphRows(w.inner);
    await w.inner.updateEvent(null, eventId, { status: "pending" });
    await expect(w.graph.maintenance.drain()).resolves.toEqual({ processed: 1, failed: 0 });
    expect(llm.calls).toHaveLength(1);
    expect(graphRows(w.inner)).toEqual(before);

    // The human decides: approving the merge supersedes the original.
    await w.graph.approve(SUBJECT, mergedId, { status: "approved", by: "rm_admin" });
    expect(await w.hint(region.id)).toMatchObject({ status: "superseded", supersededBy: mergedId });
    expect(await w.hint(mergedId)).toMatchObject({ status: "active", approval: "approved" });
  });

  it("merge_hints over two approved hints is refused: two human decisions are never folded into one", async () => {
    const seed = setup();
    const region = seed.bySlot("region.default");
    const currency = seed.bySlot("currency.default");
    const llm = new FakeLlm([{ purpose: "consolidate", reply: { ops: [{ op: "merge_hints", hintIds: [region.id, currency.id], text: "Defaults to Canadian markets and CAD.", rationale: "r" }] } }]);
    const w = setup({ llm });
    await w.graph.approve(SUBJECT, currency.id, { status: "approved", by: "rm_admin" });
    w.flag("/");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, merged: 0, opsRejected: 1 });
    const [row] = await w.rows();
    expect(row?.result).toEqual({ accepted: 0, rejected: [{ op: "merge_hints", reason: "approved" }] });
    expect((await w.audit("op.rejected"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, eventId: row?.event.id, detail: { op: "merge_hints", reason: "approved" } });
    for (const h of [region, currency]) expect(await w.hint(h.id)).toMatchObject({ status: "active", approval: "approved" });
    expect(await w.hint(deterministicId("h", null, SUBJECT, row?.event.id ?? "", 0))).toBeNull();
  });

  it("merge_nodes never folds an approved hint into a holder on the target: the op is refused; an approved holder absorbs an unapproved mover", async () => {
    const reply = { ops: [{ op: "merge_nodes", fromPath: "/consult_advice/retirement/withdrawals", intoPath: "/consult_advice/retirement", rationale: "same topic" }] };
    const seed = setup();
    const rrif = seed.bySlot("rrif.minimums"); // category-scoped, on withdrawals
    const spouse = seed.bySlot("spouse.accounts");
    const holderOf = (w: World) =>
      fixtureHint(w.ref, { id: "h_rrif_holder", nodePath: "/consult_advice/retirement", slot: rrif.slot, value: "december", text: "Prefers RRIF minimums taken in December.", scope: "category", lane: rrif.lane, kind: rrif.kind });

    const w = setup({ llm: new FakeLlm([{ purpose: "consolidate", reply }]) });
    const holder = holderOf(w);
    await w.inner.applyBatch(w.ref, [{ op: "upsertHint", hint: holder }]);
    await w.graph.approve(SUBJECT, rrif.id, { status: "approved", by: "rm_42" });
    w.flag("/consult_advice/retirement");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, merged: 0, opsRejected: 1 });
    const [row] = await w.rows();
    expect(row?.result).toEqual({ accepted: 0, rejected: [{ op: "merge_nodes", reason: "slot-conflict" }] });
    expect((await w.audit("op.rejected"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, eventId: row?.event.id, detail: { op: "merge_nodes", reason: "slot-conflict", detail: expect.stringContaining(rrif.id) } });
    expect(await w.hint(rrif.id)).toMatchObject({ status: "active", approval: "approved", nodePath: "/consult_advice/retirement/withdrawals" });
    expect(await w.hint(spouse.id)).toMatchObject({ status: "active", nodePath: "/consult_advice/retirement/withdrawals" });
    expect(await w.hint(holder.id)).toMatchObject({ status: "active", nodePath: "/consult_advice/retirement" });
    expect((await w.node("/consult_advice/retirement/withdrawals"))?.status).toBe("active");
    expect(await w.audit("hint.moved")).toEqual([]);

    // The other way round, approval wins the key: the unapproved mover folds into the approved holder and the merge lands.
    const other = setup({ llm: new FakeLlm([{ purpose: "consolidate", reply }]) });
    const approvedHolder = holderOf(other);
    await other.inner.applyBatch(other.ref, [{ op: "upsertHint", hint: approvedHolder }]);
    await other.graph.approve(SUBJECT, approvedHolder.id, { status: "approved", by: "rm_42" });
    other.flag("/consult_advice/retirement");
    expect(await other.consolidate()).toMatchObject({ usedLlm: true, merged: 1, opsRejected: 0 });
    expect(await other.hint(rrif.id)).toMatchObject({ status: "retired", retiredReason: "merged" });
    expect(await other.hint(approvedHolder.id)).toMatchObject({ status: "active", approval: "approved", nodePath: "/consult_advice/retirement" });
    expect(await other.hint(spouse.id)).toMatchObject({ status: "active", nodePath: "/consult_advice/retirement" });
    expect((await other.node("/consult_advice/retirement/withdrawals"))?.status).toBe("merged");
  });

  it("split_node moves an approved hint onto the new child intact: approval forbids retirement, not relocation", async () => {
    const seed = setup();
    const timing = seed.bySlot("cpp_oas.timing");
    const llm = new FakeLlm([
      {
        purpose: "consolidate",
        reply: {
          ops: [{ op: "split_node", nodePath: "/consult_advice/retirement", children: [{ slug: "timing", title: "CPP and OAS timing", description: "When to start government benefits.", keywords: ["cpp", "oas"], hintIds: [timing.id] }], rationale: "r" }],
        },
      },
    ]);
    const w = setup({ llm });
    await w.graph.approve(SUBJECT, timing.id, { status: "approved", by: "rm_42" });
    w.flag("/consult_advice/retirement");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 0 });
    const child = await w.node("/consult_advice/retirement/timing");
    expect(await w.hint(timing.id)).toMatchObject({ status: "active", approval: "approved", nodePath: "/consult_advice/retirement/timing", nodeId: child?.id });
    expect(child?.stats.activeHints).toBe(1);
    expect((await w.audit("hint.moved"))[0]).toMatchObject({ hintId: timing.id, detail: { via: "split_node" } });
    expect(await w.audit("hint.retired")).toEqual([]);
  });

  it("alias_slot never retires an approved hint into a holder; an alias of an alias is written for both names and the approved hint is re-slotted, not retired", async () => {
    const seed = setup();
    const region = seed.bySlot("region.default"); // approved; `region` already aliases to it
    const tone = seed.bySlot("tone");
    const llm = new FakeLlm([{ purpose: "consolidate", reply: { ops: [{ op: "alias_slot", from: "region.default", to: "tone", rationale: "r" }] } }]);
    const w = setup({ llm });
    const aliasesBefore = (await w.inner.loadSnapshot(w.ref))?.slotAliases;
    w.flag("/");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 1 });
    expect((await w.rows())[0]?.result).toEqual({ accepted: 0, rejected: [{ op: "alias_slot", reason: "slot-conflict" }] });
    expect((await w.audit("op.rejected"))[0]).toMatchObject({ detail: { op: "alias_slot", reason: "slot-conflict", detail: expect.stringContaining(region.id) } });
    expect(await w.hint(region.id)).toMatchObject({ status: "active", approval: "approved", slot: "region.default" });
    expect(await w.hint(tone.id)).toMatchObject({ status: "active", slot: "tone" });
    expect((await w.inner.loadSnapshot(w.ref))?.slotAliases).toEqual(aliasesBefore);

    w.clock.tick(1);
    llm.push({ purpose: "consolidate", reply: { ops: [{ op: "alias_slot", from: "region", to: "region.home", rationale: "r" }] } });
    w.flag("/");
    expect(await w.consolidate()).toMatchObject({ usedLlm: true, opsRejected: 0 });
    expect((await w.inner.loadSnapshot(w.ref))?.slotAliases).toMatchObject({ region: "region.home", "region.default": "region.home" });
    expect(await w.hint(region.id)).toMatchObject({ status: "active", approval: "approved", slot: "region.home" });
    expect((await w.audit("slot.aliased"))[0]).toMatchObject({ actor: CONSOLIDATE_LLM_ACTOR, detail: { from: "region", to: "region.home", canonicalFrom: "region.default" } });
    // A later proposal naming the old canonical slot reinforces the re-slotted hint instead of minting a second holder beside it.
    llm.push({
      purpose: "extract",
      reply: { ops: [{ op: "add_hint", nodePath: "/", slot: "region.default", value: "canada", text: "Defaults to Canadian markets when the region is not stated.", kind: "fact", lane: "preRoute", scope: "global", priority: 80, confidence: 0.9, rationale: "r" }] },
    });
    await w.graph.ingest(fixtureTurn(SUBJECT, "turn_region", { userText: "Always assume Canadian markets unless I say otherwise.", assistantText: "Noted." }), { waitFor: "processed" });
    expect(llm.calls).toHaveLength(3);
    expect(await w.hint(deterministicId("h", null, SUBJECT, "turn_region", 0))).toBeNull();
    expect(await w.hint(region.id)).toMatchObject({ status: "active", approval: "approved", slot: "region.home", reinforcements: region.reinforcements + 1 });
    expect(graphRows(w.inner).hints.filter((h) => h.status === "active" && h.nodePath === "/" && h.slot.startsWith("region"))).toHaveLength(1);
  });
});
