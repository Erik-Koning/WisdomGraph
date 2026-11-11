/**
 * policy.ts — every tunable number in one frozen object.
 *
 * The library has a lot of thresholds (token caps, half-lives, feedback
 * deltas, queue sizes). Scattering them as module constants would make the
 * consumer's overrides impossible and the tests' assumptions invisible, so
 * they live here as one typed `PolicyConfig`, with `defaultPolicy` as the
 * documented baseline (spec §2.7) and `mergePolicy` as the only way a partial
 * override becomes a full config.
 *
 * `defaultPolicy` is deep-frozen on purpose: a policy that silently mutates
 * under one engine would change the behaviour of every other engine in the
 * process. `mergePolicy` therefore always builds a fresh, unfrozen tree and
 * never hands back a branch of the default by reference.
 */

import type { HintMaturity, HintScope, HintSource } from "./types";

/** Recursive partial, for overrides that name only what they change. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface PolicyConfig {
  /** default "auto" */
  approval: "auto" | "review-inferred" | "review-all";
  caps: {
    /** 100 */
    preRouteTokens: number;
    /** 120 per agent bucket */
    agentTokens: number;
    /** 120 */
    responseStyleTokens: number;
    /** 300 distinct-charter tokens */
    totalTokens: number;
    /** 12 */
    maxHintsPerLane: number;
    /** 200 */
    maxHintChars: number;
    /** 4 */
    maxNodeDepth: number;
    /** 12 */
    maxChildren: number;
    /** 200 */
    maxNodesPerSubject: number;
    /** 20 (overflow triggers consolidation, never blocks capture) */
    maxActiveHintsPerNode: number;
    /** 8 (consolidation: 24) */
    maxOpsPerEvent: number;
    /** 32 */
    maxPropertiesKeys: number;
    /** 4096 */
    maxPropertiesBytes: number;
  };
  classify: {
    /** 0.25 → below: category "direct", global + always-candidate agent hints only */
    minConfidence: number;
    /** 0.6 → second node kept when score ≥ 0.6 × best */
    secondaryRatio: number;
    /** 0.3 */
    continuityBonus: number;
    /** 300 */
    embedMinBudgetMs: number;
    /** 0.5 */
    embedBlend: number;
  };
  recall: {
    /** true */
    mirrorStyleToAgents: boolean;
    /** false */
    includePending: boolean;
    /** 0.8 */
    dedupeJaccard: number;
    /** 0.05 */
    minEffectiveScore: number;
    /** client 1.0, agent 0.9, category 0.8, global 0.7 */
    scopeWeight: Record<HintScope, number>;
    /** explicit 1.0, inferred 0.75 */
    sourceWeight: Record<HintSource, number>;
    /** 1.0, 0.8, 0.5, 0.4, 0.8 (multiplier) */
    relevance: { matched: number; ancestorDecay: number; global: number; alwaysAgent: number; shared: number };
  };
  decay: {
    /** null = no decay; approved hints never decay */
    halfLifeDays: Record<HintMaturity, Record<HintSource, number | null>>;
    /** 0.15 (decay weight) */
    retireBelow: number;
    /** 3 */
    contradictionsToRetire: number;
  };
  feedback: {
    /** +0.05 */
    upConfidenceDelta: number;
    /** explicit 0.8, inferred 0.6 */
    downFactor: Record<HintSource, number>;
    /** 0.3 (inferred → retired; explicit → needsReview + pending) */
    retireConfidenceBelow: number;
  };
  promotion: {
    /** 3 (or reinforcements ≥ 1) */
    consolidatedMinApplied: number;
    /** 3 spanning ≥ establishedMinSpanDays */
    establishedMinReinforcements: number;
    /** 7 */
    establishedMinSpanDays: number;
    /** 10 (alternative path, zero contradictions) */
    establishedMinApplied: number;
  };
  ingest: {
    /** 0.0 — probability of LLM extraction on a turn neither triage regex gated; the only route for a preference phrased in words the gate does not know (§5.3) */
    extractionSampleRate: number;
    /** 20 per subject */
    consolidateEveryEvents: number;
    /** 3 */
    feedbackAnchorRetries: number;
    /** 5 000 */
    feedbackAnchorDelayMs: number;
    /** 20 000 */
    llmTimeoutMs: number;
    /** 30 (no active hints, no children) */
    nodeGcDays: number;
  };
  retention: {
    /** null = keep; text scrubbed after this, row kept as tombstone */
    eventRetentionDays: number | null;
    /** null = keep */
    auditRetentionDays: number | null;
    /** false — raw user/assistant/feedback text never logged unless true (then on `ingest.recorded`, debug level only) */
    logRawText: boolean;
  };
  /** Seeded slot vocabulary shown in the extraction outline (§5.5). */
  slots: string[];
}

/**
 * Seed slots: the conflict keys the extractor is nudged toward so that two
 * turns about the same dimension land on the same key instead of coining
 * near-synonyms. The spec leaves the list open; these are the dimensions the
 * consumer's caveats and examples name.
 */
const SEED_SLOTS = [
  "format.lists",
  "format.length",
  "format.structure",
  "tone",
  "detail.level",
  "disclaimers",
  "region.default",
  "currency.default",
  "language",
  "citations",
  "routing.default",
  "greeting",
] as const;

const DEFAULT_POLICY: PolicyConfig = {
  approval: "auto",
  caps: {
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
  },
  classify: {
    minConfidence: 0.25,
    secondaryRatio: 0.6,
    continuityBonus: 0.3,
    embedMinBudgetMs: 300,
    embedBlend: 0.5,
  },
  recall: {
    mirrorStyleToAgents: true,
    includePending: false,
    dedupeJaccard: 0.8,
    minEffectiveScore: 0.05,
    scopeWeight: { client: 1.0, agent: 0.9, category: 0.8, global: 0.7 },
    sourceWeight: { explicit: 1.0, inferred: 0.75 },
    relevance: { matched: 1.0, ancestorDecay: 0.8, global: 0.5, alwaysAgent: 0.4, shared: 0.8 },
  },
  decay: {
    halfLifeDays: {
      captured: { inferred: 30, explicit: 90 },
      consolidated: { inferred: 90, explicit: 180 },
      established: { inferred: 365, explicit: null },
    },
    retireBelow: 0.15,
    contradictionsToRetire: 3,
  },
  feedback: {
    upConfidenceDelta: 0.05,
    downFactor: { explicit: 0.8, inferred: 0.6 },
    retireConfidenceBelow: 0.3,
  },
  promotion: {
    consolidatedMinApplied: 3,
    establishedMinReinforcements: 3,
    establishedMinSpanDays: 7,
    establishedMinApplied: 10,
  },
  ingest: {
    extractionSampleRate: 0.0,
    consolidateEveryEvents: 20,
    feedbackAnchorRetries: 3,
    feedbackAnchorDelayMs: 5_000,
    llmTimeoutMs: 20_000,
    nodeGcDays: 30,
  },
  retention: {
    eventRetentionDays: null,
    auditRetentionDays: null,
    logRawText: false,
  },
  slots: [...SEED_SLOTS],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Fresh copy of a policy branch: plain objects and arrays cloned, leaves kept. */
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

/**
 * Merge `over` onto a clone of `base`, key by key, recursing into plain
 * objects. Arrays and `null` are leaves and replace wholesale — `slots: []`
 * means "no seed slots", `halfLifeDays.established.explicit: null` means "no
 * decay" — and `undefined` means "not overridden". Keys `base` does not know
 * are ignored so a typo cannot smuggle an unknown setting into the config.
 */
function mergeInto(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, baseValue] of Object.entries(base)) {
    const overValue = over[key];
    if (overValue === undefined) out[key] = clone(baseValue);
    else if (isPlainObject(baseValue) && isPlainObject(overValue)) out[key] = mergeInto(baseValue, overValue);
    else out[key] = clone(overValue);
  }
  return out;
}

/** The baseline from spec §2.7. Deep-frozen; override it through `policy: DeepPartial<PolicyConfig>` on `createWisdomGraph`, which deep-merges on top of it. */
export const defaultPolicy: PolicyConfig = deepFreeze(DEFAULT_POLICY);

/** A full, mutable `PolicyConfig`: the default with `partial` deep-merged on top. */
export function mergePolicy(partial?: DeepPartial<PolicyConfig>): PolicyConfig {
  // The merge is shape-generic and walks untyped records; the result carries
  // exactly `defaultPolicy`'s keys, which is what `PolicyConfig` describes, so
  // the two casts below only restate what the loop guarantees.
  const base = defaultPolicy as unknown as Record<string, unknown>;
  const over = (partial ?? {}) as Record<string, unknown>;
  return mergeInto(base, over) as unknown as PolicyConfig;
}
