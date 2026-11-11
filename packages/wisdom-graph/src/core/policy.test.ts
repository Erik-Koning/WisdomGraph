/**
 * The defaults are the numbers the spec (§2.7) documents, so they are pinned
 * one by one; the merge has to be deep, null-aware, and must leave the frozen
 * default untouched, because every engine in a process shares it.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy, mergePolicy, type PolicyConfig } from "./policy";

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}

describe("defaultPolicy", () => {
  it("matches the §2.7 values", () => {
    expect(defaultPolicy.approval).toBe("auto");
    expect(defaultPolicy.caps).toEqual({
      preRouteTokens: 100,
      agentTokens: 120,
      responseStyleTokens: 120,
      totalTokens: 300,
      maxHintsPerLane: 12,
      maxHintChars: 200,
      maxNodeDepth: 4,
      maxChildren: 12,
      maxNodesPerSubject: 200,
      maxActiveHintsPerNode: 20,
      maxOpsPerEvent: 8,
      maxPropertiesKeys: 32,
      maxPropertiesBytes: 4096,
    });
    expect(defaultPolicy.classify).toEqual({
      minConfidence: 0.25,
      secondaryRatio: 0.6,
      continuityBonus: 0.3,
      embedMinBudgetMs: 300,
      embedBlend: 0.5,
    });
    expect(defaultPolicy.recall).toEqual({
      mirrorStyleToAgents: true,
      includePending: false,
      dedupeJaccard: 0.8,
      minEffectiveScore: 0.05,
      scopeWeight: { client: 1.0, agent: 0.9, category: 0.8, global: 0.7 },
      sourceWeight: { explicit: 1.0, inferred: 0.75 },
      relevance: { matched: 1.0, ancestorDecay: 0.8, global: 0.5, alwaysAgent: 0.4, shared: 0.8 },
    });
    expect(defaultPolicy.decay).toEqual({
      halfLifeDays: {
        captured: { inferred: 30, explicit: 90 },
        consolidated: { inferred: 90, explicit: 180 },
        established: { inferred: 365, explicit: null },
      },
      retireBelow: 0.15,
      contradictionsToRetire: 3,
    });
    expect(defaultPolicy.feedback).toEqual({
      upConfidenceDelta: 0.05,
      downFactor: { explicit: 0.8, inferred: 0.6 },
      retireConfidenceBelow: 0.3,
    });
    expect(defaultPolicy.promotion).toEqual({
      consolidatedMinApplied: 3,
      establishedMinReinforcements: 3,
      establishedMinSpanDays: 7,
      establishedMinApplied: 10,
    });
    expect(defaultPolicy.ingest).toEqual({
      extractionSampleRate: 0.0,
      consolidateEveryEvents: 20,
      feedbackAnchorRetries: 3,
      feedbackAnchorDelayMs: 5000,
      llmTimeoutMs: 20000,
      nodeGcDays: 30,
    });
    expect(defaultPolicy.retention).toEqual({ eventRetentionDays: null, auditRetentionDays: null, logRawText: false });
  });

  it("seeds a slot vocabulary of valid slot names", () => {
    expect(defaultPolicy.slots.length).toBeGreaterThan(0);
    for (const slot of defaultPolicy.slots) expect(slot).toMatch(/^[a-z0-9_.]{2,60}$/);
    expect(new Set(defaultPolicy.slots).size).toBe(defaultPolicy.slots.length);
    expect(defaultPolicy.slots).toContain("format.lists");
  });

  it("is deep-frozen", () => {
    expect(isDeepFrozen(defaultPolicy)).toBe(true);
    expect(() => {
      (defaultPolicy.caps as { maxHintChars: number }).maxHintChars = 1;
    }).toThrow(TypeError);
    expect(defaultPolicy.caps.maxHintChars).toBe(200);
  });
});

describe("mergePolicy", () => {
  it("returns an equal, independent, mutable copy when given nothing", () => {
    const merged = mergePolicy();
    expect(merged).toEqual(defaultPolicy);
    expect(merged).not.toBe(defaultPolicy);
    expect(merged.caps).not.toBe(defaultPolicy.caps);
    expect(merged.slots).not.toBe(defaultPolicy.slots);
    expect(Object.isFrozen(merged)).toBe(false);
    merged.caps.maxHintChars = 1;
    merged.slots.push("x");
    expect(defaultPolicy.caps.maxHintChars).toBe(200);
    expect(defaultPolicy.slots).not.toContain("x");
  });

  it("deep-merges a partial override and keeps every sibling", () => {
    const merged = mergePolicy({
      approval: "review-all",
      caps: { maxHintChars: 120 },
      decay: { halfLifeDays: { captured: { inferred: 10 } } },
      recall: { scopeWeight: { client: 0.95 } },
    });
    expect(merged.approval).toBe("review-all");
    expect(merged.caps.maxHintChars).toBe(120);
    expect(merged.caps.maxNodeDepth).toBe(4);
    expect(merged.decay.halfLifeDays.captured).toEqual({ inferred: 10, explicit: 90 });
    expect(merged.decay.halfLifeDays.consolidated).toEqual({ inferred: 90, explicit: 180 });
    expect(merged.decay.retireBelow).toBe(0.15);
    expect(merged.recall.scopeWeight).toEqual({ client: 0.95, agent: 0.9, category: 0.8, global: 0.7 });
    expect(merged.recall.sourceWeight).toEqual(defaultPolicy.recall.sourceWeight);
  });

  it("treats null as a value, not as 'not set'", () => {
    const merged = mergePolicy({
      decay: { halfLifeDays: { established: { inferred: null } } },
      retention: { eventRetentionDays: 30 },
    });
    expect(merged.decay.halfLifeDays.established).toEqual({ inferred: null, explicit: null });
    expect(merged.retention).toEqual({ eventRetentionDays: 30, auditRetentionDays: null, logRawText: false });
  });

  it("replaces arrays wholesale and ignores undefined", () => {
    expect(mergePolicy({ slots: ["tone"] }).slots).toEqual(["tone"]);
    expect(mergePolicy({ slots: [] }).slots).toEqual([]);
    expect(mergePolicy({ caps: { maxHintChars: undefined } }).caps.maxHintChars).toBe(200);
    expect(mergePolicy({ approval: undefined }).approval).toBe("auto");
  });

  it("ignores keys the policy does not know", () => {
    const partial = { caps: { maxHintChars: 50, bogus: 1 }, unknown: true } as unknown as Parameters<typeof mergePolicy>[0];
    const merged = mergePolicy(partial);
    expect(merged.caps.maxHintChars).toBe(50);
    expect("bogus" in merged.caps).toBe(false);
    expect("unknown" in merged).toBe(false);
  });

  it("never mutates the default or the override", () => {
    const before = JSON.stringify(defaultPolicy);
    const override = { caps: { maxHintChars: 10 }, slots: ["a"] };
    const merged = mergePolicy(override);
    merged.slots.push("b");
    merged.caps.maxHintChars = 11;
    expect(JSON.stringify(defaultPolicy)).toBe(before);
    expect(override).toEqual({ caps: { maxHintChars: 10 }, slots: ["a"] });
    expect(merged.slots).not.toBe(override.slots);
  });

  it("produces a value assignable to PolicyConfig with the full key set", () => {
    const merged: PolicyConfig = mergePolicy({ ingest: { llmTimeoutMs: 1 } });
    expect(Object.keys(merged).sort()).toEqual(Object.keys(defaultPolicy).sort());
    expect(merged.ingest.llmTimeoutMs).toBe(1);
  });
});
