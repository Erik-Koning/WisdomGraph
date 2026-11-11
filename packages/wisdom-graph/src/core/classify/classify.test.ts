/**
 * The classifier decides which branch's hints apply, without an LLM. Its
 * contract is pinned two ways: an accuracy floor on the consumer's labelled
 * queries over the advisor fixture (so a weight change that breaks real
 * routing fails loudly), and small hand-built trees where every term of the
 * §4.2 formula — field weights, idf, ancestor credit, each bonus, the
 * confidence threshold and the secondary ratio — is checked in isolation
 * with the numbers worked out by hand.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy, mergePolicy } from "../policy";
import { noopLogger, type GraphSnapshotData, type SubjectRef } from "../ports";
import type { CategorySpec, NeutralMessage, TopicNode } from "../types";
import { FakeClock } from "../../testing/fakes";
import { fixtureHint, fixtureNode, labelledQueries, advisorCategories, advisorFixture } from "../../testing/fixtures";
import { compileSnapshot, emptySnapshotData, type SubjectSnapshot } from "../graph/snapshot";
import {
  BONUSES,
  ClassifierIndex,
  EMPTY_SIGNALS,
  FIELD_WEIGHTS,
  MAX_NODE_PATHS,
  categoryPath,
  classify,
  previousUserTurn,
  queryTerms,
  toTopic,
  toolNames,
  type ScoredNode,
} from "./index";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const clock = new FakeClock();
const ctx = { policy: defaultPolicy };

function snapshotOf(categories: CategorySpec[], partial: Partial<GraphSnapshotData> = {}): SubjectSnapshot {
  return compileSnapshot({ ...emptySnapshotData(ref), ...partial }, defaultPolicy, noopLogger, { ref, categories, clock });
}

function category(name: string, spec: Partial<CategorySpec> = {}): CategorySpec {
  return { name, keywords: [], ...spec };
}

/** Nodes for a tree under seeded categories; `paths` are level ≥ 2. */
function subNodes(...specs: [string, Partial<TopicNode>][]): TopicNode[] {
  return specs.map(([path, overrides]) => fixtureNode(ref, path, overrides));
}

async function advisorSnapshot(): Promise<SubjectSnapshot> {
  const fixture = advisorFixture();
  const data = await fixture.store.loadSnapshot(ref);
  return compileSnapshot(data, defaultPolicy, noopLogger, { ref, categories: fixture.categories, clock });
}

/** `ln(1 + N / df)` — the index's idf, spelled out so the expected numbers below read as the formula. */
const idf = (total: number, df: number): number => Math.log(1 + total / df);

describe("accuracy on labelledQueries() over advisorFixture() (§11.2)", () => {
  it("ships at least 40 rows covering every consult_* category and the direct outcome", () => {
    const rows = labelledQueries();
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const categories = new Set(rows.map((r) => r.category));
    for (const spec of advisorCategories()) expect(categories.has(spec.name), spec.name).toBe(true);
    expect(categories.has("direct")).toBe(true);
    for (const row of rows) expect(row.agents).toEqual(row.category === "direct" ? [] : [row.category]);
  });

  it("classifies at least 90% of rows to their category and includes their agents", async () => {
    const snapshot = await advisorSnapshot();
    const rows = labelledQueries();
    const misses: string[] = [];
    for (const row of rows) {
      const { topic } = classify(snapshot, row.text, ctx);
      if (topic.category !== row.category) {
        misses.push(`${JSON.stringify(row.text)} → ${topic.category} (wanted ${row.category})`);
        continue;
      }
      for (const agent of row.agents) expect(topic.agents, row.text).toContain(agent);
    }
    const accuracy = (rows.length - misses.length) / rows.length;
    expect(accuracy, misses.join("\n")).toBeGreaterThanOrEqual(0.9);
  });

  it("is deterministic and leaves the snapshot untouched", async () => {
    const snapshot = await advisorSnapshot();
    const query = "How should we sequence RRIF withdrawals for a retiree with a large TFSA?";
    const a = classify(snapshot, query, ctx);
    const b = classify(snapshot, query, ctx);
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.topic)).toBe(true);
    expect(Object.isFrozen(a.topic.nodePaths)).toBe(true);
    expect(Object.isFrozen(a.scored)).toBe(true);
    expect(JSON.parse(JSON.stringify(a.topic))).toEqual(a.topic);
  });
});

describe("the direct outcome (§4.2 step 3)", () => {
  it("is 'direct' with method 'none' and confidence 0 when nothing matches", async () => {
    const snapshot = await advisorSnapshot();
    expect(classify(snapshot, "Hello there!", ctx).topic).toEqual({ category: "direct", agents: [], confidence: 0, nodePaths: [], method: "none" });
    expect(classify(snapshot, "", ctx).topic.method).toBe("none");
    expect(classify(snapshot, "   \n  ", ctx).scored).toEqual([]);
  });

  it("is 'direct' with empty nodePaths and agents when confidence is below minConfidence, keeping the method", () => {
    const snapshot = snapshotOf([category("alpha", { keywords: ["zork"] }), category("beta", { keywords: ["zork"] })]);
    const tie = classify(snapshot, "zork", ctx);
    expect(tie.topic).toMatchObject({ category: "alpha", confidence: 0.5, nodePaths: ["/alpha", "/beta"], method: "keyword" });
    const strict = classify(snapshot, "zork", { policy: mergePolicy({ classify: { minConfidence: 0.6 } }) });
    expect(strict.topic).toEqual({ category: "direct", agents: [], confidence: 0.5, nodePaths: [], method: "keyword" });
    expect(strict.scored).toHaveLength(2);
  });

  it("confidence is best / (best + second): 1 for a lone match", () => {
    const snapshot = snapshotOf([category("alpha", { keywords: ["zork"] }), category("beta", { keywords: ["blip"] })]);
    expect(classify(snapshot, "zork", ctx).topic.confidence).toBe(1);
    const both = classify(snapshot, "zork zork blip", ctx);
    expect(both.topic.confidence).toBeCloseTo(0.5, 10);
  });
});

describe("nodePaths and secondaryRatio", () => {
  it("keeps the best plus nodes scoring ≥ secondaryRatio × best, at most three", () => {
    const snapshot = snapshotOf(["a", "b", "c", "d", "e"].map((n) => category(n, { keywords: ["zork", `only-${n}`] })));
    const { topic, scored } = classify(snapshot, "zork", ctx);
    expect(scored).toHaveLength(5);
    expect(scored.every((s) => s.score === 1)).toBe(true);
    expect(topic.nodePaths).toHaveLength(MAX_NODE_PATHS);
    expect(topic.nodePaths).toEqual(["/a", "/b", "/c"]);
  });

  it("drops a secondary node just under the ratio and keeps it when the ratio is lowered", () => {
    const snapshot = snapshotOf([category("alpha", { keywords: ["zork", "blip"] }), category("beta", { keywords: ["zork"] })]);
    const result = classify(snapshot, "zork blip", ctx);
    const beta = result.scored.find((s) => s.path === "/beta");
    expect(beta?.score).toBeGreaterThan(0.4);
    expect(beta?.score).toBeLessThan(0.6);
    expect(result.topic.nodePaths).toEqual(["/alpha"]);
    const lenient = classify(snapshot, "zork blip", { policy: mergePolicy({ classify: { secondaryRatio: 0.4 } }) });
    expect(lenient.topic.nodePaths).toEqual(["/alpha", "/beta"]);
  });
});

describe("field weights, idf and ancestor credit", () => {
  it("weights title 3, keywords 2, description 1, property values 0.5 and hint values 1, times idf", () => {
    const nodes = subNodes(
      ["/hub/title", { title: "Zork" }],
      ["/hub/keyword", { keywords: ["zork"] }],
      ["/hub/description", { description: "All about zork." }],
      ["/hub/property", { properties: { "region.default": "zork", nested: { list: ["zork"] } } }],
      ["/hub/value", {}],
    );
    const hint = fixtureHint(ref, { nodePath: "/hub/value", slot: "topic", value: "zork", text: "Prefers zork." });
    const snapshot = snapshotOf([category("hub")], { nodes: [fixtureNode(ref, "/"), fixtureNode(ref, "/hub"), ...nodes], hints: [hint] });
    const total = snapshot.index.size;
    expect(total).toBe(6);
    const scale = idf(total, 5);
    const { scored } = classify(snapshot, "zork", ctx);
    const keyword = (path: string): number => scored.find((s) => s.path === path)?.signals.keyword ?? Number.NaN;
    expect(keyword("/hub/title")).toBeCloseTo(FIELD_WEIGHTS.title * scale, 10);
    expect(keyword("/hub/keyword")).toBeCloseTo(FIELD_WEIGHTS.keyword * scale, 10);
    expect(keyword("/hub/description")).toBeCloseTo(FIELD_WEIGHTS.description * scale, 10);
    expect(keyword("/hub/property")).toBeCloseTo(FIELD_WEIGHTS.property * scale, 10);
    expect(keyword("/hub/value")).toBeCloseTo(FIELD_WEIGHTS.hintValue * scale, 10);
    // The hub collects half of every child's own score, so among the children the title wins.
    const children = scored.filter((s) => s.path !== "/hub");
    expect(children.map((s) => s.path)).toEqual(["/hub/title", "/hub/keyword", "/hub/description", "/hub/value", "/hub/property"]);
    expect(scored.find((s) => s.path === "/hub")?.signals.ancestor).toBeCloseTo(BONUSES.ancestorCredit * (3 + 2 + 1 + 0.5 + 1) * scale, 10);
  });

  it("takes the best field per token rather than summing them", () => {
    const snapshot = snapshotOf([category("alpha", { title: "Zork", keywords: ["zork"], description: "zork zork" })]);
    const { scored } = classify(snapshot, "zork", ctx);
    expect(scored[0]?.signals.keyword).toBeCloseTo(FIELD_WEIGHTS.title * idf(1, 1), 10);
  });

  it("scales by idf: a token in every node is worth ln 2, one in a single node ln(1 + N)", () => {
    const snapshot = snapshotOf([
      category("alpha", { keywords: ["common", "rare"] }),
      category("beta", { keywords: ["common"] }),
      category("gamma", { keywords: ["common"] }),
    ]);
    expect(ClassifierIndex.idf(3, 3)).toBeCloseTo(Math.log(2), 12);
    expect(ClassifierIndex.idf(3, 1)).toBeCloseTo(Math.log(4), 12);
    expect(ClassifierIndex.idf(3, 0)).toBe(0);
    const common = classify(snapshot, "common", ctx).scored;
    expect(common.map((s) => s.signals.keyword)).toEqual([2 * Math.log(2), 2 * Math.log(2), 2 * Math.log(2)]);
    const rare = classify(snapshot, "rare", ctx).scored;
    expect(rare).toHaveLength(1);
    expect(rare[0]?.signals.keyword).toBeCloseTo(2 * Math.log(4), 10);
  });

  it("credits every proper ancestor except the root at 0.5 of a child's own score, without compounding", () => {
    const nodes = subNodes(["/alpha/sub", { keywords: [] }], ["/alpha/sub/leaf", { keywords: ["zork"] }]);
    const snapshot = snapshotOf([category("alpha"), category("beta")], { nodes: [fixtureNode(ref, "/"), fixtureNode(ref, "/alpha"), ...nodes] });
    const { scored, topic } = classify(snapshot, "zork", ctx);
    const own = FIELD_WEIGHTS.keyword * idf(4, 1);
    const by = new Map(scored.map((s) => [s.path, s]));
    expect(by.get("/alpha/sub/leaf")?.signals).toMatchObject({ keyword: own, ancestor: 0, depth: 3 * BONUSES.depthPerLevel });
    expect(by.get("/alpha/sub")?.signals).toMatchObject({ keyword: 0, ancestor: BONUSES.ancestorCredit * own, depth: 2 * BONUSES.depthPerLevel });
    expect(by.get("/alpha")?.signals).toMatchObject({ keyword: 0, ancestor: BONUSES.ancestorCredit * own, depth: BONUSES.depthPerLevel });
    expect(by.has("/")).toBe(false);
    expect(by.has("/beta")).toBe(false);
    expect(topic.category).toBe("alpha");
    expect(topic.nodePaths[0]).toBe("/alpha/sub/leaf");
  });

  it("prefers the deeper of two otherwise equal nodes", () => {
    const nodes = subNodes(["/alpha/sub", { keywords: ["zork"] }]);
    const snapshot = snapshotOf([category("alpha"), category("beta", { keywords: ["zork"] })], { nodes: [fixtureNode(ref, "/"), fixtureNode(ref, "/alpha"), ...nodes] });
    const { topic, scored } = classify(snapshot, "zork", ctx);
    expect(scored.map((s) => s.path)).toEqual(["/alpha/sub", "/beta", "/alpha"]);
    expect(topic.category).toBe("alpha");
  });
});

describe("seed patterns", () => {
  it("a pattern hit dominates a couple of keyword hits on another node", () => {
    const snapshot = snapshotOf([
      category("alpha", { keywords: ["unrelated", "words"], patterns: ["\\bzork\\b"] }),
      category("beta", { keywords: ["red", "green", "blue"] }),
    ]);
    const { topic, scored } = classify(snapshot, "ZORK red green", ctx);
    expect(topic.category).toBe("alpha");
    const alpha = scored.find((s) => s.path === "/alpha");
    const beta = scored.find((s) => s.path === "/beta");
    expect(alpha?.signals).toMatchObject({ pattern: FIELD_WEIGHTS.pattern * idf(2, 1), keyword: 0 });
    expect(beta?.signals.keyword).toBeCloseTo(2 * FIELD_WEIGHTS.keyword * idf(2, 1), 10);
    expect(alpha?.total ?? 0).toBeGreaterThan(beta?.total ?? 0);
    expect(topic.method).toBe("keyword");
  });

  it("counts a node once however many of its patterns hit, and shares idf when several nodes hit", () => {
    const one = snapshotOf([category("alpha", { patterns: ["\\bzork\\b", "zor", "k$"] }), category("beta")]);
    expect(classify(one, "zork", ctx).scored[0]?.signals.pattern).toBeCloseTo(FIELD_WEIGHTS.pattern * idf(2, 1), 10);
    const two = snapshotOf([category("alpha", { patterns: ["\\bzork\\b"] }), category("beta", { patterns: ["zor"] })]);
    const { scored } = classify(two, "zork", ctx);
    expect(scored.map((s) => s.signals.pattern)).toEqual([FIELD_WEIGHTS.pattern * idf(2, 2), FIELD_WEIGHTS.pattern * idf(2, 2)]);
  });

  it("runs the pattern on the current text only, not on the previous turn", () => {
    const snapshot = snapshotOf([category("alpha", { patterns: ["\\bzork\\b"] }), category("beta", { keywords: ["blip"] })]);
    const turns: NeutralMessage[] = [{ role: "user", content: "zork" }];
    const { topic, scored } = classify(snapshot, "blip", { ...ctx, recentTurns: turns });
    expect(topic.category).toBe("beta");
    expect(scored.some((s) => s.path === "/alpha")).toBe(false);
  });
});

describe("bonuses", () => {
  const pair = (): SubjectSnapshot => snapshotOf([category("alpha", { keywords: ["zork"] }), category("beta", { keywords: ["zork"] })]);

  it("continuity breaks a tie and is reported as the method", () => {
    const snapshot = pair();
    expect(classify(snapshot, "zork", ctx).topic).toMatchObject({ category: "alpha", method: "keyword" });
    const carried = classify(snapshot, "zork", { ...ctx, recentPaths: ["/beta", "/beta", "/nowhere"] });
    expect(carried.topic).toMatchObject({ category: "beta", method: "continuity", nodePaths: ["/beta", "/alpha"] });
    expect(carried.scored[0]?.signals.continuity).toBe(defaultPolicy.classify.continuityBonus);
    expect(carried.scored[1]?.signals.continuity).toBe(0);
    expect(classify(snapshot, "zork", { ...ctx, recentPaths: ["/alpha"] }).topic).toMatchObject({ category: "alpha", method: "continuity" });
  });

  it("continuity does not override a real keyword margin", () => {
    const snapshot = snapshotOf([category("alpha", { keywords: ["zork", "blip"] }), category("beta", { keywords: ["zork"] })]);
    const { topic } = classify(snapshot, "zork blip", { ...ctx, recentPaths: ["/beta"] });
    expect(topic).toMatchObject({ category: "alpha", method: "keyword" });
  });

  it("never scores a node for continuity alone: a query that matches nothing stays direct whatever the ring holds", async () => {
    const snapshot = await advisorSnapshot();
    const direct = { category: "direct", agents: [], confidence: 0, nodePaths: [], method: "none" };
    for (const recentPaths of [["/consult_kyp"], ["/consult_kyp", "/consult_advice"], ["/consult_advice/retirement"]]) {
      const result = classify(snapshot, "hello", { ...ctx, recentPaths });
      expect(result.topic, recentPaths.join()).toEqual(direct);
      expect(result.scored).toEqual([]);
    }
    expect(classify(compileSnapshot(null, defaultPolicy, noopLogger, { ref, categories: advisorCategories(), clock }), "hello", { ...ctx, recentPaths: ["/consult_kyp"] }).topic).toEqual(direct);
  });

  it("gives the bonus only to nodes the query reached, and a lone winner with it still reports 'keyword'", () => {
    const snapshot = snapshotOf([category("alpha", { keywords: ["zork"] }), category("beta", { keywords: ["blip"] })]);
    const { topic, scored } = classify(snapshot, "zork", { ...ctx, recentPaths: ["/alpha", "/beta"] });
    expect(scored.map((s) => s.path)).toEqual(["/alpha"]);
    expect(scored[0]?.signals.continuity).toBe(defaultPolicy.classify.continuityBonus);
    expect(topic).toMatchObject({ category: "alpha", confidence: 1, method: "keyword" });
  });

  it("toTopic reports 'continuity' for a winner that has nothing but the bonus, never 'keyword'", () => {
    const snapshot = snapshotOf([category("alpha"), category("beta")]);
    const only: ScoredNode = { path: "/alpha", total: 0.4, score: 1, signals: { ...EMPTY_SIGNALS, continuity: 0.3, depth: 0.1 } };
    expect(toTopic([only], snapshot, defaultPolicy)).toMatchObject({ category: "alpha", confidence: 1, method: "continuity" });
    const carried: ScoredNode = { path: "/alpha", total: 1.4, score: 1, signals: { ...EMPTY_SIGNALS, keyword: 1, continuity: 0.3, depth: 0.1 } };
    expect(toTopic([carried], snapshot, defaultPolicy).method).toBe("keyword");
  });

  it("uses the policy's continuity bonus", () => {
    const policy = mergePolicy({ classify: { continuityBonus: 0.05 } });
    const { scored } = classify(pair(), "zork", { policy, recentPaths: ["/beta"] });
    expect(scored[0]?.signals.continuity).toBe(0.05);
  });

  it("a category hint from the context, the surface map or a tool name adds 5 and is reported as the method", () => {
    const snapshot = snapshotOf([category("alpha", { keywords: ["zork"] }), category("beta", { keywords: ["blip"] })]);
    const expectHinted = (result: ReturnType<typeof classify>): void => {
      expect(result.topic).toMatchObject({ category: "beta", method: "category-hint" });
      expect(result.scored[0]?.signals.categoryHint).toBe(BONUSES.categoryHint);
    };
    expectHinted(classify(snapshot, "zork", { ...ctx, categoryHints: ["beta", "unknown"] }));
    expectHinted(classify(snapshot, "zork", { ...ctx, surface: "client_sheet", surfaceCategories: { client_sheet: "beta" } }));
    expectHinted(classify(snapshot, "zork", { ...ctx, recentTurns: [{ role: "tool", name: "beta", content: "" }] }));
    expectHinted(classify(snapshot, "zork", { ...ctx, recentTurns: [{ role: "assistant", content: "", toolCalls: [{ name: "beta", args: {} }] }] }));
    expect(classify(snapshot, "zork", { ...ctx, surface: "client_sheet" }).topic.category).toBe("alpha");
    expect(classify(snapshot, "zork", { ...ctx, categoryHints: ["unknown"] }).topic.method).toBe("keyword");
    expect(classify(snapshot, "hello", { ...ctx, categoryHints: ["beta"] }).topic).toMatchObject({ category: "beta", confidence: 1, method: "category-hint" });
  });

  it("mentioning a configured category by name or title adds 4", () => {
    const snapshot = snapshotOf([category("alpha", { title: "Alpha Desk" }), category("beta", { keywords: ["zork"] })]);
    const byTitle = classify(snapshot, "zork — ask the Alpha desk", ctx);
    expect(byTitle.topic.category).toBe("alpha");
    expect(byTitle.scored[0]?.signals.agentMention).toBe(BONUSES.agentMention);
    const byName = classify(snapshot, "route this to alpha please", ctx);
    expect(byName.topic).toMatchObject({ category: "alpha", method: "keyword" });
    expect(classify(snapshot, "the alphabet is long", ctx).topic.category).toBe("direct");
  });

  it("mentions the consumer's handoff names and titles", async () => {
    const snapshot = await advisorSnapshot();
    const { topic, scored } = classify(snapshot, "Ask the market analyst about zork", ctx);
    expect(topic.category).toBe("consult_market_analyst");
    expect(scored[0]?.signals.agentMention).toBe(BONUSES.agentMention);
    expect(classify(snapshot, "consult_kyp should handle this", ctx).topic.category).toBe("consult_kyp");
  });
});

describe("recent turns", () => {
  it("counts the previous user turn's tokens at 0.5 and never the query itself", () => {
    const snapshot = snapshotOf([category("alpha", { keywords: ["zork"] }), category("beta", { keywords: ["blip"] })]);
    const turns: NeutralMessage[] = [
      { role: "user", content: "zork zork" },
      { role: "assistant", content: "blip blip blip" },
      { role: "user", content: "blip" },
    ];
    const { topic, scored } = classify(snapshot, "blip", { ...ctx, recentTurns: turns });
    expect(topic.category).toBe("beta");
    const alpha = scored.find((s) => s.path === "/alpha");
    const beta = scored.find((s) => s.path === "/beta");
    expect(alpha?.signals.keyword).toBeCloseTo(BONUSES.previousTurn * (beta?.signals.keyword ?? 0), 10);
    expect(beta?.signals.keyword).toBeCloseTo(FIELD_WEIGHTS.keyword * idf(2, 1), 10);
  });

  it("previousUserTurn picks the last user message that is not the query", () => {
    const turns: NeutralMessage[] = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "  The Query  " },
    ];
    expect(previousUserTurn(turns, "the query")).toBe("second");
    expect(previousUserTurn(turns, "other")).toBe("  The Query  ");
    expect(previousUserTurn([{ role: "assistant", content: "x" }], "q")).toBeUndefined();
    expect(previousUserTurn(undefined, "q")).toBeUndefined();
  });

  it("queryTerms weights the current turn 1 and the previous 0.5, current winning on overlap", () => {
    const terms = queryTerms("Zork and blips", "blip flub");
    expect([...terms.tokens]).toEqual([
      ["zork", 1],
      ["blip", 1],
      ["flub", BONUSES.previousTurn],
    ]);
    expect(terms.text).toBe("Zork and blips");
  });

  it("toolNames collects tool messages' names and assistant tool calls", () => {
    expect(
      toolNames([
        { role: "tool", name: "consult_kyp", content: "" },
        { role: "assistant", content: "", toolCalls: [{ name: "consult_advice", args: 1 }, { name: "search", args: null }] },
        { role: "user", content: "x", name: "ignored" },
      ]),
    ).toEqual(["consult_kyp", "consult_advice", "search"]);
    expect(toolNames(undefined)).toEqual([]);
  });
});

describe("agents and categories", () => {
  it("unions the matched nodes' agents and adds the category when it is configured", () => {
    const nodes = subNodes(["/alpha/sub", { keywords: ["zork"], agents: ["alpha", "helper"] }]);
    const alpha = fixtureNode(ref, "/alpha", { keywords: ["zork"], agents: ["alpha"] });
    const snapshot = snapshotOf([category("alpha", { keywords: ["zork"] })], { nodes: [fixtureNode(ref, "/"), alpha, ...nodes] });
    const { topic } = classify(snapshot, "zork", ctx);
    expect(topic.nodePaths).toEqual(["/alpha", "/alpha/sub"]);
    expect(topic.agents).toEqual(["alpha", "helper"]);
  });

  it("does not add an unconfigured level-1 slug as an agent but still reports it as the category", () => {
    const stray = fixtureNode(ref, "/legacy", { keywords: ["zork"], agents: [] });
    const snapshot = snapshotOf([category("alpha")], { nodes: [fixtureNode(ref, "/"), stray] });
    const { topic } = classify(snapshot, "zork", ctx);
    expect(topic).toMatchObject({ category: "legacy", agents: [], nodePaths: ["/legacy"] });
  });

  it("learned agents on a category node come through", async () => {
    const snapshot = await advisorSnapshot();
    const { topic } = classify(snapshot, "Decumulation timing for CPP and OAS", ctx);
    expect(topic.category).toBe("consult_advice");
    expect(topic.nodePaths).toContain("/consult_advice/retirement");
    expect(topic.agents).toEqual(expect.arrayContaining(["consult_advice", "consult_kyp"]));
  });

  it("categoryPath is the level-1 path of a name", () => {
    expect(categoryPath("consult_kyp")).toBe("/consult_kyp");
  });
});

describe("ClassifierIndex", () => {
  it("indexes active non-root nodes only, and only active hints' values", () => {
    const nodes = [
      fixtureNode(ref, "/", { keywords: ["rootword"] }),
      fixtureNode(ref, "/alpha", { keywords: ["zork"] }),
      fixtureNode(ref, "/alpha/gone", { keywords: ["zork"], status: "retired" }),
      fixtureNode(ref, "/alpha/moved", { keywords: ["zork"], status: "merged", mergedInto: "/alpha" }),
    ];
    const hints = [
      fixtureHint(ref, { nodePath: "/alpha", slot: "a", value: "canada", text: "Defaults to Canada." }),
      fixtureHint(ref, { nodePath: "/alpha", slot: "b", value: "quux", text: "Defaults to quux.", status: "retired" }),
    ];
    const index = new ClassifierIndex(nodes, hints);
    expect(index.size).toBe(1);
    expect(index.has("/")).toBe(false);
    expect(index.has("/alpha")).toBe(true);
    expect(index.has("/alpha/gone")).toBe(false);
    expect(index.tokens().sort()).toEqual(["alpha", "canada", "zork"]);
    expect(index.score(queryTerms("rootword quux")).size).toBe(0);
    expect(index.score(queryTerms("canada")).get("/alpha")?.keyword).toBeCloseTo(FIELD_WEIGHTS.hintValue * idf(1, 1), 10);
  });

  it("stems what it indexes the way it stems the query", () => {
    const index = new ClassifierIndex([fixtureNode(ref, "/alpha", { keywords: ["withdrawals", "fact sheet"] })], []);
    expect(index.tokens().sort()).toEqual(["alpha", "fact", "sheet", "withdrawal"]);
    expect(index.score(queryTerms("withdrawal")).get("/alpha")).toBeDefined();
    expect(index.score(queryTerms("sheets")).get("/alpha")).toBeDefined();
  });

  it("records an unsafe stored pattern instead of throwing and keeps the safe ones", () => {
    const index = new ClassifierIndex([fixtureNode(ref, "/alpha", { patterns: ["(a+)+", "\\bzork\\b"] })], []);
    expect(index.rejectedPatterns).toEqual([{ path: "/alpha", source: "(a+)+", reason: expect.stringContaining("nests") }]);
    expect(index.score(queryTerms("zork")).get("/alpha")?.pattern).toBeGreaterThan(0);
  });

  it("scores an empty query as nothing, and runs patterns only when there is text", () => {
    const index = new ClassifierIndex([fixtureNode(ref, "/alpha", { patterns: ["\\bzork\\b"], keywords: ["zork"] })], []);
    expect(index.score(queryTerms("")).size).toBe(0);
    expect(index.score(queryTerms("the and of")).size).toBe(0);
    const matchAll = new ClassifierIndex([fixtureNode(ref, "/alpha", { patterns: [".*"] })], []);
    expect(matchAll.score(queryTerms("")).size).toBe(0);
    expect(matchAll.score(queryTerms("the and of")).size).toBe(1);
  });
});
