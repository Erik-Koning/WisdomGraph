/**
 * The re-rank is a blend the engine may or may not run; what matters here is
 * that the blend is the spec's arithmetic, that it changes nothing when it
 * has nothing to add (same object back, so `refine()` can return its input
 * on failure), and that a node without a vector cannot win by omission.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy, mergePolicy } from "../policy";
import { noopLogger, type GraphSnapshotData, type SubjectRef } from "../ports";
import type { CategorySpec, TopicNode } from "../types";
import { FakeClock, FakeEmbedding } from "../../testing/fakes";
import { fixtureNode } from "../../testing/fixtures";
import { compileSnapshot, emptySnapshotData, type SubjectSnapshot } from "../graph/snapshot";
import { classify } from "./index";
import { cosine, rerankByEmbedding } from "./embedding";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const clock = new FakeClock();
const ctx = { policy: defaultPolicy };

describe("cosine", () => {
  it.each<[number[], number[], number]>([
    [[1, 0], [1, 0], 1],
    [[1, 0], [0, 1], 0],
    [[1, 0], [-1, 0], -1],
    [[3, 4], [6, 8], 1],
    [[1, 2, 3], [1, 2, 3], 1],
    [[1, 1], [1, 0], Math.SQRT1_2],
  ])("cosine(%j, %j) = %d", (a, b, expected) => {
    expect(cosine(a, b)).toBeCloseTo(expected, 12);
  });

  it("is 0 for empty, zero and mismatched vectors instead of NaN or a throw", () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
    expect(cosine([1], [1, 0])).toBe(0);
  });
});

describe("rerankByEmbedding", () => {
  const categories: CategorySpec[] = [
    { name: "alpha", keywords: ["zork"] },
    { name: "beta", keywords: ["blip"] },
    { name: "gamma", keywords: ["flub"] },
  ];

  function snapshotWith(embeddings: Partial<Record<string, number[]>>, extra: Partial<GraphSnapshotData> = {}): SubjectSnapshot {
    const nodes: TopicNode[] = [fixtureNode(ref, "/")];
    for (const spec of categories) {
      const vector = embeddings[spec.name];
      nodes.push(fixtureNode(ref, `/${spec.name}`, { keywords: spec.keywords, agents: [spec.name], ...(vector ? { embedding: vector } : {}) }));
    }
    return compileSnapshot({ ...emptySnapshotData(ref), nodes, ...extra }, defaultPolicy, noopLogger, { ref, categories, clock });
  }

  const alpha = [1, 0, 0];
  const beta = [0, 1, 0];

  it("returns the very same classification when embeddings are missing on the snapshot or the query", () => {
    const bare = snapshotWith({});
    const keyword = classify(bare, "zork", ctx);
    expect(bare.hasEmbeddings).toBe(false);
    expect(rerankByEmbedding(keyword, beta, bare, defaultPolicy)).toBe(keyword);
    const embedded = snapshotWith({ alpha, beta });
    const scored = classify(embedded, "zork", ctx);
    expect(rerankByEmbedding(scored, null, embedded, defaultPolicy)).toBe(scored);
    expect(rerankByEmbedding(scored, undefined, embedded, defaultPolicy)).toBe(scored);
    expect(rerankByEmbedding(scored, [], embedded, defaultPolicy)).toBe(scored);
  });

  it("blends embedBlend × cosine + (1 − embedBlend) × keyword per node and reports method 'embedding'", () => {
    const snapshot = snapshotWith({ alpha, beta });
    const keyword = classify(snapshot, "zork", ctx);
    expect(keyword.topic).toMatchObject({ category: "alpha", method: "keyword" });
    const blend = 0.6;
    const refined = rerankByEmbedding(keyword, beta, snapshot, mergePolicy({ classify: { embedBlend: blend } }));
    expect(refined).not.toBe(keyword);
    expect(refined.topic).toMatchObject({ category: "beta", method: "embedding", nodePaths: ["/beta", "/alpha"], agents: ["beta", "alpha"] });
    const by = new Map(refined.scored.map((s) => [s.path, s]));
    expect(by.get("/beta")?.total).toBeCloseTo(blend * 1 + (1 - blend) * 0, 12);
    expect(by.get("/alpha")?.total).toBeCloseTo(blend * 0 + (1 - blend) * 1, 12);
    expect(by.get("/beta")?.signals).toMatchObject({ embedding: 1, keyword: 0 });
    expect(by.get("/alpha")?.signals).toMatchObject({ embedding: 0, keyword: keyword.scored[0]?.signals.keyword });
    expect(by.has("/gamma")).toBe(false);
    expect(refined.queryTokens).toBe(keyword.queryTokens);
    expect(Object.isFrozen(refined)).toBe(true);
    expect(Object.isFrozen(refined.topic)).toBe(true);
  });

  it("keeps the keyword ranking at embedBlend 0 and uses cosine alone at 1", () => {
    const snapshot = snapshotWith({ alpha, beta });
    const keyword = classify(snapshot, "zork", ctx);
    const none = rerankByEmbedding(keyword, beta, snapshot, mergePolicy({ classify: { embedBlend: 0 } }));
    expect(none.scored.map((s) => [s.path, s.total])).toEqual([["/alpha", 1]]);
    expect(none.topic).toMatchObject({ category: "alpha", method: "embedding" });
    const pure = rerankByEmbedding(keyword, beta, snapshot, mergePolicy({ classify: { embedBlend: 1 } }));
    expect(pure.scored.map((s) => [s.path, s.total])).toEqual([["/beta", 1]]);
    expect(pure.topic.category).toBe("beta");
  });

  it("gives a node without a vector cosine 0, clamps negative similarity to 0 and treats a dimension mismatch as 0", () => {
    const snapshot = snapshotWith({ alpha, beta });
    const gamma = rerankByEmbedding(classify(snapshot, "flub", ctx), beta, snapshot, defaultPolicy);
    expect(gamma.scored.find((s) => s.path === "/gamma")).toMatchObject({ total: 0.5, signals: { embedding: 0 } });
    const opposite = rerankByEmbedding(classify(snapshot, "zork", ctx), [-1, 0, 0], snapshot, defaultPolicy);
    expect(opposite.scored.find((s) => s.path === "/alpha")).toMatchObject({ total: 0.5, signals: { embedding: 0 } });
    expect(opposite.scored.some((s) => s.path === "/beta")).toBe(false);
    const mismatch = rerankByEmbedding(classify(snapshot, "zork", ctx), [1, 0], snapshot, defaultPolicy);
    expect(mismatch.scored.map((s) => [s.path, s.total])).toEqual([["/alpha", 0.5]]);
    expect(mismatch.topic).toMatchObject({ category: "alpha", method: "embedding" });
  });

  it("normalises the blended scores so the best is 1 and applies secondaryRatio and the ≤ 3 cap", () => {
    const snapshot = snapshotWith({ alpha, beta, gamma: [0, 0, 1] });
    const refined = rerankByEmbedding(classify(snapshot, "zork", ctx), [1, 1, 0.2], snapshot, defaultPolicy);
    expect(refined.scored[0]?.score).toBe(1);
    expect(refined.scored.length).toBe(3);
    expect(refined.topic.nodePaths.length).toBeLessThanOrEqual(3);
    expect(refined.topic.nodePaths[0]).toBe(refined.scored[0]?.path);
  });

  it("lets a deterministic fake embedding flip a query the keywords cannot place", async () => {
    const fake = new FakeEmbedding(32);
    const titles = { alpha: "drawing down retirement savings", beta: "market headlines", gamma: "meeting agendas" };
    const [a, b, g] = await fake.embed([titles.alpha, titles.beta, titles.gamma]);
    const snapshot = snapshotWith({ alpha: a, beta: b, gamma: g });
    const query = "drawing down my savings";
    const keyword = classify(snapshot, query, ctx);
    expect(keyword.topic.category).toBe("direct");
    const [vector] = await fake.embed([query]);
    const refined = rerankByEmbedding(keyword, vector, snapshot, defaultPolicy);
    expect(refined.topic).toMatchObject({ category: "alpha", method: "embedding" });
    expect(refined.scored[0]?.signals.embedding ?? 0).toBeGreaterThan(refined.scored[1]?.signals.embedding ?? 0);
  });
});
