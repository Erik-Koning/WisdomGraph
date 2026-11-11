/**
 * The precedence table is checked one rule pair at a time: for each rule,
 * two hints that tie on everything above it and differ on it, so the test
 * proves both the order of the rules and the direction of each. The
 * shared-subject rule and the audience rule (two agents never conflict) are
 * then checked through `resolveConflicts`, whose `suppressed` records are
 * what `explain()` shows an advisor.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy } from "../policy";
import type { Hint } from "../types";
import { FakeClock } from "../../testing/fakes";
import { EVERYONE, audienceOf, canCoRender, compareHints, conflicts, precedence, resolveConflicts, type ConflictContext } from "./conflict";

const clock = new FakeClock();
const T0 = clock.iso();
const DAY_MS = 86_400_000;
const later = new Date(clock.now() + DAY_MS).toISOString();
const ctx: ConflictContext = { policy: defaultPolicy, now: clock.now() };

function hint(over: Partial<Hint> & { id: string }): Hint {
  return {
    text: "Prefers bullet points.",
    priority: 60,
    scope: "global",
    source: "explicit",
    confidence: 0.8,
    lane: "agent",
    kind: "preference",
    slot: "format.lists",
    nodePath: "/",
    approval: "auto",
    provenance: { originEventId: "ev", createdAt: T0, lastReinforcedAt: T0, extractor: "rule" },
    ...over,
  };
}

const agentHint = (id: string, agent: string, over: Partial<Hint> = {}): Hint =>
  hint({ id, scope: "agent", agent, nodePath: `/${agent}`, ...over });
const clientHint = (id: string, clientId: string, over: Partial<Hint> = {}): Hint => hint({ id, scope: "client", clientId, ...over });
const categoryHint = (id: string, nodePath: string, over: Partial<Hint> = {}): Hint => hint({ id, scope: "category", nodePath, ...over });

function expectWin(winner: Hint, loser: Hint, rule: string): void {
  const forward = precedence(winner, loser, ctx);
  const backward = precedence(loser, winner, ctx);
  expect(forward).toEqual({ winner, loser, rule });
  expect(backward).toEqual({ winner, loser, rule });
  expect(compareHints(winner, loser, ctx)).toBeLessThan(0);
  expect(compareHints(loser, winner, ctx)).toBeGreaterThan(0);
}

describe("precedence table (§6.3)", () => {
  it("1. approval: approved beats auto even when the auto hint would win every later rule", () => {
    const approved = hint({ id: "b", approval: "approved", scope: "global", source: "inferred", priority: 10 });
    const auto = clientHint("a", "client_A", { source: "explicit", priority: 100, provenance: { originEventId: "ev", createdAt: later, lastReinforcedAt: later, extractor: "rule" } });
    expectWin(approved, auto, "approval");
  });

  it("2. scope: client > agent > category > global", () => {
    const client = clientHint("c", "client_A");
    const agent = agentHint("a", "consult_advice");
    const category = categoryHint("k", "/consult_advice");
    const global = hint({ id: "g" });
    expectWin(client, agent, "scope");
    expectWin(agent, category, "scope");
    expectWin(category, global, "scope");
    expectWin(client, global, "scope");
    expectWin(client, category, "scope");
    expectWin(agent, global, "scope");
  });

  it("2. scope: between category hints the deeper node wins", () => {
    const deep = categoryHint("d", "/consult_advice/retirement/withdrawals");
    const shallow = categoryHint("s", "/consult_advice");
    expectWin(deep, shallow, "scope");
  });

  it("2. scope beats source: an inferred client hint beats an explicit global one", () => {
    const client = clientHint("c", "client_A", { source: "inferred" });
    const global = hint({ id: "g", source: "explicit" });
    expectWin(client, global, "scope");
  });

  it("3. source: explicit beats inferred at equal approval and scope", () => {
    const explicit = hint({ id: "e", source: "explicit", priority: 10 });
    const inferred = hint({ id: "i", source: "inferred", priority: 100 });
    expectWin(explicit, inferred, "source");
    const deepInferred = categoryHint("d", "/consult_advice/retirement", { source: "inferred" });
    const deepExplicit = categoryHint("x", "/consult_advice/retirement", { source: "explicit" });
    expectWin(deepExplicit, deepInferred, "source");
  });

  it("4. recency: the more recently reinforced hint wins at equal source", () => {
    const newer = hint({ id: "n", priority: 10, provenance: { originEventId: "ev", createdAt: T0, lastReinforcedAt: later, extractor: "rule" } });
    const older = hint({ id: "o", priority: 100 });
    expectWin(newer, older, "recency");
  });

  it("5. score: the higher effective score wins at equal recency", () => {
    const strong = hint({ id: "s", priority: 90 });
    const weak = hint({ id: "w", priority: 30 });
    expectWin(strong, weak, "score");
  });

  it("5. score uses the caller's effective scores when given", () => {
    const a = hint({ id: "a", priority: 30 });
    const b = hint({ id: "b", priority: 90 });
    const custom: ConflictContext = { ...ctx, effective: (h) => (h.id === "a" ? 1 : 0.1) };
    expect(precedence(a, b, custom)).toEqual({ winner: a, loser: b, rule: "score" });
  });

  it("5. score: a complete tie falls to the lower id, so the order is total", () => {
    const a = hint({ id: "h_a" });
    const b = hint({ id: "h_b" });
    expectWin(a, b, "score");
  });

  it("returns null for the same hint", () => {
    const a = hint({ id: "a" });
    expect(precedence(a, { ...a }, ctx)).toBeNull();
    expect(compareHints(a, a, ctx)).toBe(0);
  });
});

describe("shared-subject rule", () => {
  const withShared = (...ids: string[]): ConflictContext => ({ ...ctx, shared: new Set(ids) });

  it("a shared hint loses to a primary hint of the same slot when both are approved", () => {
    const shared = hint({ id: "shared", approval: "approved", priority: 100 });
    const primary = hint({ id: "primary", approval: "approved", priority: 10 });
    const c = withShared("shared");
    expect(precedence(shared, primary, c)).toEqual({ winner: primary, loser: shared, rule: "shared-subject" });
    expect(precedence(primary, shared, c)).toEqual({ winner: primary, loser: shared, rule: "shared-subject" });
  });

  it("a shared hint loses when neither is approved, whatever the other rules say", () => {
    const shared = clientHint("shared", "client_A", { source: "explicit" });
    const primary = hint({ id: "primary", source: "inferred", priority: 1 });
    expect(precedence(shared, primary, withShared("shared"))).toEqual({ winner: primary, loser: shared, rule: "shared-subject" });
  });

  it("an approved shared hint beats an unapproved primary one — by the approval rule", () => {
    const shared = hint({ id: "shared", approval: "approved" });
    const primary = clientHint("primary", "client_A");
    expect(precedence(shared, primary, withShared("shared"))).toEqual({ winner: shared, loser: primary, rule: "approval" });
  });

  it("two shared hints resolve by the ordinary table", () => {
    const a = hint({ id: "a", approval: "approved", source: "explicit" });
    const b = hint({ id: "b", approval: "approved", source: "inferred" });
    expect(precedence(a, b, withShared("a", "b"))).toEqual({ winner: a, loser: b, rule: "source" });
  });
});

describe("audience: which hints can conflict", () => {
  it("is the agent for agent-scoped hints and everyone otherwise", () => {
    expect(audienceOf(agentHint("a", "consult_advice"))).toBe("consult_advice");
    expect(audienceOf(hint({ id: "g" }))).toBe(EVERYONE);
    expect(audienceOf(clientHint("c", "client_A"))).toBe(EVERYONE);
    expect(audienceOf(categoryHint("k", "/consult_advice"))).toBe(EVERYONE);
  });

  it("two agents' hints never render together; everyone-hints render with any", () => {
    const advice = agentHint("a", "consult_advice");
    const kyp = agentHint("k", "consult_kyp");
    const global = hint({ id: "g" });
    expect(canCoRender(advice, kyp)).toBe(false);
    expect(canCoRender(advice, global)).toBe(true);
    expect(canCoRender(global, kyp)).toBe(true);
    expect(canCoRender(advice, agentHint("a2", "consult_advice"))).toBe(true);
  });

  it("conflicts need the same slot", () => {
    expect(conflicts(hint({ id: "a", slot: "tone" }), hint({ id: "b", slot: "tone" }))).toBe(true);
    expect(conflicts(hint({ id: "a", slot: "tone" }), hint({ id: "b", slot: "format.lists" }))).toBe(false);
    expect(conflicts(agentHint("a", "consult_advice"), agentHint("k", "consult_kyp"))).toBe(false);
  });
});

describe("resolveConflicts", () => {
  it("client 'detailed' beats global 'brief' on the same slot; the loser is recorded with the winner and rule (§6.4)", () => {
    const detailed = clientHint("detailed", "client_A", { slot: "detail.level", text: "Prefers detailed explanations." });
    const brief = hint({ id: "brief", slot: "detail.level", text: "Prefers brief answers." });
    const { kept, suppressed } = resolveConflicts([brief, detailed], defaultPolicy, ctx.now);
    expect(kept).toEqual([detailed]);
    expect(suppressed).toEqual([{ hintId: "brief", by: "detailed", rule: "scope" }]);
  });

  it("keeps one winner per slot and leaves other slots alone", () => {
    const a = hint({ id: "a", slot: "tone", source: "explicit" });
    const b = hint({ id: "b", slot: "tone", source: "inferred" });
    const c = hint({ id: "c", slot: "format.lists" });
    const { kept, suppressed } = resolveConflicts([a, b, c], defaultPolicy, ctx.now);
    expect(kept.map((h) => h.id).sort()).toEqual(["a", "c"]);
    expect(suppressed).toEqual([{ hintId: "b", by: "a", rule: "source" }]);
  });

  it("keeps agent-scoped hints for different agents on the same slot, and suppresses the everyone-hint they both beat", () => {
    const advice = agentHint("advice", "consult_advice", { slot: "disclaimers" });
    const kyp = agentHint("kyp", "consult_kyp", { slot: "disclaimers" });
    const global = hint({ id: "global", slot: "disclaimers" });
    const { kept, suppressed } = resolveConflicts([global, kyp, advice], defaultPolicy, ctx.now);
    expect(kept.map((h) => h.id).sort()).toEqual(["advice", "kyp"]);
    expect(suppressed).toEqual([{ hintId: "global", by: "advice", rule: "scope" }]);
  });

  it("an approved global hint suppresses every agent's hint on its slot by approval", () => {
    const global = hint({ id: "global", slot: "disclaimers", approval: "approved" });
    const advice = agentHint("advice", "consult_advice", { slot: "disclaimers" });
    const kyp = agentHint("kyp", "consult_kyp", { slot: "disclaimers" });
    const { kept, suppressed } = resolveConflicts([advice, kyp, global], defaultPolicy, ctx.now);
    expect(kept).toEqual([global]);
    expect(suppressed).toEqual([
      { hintId: "advice", by: "global", rule: "approval" },
      { hintId: "kyp", by: "global", rule: "approval" },
    ]);
  });

  it("two hints for the same agent on one slot still resolve to one", () => {
    const older = agentHint("older", "consult_advice", { slot: "disclaimers" });
    const newer = agentHint("newer", "consult_advice", {
      slot: "disclaimers",
      provenance: { originEventId: "ev", createdAt: later, lastReinforcedAt: later, extractor: "rule" },
    });
    const { kept, suppressed } = resolveConflicts([older, newer], defaultPolicy, ctx.now);
    expect(kept).toEqual([newer]);
    expect(suppressed).toEqual([{ hintId: "older", by: "newer", rule: "recency" }]);
  });

  it("applies the shared-subject rule through opts.shared", () => {
    const shared = hint({ id: "shared", approval: "approved", priority: 100 });
    const primary = hint({ id: "primary", approval: "approved", priority: 10 });
    const { kept, suppressed } = resolveConflicts([shared, primary], defaultPolicy, ctx.now, { shared: new Set(["shared"]) });
    expect(kept).toEqual([primary]);
    expect(suppressed).toEqual([{ hintId: "shared", by: "primary", rule: "shared-subject" }]);
  });

  it("is independent of input order and folds duplicate ids", () => {
    const hints = [
      hint({ id: "g", slot: "tone" }),
      clientHint("c", "client_A", { slot: "tone" }),
      agentHint("a", "consult_advice", { slot: "tone" }),
      hint({ id: "x", slot: "other" }),
    ];
    const forward = resolveConflicts(hints, defaultPolicy, ctx.now);
    const backward = resolveConflicts([...hints].reverse(), defaultPolicy, ctx.now);
    const doubled = resolveConflicts([...hints, ...hints], defaultPolicy, ctx.now);
    const normalise = (r: ReturnType<typeof resolveConflicts>) => ({
      kept: r.kept.map((h) => h.id).sort(),
      suppressed: [...r.suppressed].sort((p, q) => p.hintId.localeCompare(q.hintId)),
    });
    expect(normalise(backward)).toEqual(normalise(forward));
    expect(normalise(doubled)).toEqual(normalise(forward));
    expect(normalise(forward).kept).toEqual(["c", "x"]);
  });

  it("the public three-argument form scores rule 5 at relevance 1", () => {
    const strong = hint({ id: "strong", priority: 90 });
    const weak = hint({ id: "weak", priority: 30 });
    const { kept, suppressed } = resolveConflicts([weak, strong], defaultPolicy, ctx.now);
    expect(kept).toEqual([strong]);
    expect(suppressed).toEqual([{ hintId: "weak", by: "strong", rule: "score" }]);
  });

  it("returns nothing for nothing", () => {
    expect(resolveConflicts([], defaultPolicy, ctx.now)).toEqual({ kept: [], suppressed: [] });
  });
});
