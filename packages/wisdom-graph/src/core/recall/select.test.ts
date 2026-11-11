/**
 * Candidate selection is checked against the advisor fixture, whose hints
 * cover every scope, both subjects and every status the gate must handle.
 * Topics are hand-built rather than classified so each test controls the
 * one thing it is about: which node matched, which agents were predicted,
 * which client is asking.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy, mergePolicy } from "../policy";
import { noopLogger, type SubjectRef } from "../ports";
import type { Topic } from "../types";
import { FakeClock } from "../../testing/fakes";
import { advisorFixture } from "../../testing/fixtures";
import { compileSnapshot, type SubjectSnapshot } from "../graph/snapshot";
import { collectCandidates, nodeRelevance, type Candidate } from "./select";

const clock = new FakeClock();
const { relevance } = defaultPolicy.recall;

async function snapshots(statuses?: ("active" | "pending" | "superseded" | "retired")[]): Promise<{ primary: SubjectSnapshot; shared: SubjectSnapshot }> {
  const fixture = advisorFixture({ clock });
  const ref: SubjectRef = { tenantId: null, subjectId: fixture.subjectId };
  const sharedRef: SubjectRef = { tenantId: null, subjectId: fixture.sharedSubjectId };
  const opts = statuses ? { statuses } : {};
  const primary = compileSnapshot(await fixture.store.loadSnapshot(ref, opts), defaultPolicy, noopLogger, { ref, categories: fixture.categories, clock });
  const shared = compileSnapshot(await fixture.store.loadSnapshot(sharedRef, opts), defaultPolicy, noopLogger, { ref: sharedRef, categories: fixture.categories, clock });
  return { primary, shared };
}

function topic(over: Partial<Topic> = {}): Topic {
  return { category: "direct", agents: [], confidence: 0, nodePaths: [], method: "none", ...over };
}

const retirement = topic({ category: "consult_advice", agents: ["consult_advice", "consult_kyp"], confidence: 0.9, nodePaths: ["/consult_advice/retirement"], method: "keyword" });
const markets = topic({ category: "consult_market_analyst", agents: ["consult_market_analyst"], confidence: 0.8, nodePaths: ["/consult_market_analyst/canada"], method: "keyword" });
const direct = topic();

function bySlot(candidates: readonly Candidate[]): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = out.get(c.hint.slot) ?? [];
    list.push(c);
    out.set(c.hint.slot, list);
  }
  return out;
}

function one(candidates: readonly Candidate[], slot: string, scope?: string): Candidate {
  const found = candidates.filter((c) => c.hint.slot === slot && (scope === undefined || c.hint.scope === scope));
  const [first] = found;
  if (found.length !== 1 || first === undefined) throw new Error(`expected exactly one candidate for ${slot}${scope ? ` (${scope})` : ""}, found ${found.length}`);
  return first;
}

describe("nodeRelevance", () => {
  it("is the flat global relevance at the root, whatever matched", () => {
    expect(nodeRelevance("/", retirement, defaultPolicy)).toBe(relevance.global);
    expect(nodeRelevance("/", direct, defaultPolicy)).toBe(relevance.global);
  });

  it("is 1 on a matched node and decays by distance on its ancestors", () => {
    const t = topic({ nodePaths: ["/consult_advice/retirement/withdrawals"] });
    expect(nodeRelevance("/consult_advice/retirement/withdrawals", t, defaultPolicy)).toBe(relevance.matched);
    expect(nodeRelevance("/consult_advice/retirement", t, defaultPolicy)).toBeCloseTo(relevance.ancestorDecay, 12);
    expect(nodeRelevance("/consult_advice", t, defaultPolicy)).toBeCloseTo(relevance.ancestorDecay ** 2, 12);
  });

  it("is undefined off the matched branches, including below a match", () => {
    expect(nodeRelevance("/consult_market_analyst", retirement, defaultPolicy)).toBeUndefined();
    expect(nodeRelevance("/consult_advice/retirement/withdrawals", retirement, defaultPolicy)).toBeUndefined();
    expect(nodeRelevance("/consult_advice", direct, defaultPolicy)).toBeUndefined();
  });

  it("takes the best over several matched nodes", () => {
    const t = topic({ nodePaths: ["/consult_advice/retirement/withdrawals", "/consult_advice"] });
    expect(nodeRelevance("/consult_advice", t, defaultPolicy)).toBe(relevance.matched);
  });
});

describe("collectCandidates — scope filters and relevance (§4.2 step 4)", () => {
  it("global hints are always candidates at the global relevance, even for a direct query", async () => {
    const { primary } = await snapshots();
    const candidates = collectCandidates(primary, null, direct, {}, defaultPolicy);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c.hint.scope === "global" || c.hint.scope === "agent").toBe(true);
    const lists = one(candidates, "format.lists");
    expect(lists.hint.scope).toBe("global");
    expect(lists.relevance).toBe(relevance.global);
    expect(lists.shared).toBe(false);
    expect(lists.maturity).toBe("consolidated");
  });

  it("a global-scoped hint applies at the flat global relevance wherever it hangs (§4.2 step 4: root/global)", async () => {
    const fixture = advisorFixture({ clock });
    const ref: SubjectRef = { tenantId: null, subjectId: fixture.subjectId };
    const jargon = fixture.hints.find((h) => h.slot === "jargon");
    if (!jargon) throw new Error("fixture changed");
    expect(jargon.nodePath).toBe("/consult_advice");
    const data = await fixture.store.loadSnapshot(ref);
    if (!data) throw new Error("fixture subject missing");
    const rewired = { ...data, hints: data.hints.map((h) => (h.id === jargon.id ? { ...h, scope: "global" as const } : h)) };
    const snapshot = compileSnapshot(rewired, defaultPolicy, noopLogger, { ref, categories: fixture.categories, clock });
    // On its own branch it is not boosted to the matched or ancestor relevance…
    expect(one(collectCandidates(snapshot, null, retirement, {}, defaultPolicy), "jargon").relevance).toBe(relevance.global);
    // …and off the branch it is still a candidate, at the same flat relevance.
    expect(one(collectCandidates(snapshot, null, markets, {}, defaultPolicy), "jargon").relevance).toBe(relevance.global);
    expect(one(collectCandidates(snapshot, null, direct, {}, defaultPolicy), "jargon").relevance).toBe(relevance.global);
  });

  it("category hints apply on the matched node and its ancestors, decaying with distance", async () => {
    const { primary } = await snapshots();
    const candidates = collectCandidates(primary, null, retirement, {}, defaultPolicy);
    expect(one(candidates, "horizon.default", "category").relevance).toBe(relevance.matched);
    expect(one(candidates, "cpp_oas.timing").relevance).toBe(relevance.matched);
    expect(one(candidates, "jargon").relevance).toBeCloseTo(relevance.ancestorDecay, 12);
  });

  it("category hints on unrelated branches — and below the match — are not candidates", async () => {
    const { primary } = await snapshots();
    const slots = bySlot(collectCandidates(primary, null, retirement, {}, defaultPolicy));
    expect(slots.has("citations")).toBe(false);
    expect(slots.has("rrif.minimums")).toBe(false);
    expect(slots.has("prep.length")).toBe(false);
    expect(slots.has("networth.unit")).toBe(false);
  });

  it("agent-scoped hints for a configured agent survive a wrong classification at relevance alwaysAgent", async () => {
    const { primary } = await snapshots();
    const candidates = collectCandidates(primary, null, markets, {}, defaultPolicy);
    const disclaimers = one(candidates, "disclaimers");
    expect(disclaimers.hint.agent).toBe("consult_advice");
    expect(disclaimers.relevance).toBe(relevance.alwaysAgent);
    expect(one(candidates, "kyp.first").relevance).toBe(relevance.alwaysAgent);
    expect(one(candidates, "digest.size").relevance).toBe(relevance.alwaysAgent);
    expect(one(candidates, "fees.reporting").relevance).toBe(relevance.alwaysAgent);
    // …while the category-scoped hint on the same wrong branch is not a candidate.
    expect(bySlot(candidates).has("jargon")).toBe(false);
  });

  it("agent-scoped hints of a predicted agent take their node's relevance, or matched when off-branch", async () => {
    const { primary } = await snapshots();
    const candidates = collectCandidates(primary, null, retirement, {}, defaultPolicy);
    expect(one(candidates, "disclaimers").relevance).toBeCloseTo(relevance.ancestorDecay, 12);
    expect(one(candidates, "fees.reporting").relevance).toBe(relevance.matched);
    expect(one(candidates, "kyp.first").relevance).toBe(relevance.matched);
  });

  it("agent-scoped hints for an agent that is neither predicted nor configured are not candidates", async () => {
    const fixture = advisorFixture({ clock });
    const ref: SubjectRef = { tenantId: null, subjectId: fixture.subjectId };
    const stranger = fixture.hints.find((h) => h.slot === "digest.size");
    if (!stranger) throw new Error("fixture changed");
    const data = await fixture.store.loadSnapshot(ref);
    if (!data) throw new Error("fixture subject missing");
    const rewired = { ...data, hints: data.hints.map((h) => (h.id === stranger.id ? { ...h, agent: "consult_tax" } : h)) };
    const snapshot = compileSnapshot(rewired, defaultPolicy, noopLogger, { ref, categories: fixture.categories, clock });
    expect(bySlot(collectCandidates(snapshot, null, direct, {}, defaultPolicy)).has("digest.size")).toBe(false);
  });

  it("client hints only appear when clientId matches", async () => {
    const { primary } = await snapshots();
    const forA = collectCandidates(primary, null, retirement, { clientId: "client_A" }, defaultPolicy);
    expect(one(forA, "detail.level").hint.clientId).toBe("client_A");
    expect(one(forA, "detail.level").relevance).toBe(relevance.global);
    const horizons = forA.filter((c) => c.hint.slot === "horizon.default");
    expect(horizons.map((c) => c.hint.scope).sort()).toEqual(["category", "client"]);
    expect(one(forA, "horizon.default", "client").relevance).toBe(relevance.matched);

    for (const req of [{}, { clientId: null }, { clientId: undefined }, { clientId: "client_B" }]) {
      const candidates = collectCandidates(primary, null, retirement, req, defaultPolicy);
      expect(candidates.some((c) => c.hint.scope === "client"), JSON.stringify(req)).toBe(false);
      expect(one(candidates, "horizon.default").hint.scope).toBe("category");
    }
  });

  it("client hints follow the topical axis like category hints", async () => {
    const { primary } = await snapshots();
    const candidates = collectCandidates(primary, null, markets, { clientId: "client_A" }, defaultPolicy);
    expect(one(candidates, "detail.level").hint.scope).toBe("client");
    expect(bySlot(candidates).has("horizon.default")).toBe(false);
  });
});

describe("collectCandidates — visibility gates", () => {
  it("approvedOnly filters to approved hints", async () => {
    const { primary, shared } = await snapshots();
    const strict = collectCandidates(primary, shared, retirement, { clientId: "client_A", approvedOnly: true }, defaultPolicy);
    expect(strict.length).toBe(2);
    for (const c of strict) expect(c.hint.approval).toBe("approved");
    expect(one(strict, "region.default").shared).toBe(false);
    expect(one(strict, "performance.asof").shared).toBe(true);
    const loose = collectCandidates(primary, shared, retirement, { clientId: "client_A" }, defaultPolicy);
    expect(loose.length).toBeGreaterThan(strict.length);
  });

  it("pending and needsReview hints are excluded unless includePending", async () => {
    const { primary } = await snapshots(["active", "pending"]);
    const closed = bySlot(collectCandidates(primary, null, markets, {}, defaultPolicy));
    expect(closed.has("index.default")).toBe(false);
    expect(closed.has("disclosure.fees")).toBe(false);

    const open = collectCandidates(primary, null, markets, {}, mergePolicy({ recall: { includePending: true } }));
    expect(one(open, "index.default").hint.slot).toBe("index.default");
    expect(primary.recordsById.get(one(open, "index.default").hint.id)?.status).toBe("pending");
    expect(primary.recordsById.get(one(open, "disclosure.fees").hint.id)?.needsReview).toBe(true);
  });

  it("superseded and retired hints are never candidates, even when the snapshot holds them", async () => {
    const { primary } = await snapshots(["active", "pending", "superseded", "retired"]);
    const slots = bySlot(collectCandidates(primary, null, direct, {}, mergePolicy({ recall: { includePending: true } })));
    const lengths = slots.get("format.length") ?? [];
    expect(lengths.map((c) => primary.recordsById.get(c.hint.id)?.status)).toEqual(["active"]);
    expect(slots.has("format.emoji")).toBe(false);
  });
});

describe("collectCandidates — shared subject", () => {
  it("contributes approved hints only, scaled by relevance.shared and flagged shared", async () => {
    const { primary, shared } = await snapshots();
    const candidates = collectCandidates(primary, shared, direct, {}, defaultPolicy);
    const asOf = one(candidates, "performance.asof");
    expect(asOf.shared).toBe(true);
    expect(asOf.hint.approval).toBe("approved");
    expect(asOf.relevance).toBeCloseTo(relevance.global * relevance.shared, 12);
    expect(bySlot(candidates).has("format.numbers")).toBe(false);
    expect(candidates.filter((c) => c.shared)).toHaveLength(1);
  });

  it("is simply absent when not configured", async () => {
    const { primary } = await snapshots();
    const candidates = collectCandidates(primary, null, direct, {}, defaultPolicy);
    expect(candidates.some((c) => c.shared)).toBe(false);
  });
});

describe("collectCandidates — shape", () => {
  it("returns the snapshot's own frozen Hint objects, in snapshot order, without duplicates", async () => {
    const { primary, shared } = await snapshots();
    const candidates = collectCandidates(primary, shared, retirement, { clientId: "client_A" }, defaultPolicy);
    const ids = candidates.map((c) => c.hint.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of candidates) {
      expect(Object.isFrozen(c.hint)).toBe(true);
      const owner = c.shared ? shared : primary;
      expect(owner.hints.includes(c.hint)).toBe(true);
    }
    const primaryOrder = candidates.filter((c) => !c.shared).map((c) => primary.hints.indexOf(c.hint));
    expect([...primaryOrder].sort((a, b) => a - b)).toEqual(primaryOrder);
  });
});
