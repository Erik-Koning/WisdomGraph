/**
 * The §3.5 rule table, one test per rule per boundary. Each case starts from
 * a known-good row, breaks exactly one thing, and asserts the issue lands on
 * that field's JSON pointer — the paths are what the LLM retry prompt echoes.
 */
import { describe, expect, it } from "vitest";
import type { FeedbackEvent, Hint, HintRecord, RecallRequest, TopicNode, TurnEvent } from "../types";
import { defaultPolicy } from "../policy";
import { validators } from "../index";
import { hintRecordValidator, hintValidator, normaliseSlotValue, LANE_KINDS } from "./hint";
import { nodeValidator } from "./node";
import { validateConsolidateEvent, validateStoredEventBody } from "./event";
import { proposalValidator, type Proposal } from "./proposal";
import type { Validator } from "./validate";

const T0 = "2026-09-01T14:02:11.000Z";

function issuePaths(result: ReturnType<Validator<unknown>>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.path);
}

/** Apply `patch` (undefined deletes the key) and expect exactly these issue paths. */
function expectPaths<T extends object>(v: Validator<T>, base: T, patch: Record<string, unknown>, expected: string[]): void {
  const input: Record<string, unknown> = Object.fromEntries(Object.entries(base));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete input[key];
    else input[key] = value;
  }
  const result = v(input);
  expect(issuePaths(result), `patch ${JSON.stringify(patch)}`).toEqual(expected);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const hint: Hint = {
  id: "h_3f9c1a2b7d0e4c55",
  text: "Omits regulatory disclaimers unless the user asks for them.",
  priority: 82,
  scope: "agent",
  source: "explicit",
  confidence: 0.9,
  lane: "agent",
  kind: "constraint",
  slot: "disclaimers",
  nodePath: "/consult_advice",
  agent: "consult_advice",
  approval: "auto",
  provenance: { originEventId: "fb_01J8Q", runId: "run_7", createdAt: T0, lastReinforcedAt: T0, extractor: "llm" },
};

const record: HintRecord = {
  id: "h_3f9c1a2b7d0e4c55",
  tenantId: null,
  subjectId: "rm_42",
  nodeId: "n_8ab1",
  nodePath: "/consult_advice",
  slot: "disclaimers",
  value: "omit unless asked",
  text: "Omits regulatory disclaimers unless the user asks for them.",
  kind: "constraint",
  lane: "agent",
  scope: "agent",
  agent: "consult_advice",
  source: "explicit",
  confidence: 0.9,
  priority: 82,
  status: "active",
  approval: "auto",
  maturity: "consolidated",
  needsReview: false,
  reinforcements: 3,
  contradictions: 0,
  applied: 17,
  version: 4,
  provenance: {
    originEventId: "fb_01J8Q",
    eventIds: ["fb_01J8Q", "turn_01J9A", "fb_01JA0"],
    runIds: ["run_7", "run_31"],
    extractor: { kind: "llm", promptVersion: "extract@1", model: "gemini-2.5-pro" },
  },
  createdAt: T0,
  updatedAt: T0,
  lastReinforcedAt: T0,
  lastAppliedAt: T0,
};

const node: TopicNode = {
  id: "n_8ab1",
  tenantId: null,
  subjectId: "rm_42",
  path: "/consult_advice/retirement",
  parentPath: "/consult_advice",
  slug: "retirement",
  title: "Retirement planning",
  description: "Decumulation, RRIF/RRSP withdrawals, CPP/OAS timing questions.",
  keywords: ["retirement", "rrif", "rrsp", "withdrawal", "decumulation", "cpp", "oas"],
  patterns: [],
  agents: ["consult_advice", "consult_kyp"],
  properties: { "region.default": "CA", "horizon.default_years": 25 },
  level: 2,
  locked: false,
  status: "active",
  stats: { activeHints: 4, lastIngestAt: T0 },
  version: 3,
  createdAt: T0,
  updatedAt: T0,
};

const root: TopicNode = {
  ...node,
  id: "n_root",
  path: "/",
  parentPath: null,
  slug: "",
  title: "Global",
  description: "",
  keywords: [],
  agents: [],
  properties: {},
  level: 0,
  locked: true,
  stats: { activeHints: 0 },
};

const turn: TurnEvent = {
  type: "turn",
  id: "turn_run-7",
  runId: "run-7",
  subjectId: "rm_42",
  clientId: null,
  threadId: "client-9",
  category: "consult_advice",
  agentsUsed: ["consult_advice"],
  toolsUsed: ["holdings"],
  dataSources: ["crm"],
  userText: "Stop adding disclaimers please.",
  assistantText: "Understood, I will omit them going forward.",
  model: "gemini-2.5-pro",
  appliedHintIds: ["h_1"],
  surface: "client_sheet",
  at: T0,
};

const feedback: FeedbackEvent = {
  type: "feedback",
  id: "fb_01J8Q",
  runId: "run-7",
  subjectId: "rm_42",
  signal: "down",
  text: "too long",
  target: "agent:consult_advice",
  at: T0,
};

const request: RecallRequest = {
  subjectId: "rm_42",
  clientId: "client_A",
  text: "How should I plan RRIF withdrawals?",
  recentTurns: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello", toolCalls: [{ name: "x", args: { a: 1 } }] }],
  surface: "standalone",
  budgetMs: 150,
  approvedOnly: false,
  refine: true,
  requestId: "req_1",
};

/** The §5.5 worked example, minus the elided ids. */
const proposal: Proposal = {
  ops: [
    { op: "update_hint", hintId: "h_3f9c", text: "Omits regulatory disclaimers unless the user asks for them.", confidence: 0.95, rationale: "user restated it" },
    {
      op: "create_node",
      parentPath: "/consult_advice",
      slug: "reporting",
      title: "Client reporting",
      description: "How performance and holdings reports are written for clients.",
      keywords: ["report", "quarterly", "summary"],
      hints: [
        {
          slot: "format.lists",
          value: "bullets max 5",
          text: "Prefers bullet points; at most 5 per answer.",
          kind: "style",
          lane: "responseStyle",
          scope: "agent",
          agent: "consult_advice",
          priority: 70,
          confidence: 0.85,
          rationale: "explicit request in feedback",
        },
      ],
      rationale: "reporting preferences recur and have no node",
    },
    { op: "set_property", nodePath: "/consult_market_analyst", key: "region.default", value: "CA" },
  ],
};

const addHint = {
  op: "add_hint",
  nodePath: "/consult_advice",
  slot: "format.lists",
  value: "bullets max 5",
  text: "Prefers bullet points; at most 5 per answer.",
  kind: "style",
  lane: "responseStyle",
  scope: "agent",
  agent: "consult_advice",
  priority: 70,
  confidence: 0.85,
  rationale: "explicit request",
} as const;

function withOps(ops: unknown[]): unknown {
  return { ops };
}

// ── Hint ─────────────────────────────────────────────────────────────────────

describe("validators.hint", () => {
  it("accepts the §3.3 projection unchanged", () => {
    expect(validators.hint(hint)).toEqual({ ok: true, value: hint });
  });

  it.each([
    ["slot too short", { slot: "x" }, ["/slot"]],
    ["slot uppercase", { slot: "Bad.Slot" }, ["/slot"]],
    ["slot too long", { slot: "a".repeat(61) }, ["/slot"]],
    ["slot with dash", { slot: "format-lists" }, ["/slot"]],
    ["nodePath without leading slash", { nodePath: "consult_advice" }, ["/nodePath"]],
    ["nodePath with trailing slash", { nodePath: "/consult_advice/" }, ["/nodePath"]],
    ["nodePath with bad slug", { nodePath: "/Consult" }, ["/nodePath"]],
    ["nodePath too deep", { nodePath: "/a/b/c/d/e" }, ["/nodePath"]],
    ["priority below 0", { priority: -1 }, ["/priority"]],
    ["priority above 100", { priority: 101 }, ["/priority"]],
    ["priority not integer", { priority: 50.5 }, ["/priority"]],
    ["confidence below 0", { confidence: -0.1 }, ["/confidence"]],
    ["confidence above 1", { confidence: 1.1 }, ["/confidence"]],
    ["text empty", { text: "" }, ["/text"]],
    ["text whitespace only", { text: "   " }, ["/text"]],
    ["text over maxHintChars", { text: "x".repeat(defaultPolicy.caps.maxHintChars + 1) }, ["/text"]],
    ["approval rejected never reaches a recall", { approval: "rejected" }, ["/approval"]],
    ["scope enum", { scope: "team" }, ["/scope"]],
    ["source enum", { source: "guessed" }, ["/source"]],
    ["lane enum", { lane: "middle" }, ["/lane"]],
    ["kind enum", { kind: "rule" }, ["/kind"]],
    ["provenance date", { provenance: { ...hint.provenance, createdAt: "yesterday" } }, ["/provenance/createdAt"]],
    ["provenance extractor", { provenance: { ...hint.provenance, extractor: "bot" } }, ["/provenance/extractor"]],
    ["missing id", { id: undefined }, ["/id"]],
  ])("rejects %s", (_, patch, expected) => {
    expectPaths(validators.hint, hint, patch, expected);
  });

  it("accepts the boundaries of the numeric ranges", () => {
    for (const priority of [0, 100]) expect(validators.hint({ ...hint, priority }).ok).toBe(true);
    for (const confidence of [0, 1]) expect(validators.hint({ ...hint, confidence }).ok).toBe(true);
    expect(validators.hint({ ...hint, nodePath: "/a/b/c/d" }).ok).toBe(true);
    expect(validators.hint({ ...hint, text: "x".repeat(defaultPolicy.caps.maxHintChars) }).ok).toBe(true);
    expect(validators.hint({ ...hint, slot: "ab" }).ok).toBe(true);
  });

  describe("agent / clientId presence", () => {
    it.each([
      ["agent scope without agent", { scope: "agent", agent: undefined }, ["/agent"]],
      ["global scope with agent", { scope: "global", agent: "consult_advice" }, ["/agent"]],
      ["client scope without clientId", { scope: "client", agent: undefined }, ["/clientId"]],
      ["category scope with clientId", { scope: "category", agent: undefined, clientId: "c1" }, ["/clientId"]],
      ["agent scope with clientId too", { scope: "agent", clientId: "c1" }, ["/clientId"]],
    ])("rejects %s", (_, patch, expected) => {
      expectPaths(validators.hint, hint, patch, expected);
    });

    it("accepts each scope with exactly its key", () => {
      expect(validators.hint({ ...hint, scope: "global", agent: undefined }).ok).toBe(true);
      expect(validators.hint({ ...hint, scope: "category", agent: undefined }).ok).toBe(true);
      expect(validators.hint({ ...hint, scope: "agent", agent: "consult_kyp" }).ok).toBe(true);
      expect(validators.hint({ ...hint, scope: "client", agent: undefined, clientId: "client_A" }).ok).toBe(true);
    });

    it("checks agent against the vocabulary when the factory is given one", () => {
      const known = hintValidator({}, { agents: ["consult_advice", "consult_kyp"] });
      expect(known(hint).ok).toBe(true);
      expect(issuePaths(known({ ...hint, agent: "consult_unknown" }))).toEqual(["/agent"]);
      expect(known({ ...hint, agent: "consult_unknown" })).toMatchObject({
        issues: [{ path: "/agent", message: '"consult_unknown" is not a configured agent' }],
      });
      // Outside agent scope the presence rule fires once; the vocabulary rule stays quiet.
      expect(issuePaths(known({ ...hint, scope: "global", agent: "consult_unknown" }))).toEqual(["/agent"]);
      expect(known({ ...hint, scope: "global", agent: undefined }).ok).toBe(true);
      // The fixed export has no vocabulary and accepts any agent name.
      expect(validators.hint({ ...hint, agent: "consult_unknown" }).ok).toBe(true);
    });
  });

  describe("lane × kind matrix", () => {
    const kinds = ["preference", "style", "routing", "fact", "constraint"] as const;
    const lanes = ["preRoute", "agent", "responseStyle"] as const;
    it.each(lanes.flatMap((lane) => kinds.map((kind) => [lane, kind, LANE_KINDS[lane].includes(kind)] as const)))(
      "%s × %s → %s",
      (lane, kind, allowed) => {
        const result = validators.hint({ ...hint, lane, kind });
        expect(result.ok).toBe(allowed);
        if (!allowed) expect(issuePaths(result)).toEqual(["/kind"]);
      },
    );
  });

  it("drops unknown keys rather than failing (the consumer may carry extras)", () => {
    const result = validators.hint({ ...hint, extra: 1 });
    expect(result).toEqual({ ok: true, value: hint });
  });

  it("honours a custom maxHintChars / maxNodeDepth", () => {
    const strict = hintValidator({ maxHintChars: 20, maxNodeDepth: 1 });
    expect(issuePaths(strict({ ...hint, nodePath: "/a/b" }))).toEqual(["/text", "/nodePath"]);
    expect(strict({ ...hint, text: "Prefers brevity.", nodePath: "/a" }).ok).toBe(true);
  });
});

// ── HintRecord ───────────────────────────────────────────────────────────────

describe("validators.hintRecord", () => {
  it("accepts the §3.3 record unchanged", () => {
    expect(validators.hintRecord(record)).toEqual({ ok: true, value: record });
  });

  it("normalises the slot value and caps it at 80 chars", () => {
    expect(normaliseSlotValue("  Bullets,   Max 5.  ")).toBe("bullets, max 5");
    const r = validators.hintRecord({ ...record, value: "  Omit   Unless ASKED. " });
    expect(r.ok && r.value.value).toBe("omit unless asked");
    expect(validators.hintRecord({ ...record, value: "v".repeat(80) }).ok).toBe(true);
    expectPaths(validators.hintRecord, record, { value: "v".repeat(81) }, ["/value"]);
    expectPaths(validators.hintRecord, record, { value: "" }, ["/value"]);
    expectPaths(validators.hintRecord, record, { value: " . " }, ["/value"]);
  });

  it.each([
    ["status enum", { status: "archived" }, ["/status"]],
    ["maturity enum", { maturity: "ancient" }, ["/maturity"]],
    ["approval enum", { approval: "maybe" }, ["/approval"]],
    ["retiredReason enum", { retiredReason: "bored" }, ["/retiredReason"]],
    ["needsReview not boolean", { needsReview: "no" }, ["/needsReview"]],
    ["negative reinforcements", { reinforcements: -1 }, ["/reinforcements"]],
    ["fractional applied", { applied: 1.5 }, ["/applied"]],
    ["negative version", { version: -1 }, ["/version"]],
    ["missing subjectId", { subjectId: undefined }, ["/subjectId"]],
    ["empty nodeId", { nodeId: "" }, ["/nodeId"]],
    ["tenantId not string/null", { tenantId: 5 }, ["/tenantId"]],
    ["bad lastAppliedAt", { lastAppliedAt: "soon" }, ["/lastAppliedAt"]],
    ["provenance eventIds over 50", { provenance: { ...record.provenance, eventIds: Array.from({ length: 51 }, (_, i) => `e${i}`) } }, ["/provenance/eventIds"]],
    ["provenance runIds over 50", { provenance: { ...record.provenance, runIds: Array.from({ length: 51 }, (_, i) => `r${i}`) } }, ["/provenance/runIds"]],
    ["provenance extractor kind", { provenance: { ...record.provenance, extractor: { kind: "bot" } } }, ["/provenance/extractor/kind"]],
    ["provenance approval at", { provenance: { ...record.provenance, approval: { by: "rm_42", at: "later" } } }, ["/provenance/approval/at"]],
    ["slot pattern", { slot: "no spaces here" }, ["/slot"]],
    ["agent scope without agent", { agent: undefined }, ["/agent"]],
    ["lane × kind", { lane: "preRoute", kind: "style" }, ["/kind"]],
  ])("rejects %s", (_, patch, expected) => {
    expectPaths(validators.hintRecord, record, patch, expected);
  });

  it("accepts rejected/approved approvals, a tenant, and the optional chain fields", () => {
    const full: HintRecord = {
      ...record,
      tenantId: "acme",
      approval: "approved",
      status: "superseded",
      supersedes: "h_old",
      supersededBy: "h_new",
      retiredReason: "contradicted",
      provenance: { ...record.provenance, approval: { by: "rm_42", at: T0, note: "ok" }, supersedes: "h_old" },
    };
    expect(validators.hintRecord(full)).toEqual({ ok: true, value: full });
    expect(validators.hintRecord({ ...record, approval: "rejected" }).ok).toBe(true);
  });

  it("honours custom caps", () => {
    const v = hintRecordValidator({ maxHintChars: 10 });
    expect(issuePaths(v(record))).toEqual(["/text"]);
  });

  it("checks agent against the vocabulary when the factory is given one", () => {
    const known = hintRecordValidator({}, { agents: ["consult_kyp"] });
    expect(issuePaths(known(record))).toEqual(["/agent"]);
    expect(known({ ...record, agent: "consult_kyp" }).ok).toBe(true);
    expect(validators.hintRecord(record).ok).toBe(true);
  });
});

// ── TopicNode ────────────────────────────────────────────────────────────────

describe("validators.node", () => {
  it("accepts the §3.4 node and a root node", () => {
    expect(validators.node(node)).toEqual({ ok: true, value: node });
    expect(validators.node(root)).toEqual({ ok: true, value: root });
  });

  it.each([
    ["path without leading slash", { path: "consult_advice" }, ["/path"]],
    ["path with uppercase slug", { path: "/consult_advice/Retirement" }, ["/path"]],
    ["path with empty segment", { path: "/consult_advice//retirement" }, ["/path"]],
    ["path with trailing slash", { path: "/consult_advice/retirement/" }, ["/path"]],
    ["path deeper than maxNodeDepth", { path: "/a/b/c/d/e" }, ["/path"]],
    ["slug not the last segment", { slug: "Retirement" }, ["/slug"]],
    ["slug empty on a non-root", { slug: "" }, ["/slug"]],
    ["parentPath inconsistent", { parentPath: "/" }, ["/parentPath"]],
    ["parentPath null on a non-root", { parentPath: null }, ["/parentPath"]],
    ["level inconsistent", { level: 1 }, ["/level"]],
    ["level above maxNodeDepth", { level: 5 }, ["/level"]],
    ["title empty", { title: "" }, ["/title"]],
    ["title over 80", { title: "t".repeat(81) }, ["/title"]],
    ["description over 200", { description: "d".repeat(201) }, ["/description"]],
    ["keywords over 40", { keywords: Array.from({ length: 41 }, (_, i) => `k${i}`) }, ["/keywords"]],
    ["keyword with punctuation", { keywords: ["rrsp", "bad!"] }, ["/keywords/1"]],
    ["keyword starting with a dash", { keywords: ["-rrsp"] }, ["/keywords/0"]],
    ["keyword over 40", { keywords: ["k".repeat(41)] }, ["/keywords/0"]],
    ["status enum", { status: "hidden" }, ["/status"]],
    ["mergedInto not a path", { mergedInto: "elsewhere" }, ["/mergedInto"]],
    ["stats.activeHints negative", { stats: { activeHints: -1 } }, ["/stats/activeHints"]],
    ["stats.lastIngestAt bad", { stats: { activeHints: 0, lastIngestAt: "x" } }, ["/stats/lastIngestAt"]],
    ["embedding not numeric", { embedding: [0.1, "x"] }, ["/embedding/1"]],
    ["locked not boolean", { locked: "yes" }, ["/locked"]],
    ["createdAt bad", { createdAt: "2026" }, ["/createdAt"]],
  ])("rejects %s", (_, patch, expected) => {
    expectPaths(validators.node, node, patch, expected);
  });

  it("accepts a path at exactly maxNodeDepth with consistent derived fields", () => {
    const deep: TopicNode = { ...node, path: "/a/b/c/d", parentPath: "/a/b/c", slug: "d", level: 4 };
    expect(validators.node(deep).ok).toBe(true);
  });

  it("lower-cases and trims keywords into canonical form", () => {
    const r = validators.node({ ...node, keywords: [" RRSP ", "Tax Free"] });
    expect(r.ok && r.value.keywords).toEqual(["rrsp", "tax free"]);
  });

  describe("properties", () => {
    it.each([
      ["over maxPropertiesKeys", Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])), ["/properties"]],
      ["over maxPropertiesBytes", Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, "x".repeat(812)])), ["/properties"]],
      ["reserved key keywords", { keywords: ["x"] }, ["/properties/keywords"]],
      ["reserved key patterns", { patterns: [] }, ["/properties/patterns"]],
      ["reserved key agents", { agents: [] }, ["/properties/agents"]],
      ["reserved key title", { title: "x" }, ["/properties/title"]],
      ["reserved key description", { description: "x" }, ["/properties/description"]],
      ["empty key", { "": 1 }, ["/properties/"]],
      ["nested deeper than 3", { a: { b: { c: { d: 1 } } } }, ["/properties/a"]],
      ["non-JSON value", { when: new Date() }, ["/properties/when"]],
      ["undefined value", { a: undefined }, ["/properties/a"]],
      ["string over 1000 chars", { a: "s".repeat(1001) }, ["/properties/a"]],
      ["array instead of object", [], ["/properties"]],
      ["prototype key __proto__", JSON.parse('{"__proto__":{"polluted":true}}'), ["/properties/__proto__"]],
      ["prototype key constructor", { constructor: "x" }, ["/properties/constructor"]],
      ["prototype key prototype", { prototype: 1 }, ["/properties/prototype"]],
      ["nested __proto__ key", { a: JSON.parse('{"__proto__":{"polluted":true}}') }, ["/properties/a/__proto__"]],
    ])("rejects %s", (_, properties, expected) => {
      expectPaths(validators.node, node, { properties }, expected);
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it("returns a rebuilt bag that aliases nothing in the row", () => {
      const nested = { region: "CA", horizons: [5, 10] };
      const r = validators.node({ ...node, properties: { nested } });
      expect(r.ok && r.value.properties.nested).toEqual(nested);
      expect(r.ok && r.value.properties.nested).not.toBe(nested);
      expect(r.ok && Object.getPrototypeOf(r.value.properties)).toBe(Object.prototype);
    });

    it("accepts 32 keys, depth 3, and 4 KB exactly", () => {
      const thirtyTwo = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i]));
      expect(validators.node({ ...node, properties: thirtyTwo }).ok).toBe(true);
      expect(validators.node({ ...node, properties: { a: { b: { c: 1 } } } }).ok).toBe(true);
      // Five 811-char strings under 2-char keys serialise to exactly 4096 bytes
      // (41 bytes of framing + 5 × 811); each string stays under the 1 000-char rule.
      const exact = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, "x".repeat(811)]));
      expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBe(defaultPolicy.caps.maxPropertiesBytes);
      expect(validators.node({ ...node, properties: exact }).ok).toBe(true);
      const over = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, "x".repeat(812)]));
      expect(issuePaths(validators.node({ ...node, properties: over }))).toEqual(["/properties"]);
    });

    it("honours custom property caps", () => {
      const v = nodeValidator({ maxPropertiesKeys: 1 });
      expect(issuePaths(v(node))).toEqual(["/properties"]);
    });
  });
});

// ── Events ───────────────────────────────────────────────────────────────────

describe("validators.event", () => {
  it("accepts a turn and a feedback event, and the minimal forms", () => {
    expect(validators.event(turn)).toEqual({ ok: true, value: turn });
    expect(validators.event(feedback)).toEqual({ ok: true, value: feedback });
    const minimalTurn = { type: "turn", id: "t1", runId: "r1", subjectId: "rm_1", userText: "", assistantText: "" };
    expect(validators.event(minimalTurn)).toEqual({ ok: true, value: minimalTurn });
    const noAgents = { ...minimalTurn, agentsUsed: [] }; // a host without agents may also say so explicitly
    expect(validators.event(noAgents)).toEqual({ ok: true, value: noAgents });
    const minimalFeedback = { type: "feedback", id: "f1", runId: "r1", subjectId: "rm_1", signal: "up" };
    expect(validators.event(minimalFeedback)).toEqual({ ok: true, value: minimalFeedback });
  });

  it.each([
    ["id with a space", { id: "has space" }, ["/id"]],
    ["id with a slash", { id: "a/b" }, ["/id"]],
    ["id empty", { id: "" }, ["/id"]],
    ["id over 128", { id: "i".repeat(129) }, ["/id"]],
    ["id missing", { id: undefined }, ["/id"]],
    ["runId empty", { runId: "" }, ["/runId"]],
    ["subjectId missing", { subjectId: undefined }, ["/subjectId"]],
    ["clientId empty string", { clientId: "" }, ["/clientId"]],
    ["agentsUsed not an array", { agentsUsed: "consult_advice" }, ["/agentsUsed"]],
    ["agentsUsed not strings", { agentsUsed: [1] }, ["/agentsUsed/0"]],
    ["userText not a string", { userText: null }, ["/userText"]],
    ["assistantText missing", { assistantText: undefined }, ["/assistantText"]],
    ["surface enum", { surface: "mobile" }, ["/surface"]],
    ["at not ISO", { at: "now" }, ["/at"]],
    ["appliedHintIds not strings", { appliedHintIds: [null] }, ["/appliedHintIds/0"]],
  ])("rejects a turn with %s", (_, patch, expected) => {
    expectPaths(validators.event, turn, patch, expected);
  });

  it("accepts ids with every allowed character class", () => {
    expect(validators.event({ ...turn, id: "Turn_01.J9A:run-7" }).ok).toBe(true);
  });

  it("does not cap text at validation time (admission caps it afterwards)", () => {
    expect(validators.event({ ...turn, userText: "u".repeat(20_000) }).ok).toBe(true);
  });

  it.each([
    ["signal enum", { signal: "meh" }, ["/signal"]],
    ["target unknown", { target: "everything" }, ["/target"]],
    ["target agent without a name", { target: "agent:" }, ["/target"]],
    ["target tool with whitespace name", { target: "tool: x" }, ["/target"]],
    ["text not a string", { text: 5 }, ["/text"]],
    ["id pattern", { id: "bad id" }, ["/id"]],
  ])("rejects feedback with %s", (_, patch, expected) => {
    expectPaths(validators.event, feedback, patch, expected);
  });

  it.each(["response", "agent:consult_kyp", "tool:holdings_lookup"])("accepts feedback target %s", (target) => {
    expect(validators.event({ ...feedback, target }).ok).toBe(true);
  });

  it("reports an unknown or missing type at /type", () => {
    expect(issuePaths(validators.event({ ...turn, type: "chat" }))).toEqual(["/type"]);
    expect(issuePaths(validators.event({ id: "x" }))).toEqual(["/type"]);
    expect(issuePaths(validators.event("turn"))).toEqual([""]);
  });

  it("drops unknown keys from consumer events", () => {
    const r = validators.event({ ...feedback, extra: "ignored" });
    expect(r).toEqual({ ok: true, value: feedback });
  });

  it("validates consolidate events and every stored body", () => {
    const consolidate = { type: "consolidate", id: "c1", subjectId: "rm_1", nodePath: "/consult_advice" };
    expect(validateConsolidateEvent(consolidate)).toEqual({ ok: true, value: consolidate });
    expect(issuePaths(validateConsolidateEvent({ ...consolidate, nodePath: "nope" }))).toEqual(["/nodePath"]);
    expect(validateStoredEventBody(consolidate).ok).toBe(true);
    expect(validateStoredEventBody(turn).ok).toBe(true);
    expect(validateStoredEventBody(feedback).ok).toBe(true);
    // The consumer-facing validator does not admit internal events.
    expect(issuePaths(validators.event(consolidate))).toEqual(["/type"]);
  });
});

// ── RecallRequest ────────────────────────────────────────────────────────────

describe("validators.recallRequest", () => {
  it("accepts a full request and the minimal one", () => {
    expect(validators.recallRequest(request)).toEqual({ ok: true, value: request });
    const minimal = { subjectId: "rm_1", text: "", budgetMs: 0 };
    expect(validators.recallRequest(minimal)).toEqual({ ok: true, value: minimal });
  });

  it("keeps the AbortSignal by identity and rejects a non-signal", () => {
    const controller = new AbortController();
    const r = validators.recallRequest({ ...request, signal: controller.signal });
    expect(r.ok && r.value.signal).toBe(controller.signal);
    expectPaths(validators.recallRequest, request, { signal: {} }, ["/signal"]);
    expectPaths(validators.recallRequest, request, { signal: "abort" }, ["/signal"]);
    // Structural: anything with a boolean `aborted` passes (another realm's signal, a polyfill).
    expect(validators.recallRequest({ ...request, signal: { aborted: false } }).ok).toBe(true);
  });

  it.each([
    ["subjectId empty", { subjectId: "" }, ["/subjectId"]],
    ["subjectId missing", { subjectId: undefined }, ["/subjectId"]],
    ["text missing", { text: undefined }, ["/text"]],
    ["text not a string", { text: 42 }, ["/text"]],
    ["budgetMs negative", { budgetMs: -1 }, ["/budgetMs"]],
    ["budgetMs string", { budgetMs: "150" }, ["/budgetMs"]],
    ["budgetMs missing", { budgetMs: undefined }, ["/budgetMs"]],
    ["budgetMs NaN", { budgetMs: Number.NaN }, ["/budgetMs"]],
    ["clientId empty string", { clientId: "" }, ["/clientId"]],
    ["surface enum", { surface: "tv" }, ["/surface"]],
    ["approvedOnly not boolean", { approvedOnly: "yes" }, ["/approvedOnly"]],
    ["refine not boolean", { refine: 1 }, ["/refine"]],
    ["requestId empty", { requestId: "" }, ["/requestId"]],
    ["recentTurns role enum", { recentTurns: [{ role: "bot", content: "x" }] }, ["/recentTurns/0/role"]],
    ["recentTurns content missing", { recentTurns: [{ role: "user" }] }, ["/recentTurns/0/content"]],
    ["recentTurns toolCalls name", { recentTurns: [{ role: "assistant", content: "", toolCalls: [{ args: 1 }] }] }, ["/recentTurns/0/toolCalls/0/name"]],
    ["recentTurns not an array", { recentTurns: "none" }, ["/recentTurns"]],
  ])("rejects %s", (_, patch, expected) => {
    expectPaths(validators.recallRequest, request, patch, expected);
  });

  it("accepts a null clientId and a fractional budget", () => {
    expect(validators.recallRequest({ ...request, clientId: null, budgetMs: 2.5 }).ok).toBe(true);
  });

  it("drops unknown keys", () => {
    const r = validators.recallRequest({ ...request, category: "consult_advice" });
    expect(r).toEqual({ ok: true, value: request });
  });
});

// ── Proposal ─────────────────────────────────────────────────────────────────

describe("validators.proposal", () => {
  it("accepts the §5.5 worked example, an empty proposal, and every op kind", () => {
    expect(validators.proposal(proposal)).toEqual({ ok: true, value: proposal });
    expect(validators.proposal({ ops: [] })).toEqual({ ok: true, value: { ops: [] } });
    const everyOp = withOps([
      addHint,
      { op: "update_hint", hintId: "h1", priority: 50, rationale: "r" },
      { op: "reinforce_hint", hintId: "h1" },
      { op: "retire_hint", hintId: "h1", reason: "obsolete", rationale: "r" },
      { op: "update_node", nodePath: "/consult_advice", keywords: ["rrsp"], rationale: "r" },
      { op: "noop", rationale: "nothing to remember" },
      { op: "merge_hints", hintIds: ["h1", "h2"], text: "Prefers brevity.", rationale: "r" },
      { op: "move_hint", hintId: "h1", nodePath: "/consult_advice/retirement", rationale: "r" },
      {
        op: "split_node",
        nodePath: "/consult_advice",
        children: [{ slug: "reporting", title: "Reporting", description: "Reports.", keywords: ["report"], hintIds: ["h1"] }],
        rationale: "r",
      },
      { op: "merge_nodes", fromPath: "/consult_advice/a", intoPath: "/consult_advice/b", rationale: "r" },
      { op: "alias_slot", from: "lists", to: "format.lists", rationale: "r" },
    ]);
    const r = proposalValidator({ maxOps: 24 })(everyOp);
    expect(issuePaths(r)).toEqual([]);
  });

  it("caps ops at maxOpsPerEvent by default and at the override", () => {
    const nine = withOps(Array.from({ length: 9 }, () => ({ op: "noop", rationale: "r" })));
    expect(issuePaths(validators.proposal(nine))).toEqual(["/ops"]);
    const eight = withOps(Array.from({ length: 8 }, () => ({ op: "noop", rationale: "r" })));
    expect(validators.proposal(eight).ok).toBe(true);
    const twentyFour = withOps(Array.from({ length: 24 }, () => ({ op: "noop", rationale: "r" })));
    expect(proposalValidator({ maxOps: 24 })(twentyFour).ok).toBe(true);
    const twentyFive = withOps(Array.from({ length: 25 }, () => ({ op: "noop", rationale: "r" })));
    expect(issuePaths(proposalValidator({ maxOps: 24 })(twentyFive))).toEqual(["/ops"]);
  });

  it("is strict: unknown keys on the proposal and on ops are issues", () => {
    expect(issuePaths(validators.proposal({ ops: [], reasoning: "…" }))).toEqual(["/reasoning"]);
    expect(issuePaths(validators.proposal(withOps([{ op: "noop", rationale: "r", why: "x" }])))).toEqual(["/ops/0/why"]);
    expect(issuePaths(validators.proposal(withOps([{ ...addHint, hintId: "h1" }])))).toEqual(["/ops/0/hintId"]);
  });

  it("reports an unknown op at /ops/i/op and a non-object op at /ops/i", () => {
    expect(issuePaths(validators.proposal(withOps([{ op: "delete_everything" }])))).toEqual(["/ops/0/op"]);
    expect(issuePaths(validators.proposal(withOps([{ rationale: "r" }])))).toEqual(["/ops/0/op"]);
    expect(issuePaths(validators.proposal(withOps(["noop"])))).toEqual(["/ops/0"]);
    expect(issuePaths(validators.proposal({ ops: "none" }))).toEqual(["/ops"]);
    expect(issuePaths(validators.proposal(null))).toEqual([""]);
  });

  describe("add_hint", () => {
    it.each([
      ["slot pattern", { slot: "Format Lists" }, ["/ops/0/slot"]],
      ["nodePath syntax", { nodePath: "consult_advice" }, ["/ops/0/nodePath"]],
      ["nodePath depth", { nodePath: "/a/b/c/d/e" }, ["/ops/0/nodePath"]],
      ["priority range", { priority: 101 }, ["/ops/0/priority"]],
      ["priority integer", { priority: 7.5 }, ["/ops/0/priority"]],
      ["confidence range", { confidence: 2 }, ["/ops/0/confidence"]],
      ["text over maxHintChars", { text: "x".repeat(201) }, ["/ops/0/text"]],
      ["text empty", { text: "" }, ["/ops/0/text"]],
      ["value empty", { value: "" }, ["/ops/0/value"]],
      ["kind enum", { kind: "rule" }, ["/ops/0/kind"]],
      ["lane × kind", { lane: "preRoute", kind: "style" }, ["/ops/0/kind"]],
      ["lane × kind (responseStyle/routing)", { lane: "responseStyle", kind: "routing" }, ["/ops/0/kind"]],
      ["agent scope without agent", { agent: undefined }, ["/ops/0/agent"]],
      ["global scope with agent", { scope: "global" }, ["/ops/0/agent"]],
      ["clientScoped not boolean", { clientScoped: "yes" }, ["/ops/0/clientScoped"]],
      ["client scope without clientScoped", { scope: "client", agent: undefined }, ["/ops/0/clientScoped"]],
      ["client scope with clientScoped false", { scope: "client", agent: undefined, clientScoped: false }, ["/ops/0/clientScoped"]],
      ["global scope with clientScoped", { scope: "global", agent: undefined, clientScoped: true }, ["/ops/0/clientScoped"]],
      ["agent scope with clientScoped", { clientScoped: true }, ["/ops/0/clientScoped"]],
      ["rationale missing", { rationale: undefined }, ["/ops/0/rationale"]],
      ["clientId is not a proposal field", { clientId: "c1" }, ["/ops/0/clientId"]],
    ])("rejects %s", (_, patch, expected) => {
      const op: Record<string, unknown> = { ...addHint };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete op[k];
        else op[k] = v;
      }
      expect(issuePaths(validators.proposal(withOps([op]))), JSON.stringify(patch)).toEqual(expected);
    });

    it("accepts client scope with clientScoped (the id is never in a proposal)", () => {
      const op = { ...addHint, scope: "client", agent: undefined, clientScoped: true };
      expect(validators.proposal(withOps([op])).ok).toBe(true);
      // An explicit `false` outside client scope is a statement, not a claim.
      expect(validators.proposal(withOps([{ ...addHint, clientScoped: false }])).ok).toBe(true);
    });
  });

  describe("create_node", () => {
    const create = proposal.ops[1] as Extract<Proposal["ops"][number], { op: "create_node" }>;
    it.each([
      ["slug pattern", { slug: "Client Reporting" }, ["/ops/0/slug"]],
      ["slug too long", { slug: "s".repeat(41) }, ["/ops/0/slug"]],
      ["parentPath syntax", { parentPath: "consult_advice" }, ["/ops/0/parentPath"]],
      ["title empty", { title: " " }, ["/ops/0/title"]],
      ["title over 80", { title: "t".repeat(81) }, ["/ops/0/title"]],
      ["description empty", { description: "" }, ["/ops/0/description"]],
      ["description over 200", { description: "d".repeat(201) }, ["/ops/0/description"]],
      ["keywords over 40", { keywords: Array.from({ length: 41 }, (_, i) => `k${i}`) }, ["/ops/0/keywords"]],
      ["keyword pattern", { keywords: ["ok", "not ok!"] }, ["/ops/0/keywords/1"]],
      ["no hints", { hints: [] }, ["/ops/0/hints"]],
      ["hint lane × kind", { hints: [{ ...create.hints[0], lane: "preRoute", kind: "style" }] }, ["/ops/0/hints/0/kind"]],
      ["hint agent presence", { hints: [{ ...create.hints[0], scope: "category" }] }, ["/ops/0/hints/0/agent"]],
      ["hint unknown key", { hints: [{ ...create.hints[0], nodePath: "/x" }] }, ["/ops/0/hints/0/nodePath"]],
      ["hint client scope without clientScoped", { hints: [{ ...create.hints[0], scope: "client", agent: undefined }] }, ["/ops/0/hints/0/clientScoped"]],
      ["hint clientScoped outside client scope", { hints: [{ ...create.hints[0], clientScoped: true }] }, ["/ops/0/hints/0/clientScoped"]],
      ["properties reserved key", { properties: { keywords: ["x"] } }, ["/ops/0/properties/keywords"]],
      ["properties prototype key", { properties: JSON.parse('{"__proto__":{"polluted":true}}') }, ["/ops/0/properties/__proto__"]],
      ["properties key count", { properties: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1])) }, ["/ops/0/properties"]],
      ["properties depth", { properties: { a: { b: { c: { d: 1 } } } } }, ["/ops/0/properties/a"]],
      ["properties string length", { properties: { a: "s".repeat(1001) } }, ["/ops/0/properties/a"]],
      ["agents not strings", { agents: [1] }, ["/ops/0/agents/0"]],
      ["rationale missing", { rationale: undefined }, ["/ops/0/rationale"]],
    ])("rejects %s", (_, patch, expected) => {
      const op: Record<string, unknown> = { ...create };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete op[k];
        else op[k] = v;
      }
      expect(issuePaths(validators.proposal(withOps([op]))), JSON.stringify(patch)).toEqual(expected);
    });

    it("accepts one hint, a rationale, and optional agents/properties", () => {
      const op = { ...create, agents: ["consult_advice"], properties: { "region.default": "CA" } };
      expect(validators.proposal(withOps([op])).ok).toBe(true);
    });
  });

  describe("other ops", () => {
    it.each([
      ["update_hint hintId empty", { op: "update_hint", hintId: "", rationale: "r" }, ["/ops/0/hintId"]],
      ["update_hint priority range", { op: "update_hint", hintId: "h1", priority: -1, rationale: "r" }, ["/ops/0/priority"]],
      ["update_hint text too long", { op: "update_hint", hintId: "h1", text: "x".repeat(201), rationale: "r" }, ["/ops/0/text"]],
      ["reinforce_hint missing id", { op: "reinforce_hint" }, ["/ops/0/hintId"]],
      ["retire_hint reason enum", { op: "retire_hint", hintId: "h1", reason: "decayed", rationale: "r" }, ["/ops/0/reason"]],
      ["update_node keyword pattern", { op: "update_node", nodePath: "/a", keywords: ["Bad!"], rationale: "r" }, ["/ops/0/keywords/0"]],
      ["update_node path", { op: "update_node", nodePath: "a", rationale: "r" }, ["/ops/0/nodePath"]],
      ["set_property reserved key", { op: "set_property", nodePath: "/a", key: "title", value: "x" }, ["/ops/0/key"]],
      ["set_property __proto__ key", { op: "set_property", nodePath: "/a", key: "__proto__", value: { polluted: true } }, ["/ops/0/key"]],
      ["set_property constructor key", { op: "set_property", nodePath: "/a", key: "constructor", value: 1 }, ["/ops/0/key"]],
      ["set_property prototype key", { op: "set_property", nodePath: "/a", key: "prototype", value: 1 }, ["/ops/0/key"]],
      ["set_property value with __proto__ key", { op: "set_property", nodePath: "/a", key: "k", value: JSON.parse('{"__proto__":{"polluted":true}}') }, ["/ops/0/value/__proto__"]],
      ["set_property empty key", { op: "set_property", nodePath: "/a", key: "", value: "x" }, ["/ops/0/key"]],
      ["set_property long string", { op: "set_property", nodePath: "/a", key: "k", value: "s".repeat(1001) }, ["/ops/0/value"]],
      ["set_property depth", { op: "set_property", nodePath: "/a", key: "k", value: { a: { b: { c: 1 } } } }, ["/ops/0/value"]],
      ["set_property non-JSON", { op: "set_property", nodePath: "/a", key: "k", value: undefined }, ["/ops/0/value"]],
      ["noop without rationale", { op: "noop" }, ["/ops/0/rationale"]],
      ["merge_hints one id", { op: "merge_hints", hintIds: ["h1"], text: "Prefers brevity.", rationale: "r" }, ["/ops/0/hintIds"]],
      ["merge_hints duplicate ids", { op: "merge_hints", hintIds: ["h1", "h1"], text: "Prefers brevity.", rationale: "r" }, ["/ops/0/hintIds/1"]],
      ["merge_hints slot pattern", { op: "merge_hints", hintIds: ["h1", "h2"], text: "t", slot: "X", rationale: "r" }, ["/ops/0/slot"]],
      ["move_hint path", { op: "move_hint", hintId: "h1", nodePath: "//", rationale: "r" }, ["/ops/0/nodePath"]],
      ["split_node no children", { op: "split_node", nodePath: "/a", children: [], rationale: "r" }, ["/ops/0/children"]],
      ["split_node child slug", { op: "split_node", nodePath: "/a", children: [{ slug: "Bad", title: "t", description: "d", keywords: [], hintIds: [] }], rationale: "r" }, ["/ops/0/children/0/slug"]],
      ["merge_nodes same path", { op: "merge_nodes", fromPath: "/a", intoPath: "/a", rationale: "r" }, ["/ops/0/intoPath"]],
      ["alias_slot same slot", { op: "alias_slot", from: "lists", to: "lists", rationale: "r" }, ["/ops/0/to"]],
      ["alias_slot pattern", { op: "alias_slot", from: "L", to: "format.lists", rationale: "r" }, ["/ops/0/from"]],
    ])("rejects %s", (_, op, expected) => {
      expect(issuePaths(validators.proposal(withOps([op])))).toEqual(expected);
    });

    it("reports every bad op, not just the first", () => {
      const r = validators.proposal(withOps([{ op: "noop" }, { op: "reinforce_hint", hintId: "h1" }, { op: "nope" }]));
      expect(issuePaths(r)).toEqual(["/ops/0/rationale", "/ops/2/op"]);
    });
  });

  describe("purpose", () => {
    const consolidation = [
      { op: "merge_hints", hintIds: ["h1", "h2"], text: "Prefers brevity.", rationale: "r" },
      { op: "move_hint", hintId: "h1", nodePath: "/a", rationale: "r" },
      { op: "split_node", nodePath: "/a", children: [{ slug: "b", title: "B", description: "d", keywords: [], hintIds: [] }], rationale: "r" },
      { op: "merge_nodes", fromPath: "/a", intoPath: "/b", rationale: "r" },
      { op: "alias_slot", from: "lists", to: "format.lists", rationale: "r" },
    ];

    it.each([
      ["proposalValidator({ purpose: \"extract\" })", proposalValidator({ purpose: "extract" })],
      ["validators.proposal (the extraction gate)", validators.proposal],
    ])("%s rejects every consolidation-only op", (_, extract) => {
      const r = extract(withOps(consolidation));
      expect(issuePaths(r)).toEqual(consolidation.map((_, i) => `/ops/${i}/op`));
      expect(r.ok ? [] : r.issues.map((i) => i.message)).toContain('"merge_hints" is a consolidation-only op');
      expect(extract(withOps([addHint, { op: "noop", rationale: "r" }])).ok).toBe(true);
    });

    it("allows them when consolidating or when the factory is given no purpose", () => {
      expect(proposalValidator({ purpose: "consolidate" })(withOps(consolidation)).ok).toBe(true);
      expect(proposalValidator({ purpose: "consolidate", maxOps: 24 })(withOps(consolidation)).ok).toBe(true);
      expect(proposalValidator()(withOps(consolidation)).ok).toBe(true);
    });
  });

  describe("agent vocabulary", () => {
    const create = proposal.ops[1] as Extract<Proposal["ops"][number], { op: "create_node" }>;
    const known = proposalValidator({ agents: ["consult_advice"] });

    it("rejects an unknown agent at the hint's agent, in add_hint and create_node.hints", () => {
      expect(known(proposal).ok).toBe(true);
      expect(issuePaths(known(withOps([{ ...addHint, agent: "consult_nope" }])))).toEqual(["/ops/0/agent"]);
      const op = { ...create, hints: [{ ...create.hints[0], agent: "consult_nope" }] };
      expect(issuePaths(known(withOps([op])))).toEqual(["/ops/0/hints/0/agent"]);
    });

    it("is off for the fixed export, which has no engine to ask", () => {
      expect(validators.proposal(withOps([{ ...addHint, agent: "consult_nope" }])).ok).toBe(true);
    });
  });

  it("honours custom caps for hint text and node depth", () => {
    const v = proposalValidator({ caps: { maxHintChars: 10, maxNodeDepth: 1 } });
    expect(issuePaths(v(withOps([{ ...addHint, nodePath: "/a/b" }])))).toEqual(["/ops/0/nodePath", "/ops/0/text"]);
  });
});
