/**
 * The injection helpers are checked against the compiler they wrap: each
 * site's helper is `""` on an empty lane and otherwise exactly what
 * `compileCharter` renders for that lane, the agent preamble keeps the
 * bucket the assembler built (mirrored voice hints included) and serves
 * `agentDefaults` to an unknown agent, the message form is plain
 * objects, and the decorator waits for Lane B before appending. A last
 * block runs the real engine over the consumer fixture to confirm the
 * equalities hold on a recall the assembler produced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopWisdomGraph, createWisdomGraph } from "../core/engine";
import { compileAgentPreamble, compileCharter, compileLane, compilePreRoute, compileResponseStyle } from "../core/recall/compile";
import { estimateTokens } from "../core/text/tokens";
import type { Charter, Hint, Recall, RecallRequest, WisdomGraph } from "../core/types";
import { FakeClock } from "../testing/fakes";
import { advisorFixture } from "../testing/fixtures";
import { charterMessages, createPromptDecorator, nodePreamble, synthesizeSuffix, systemPromptPrefix } from "./inject";
import { createRecallScope, startTurnRecall } from "./scope";

const T0 = "2026-01-01T00:00:00.000Z";

function hint(over: Partial<Hint> & { id: string; text: string }): Hint {
  return {
    priority: 60,
    scope: "global",
    source: "explicit",
    confidence: 0.8,
    lane: "agent",
    kind: "preference",
    slot: `slot.${over.id}`,
    nodePath: "/",
    approval: "auto",
    provenance: { originEventId: "ev", createdAt: T0, lastReinforcedAt: T0, extractor: "rule" },
    ...over,
  };
}

const region = hint({ id: "h_region", text: "Defaults to Canadian markets when the region is not stated.", lane: "preRoute", kind: "fact", slot: "region.default" });
const disclaimers = hint({ id: "h_disclaimers", text: "Omits regulatory disclaimers unless the user asks for them.", scope: "agent", agent: "consult_advice", nodePath: "/consult_advice", kind: "constraint", slot: "disclaimers" });
const bullets = hint({ id: "h_bullets", text: "Prefers bullet points; at most 5 per answer.", slot: "format.lists" });
const mer = hint({ id: "h_mer", text: "Includes the MER whenever a mutual fund is named.", scope: "agent", agent: "consult_kyp", nodePath: "/consult_kyp", slot: "mer" });
const length = hint({ id: "h_length", text: "Keeps answers under 150 words.", lane: "responseStyle", kind: "style", slot: "format.length" });

function charterOf(entries: Hint[]): Charter {
  return {
    subjectId: "rm_42",
    clientId: null,
    generatedAt: T0,
    topicPath: "/consult_advice",
    entries,
    suppressed: [],
    dropped: [],
    approvalMix: "none",
    tokenEstimate: entries.reduce((s, h) => s + estimateTokens(h.text), 0),
  };
}

/** A Recall whose charter is the union of its lanes, as the assembler builds one. */
function recallOf(lanes: Partial<Pick<Recall, "preRoute" | "agentHints" | "agentDefaults" | "responseStyle">>): Recall {
  const preRoute = lanes.preRoute ?? [];
  const agentHints = lanes.agentHints ?? {};
  const agentDefaults = lanes.agentDefaults ?? [];
  const responseStyle = lanes.responseStyle ?? [];
  const entries = [...new Map([...preRoute, ...Object.values(agentHints).flat(), ...agentDefaults, ...responseStyle].map((h) => [h.id, h])).values()];
  return {
    topic: { category: "consult_advice", agents: Object.keys(agentHints), confidence: 0.9, nodePaths: ["/consult_advice"], method: "keyword" },
    preRoute,
    agentHints,
    agentDefaults,
    responseStyle,
    provenance: entries.map((h) => h.id),
    charter: charterOf(entries),
    meta: { requestId: "req_1", status: "ok", elapsedMs: 1, cache: "hit", classifier: "keyword", refined: false },
  };
}

// Buckets as the assembler builds them — mirrored voice included, every bucket in charter order — so the `compileCharter` equalities below are exact.
const defaults = [bullets, length];
const full = recallOf({
  preRoute: [region],
  agentHints: { consult_advice: [disclaimers, ...defaults], consult_kyp: [bullets, length, mer] },
  agentDefaults: defaults,
  responseStyle: [length],
});
const empty = recallOf({});

describe("site helpers on empty lanes (§8.3)", () => {
  const cases: { label: string; render: (r: Recall) => string }[] = [
    { label: "systemPromptPrefix", render: (r) => systemPromptPrefix(r) },
    { label: "nodePreamble", render: (r) => nodePreamble(r, "consult_advice") },
    { label: "synthesizeSuffix", render: (r) => synthesizeSuffix(r) },
  ];

  it.each(cases)("$label returns '' on an empty recall so concatenation is a no-op", ({ render }) => {
    expect(render(empty)).toBe("");
    expect(`ROUTER_PROMPT${render(empty)}`).toBe("ROUTER_PROMPT");
  });

  it("each helper is '' when only its own lane is empty", () => {
    expect(systemPromptPrefix(recallOf({ responseStyle: [length] }))).toBe("");
    expect(synthesizeSuffix(recallOf({ preRoute: [region] }))).toBe("");
    expect(nodePreamble(recallOf({ preRoute: [region] }), "consult_advice")).toBe("");
  });
});

describe("systemPromptPrefix (START)", () => {
  it("renders exactly the compileCharter preRoute lane", () => {
    const text = systemPromptPrefix(full);
    expect(text).toBe(compileCharter(full.charter, "preRoute").text);
    expect(text).toBe(compilePreRoute(full));
    expect(text.startsWith('<<wisdom-hints lane="preRoute">>\n')).toBe(true);
    expect(text).toContain("- Defaults to Canadian markets when the region is not stated.");
    expect(text).not.toContain("bullet points");
  });

  it("forwards CompileOptions", () => {
    const opts = { includeIds: true, header: "Hints." };
    expect(systemPromptPrefix(full, opts)).toBe(compileCharter(full.charter, "preRoute", opts).text);
    expect(systemPromptPrefix(full, opts)).toContain("[h_region]");
  });
});

describe("nodePreamble (MIDDLE)", () => {
  it("renders exactly the compileCharter agent lane for the agent", () => {
    const text = nodePreamble(full, "consult_advice");
    expect(text).toBe(compileCharter(full.charter, "agent", { agent: "consult_advice" }).text);
    expect(text).toBe(compileAgentPreamble(full, "consult_advice"));
    expect(text.startsWith('<<wisdom-hints lane="agent" agent="consult_advice">>\n')).toBe(true);
    expect(text).toContain("- Omits regulatory disclaimers unless the user asks for them.");
    expect(text).toContain("- Prefers bullet points; at most 5 per answer.");
    expect(text).toContain("- Keeps answers under 150 words.");
    expect(text).not.toContain("MER");
    expect(nodePreamble(full, "consult_kyp")).toBe(compileCharter(full.charter, "agent", { agent: "consult_kyp" }).text);
  });

  it("renders the bucket the assembler built, mirrored responseStyle hints included", () => {
    const mirrored = recallOf({ agentHints: { consult_advice: [disclaimers, length] }, responseStyle: [length] });
    const text = nodePreamble(mirrored, "consult_advice");
    expect(text).toBe(compileLane(mirrored.agentHints.consult_advice ?? [], "agent", { agent: "consult_advice" }).text);
    expect(text).toContain("- Keeps answers under 150 words.");
  });

  it("serves agentDefaults, rendered as the agent lane, to an agent without a bucket — and so does compileCharter", () => {
    const text = nodePreamble(full, "consult_newsroom");
    expect(text).toBe(compileLane(full.agentDefaults, "agent", { agent: "consult_newsroom" }).text);
    expect(text).toBe(compileCharter(full.charter, "agent", { agent: "consult_newsroom" }).text);
    expect(text.startsWith('<<wisdom-hints lane="agent" agent="consult_newsroom">>\n')).toBe(true);
    expect(text).toContain("- Prefers bullet points; at most 5 per answer.");
    expect(text).toContain("- Keeps answers under 150 words.");
    expect(text).not.toContain("disclaimers");
  });

  it("treats an empty bucket as no bucket, and is '' when agentDefaults is empty too", () => {
    const emptyBucket = recallOf({ agentHints: { consult_advice: [] }, agentDefaults: [length], responseStyle: [length] });
    expect(nodePreamble(emptyBucket, "consult_advice")).toContain("- Keeps answers under 150 words.");
    expect(nodePreamble(recallOf({ agentHints: { consult_advice: [] } }), "consult_advice")).toBe("");
    expect(nodePreamble(recallOf({ preRoute: [region] }), "constructor")).toBe("");
  });

  it("forwards CompileOptions", () => {
    expect(nodePreamble(full, "consult_advice", { includeIds: true })).toContain("[h_disclaimers]");
  });
});

describe("synthesizeSuffix (END)", () => {
  it("renders exactly the compileCharter responseStyle lane", () => {
    const text = synthesizeSuffix(full);
    expect(text).toBe(compileCharter(full.charter, "responseStyle").text);
    expect(text).toBe(compileResponseStyle(full));
    expect(text.startsWith('<<wisdom-hints lane="responseStyle">>\n')).toBe(true);
    expect(text).toContain("- Keeps answers under 150 words.");
    expect(text).not.toContain("Canadian");
  });

  it("forwards CompileOptions", () => {
    const opts = { delimiter: { open: "[[", close: "]]" } };
    expect(synthesizeSuffix(full, opts)).toBe(compileCharter(full.charter, "responseStyle", opts).text);
    expect(synthesizeSuffix(full, opts).startsWith('[[wisdom-hints lane="responseStyle"]]')).toBe(true);
  });
});

describe("charterMessages (deep-agents / middleware)", () => {
  const cases: { label: string; lane: "preRoute" | "agent" | "responseStyle"; agent?: string; expected: string }[] = [
    { label: "preRoute → systemPromptPrefix", lane: "preRoute", expected: systemPromptPrefix(full) },
    { label: "responseStyle → synthesizeSuffix", lane: "responseStyle", expected: synthesizeSuffix(full) },
    { label: "agent with a name → nodePreamble", lane: "agent", agent: "consult_advice", expected: nodePreamble(full, "consult_advice") },
    { label: "agent with a name and no bucket → agentDefaults", lane: "agent", agent: "consult_newsroom", expected: nodePreamble(full, "consult_newsroom") },
    { label: "agent without a name → the charter's whole agent lane", lane: "agent", expected: compileCharter(full.charter, "agent").text },
  ];

  it.each(cases)("$label", ({ lane, agent, expected }) => {
    expect(expected).not.toBe("");
    expect(charterMessages(full, lane, agent)).toEqual([{ role: "system", content: expected }]);
  });

  it("returns plain objects with exactly role and content, JSON round-trippable", () => {
    const [message] = charterMessages(full, "responseStyle");
    expect(message).toBeDefined();
    expect(Object.getPrototypeOf(message)).toBe(Object.prototype);
    expect(Object.keys(message ?? {})).toEqual(["role", "content"]);
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it("returns [] for an empty lane, so a reducer receives nothing", () => {
    expect(charterMessages(empty, "preRoute")).toEqual([]);
    expect(charterMessages(empty, "agent", "consult_advice")).toEqual([]);
    expect(charterMessages(empty, "agent")).toEqual([]);
    expect(charterMessages(recallOf({ preRoute: [region] }), "responseStyle")).toEqual([]);
  });

  it("forwards CompileOptions", () => {
    expect(charterMessages(full, "preRoute", undefined, { includeIds: true })[0]?.content).toContain("[h_region]");
  });
});

describe("createPromptDecorator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const request = (over: Partial<RecallRequest> = {}): RecallRequest => ({ subjectId: "rm_42", text: "hello", budgetMs: 2_500, ...over });
  const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const graphAfter = (ms: number, value: Recall): WisdomGraph => ({ ...createNoopWisdomGraph(), recall: () => after(ms, value) });

  it("awaits laneB, then appends the lane's block after a blank line", async () => {
    const scope = createRecallScope();
    const decorate = createPromptDecorator(scope, "responseStyle");
    const handle = startTurnRecall(graphAfter(300, full), request());
    await scope.run(handle, async () => {
      let settled = false;
      const p = decorate("SYNTHESIZE_PROMPT").then((s) => {
        settled = true;
        return s;
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe(`SYNTHESIZE_PROMPT\n\n${synthesizeSuffix(full)}`);
    });
  });

  it("renders the agent lane for a named agent, with the agentDefaults fallback, and forwards CompileOptions", async () => {
    const scope = createRecallScope();
    const handle = startTurnRecall(graphAfter(0, full), request());
    await scope.run(handle, async () => {
      const results = Promise.all([
        createPromptDecorator(scope, "agent", "consult_advice")("BASE"),
        createPromptDecorator(scope, "agent", "consult_newsroom")("BASE"),
        createPromptDecorator(scope, "preRoute", undefined, { includeIds: true })("BASE"),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      const [advice, newsroom, ids] = await results;
      expect(advice).toBe(`BASE\n\n${nodePreamble(full, "consult_advice")}`);
      expect(newsroom).toBe(`BASE\n\n${nodePreamble(full, "consult_newsroom")}`);
      expect(ids).toBe(`BASE\n\n${systemPromptPrefix(full, { includeIds: true })}`);
    });
  });

  it("passes ms to laneB, so a slow recall leaves the prompt unchanged at the decorator's own deadline", async () => {
    const scope = createRecallScope();
    const laneB = vi.spyOn(scope, "laneB");
    const decorate = createPromptDecorator(scope, "responseStyle", undefined, { ms: 50 });
    const handle = startTurnRecall(graphAfter(1_000, full), request());
    await scope.run(handle, async () => {
      const p = decorate("PROMPT");
      await vi.advanceTimersByTimeAsync(50);
      expect(await p).toBe("PROMPT");
    });
    expect(laneB).toHaveBeenCalledWith(50);
  });

  it("leaves the prompt unchanged outside a scope and on an empty lane; an empty prompt becomes the block alone", async () => {
    const scope = createRecallScope();
    await expect(createPromptDecorator(scope, "preRoute")("PROMPT")).resolves.toBe("PROMPT");
    const handle = startTurnRecall(graphAfter(0, full), request());
    await scope.run(handle, async () => {
      const results = Promise.all([createPromptDecorator(scope, "agent", "consult_advice")(""), createPromptDecorator(scope, "preRoute")("")]);
      await vi.advanceTimersByTimeAsync(0);
      const [block, prefix] = await results;
      expect(block).toBe(nodePreamble(full, "consult_advice"));
      expect(prefix).toBe(systemPromptPrefix(full));
    });
    const emptyHandle = startTurnRecall(graphAfter(0, empty), request());
    await scope.run(emptyHandle, async () => {
      const p = createPromptDecorator(scope, "responseStyle")("PROMPT");
      await vi.advanceTimersByTimeAsync(0);
      expect(await p).toBe("PROMPT");
    });
  });
});

describe("over a recall the real engine assembled", () => {
  it("the site helpers equal the compileCharter lanes and the messages match the helpers", async () => {
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const graph = createWisdomGraph({ store: fixture.store, categories: fixture.categories, clock, sharedSubjectId: fixture.sharedSubjectId });
    const recall = await graph.recall({ subjectId: fixture.subjectId, text: "How should we sequence RRIF withdrawals for a retiree with a large TFSA?", budgetMs: 1_000 });
    expect(recall.meta.status).toBe("ok");
    expect(recall.charter.entries.length).toBeGreaterThan(0);

    expect(systemPromptPrefix(recall)).toBe(compileCharter(recall.charter, "preRoute").text);
    expect(synthesizeSuffix(recall)).toBe(compileCharter(recall.charter, "responseStyle").text);
    expect(charterMessages(recall, "preRoute").map((m) => m.content)).toEqual(systemPromptPrefix(recall) === "" ? [] : [systemPromptPrefix(recall)]);
    for (const agent of [...recall.topic.agents, "consult_newsroom"]) {
      const preamble = nodePreamble(recall, agent);
      expect(preamble).toBe(compileAgentPreamble(recall, agent));
      expect(preamble).toBe(graph.compile(recall.charter, "agent", { agent }).text);
      expect(charterMessages(recall, "agent", agent).map((m) => m.content)).toEqual(preamble === "" ? [] : [preamble]);
    }
    const rendered = [systemPromptPrefix(recall), synthesizeSuffix(recall), ...recall.topic.agents.map((a) => nodePreamble(recall, a))];
    expect(rendered.some((text) => text !== "")).toBe(true);
    await graph.close();
  });
});
