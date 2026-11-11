/**
 * The assembler's contract is a set of invariants over any candidate list —
 * caps never exceeded, every candidate given exactly one outcome, mirrored
 * copies free — plus the specific behaviours of each pass. The invariants
 * are checked on 1 000 seeded random charters so a change that breaks them
 * for some shape of input fails reproducibly; the behaviours on small
 * hand-built cases where the expected outcome can be read off the spec.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy, mergePolicy, type PolicyConfig } from "../policy";
import type { Hint, HintLane, HintScope, Topic } from "../types";
import { FakeClock } from "../../testing/fakes";
import { estimateTokens } from "../text/tokens";
import { assembleCharter, scoreCandidates, type AssembleContext, type Assembly } from "./charter";
import type { Candidate } from "./select";

const clock = new FakeClock();
const T0 = clock.iso();

function hint(over: Partial<Hint> & { id: string }): Hint {
  const h: Hint = {
    text: "Prefers bullet points; at most 5 per answer.",
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
  return Object.freeze(h);
}

function candidate(h: Hint, over: Partial<Omit<Candidate, "hint">> = {}): Candidate {
  return { hint: h, maturity: "consolidated", relevance: 1, shared: false, ...over };
}

function topic(over: Partial<Topic> = {}): Topic {
  return { category: "consult_advice", agents: ["consult_advice"], confidence: 0.9, nodePaths: ["/consult_advice"], method: "keyword", ...over };
}

function context(over: Partial<AssembleContext> = {}): AssembleContext {
  return { policy: defaultPolicy, now: clock.now(), topic: topic(), subjectId: "rm_42", clientId: null, ...over };
}

const ids = (hints: readonly Hint[]): string[] => hints.map((h) => h.id);
const tokens = (hints: readonly Hint[]): number => hints.reduce((sum, h) => sum + estimateTokens(h.text), 0);

/** Text of exactly `n` estimated tokens (4 chars each). */
const textOf = (n: number, seed = "Prefers"): string => `${seed} ${"x".repeat(Math.max(0, n * 4 - seed.length - 1))}`.slice(0, n * 4);

describe("scoreCandidates", () => {
  it("attaches decay and effective per candidate in order", () => {
    const fresh = candidate(hint({ id: "a", priority: 80, confidence: 0.9 }), { relevance: 0.5 });
    const scored = scoreCandidates([fresh], context());
    expect(scored).toHaveLength(1);
    expect(scored[0]?.decayWeight).toBe(1);
    expect(scored[0]?.effective).toBeCloseTo(0.8 * 0.9 * 0.7 * 1 * 0.5, 12);
  });
});

describe("assembleCharter — passes", () => {
  it("drops candidates under minEffectiveScore as stale", () => {
    const weak = hint({ id: "weak", priority: 5, confidence: 0.5, source: "inferred" });
    const strong = hint({ id: "strong" });
    const { charter, agentHints } = assembleCharter([candidate(weak, { relevance: 0.5 }), candidate(strong)], context());
    expect(charter.dropped).toEqual([{ hintId: "weak", reason: "stale" }]);
    expect(ids(charter.entries)).toEqual(["strong"]);
    expect(ids(agentHints.consult_advice ?? [])).toEqual(["strong"]);
  });

  it("records slot losers in suppressed with the winner and rule, and keeps them out of every lane", () => {
    const brief = hint({ id: "brief", slot: "detail.level", lane: "responseStyle", text: "Prefers brief answers." });
    const detailed = hint({ id: "detailed", slot: "detail.level", lane: "responseStyle", scope: "client", clientId: "client_A", text: "Prefers detailed explanations." });
    const a = assembleCharter([candidate(brief), candidate(detailed)], context({ clientId: "client_A" }));
    expect(a.charter.suppressed).toEqual([{ hintId: "brief", by: "detailed", rule: "scope" }]);
    expect(ids(a.charter.entries)).toEqual(["detailed"]);
    expect(ids(a.responseStyle)).toEqual(["detailed"]);
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["detailed"]);
    expect(a.charter.dropped).toEqual([]);
  });

  it("applies the shared-subject rule to shared candidates", () => {
    const shared = hint({ id: "shared", slot: "asof", approval: "approved", lane: "preRoute", kind: "constraint" });
    const primary = hint({ id: "primary", slot: "asof", approval: "approved", lane: "preRoute", kind: "constraint" });
    const { charter } = assembleCharter([candidate(shared, { shared: true }), candidate(primary)], context());
    expect(charter.suppressed).toEqual([{ hintId: "shared", by: "primary", rule: "shared-subject" }]);
  });

  it("drops exact-normalised-text duplicates across slots, keeping the higher effective", () => {
    const a = hint({ id: "a", priority: 90, text: "Prefers bullet points; at most 5 per answer." });
    const b = hint({ id: "b", priority: 40, text: "prefers  Bullet points; at most 5 per answer." });
    const { charter } = assembleCharter([candidate(b), candidate(a)], context());
    expect(charter.dropped).toEqual([{ hintId: "b", reason: "duplicate" }]);
    expect(ids(charter.entries)).toEqual(["a"]);
  });

  it("drops token-Jaccard duplicates at or above dedupeJaccard and keeps near-misses", () => {
    const a = hint({ id: "a", priority: 90, text: "Prefers bullet points; at most 5 per answer." });
    const same = hint({ id: "same", priority: 40, text: "Prefers bullet points, at most 5 per answer" });
    const near = hint({ id: "near", priority: 40, text: "Prefers bullet points; at most five per answer." });
    const { charter } = assembleCharter([candidate(a), candidate(same), candidate(near)], context());
    expect(charter.dropped).toEqual([{ hintId: "same", reason: "duplicate" }]);
    expect(ids(charter.entries).sort()).toEqual(["a", "near"]);
    const strict = assembleCharter([candidate(a), candidate(near)], context({ policy: mergePolicy({ recall: { dedupeJaccard: 0.7 } }) }));
    expect(strict.charter.dropped).toEqual([{ hintId: "near", reason: "duplicate" }]);
  });

  it("does not dedupe two agents' own copies of the same statement", () => {
    const advice = hint({ id: "advice", scope: "agent", agent: "consult_advice", nodePath: "/consult_advice", text: "Includes the MER whenever a fund is named." });
    const kyp = hint({ id: "kyp", scope: "agent", agent: "consult_kyp", nodePath: "/consult_kyp", text: "Includes the MER whenever a fund is named." });
    const a = assembleCharter([candidate(advice), candidate(kyp)], context());
    expect(a.charter.dropped).toEqual([]);
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["advice"]);
    expect(ids(a.agentHints.consult_kyp ?? [])).toEqual(["kyp"]);
  });

  it("dedupes within a render site only: the router keeps a statement a specialist also gets, a style twin of an agent hint goes", () => {
    const route = hint({ id: "route", lane: "preRoute", kind: "routing", priority: 90, text: "Routes market questions to consult_market_analyst." });
    const agentCopy = hint({ id: "agent_copy", priority: 40, text: "Routes market questions to consult_market_analyst." });
    const a = assembleCharter([candidate(route), candidate(agentCopy)], context());
    expect(a.charter.dropped).toEqual([]);
    expect(ids(a.preRoute)).toEqual(["route"]);
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["agent_copy"]);

    const style = hint({ id: "style", lane: "responseStyle", kind: "style", priority: 90, text: "Keeps answers under 150 words." });
    const twin = hint({ id: "twin", priority: 40, text: "Keeps answers under 150 words." });
    const b = assembleCharter([candidate(style), candidate(twin)], context());
    expect(b.charter.dropped).toEqual([{ hintId: "twin", reason: "duplicate" }]);
    expect(ids(b.agentHints.consult_advice ?? [])).toEqual(["style"]);
  });

  it("records the snapshot's invalid rows, and lists records by hint id", () => {
    const { charter } = assembleCharter([candidate(hint({ id: "ok" })), candidate(hint({ id: "a_stale", priority: 1, confidence: 0.1 }))], context({ invalidRowIds: ["h_bad"] }));
    expect(charter.dropped).toEqual([
      { hintId: "a_stale", reason: "stale" },
      { hintId: "h_bad", reason: "invalid-row" },
    ]);
  });

  it("folds duplicate candidate ids to one", () => {
    const h = hint({ id: "a" });
    const { charter, trace } = assembleCharter([candidate(h), candidate(h, { relevance: 0.4 })], context());
    expect(ids(charter.entries)).toEqual(["a"]);
    expect(trace).toHaveLength(1);
    expect(trace[0]?.relevance).toBe(1);
  });
});

describe("assembleCharter — lanes", () => {
  const style = hint({ id: "style", lane: "responseStyle", kind: "style", text: "Keeps answers under 150 words." });
  const advice = hint({ id: "advice", scope: "agent", agent: "consult_advice", nodePath: "/consult_advice", kind: "constraint", text: "Omits regulatory disclaimers unless the user asks for them." });
  const route = hint({ id: "route", lane: "preRoute", kind: "routing", text: "Routes market questions to consult_market_analyst." });
  const global = hint({ id: "global", text: "Avoids jargon when explaining products." });
  const two = topic({ agents: ["consult_advice", "consult_kyp"] });

  it("buckets by lane; agent-scoped hints go to their agent and other agent-lane hints fan out to every topic agent", () => {
    const a = assembleCharter([candidate(style), candidate(advice), candidate(route), candidate(global)], context({ topic: two, policy: mergePolicy({ recall: { mirrorStyleToAgents: false } }) }));
    expect(ids(a.preRoute)).toEqual(["route"]);
    expect(ids(a.responseStyle)).toEqual(["style"]);
    expect(ids(a.agentHints.consult_advice ?? []).sort()).toEqual(["advice", "global"]);
    expect(ids(a.agentHints.consult_kyp ?? [])).toEqual(["global"]);
    expect(ids(a.charter.entries).sort()).toEqual(["advice", "global", "route", "style"]);
  });

  it("mirroring on: responseStyle hints appear in every topic agent's bucket and count once toward the total", () => {
    const a = assembleCharter([candidate(style), candidate(advice)], context({ topic: two }));
    expect(ids(a.responseStyle)).toEqual(["style"]);
    expect(ids(a.agentHints.consult_advice ?? [])).toContain("style");
    expect(ids(a.agentHints.consult_kyp ?? [])).toEqual(["style"]);
    expect(ids(a.charter.entries).sort()).toEqual(["advice", "style"]);
    expect(a.charter.tokenEstimate).toBe(tokens([style, advice]));
    expect(a.charter.dropped).toEqual([]);
  });

  it("mirroring off: agent buckets hold only agent-lane hints and an agent with nothing gets no bucket", () => {
    const a = assembleCharter([candidate(style), candidate(advice)], context({ topic: two, policy: mergePolicy({ recall: { mirrorStyleToAgents: false } }) }));
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["advice"]);
    expect(Object.hasOwn(a.agentHints, "consult_kyp")).toBe(false);
    expect(ids(a.responseStyle)).toEqual(["style"]);
  });

  it("an agent-scoped responseStyle hint is mirrored only into its own agent's bucket", () => {
    const voice = hint({ id: "voice", lane: "responseStyle", kind: "preference", scope: "agent", agent: "consult_kyp", nodePath: "/consult_kyp", text: "Likes a closing question at the end." });
    const a = assembleCharter([candidate(voice), candidate(advice)], context({ topic: two }));
    expect(ids(a.responseStyle)).toEqual(["voice"]);
    expect(ids(a.agentHints.consult_kyp ?? [])).toEqual(["voice"]);
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["advice"]);
  });

  it("an always-candidate agent outside the topic gets a bucket with fan-out and mirrored hints", () => {
    const kyp = hint({ id: "kyp", scope: "agent", agent: "consult_kyp", nodePath: "/consult_kyp", text: "Includes the MER whenever a fund is named." });
    const a = assembleCharter([candidate(kyp, { relevance: 0.4 }), candidate(global), candidate(style)], context({ topic: topic({ category: "direct", agents: [], nodePaths: [] }) }));
    expect(Object.keys(a.agentHints)).toEqual(["consult_kyp"]);
    expect(ids(a.agentHints.consult_kyp ?? []).sort()).toEqual(["global", "kyp", "style"]);
    expect(a.charter.dropped).toEqual([]);
  });

  it("gives an agent named __proto__ an own bucket and leaves the record's prototype alone", () => {
    const odd = hint({ id: "odd", scope: "agent", agent: "__proto__", nodePath: "/__proto__", text: "Prefers the odd case handled." });
    const a = assembleCharter([candidate(odd)], context({ topic: topic({ category: "direct", agents: [], nodePaths: [] }) }));
    expect(Object.hasOwn(a.agentHints, "__proto__")).toBe(true);
    expect(Object.keys(a.agentHints)).toEqual(["__proto__"]);
    expect(ids(a.agentHints["__proto__"] ?? [])).toEqual(["odd"]);
    expect(Object.getPrototypeOf(a.agentHints)).toBe(Object.prototype);
    expect(JSON.stringify(a.agentHints)).toContain('"__proto__":[');
    expect(ids(a.charter.entries)).toEqual(["odd"]);
  });

  it("an agent-lane hint with no agent bucket lands in agentDefaults, never in dropped", () => {
    const a = assembleCharter([candidate(global), candidate(style)], context({ topic: topic({ category: "direct", agents: [], nodePaths: [] }) }));
    expect(a.agentHints).toEqual({});
    expect(ids(a.agentDefaults)).toEqual(["global", "style"]);
    expect(a.charter.dropped).toEqual([]);
    expect(ids(a.charter.entries).sort()).toEqual(["global", "style"]);
  });

  it("agentDefaults holds what every bucket shares — everyone's agent-lane hints and the mirrored voice — and nothing agent-scoped", () => {
    const voice = hint({ id: "voice", lane: "responseStyle", kind: "preference", scope: "agent", agent: "consult_kyp", nodePath: "/consult_kyp", text: "Likes a closing question at the end." });
    const a = assembleCharter([candidate(global), candidate(style), candidate(advice), candidate(voice)], context({ topic: two }));
    expect(ids(a.agentDefaults).sort()).toEqual(["global", "style"]);
    expect(ids(a.agentHints.consult_advice ?? []).sort()).toEqual(["advice", "global", "style"]);
    expect(ids(a.agentHints.consult_kyp ?? []).sort()).toEqual(["global", "style", "voice"]);
    const off = assembleCharter([candidate(global), candidate(style)], context({ topic: two, policy: mergePolicy({ recall: { mirrorStyleToAgents: false } }) }));
    expect(ids(off.agentDefaults)).toEqual(["global"]);
    expect(assembleCharter([], context()).agentDefaults).toEqual([]);
  });

  it("agentDefaults is filled under the agent lane cap and costs the total nothing beyond the entries it shares", () => {
    const hints = [1, 2, 3, 4].map((i) => hint({ id: `h${i}`, priority: 100 - i, text: textOf(10, `Prefers${i}`) }));
    const a = assembleCharter(hints.map((h) => candidate(h)), context({ policy: mergePolicy({ caps: { agentTokens: 25 } }) }));
    expect(ids(a.agentDefaults)).toEqual(["h1", "h2"]);
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["h1", "h2"]);
    expect(a.charter.tokenEstimate).toBe(20);
    const direct = assembleCharter(hints.map((h) => candidate(h)), context({ topic: topic({ category: "direct", agents: [], nodePaths: [] }), policy: mergePolicy({ caps: { agentTokens: 25 } }) }));
    expect(ids(direct.agentDefaults)).toEqual(["h1", "h2"]);
    expect(direct.charter.dropped).toEqual([
      { hintId: "h3", reason: "budget" },
      { hintId: "h4", reason: "budget" },
    ]);
  });

  it("sorts every bucket and the entries by effective, then priority, then id", () => {
    const low = hint({ id: "b_low", priority: 20, text: "Avoids emoji." });
    const high = hint({ id: "c_high", priority: 90, text: "Uses plain English." });
    const tieA = hint({ id: "a_tie", priority: 50, text: "Formats dates as YYYY-MM-DD." });
    const tieB = hint({ id: "d_tie", priority: 50, text: "Reports returns in percentages." });
    const a = assembleCharter([candidate(low), candidate(tieB), candidate(high), candidate(tieA)], context());
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["c_high", "a_tie", "d_tie", "b_low"]);
    expect(ids(a.charter.entries)).toEqual(["c_high", "a_tie", "d_tie", "b_low"]);
    const styleFirst = hint({ id: "s", lane: "responseStyle", kind: "style", priority: 100, text: "Keeps it short." });
    const b = assembleCharter([candidate(low), candidate(styleFirst)], context());
    expect(ids(b.agentHints.consult_advice ?? [])).toEqual(["s", "b_low"]);
  });
});

describe("assembleCharter — caps", () => {
  const smallCaps = (over: Partial<PolicyConfig["caps"]>): PolicyConfig => mergePolicy({ caps: over });

  it("lane overflow lands in dropped: budget, and only for hints placed nowhere", () => {
    const hints = [1, 2, 3, 4].map((i) => hint({ id: `h${i}`, priority: 100 - i, text: textOf(10, `Prefers${i}`) }));
    const a = assembleCharter(hints.map((h) => candidate(h)), context({ policy: smallCaps({ agentTokens: 25 }) }));
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["h1", "h2"]);
    expect(a.charter.dropped).toEqual([
      { hintId: "h3", reason: "budget" },
      { hintId: "h4", reason: "budget" },
    ]);
    expect(ids(a.charter.entries)).toEqual(["h1", "h2"]);
    expect(a.charter.tokenEstimate).toBe(20);
  });

  it("greedy fill skips a hint that does not fit and takes a later smaller one", () => {
    const big = hint({ id: "big", priority: 90, text: textOf(20) });
    const small = hint({ id: "small", priority: 10, text: textOf(5) });
    const a = assembleCharter([candidate(big), candidate(small)], context({ policy: smallCaps({ agentTokens: 12 }) }));
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["small"]);
    expect(a.charter.dropped).toEqual([{ hintId: "big", reason: "budget" }]);
  });

  it("maxHintsPerLane bounds every bucket", () => {
    const hints = Array.from({ length: 20 }, (_, i) => hint({ id: `h${String(i).padStart(2, "0")}`, priority: 99 - i, text: `Prefers option ${i}.` }));
    const a = assembleCharter(hints.map((h) => candidate(h)), context({ policy: smallCaps({ maxHintsPerLane: 3, agentTokens: 10_000, totalTokens: 10_000 }) }));
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["h00", "h01", "h02"]);
    expect(a.charter.dropped).toHaveLength(17);
    for (const d of a.charter.dropped) expect(d.reason).toBe("budget");
  });

  it("the total cap counts a distinct entry once: a hint mirrored into three buckets costs one line", () => {
    const style = hint({ id: "style", lane: "responseStyle", kind: "style", text: textOf(10) });
    const own = hint({ id: "own", text: textOf(10, "Avoids") });
    const three = topic({ agents: ["consult_advice", "consult_kyp", "consult_meetings"] });
    const a = assembleCharter([candidate(style), candidate(own)], context({ topic: three, policy: smallCaps({ totalTokens: 20 }) }));
    for (const agent of three.agents) expect(ids(a.agentHints[agent] ?? [])).toContain("style");
    expect(ids(a.responseStyle)).toEqual(["style"]);
    expect(ids(a.charter.entries).sort()).toEqual(["own", "style"]);
    expect(a.charter.tokenEstimate).toBe(20);
    expect(a.charter.dropped).toEqual([]);
  });

  it("the total cap drops what the lanes alone would have kept", () => {
    const route = hint({ id: "route", lane: "preRoute", kind: "routing", priority: 90, text: textOf(10) });
    const own = hint({ id: "own", priority: 80, text: textOf(10, "Avoids") });
    const style = hint({ id: "style", lane: "responseStyle", kind: "style", priority: 70, text: textOf(10, "Keeps") });
    const a = assembleCharter([candidate(route), candidate(own), candidate(style)], context({ policy: smallCaps({ totalTokens: 20 }) }));
    expect(ids(a.preRoute)).toEqual(["route"]);
    expect(ids(a.agentHints.consult_advice ?? [])).toEqual(["own"]);
    expect(a.responseStyle).toEqual([]);
    expect(a.charter.dropped).toEqual([{ hintId: "style", reason: "budget" }]);
    expect(a.charter.tokenEstimate).toBe(20);
  });

  it("honours a custom tokenizer", () => {
    const a = assembleCharter([candidate(hint({ id: "a", text: "Prefers x." }))], context({ tokenizer: () => 500 }));
    expect(a.charter.entries).toEqual([]);
    expect(a.charter.dropped).toEqual([{ hintId: "a", reason: "budget" }]);
    expect(a.charter.tokenEstimate).toBe(0);
  });
});

describe("assembleCharter — charter fields and trace", () => {
  it("fills identity, time and topic from the context", () => {
    const a = assembleCharter([], context({ clientId: "client_A", topic: topic({ nodePaths: ["/consult_advice/retirement", "/consult_advice"] }) }));
    expect(a.charter.subjectId).toBe("rm_42");
    expect(a.charter.clientId).toBe("client_A");
    expect(a.charter.generatedAt).toBe(T0);
    expect(a.charter.topicPath).toBe("/consult_advice/retirement");
    expect(assembleCharter([], context({ topic: topic({ nodePaths: [] }) })).charter.topicPath).toBe("/");
    expect(assembleCharter([], context({ clientId: undefined })).charter.clientId).toBeNull();
  });

  it("approvalMix is none, mixed or approved-only", () => {
    const approved = hint({ id: "a", approval: "approved", text: "Defaults to Canadian markets." });
    const auto = hint({ id: "b", text: "Avoids jargon with new clients." });
    expect(assembleCharter([], context()).charter.approvalMix).toBe("none");
    expect(assembleCharter([candidate(auto)], context()).charter.approvalMix).toBe("none");
    expect(assembleCharter([candidate(auto), candidate(approved)], context()).charter.approvalMix).toBe("mixed");
    expect(assembleCharter([candidate(approved)], context()).charter.approvalMix).toBe("approved-only");
  });

  it("gives every candidate exactly one outcome in the trace", () => {
    const kept = hint({ id: "kept", slot: "s1" });
    const lost = hint({ id: "lost", slot: "s1", source: "inferred" });
    const stale = hint({ id: "stale", priority: 1, confidence: 0.1 });
    const twin = hint({ id: "twin", slot: "s2", priority: 10 });
    const a = assembleCharter([candidate(kept), candidate(lost), candidate(stale, { relevance: 0.4 }), candidate(twin)], context());
    const byId = new Map(a.trace.map((t) => [t.hintId, t]));
    expect(byId.get("kept")).toMatchObject({ outcome: "kept", relevance: 1, decayWeight: 1 });
    expect(byId.get("lost")).toMatchObject({ outcome: "suppressed", rule: "source" });
    expect(byId.get("stale")).toMatchObject({ outcome: "dropped", reason: "stale" });
    expect(byId.get("twin")).toMatchObject({ outcome: "dropped", reason: "duplicate" });
    expect(a.trace).toHaveLength(4);
  });

  it("is a plain, JSON-clean value that freezes without touching the snapshot's hints", () => {
    const a = assembleCharter([candidate(hint({ id: "a" }))], context());
    expect(JSON.parse(JSON.stringify(a.charter))).toEqual(a.charter);
    expect(Object.isFrozen(a.charter)).toBe(false);
    expect(Object.isFrozen(a.charter.entries[0])).toBe(true);
  });
});

// ── Random charters ──────────────────────────────────────────────────────────

/** mulberry32: a tiny seeded PRNG so a failing shape reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENTS = ["consult_advice", "consult_kyp", "consult_market_analyst", "consult_meetings"];
const LANES: HintLane[] = ["preRoute", "agent", "responseStyle"];
const SCOPES: HintScope[] = ["global", "category", "agent", "client"];
const OPENERS = ["Prefers", "Avoids", "Uses", "Keeps", "Limits", "Includes", "Omits", "Formats", "Reports", "Wants"];

function randomCase(seed: number): { candidates: Candidate[]; ctx: AssembleContext } {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const count = Math.floor(r() * 60);
  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i += 1) {
    const scope = pick(SCOPES);
    const lane = pick(LANES);
    const words = 2 + Math.floor(r() * 40);
    const text = `${pick(OPENERS)} ${Array.from({ length: words }, () => pick(["bullet", "table", "brief", "detail", "client", "fund", "report", "date", "source", "summary", "tone", "plain", "jargon"])).join(" ")}.`;
    const h = hint({
      id: `h_${seed}_${i}`,
      text,
      priority: Math.floor(r() * 101),
      confidence: Math.round(r() * 100) / 100,
      scope,
      source: r() < 0.5 ? "explicit" : "inferred",
      lane,
      kind: lane === "preRoute" ? "routing" : lane === "responseStyle" ? "style" : "preference",
      slot: `slot.${Math.floor(r() * 15)}`,
      nodePath: scope === "global" ? "/" : "/consult_advice",
      approval: r() < 0.2 ? "approved" : "auto",
      ...(scope === "agent" ? { agent: pick(AGENTS) } : {}),
      ...(scope === "client" ? { clientId: "client_A" } : {}),
    });
    candidates.push({ hint: h, maturity: pick(["captured", "consolidated", "established"]), relevance: [1, 0.8, 0.5, 0.4][Math.floor(r() * 4)] as number, shared: r() < 0.1 });
  }
  const agents = AGENTS.filter(() => r() < 0.5);
  const mirror = r() < 0.7;
  return {
    candidates,
    ctx: context({ topic: topic({ agents, category: agents[0] ?? "direct" }), clientId: "client_A", policy: mergePolicy({ recall: { mirrorStyleToAgents: mirror } }) }),
  };
}

function checkInvariants(a: Assembly, candidates: readonly Candidate[], policy: PolicyConfig): void {
  const { caps } = policy;
  const lane = (hints: readonly Hint[], cap: number, name: string): void => {
    expect(tokens(hints), `${name} tokens`).toBeLessThanOrEqual(cap);
    expect(hints.length, `${name} count`).toBeLessThanOrEqual(caps.maxHintsPerLane);
    expect(new Set(ids(hints)).size, `${name} distinct`).toBe(hints.length);
  };
  lane(a.preRoute, caps.preRouteTokens, "preRoute");
  lane(a.responseStyle, caps.responseStyleTokens, "responseStyle");
  lane(a.agentDefaults, caps.agentTokens, "agentDefaults");
  for (const [agent, bucket] of Object.entries(a.agentHints)) {
    lane(bucket, caps.agentTokens, `agent:${agent}`);
    expect(bucket.length).toBeGreaterThan(0);
  }
  for (const h of a.agentDefaults) expect(h.scope, `${h.id} in agentDefaults`).not.toBe("agent");

  const candidateIds = new Set(candidates.map((c) => c.hint.id));
  const entries = new Set(ids(a.charter.entries));
  expect(tokens(a.charter.entries)).toBeLessThanOrEqual(caps.totalTokens);
  expect(a.charter.tokenEstimate).toBe(tokens(a.charter.entries));
  expect(entries.size).toBe(a.charter.entries.length);
  for (const h of [...a.preRoute, ...a.responseStyle, ...a.agentDefaults, ...Object.values(a.agentHints).flat()]) expect(entries.has(h.id)).toBe(true);
  const placed = new Set(ids([...a.preRoute, ...a.responseStyle, ...a.agentDefaults, ...Object.values(a.agentHints).flat()]));
  for (const id of entries) expect(placed.has(id)).toBe(true);

  const outcomes = new Map<string, number>();
  const bump = (id: string): void => {
    outcomes.set(id, (outcomes.get(id) ?? 0) + 1);
  };
  for (const id of entries) bump(id);
  for (const s of a.charter.suppressed) {
    bump(s.hintId);
    expect(entries.has(s.hintId)).toBe(false);
    expect(candidateIds.has(s.by)).toBe(true);
  }
  for (const d of a.charter.dropped) {
    bump(d.hintId);
    expect(entries.has(d.hintId)).toBe(false);
  }
  for (const id of candidateIds) expect(outcomes.get(id), id).toBe(1);
  expect(a.trace).toHaveLength(candidateIds.size);
}

describe("assembleCharter — 1 000 random charters", () => {
  it("never exceed lane, total or maxHintsPerLane caps and give every candidate one outcome", () => {
    for (let seed = 1; seed <= 1000; seed += 1) {
      const { candidates, ctx } = randomCase(seed);
      checkInvariants(assembleCharter(candidates, ctx), candidates, ctx.policy);
    }
  });

  it("are deterministic and independent of candidate order", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const { candidates, ctx } = randomCase(seed);
      const a = assembleCharter(candidates, ctx);
      const b = assembleCharter([...candidates].reverse(), ctx);
      expect(b.charter).toEqual(a.charter);
      expect(b.preRoute).toEqual(a.preRoute);
      expect(b.agentHints).toEqual(a.agentHints);
      expect(b.agentDefaults).toEqual(a.agentDefaults);
      expect(b.responseStyle).toEqual(a.responseStyle);
    }
  });
});
