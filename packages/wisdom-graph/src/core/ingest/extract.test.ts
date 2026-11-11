/**
 * The extraction step against a scripted model: tolerant parsing, one
 * retry with the problem echoed when the reply is not a proposal at all,
 * `unparseable` after the second failure and remembered on the row, the
 * call shape spec §5.5 fixes (json, purpose, maxTokens, a signal under
 * the timeout deadline), the source set by the library and never the
 * model, structural faults judged op by op rather than retried, and the
 * whole path through a real engine — proposal persisted on the row, ops
 * applied, counters and logs in place.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deterministicId } from "../ids";
import { defaultPolicy, type DeepPartial, type PolicyConfig } from "../policy";
import { noopLogger, type LlmPort, type SubjectRef } from "../ports";
import type { HintRecord, TurnEvent, WisdomGraphOptions } from "../types";
import type { Proposal } from "../schema/proposal";
import { compileSnapshot, type SubjectSnapshot } from "../graph/snapshot";
import { MemoryStore } from "../store/memory";
import { WisdomGraphEngine } from "../engine";
import { CapturingTracer, CollectingLogger, FakeClock, FakeLlm } from "../../testing/fakes";
import { fixtureFeedback, fixtureTurn, advisorFixture } from "../../testing/fixtures";
import { USER_TEXT_OPEN } from "../text/sanitize";
import { RETRY_PREFIX } from "./prompts";
import { EXTRACTION_ATTEMPTS, extractJson, fetchExtraRecords, focusPathsFor, proposalEnvelope, referencedHintIds, runExtraction, unparseableProposal, type ExtractionContext } from "./extract";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const GATED = "Stop adding disclaimers please, and always use bullets.";

const goodProposal = (over: Partial<Proposal["ops"][number]> = {}): Proposal => ({
  ops: [
    {
      op: "add_hint",
      nodePath: "/consult_advice",
      slot: "format.headline",
      value: "short headline",
      text: "Likes a short headline before the detail.",
      kind: "style",
      lane: "responseStyle",
      scope: "category",
      priority: 60,
      confidence: 0.7,
      rationale: "the user asked for it",
      ...over,
    } as Proposal["ops"][number],
  ],
});

async function snapshotOf(store: MemoryStore, clock: FakeClock, categories = advisorFixture().categories): Promise<SubjectSnapshot> {
  return compileSnapshot(await store.loadSnapshot(ref), defaultPolicy, noopLogger, { ref, categories, clock });
}

function context(clock: FakeClock, over: Partial<ExtractionContext> = {}): ExtractionContext {
  return { policy: defaultPolicy, clock, anchor: null, source: "inferred", logger: new CollectingLogger(), ...over };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("extractJson", () => {
  it.each<[string, string, unknown]>([
    ["a bare object", '{"ops":[]}', { ops: [] }],
    ["a fenced object", '```json\n{"ops":[{"op":"noop","rationale":"r"}]}\n```', { ops: [{ op: "noop", rationale: "r" }] }],
    ["prose around the object", 'Sure! Here you go:\n{"ops":[]}\nHope that helps.', { ops: [] }],
    ["braces and quotes inside strings", '{"ops":[{"op":"noop","rationale":"a } brace and a \\" quote { here"}]}', { ops: [{ op: "noop", rationale: 'a } brace and a " quote { here' }] }],
    ["nested objects", '{"ops":[{"op":"set_property","nodePath":"/","key":"k","value":{"a":{"b":1}}}]} trailing {', { ops: [{ op: "set_property", nodePath: "/", key: "k", value: { a: { b: 1 } } }] }],
  ])("parses %s", (_name, text, value) => {
    expect(extractJson(text)).toEqual({ ok: true, value });
  });

  it.each<[string, string, string]>([
    ["no object at all", "I cannot help with that.", "no JSON object"],
    ["a truncated reply", '{"ops":[{"op":"noop","rationale":"r"', "unbalanced"],
    ["invalid JSON inside the braces", "{ops: []}", "invalid JSON"],
    ["a string inside the braces never closed", '{"ops": "', "unbalanced"],
  ])("reports %s", (_name, text, reason) => {
    const parsed = extractJson(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });
});

describe("runExtraction (§5.5)", () => {
  it("calls the model in JSON mode with purpose, maxTokens and a signal, and returns the validated proposal", async () => {
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const snapshot = await snapshotOf(fixture.store, clock);
    const llm = new FakeLlm([{ purpose: "extract", reply: goodProposal() }]);
    const turn = fixtureTurn("rm_42", "t1", { userText: GATED });
    const logger = new CollectingLogger();
    const proposal = await runExtraction(llm, snapshot, turn, context(clock, { anchor: turn, logger }));
    expect(proposal).toEqual(goodProposal());
    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0] as { prompt: string; opts: Parameters<LlmPort["complete"]>[1] };
    expect(call.opts).toMatchObject({ json: true, purpose: "extract", maxTokens: 1500 });
    expect(call.opts.signal).toBeInstanceOf(AbortSignal);
    expect(call.opts.signal?.aborted).toBe(false);
    expect(call.prompt).toContain("GRAPH OUTLINE");
    expect(call.prompt).toContain(USER_TEXT_OPEN);
    expect(call.prompt).toContain("Classified path for this evidence: /consult_advice");
    const line = logger.find({ level: "debug", msg: "llm.call" })[0]?.obj as Record<string, unknown>;
    expect(line).toMatchObject({ purpose: "extract", ok: true, eventId: "t1", subjectId: "rm_42" });
    expect(typeof line.promptTokens).toBe("number");
    expect(typeof line.responseTokens).toBe("number");
    expect(typeof line.elapsedMs).toBe("number");
  });

  it("retries exactly once with the problems echoed, then gives up with null", async () => {
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const snapshot = await snapshotOf(fixture.store, clock);
    const turn = fixtureTurn("rm_42", "t1", { userText: GATED });

    const fixed = new FakeLlm([{ reply: "not json at all" }, { reply: goodProposal() }]);
    await expect(runExtraction(fixed, snapshot, turn, context(clock, { anchor: turn }))).resolves.toEqual(goodProposal());
    expect(fixed.calls).toHaveLength(2);
    const retry = fixed.calls[1]?.prompt as string;
    expect(retry.startsWith(fixed.calls[0]?.prompt as string)).toBe(true);
    expect(retry).toContain(`${RETRY_PREFIX}\n- no JSON object in the reply`);

    const hopeless = new FakeLlm([{ reply: "{ nope" }, { reply: "still nope" }, { reply: goodProposal() }]);
    const logger = new CollectingLogger();
    await expect(runExtraction(hopeless, snapshot, turn, context(clock, { anchor: turn, logger }))).resolves.toBeNull();
    expect(hopeless.calls).toHaveLength(EXTRACTION_ATTEMPTS);
    expect(logger.find({ msg: "llm.invalid-proposal" }).map((e) => (e.obj as { attempt: number }).attempt)).toEqual([1, 2]);
  });

  it("never retries a proposal whose ops are structurally off — gate 1 judges each op — and retries only a reply without an ops array", async () => {
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const snapshot = await snapshotOf(fixture.store, clock);
    const turn = fixtureTurn("rm_42", "t1", { userText: GATED });
    const off = goodProposal({ scope: "agent", agent: "consult_nobody" } as Partial<Proposal["ops"][number]>);
    const llm = new FakeLlm([{ reply: off }, { reply: goodProposal() }]);
    await expect(runExtraction(llm, snapshot, turn, context(clock, { anchor: turn }))).resolves.toEqual(off);
    expect(llm.calls).toHaveLength(1);
    // The ops are kept as written — a smuggled `source` included, for gate 1 to refuse — and unknown top-level keys are dropped.
    const smuggled = { ops: [{ ...goodProposal().ops[0], source: "explicit" }], notes: "n", extra: true };
    const loose = new FakeLlm([{ reply: smuggled }]);
    await expect(runExtraction(loose, snapshot, turn, context(clock, { anchor: turn }))).resolves.toEqual({ ops: smuggled.ops, notes: "n" });
    expect(proposalEnvelope({ ops: [], notes: 1 })).toEqual({ ok: true, value: { ops: [] } });
    expect(proposalEnvelope([])).toMatchObject({ ok: false, reason: expect.stringContaining("not a JSON object") });
    expect(proposalEnvelope({ operations: [] })).toMatchObject({ ok: false, reason: '"ops" must be an array of operations' });
    // No ops array is not a proposal: one retry naming the problem, built from the original prompt, then null.
    const envelope = new FakeLlm([{ reply: { operations: [] } }, { reply: { ops: "none" } }, { reply: goodProposal() }]);
    const logger = new CollectingLogger();
    await expect(runExtraction(envelope, snapshot, turn, context(clock, { anchor: turn, logger }))).resolves.toBeNull();
    expect(envelope.calls).toHaveLength(2);
    expect(envelope.calls[1]?.prompt).toContain(`${RETRY_PREFIX}\n- "ops" must be an array of operations`);
    expect((envelope.calls[1]?.prompt as string).match(new RegExp(RETRY_PREFIX, "g"))).toHaveLength(1);
    expect(logger.find({ msg: "llm.invalid-proposal" }).map((e) => (e.obj as { attempt: number }).attempt)).toEqual([1, 2]);
    // A vocabulary the caller supplies reaches the prompt.
    const wider = new FakeLlm([{ reply: goodProposal() }]);
    await runExtraction(wider, snapshot, turn, context(clock, { anchor: turn, agents: ["consult_nobody"] }));
    expect(wider.calls[0]?.prompt).toContain("- consult_nobody (learned from routing history)");
  });

  it("propagates a model error, a timeout on llmTimeoutMs, and the worker's abort as attempt failures", async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const snapshot = await snapshotOf(fixture.store, clock);
    const turn = fixtureTurn("rm_42", "t1", { userText: GATED });

    const boom = new FakeLlm([{ reply: "", throws: new Error("model down") }]);
    await expect(runExtraction(boom, snapshot, turn, context(clock, { anchor: turn }))).rejects.toThrow("model down");

    const hung = new FakeLlm([{ reply: "", hang: true }]);
    const logger = new CollectingLogger();
    const policy = { ...defaultPolicy, ingest: { ...defaultPolicy.ingest, llmTimeoutMs: 50 } };
    const timedOut = runExtraction(hung, snapshot, turn, context(clock, { anchor: turn, logger, policy }));
    const settled = timedOut.then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.name : String(e)),
    );
    await vi.advanceTimersByTimeAsync(49);
    expect(hung.calls[0]?.opts.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toBe("TimeoutError");
    expect(hung.calls[0]?.opts.signal?.aborted).toBe(true);
    expect(logger.find({ msg: "llm.call" })[0]?.obj).toMatchObject({ ok: false, timedOut: true });

    const controller = new AbortController();
    const waiting = new FakeLlm([{ reply: "", hang: true }]);
    const aborted = runExtraction(waiting, snapshot, turn, context(clock, { anchor: turn, signal: controller.signal }));
    const outcome = aborted.then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("closing"));
    expect(await outcome).toBe("closing");

    const deaf = { complete: () => new Promise<string>(() => undefined) };
    const ignored = runExtraction(deaf, snapshot, turn, context(clock, { anchor: turn, policy }));
    const ignoredOutcome = ignored.then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.name : String(e)),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await ignoredOutcome).toBe("TimeoutError");
  });

  it("focuses the outline on the classified paths, the router's category and the targeted hints' nodes", async () => {
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const snapshot = await snapshotOf(fixture.store, clock);
    const retirement = "How should we sequence RRIF withdrawals for a retiree with a large TFSA?";
    const turn = fixtureTurn("rm_42", "t1", { userText: retirement, category: "consult_meetings" });
    const paths = focusPathsFor(snapshot, turn, turn, [], defaultPolicy);
    expect(paths[0]?.startsWith("/consult_advice")).toBe(true);
    expect(paths).toContain("/consult_meetings");
    const kyp = snapshot.records.find((r) => r.slot === "kyp.first") as HintRecord;
    const feedback = fixtureFeedback("rm_42", "fb", { runId: "run_t1", signal: "comment", text: "Too long." });
    expect(focusPathsFor(snapshot, feedback, turn, [kyp], defaultPolicy)).toContain("/consult_kyp");
    expect(focusPathsFor(snapshot, fixtureTurn("rm_42", "t2", { userText: "hi" }), null, [], defaultPolicy)).toEqual([]);
    expect(focusPathsFor(snapshot, fixtureTurn("rm_42", "t3", { userText: "hi", category: "not_configured" }), fixtureTurn("rm_42", "t3", { userText: "hi", category: "not_configured" }), [], defaultPolicy)).toEqual([]);
  });

  it("names the rows a proposal refers to and fetches the ones the snapshot lacks", async () => {
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const snapshot = await snapshotOf(fixture.store, clock);
    const pending = fixture.hints.find((h) => h.status === "pending") as HintRecord;
    const superseded = fixture.hints.find((h) => h.status === "superseded") as HintRecord;
    const active = snapshot.records[0] as HintRecord;
    const proposal: Proposal = {
      ops: [
        goodProposal().ops[0] as Proposal["ops"][number],
        { op: "update_hint", hintId: pending.id, text: "Prefers x.", rationale: "r" },
        { op: "reinforce_hint", hintId: active.id },
        { op: "retire_hint", hintId: superseded.id, reason: "obsolete", rationale: "r" },
        { op: "create_node", parentPath: "/consult_kyp", slug: "x", title: "X", description: "d", keywords: [], hints: [goodProposal().ops[0] as never, goodProposal().ops[0] as never], rationale: "r" },
        { op: "noop", rationale: "r" },
      ],
    };
    const ids = referencedHintIds(proposal, ref, "ev_1");
    const mint = (label: string | number): string => deterministicId("h", null, "rm_42", "ev_1", label);
    expect(ids).toEqual([mint(0), pending.id, mint(1), active.id, superseded.id, mint("4.0"), mint("4.1")]);
    const extra = await fetchExtraRecords(fixture.store, ref, snapshot, ids);
    expect(extra.map((h) => h.id).sort()).toEqual([pending.id, superseded.id].sort());
    expect(await fetchExtraRecords(fixture.store, ref, snapshot, [active.id])).toEqual([]);
  });
});

describe("through the engine (§5.2, §5.5, §5.6)", () => {
  interface Options {
    llm?: LlmPort;
    policy?: DeepPartial<PolicyConfig>;
    queue?: WisdomGraphOptions["queue"];
  }

  function setup(over: Options = {}) {
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const logger = new CollectingLogger();
    const tracer = new CapturingTracer();
    const graph = new WisdomGraphEngine({
      store: fixture.store,
      categories: fixture.categories,
      clock,
      logger,
      tracer,
      ...(over.llm !== undefined ? { llm: over.llm } : {}),
      ...(over.policy !== undefined ? { policy: over.policy } : {}),
      ...(over.queue !== undefined ? { queue: over.queue } : {}),
    });
    const bySlot = (slot: string): HintRecord => fixture.hints.find((h) => h.slot === slot && h.status === "active") as HintRecord;
    return { graph, store: fixture.store, logger, tracer, clock, fixture, bySlot };
  }

  const turnOf = (id: string, over: Partial<TurnEvent> = {}): TurnEvent => fixtureTurn("rm_42", id, { userText: GATED, assistantText: "Understood.", agentsUsed: ["consult_advice"], model: "gemini-2.5-pro", ...over });

  it("malformed JSON twice: one retry, then the event is done with result.rejected 'unparseable' and the rejection counted and audited", async () => {
    const llm = new FakeLlm([{ reply: "garbage" }, { reply: "more garbage" }, { reply: goodProposal() }]);
    const w = setup({ llm });
    await expect(w.graph.ingest(turnOf("turn_bad"), { waitFor: "processed" })).resolves.toMatchObject({ status: "processed" });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.prompt).toContain(RETRY_PREFIX);
    const row = await w.store.getEvent(null, "turn_bad");
    // `accepted` counts the turn's own ledger ops (keyword refresh) too; extraction contributed none.
    expect(row).toMatchObject({ status: "done", result: { rejected: [{ op: "*", reason: "unparseable" }] } });
    // Remembered on the row, so a replay repeats the verdict without calling the model (§5.2).
    expect(row?.proposal).toEqual(unparseableProposal());
    expect(w.graph.stats()).toMatchObject({ llmCalls: 2, opsRejected: 1, processed: 1 });
    expect(await w.store.getHint(ref, deterministicId("h", null, "rm_42", "turn_bad", 0))).toBeNull();
    expect(w.logger.find({ level: "warn", msg: "proposal.rejected" })[0]?.obj).toMatchObject({ eventId: "turn_bad", op: "*", reason: "unparseable" });
    const audit = await w.store.listAudit(ref, 10);
    expect(audit[0]).toMatchObject({ actor: "llm:extract@1", action: "op.rejected", eventId: "turn_bad", detail: { op: "*", reason: "unparseable" } });
    expect(w.logger.find({ msg: "ingest.processed" })[0]?.obj).toMatchObject({ extracted: true, opsRejected: 1 });
    // No raw text on any log line.
    for (const entry of w.logger.entries) expect(JSON.stringify(entry.obj)).not.toContain(GATED);
  });

  it("a valid proposal is persisted on the row before apply, its ops land with the library's source, and every rejection is logged with its reason", async () => {
    const proposal: Proposal = {
      ops: [
        ...goodProposal().ops,
        { op: "reinforce_hint", hintId: "h_made_up" },
        { op: "set_property", nodePath: "/consult_market_analyst", key: "region.default", value: "CA" },
      ],
    };
    const llm = new FakeLlm([{ purpose: "extract", reply: proposal }]);
    const w = setup({ llm });
    const lists = w.bySlot("format.lists");
    await expect(w.graph.ingest(turnOf("turn_ok", { appliedHintIds: [lists.id] }), { waitFor: "processed" })).resolves.toMatchObject({ status: "processed" });
    const row = await w.store.getEvent(null, "turn_ok");
    expect(row).toMatchObject({ status: "done", proposal, result: { rejected: [{ op: "reinforce_hint", reason: "unknown-hint" }] } });
    expect(row?.result?.accepted).toBeGreaterThanOrEqual(3);
    const created = await w.store.getHint(ref, deterministicId("h", null, "rm_42", "turn_ok", 0));
    expect(created).toMatchObject({
      nodePath: "/consult_advice",
      slot: "format.headline",
      value: "short headline",
      source: "inferred",
      status: "active",
      maturity: "captured",
      provenance: { originEventId: "turn_ok", eventIds: ["turn_ok"], runIds: ["run_turn_ok"], extractor: { kind: "llm", promptVersion: "extract@1" } },
    });
    // The turn's `model` is the chat model, not the extractor's; the port does not report one, so none is claimed.
    expect(created?.provenance.extractor).not.toHaveProperty("model");
    const analyst = (await w.store.loadSnapshot(ref))?.nodes.find((n) => n.path === "/consult_market_analyst");
    expect(analyst?.properties).toEqual({ "region.default": "CA" });
    expect((await w.store.getHint(ref, lists.id))?.applied).toBe(lists.applied + 1);
    expect(w.graph.stats()).toMatchObject({ llmCalls: 1, opsRejected: 1 });
    expect(w.graph.stats().opsAccepted).toBeGreaterThanOrEqual(3);
    expect(w.logger.find({ level: "warn", msg: "proposal.rejected" })[0]?.obj).toMatchObject({ eventId: "turn_ok", op: "reinforce_hint", reason: "unknown-hint", index: 1 });
    expect(w.tracer.named("wisdom.ingest.extract")[0]).toMatchObject({ ended: true, attrs: { "wisdom.ops_accepted": 2, "wisdom.ops_rejected": 1 } });
    const audit = (await w.store.listAudit(ref, 20)).filter((a) => a.eventId === "turn_ok" && a.actor.startsWith("llm:"));
    expect(audit.map((a) => a.action).sort()).toEqual(["hint.created", "node.property", "op.rejected"].sort());
    expect(audit.every((a) => a.actor === "llm:extract@1")).toBe(true);
  });

  it("one bad op costs only itself: a consolidation-only op and a malformed op beside a good one are rejected with their reason codes, the good one lands, and the model is called once", async () => {
    const good = goodProposal().ops[0] as Proposal["ops"][number];
    const proposal = {
      ops: [
        good,
        { op: "merge_nodes", fromPath: "/consult_advice/retirement", intoPath: "/consult_advice", rationale: "tidy" },
        { ...good, nodePath: "/consult_kyp", slot: "kyp.x", source: "explicit" },
      ],
    };
    const llm = new FakeLlm([{ purpose: "extract", reply: proposal }, { purpose: "extract", reply: goodProposal() }]);
    const w = setup({ llm });
    await expect(w.graph.ingest(turnOf("turn_mixed"), { waitFor: "processed" })).resolves.toMatchObject({ status: "processed" });
    expect(llm.calls).toHaveLength(1);
    const row = await w.store.getEvent(null, "turn_mixed");
    expect(row).toMatchObject({
      status: "done",
      proposal,
      result: {
        rejected: [
          { op: "merge_nodes", reason: "consolidation-only" },
          { op: "add_hint", reason: "invalid" },
        ],
      },
    });
    expect(await w.store.getHint(ref, deterministicId("h", null, "rm_42", "turn_mixed", 0))).toMatchObject({ slot: "format.headline", source: "inferred", status: "active" });
    expect(await w.store.getHint(ref, deterministicId("h", null, "rm_42", "turn_mixed", 2))).toBeNull();
    expect((await w.store.loadSnapshot(ref))?.nodes.find((n) => n.path === "/consult_advice/retirement")?.status).toBe("active");
    expect(w.graph.stats()).toMatchObject({ llmCalls: 1, opsRejected: 2 });
    const warned = w.logger.find({ level: "warn", msg: "proposal.rejected" }).map((e) => e.obj as { op: string; reason: string; index: number });
    expect(warned).toEqual([
      expect.objectContaining({ eventId: "turn_mixed", op: "merge_nodes", reason: "consolidation-only", index: 1 }),
      expect.objectContaining({ eventId: "turn_mixed", op: "add_hint", reason: "invalid", index: 2, detail: expect.stringContaining("/ops/2/source") }),
    ]);
    const audit = (await w.store.listAudit(ref, 20)).filter((a) => a.eventId === "turn_mixed" && a.action === "op.rejected");
    expect(audit.map((a) => a.detail.reason).sort()).toEqual(["consolidation-only", "invalid"]);
  });

  it("feedback with text extracts as explicit, lists the applied hints, biases a correction toward update_hint, and honours the target", async () => {
    const disclaimers = setup().bySlot("disclaimers");
    const proposal: Proposal = {
      ops: [
        { op: "update_hint", hintId: disclaimers.id, text: "Omits regulatory disclaimers entirely.", value: "omit entirely", rationale: "corrected" },
        { op: "add_hint", nodePath: "/consult_kyp", slot: "kyp.x", value: "x", text: "Prefers x.", kind: "preference", lane: "agent", scope: "category", priority: 50, confidence: 0.5, rationale: "r" },
      ],
    };
    const llm = new FakeLlm([{ reply: proposal }]);
    const w = setup({ llm });
    await w.graph.ingest(turnOf("turn_c", { runId: "run_c", appliedHintIds: [disclaimers.id] }), { waitFor: "processed", extract: "skip" });
    await expect(w.graph.ingest(fixtureFeedback("rm_42", "fb_c", { runId: "run_c", signal: "correction", text: "No — never add disclaimers at all.", target: "agent:consult_advice" }), { waitFor: "processed" })).resolves.toMatchObject({ status: "processed" });
    expect(llm.calls).toHaveLength(1);
    const prompt = llm.calls[0]?.prompt as string;
    expect(prompt).toContain("Feedback signal: correction (target: agent:consult_advice)");
    expect(prompt).toContain("prefer updating the applied hint that caused it");
    expect(prompt).toContain(disclaimers.id);
    expect(prompt).toContain("Source the library will record for new hints: explicit");
    const row = await w.store.getEvent(null, "fb_c");
    expect(row?.result).toEqual({ accepted: 1, rejected: [{ op: "add_hint", reason: "off-target" }] });
    expect(await w.store.getHint(ref, disclaimers.id)).toMatchObject({ value: "omit entirely", text: "Omits regulatory disclaimers entirely.", source: "explicit" });
  });

  it("a model that hangs past llmTimeoutMs fails the attempt onto the backoff schedule; the next attempt calls again", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlm([{ reply: "", hang: true }, { reply: goodProposal() }]);
    const w = setup({ llm, policy: { ingest: { llmTimeoutMs: 100 } } });
    const receipt = w.graph.ingest(turnOf("turn_slow"), { waitFor: "processed" });
    await vi.advanceTimersByTimeAsync(100);
    expect(await w.store.getEvent(null, "turn_slow")).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("TimeoutError") });
    expect(w.logger.find({ level: "warn", msg: "ingest.retry" })).toHaveLength(1);
    w.clock.tick(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(receipt).resolves.toMatchObject({ status: "processed" });
    expect(llm.calls).toHaveLength(2);
    expect(await w.store.getEvent(null, "turn_slow")).toMatchObject({ status: "done", attempts: 2, result: { rejected: [] } });
    expect(await w.store.getHint(ref, deterministicId("h", null, "rm_42", "turn_slow", 0))).toMatchObject({ slot: "format.headline" });
    expect(w.graph.stats().llmCalls).toBe(2);
    await w.graph.close();
  });

  it("close({ graceMs }) aborts a model call in flight once the grace is over and leaves the row on the backoff schedule for drain()", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlm([{ reply: "", hang: true }]);
    const w = setup({ llm });
    const receipt = w.graph.ingest(turnOf("turn_close"), { waitFor: "processed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(llm.calls).toHaveLength(1);
    let resolved = false;
    const closing = w.graph.close({ graceMs: 1_000 }).then(() => {
      resolved = true;
    });
    // Within the grace the call runs on; the signal is aborted the moment it ends.
    await vi.advanceTimersByTimeAsync(999);
    expect(llm.calls[0]?.opts.signal?.aborted).toBe(false);
    expect(resolved).toBe(false);
    w.clock.tick(1_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(llm.calls[0]?.opts.signal?.aborted).toBe(true);
    await closing;
    expect(resolved).toBe(true);
    await expect(receipt).resolves.toMatchObject({ eventId: "turn_close", status: "recorded", reason: expect.stringContaining("closed") });
    expect(await w.store.getEvent(null, "turn_close")).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("WisdomGraph closed"), retryAt: expect.any(String) });
    // A second close() joins the first; nothing runs afterwards.
    await w.graph.close();
    expect(llm.calls).toHaveLength(1);
  });

  it("close() drops the backlog without starting its model calls and is bounded by one grace, not by the queue depth", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlm([{ reply: "", hang: true }, { reply: "", hang: true }, { reply: "", hang: true }]);
    const w = setup({ llm, queue: { concurrency: 1 } });
    const receipts = ["turn_c1", "turn_c2", "turn_c3"].map((id) => w.graph.ingest(turnOf(id), { waitFor: "processed", extract: "force" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(llm.calls).toHaveLength(1);
    expect(w.graph.stats().queueDepth).toBe(3);
    let resolved = false;
    const closing = w.graph.close().then(() => {
      resolved = true;
    });
    // The two waiting jobs are cancelled at once; their rows are untouched and still pending.
    await vi.advanceTimersByTimeAsync(0);
    await expect(receipts[1]).resolves.toMatchObject({ eventId: "turn_c2", status: "recorded", reason: expect.stringContaining("closed") });
    await expect(receipts[2]).resolves.toMatchObject({ eventId: "turn_c3", status: "recorded", reason: expect.stringContaining("closed") });
    expect(await w.store.getEvent(null, "turn_c2")).toMatchObject({ status: "pending", attempts: 0 });
    expect(await w.store.getEvent(null, "turn_c3")).toMatchObject({ status: "pending", attempts: 0 });
    expect(w.graph.stats().queueDepth).toBe(1);
    expect(resolved).toBe(false);
    // The default grace is one model call's deadline; the running call is interrupted then, and no other call ever starts.
    w.clock.tick(defaultPolicy.ingest.llmTimeoutMs);
    await vi.advanceTimersByTimeAsync(defaultPolicy.ingest.llmTimeoutMs);
    await closing;
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.opts.signal?.aborted).toBe(true);
    await expect(receipts[0]).resolves.toMatchObject({ eventId: "turn_c1", status: "recorded", reason: expect.stringContaining("closed") });
    expect(await w.store.getEvent(null, "turn_c1")).toMatchObject({ status: "failed", attempts: 1, retryAt: expect.any(String) });
    expect(w.graph.stats().queueDepth).toBe(0);
  });

  it("close({ graceMs: 0 }) interrupts at once; close() with nothing running resolves without waiting", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlm([{ reply: "", hang: true }]);
    const w = setup({ llm });
    const receipt = w.graph.ingest(turnOf("turn_now"), { waitFor: "processed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(llm.calls).toHaveLength(1);
    const closing = w.graph.close({ graceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(llm.calls[0]?.opts.signal?.aborted).toBe(true);
    await closing;
    await expect(receipt).resolves.toMatchObject({ status: "recorded", reason: expect.stringContaining("closed") });
    expect(await w.store.getEvent(null, "turn_now")).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("WisdomGraph closed") });

    const idle = setup({ llm: new FakeLlm([]) });
    await idle.graph.close();
    expect(idle.graph.stats().queueDepth).toBe(0);
  });

  it("retention.logRawText: raw text appears on `ingest.recorded` at debug only when the flag is on", async () => {
    const marker = "ZEBRAQUARTZ";
    const turn = turnOf("turn_raw", { userText: `${marker} user`, assistantText: `${marker} assistant` });
    const feedback = fixtureFeedback("rm_42", "fb_raw", { runId: turn.runId, text: `${marker} feedback` });
    for (const logRawText of [false, true]) {
      const w = setup({ llm: new FakeLlm([]), policy: { retention: { logRawText } } });
      await w.graph.ingest(turn, { waitFor: "processed", extract: "skip" });
      await w.graph.ingest(feedback, { waitFor: "processed", extract: "skip" });
      const recorded = w.logger.find({ msg: "ingest.recorded" });
      expect(recorded).toHaveLength(2);
      expect(recorded.every((e) => e.level === "debug")).toBe(true);
      const carrying = w.logger.entries.filter((e) => JSON.stringify(e.obj).includes(marker));
      if (logRawText) {
        expect(recorded[0]?.obj).toMatchObject({ eventId: "turn_raw", userText: `${marker} user`, assistantText: `${marker} assistant` });
        expect(recorded[1]?.obj).toMatchObject({ eventId: "fb_raw", text: `${marker} feedback` });
        expect(carrying.every((e) => e.msg === "ingest.recorded")).toBe(true);
      } else {
        expect(carrying).toHaveLength(0);
      }
      await w.graph.close();
    }
  });
});
