/**
 * policy/decay.ts — how a hint's weight changes with time, and when time
 * promotes or retires it.
 *
 * The maturity model (spec §3.2, §6.2) is the library's "biological memory":
 * a hint captured from one conversation fades unless something reinforces
 * it, a consolidated one fades slower, an established one barely at all,
 * and a human-approved one never. All of that is one exponential —
 * `0.5 ^ (age / halfLife)` — with the half-life read from the policy table
 * by maturity × source, so the whole model is tunable from `PolicyConfig`
 * and every consumer of the weight (charter scoring, `explain()`'s decay
 * column, `maintain()`'s retirement sweep) agrees to the digit.
 *
 * Everything here is a pure function of a record and a clock reading. Time
 * arrives as `now` (epoch ms) rather than being read from `Date`, because
 * recall must be reproducible in tests at a `FakeClock` and because
 * `maintain()` sweeps thousands of rows against one instant, not a moving
 * one.
 *
 * `scoreHint` is the public name of `effectiveScore` (spec §2.8): the same
 * function, exported once for the consumer and once under the name the
 * charter assembler and the spec's formula use.
 */

import type { PolicyConfig } from "../policy";
import type { Hint, HintMaturity, HintRecord, HintSource } from "../types";

const DAY_MS = 86_400_000;

/** What decay needs from a hint; both `Hint` and `HintRecord` satisfy it once the timestamp is located. */
interface DecayFacts {
  source: HintSource;
  approved: boolean;
  maturity: HintMaturity;
  lastReinforcedAt: string;
}

/**
 * A `Hint` carries no maturity — it is the recall-facing projection — so the
 * caller supplies one from the record it came from. Absent that, `captured`
 * (the shortest half-life) is assumed: the unknown case decays fastest, which
 * errs toward forgetting rather than toward trusting.
 */
export const DEFAULT_MATURITY: HintMaturity = "captured";

function factsOf(h: Hint | HintRecord, maturity?: HintMaturity): DecayFacts {
  if ("maturity" in h) {
    return { source: h.source, approved: h.approval === "approved", maturity: h.maturity, lastReinforcedAt: h.lastReinforcedAt };
  }
  return {
    source: h.source,
    approved: h.approval === "approved",
    maturity: maturity ?? DEFAULT_MATURITY,
    lastReinforcedAt: h.provenance.lastReinforcedAt,
  };
}

/** Days from `iso` to `now`, never negative; an unparseable instant reads as "just now". */
export function ageDays(iso: string, now: number): number {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, (now - at) / DAY_MS);
}

/**
 * The half-life in days that applies to a hint, or `null` when it never
 * decays: approved hints and any maturity × source the policy sets to
 * `null`. A non-positive configured half-life is treated as "no decay"
 * rather than as instant decay, so a misconfiguration cannot silently
 * retire a subject's whole graph.
 */
export function halfLifeDays(h: Hint | HintRecord, policy: PolicyConfig, maturity?: HintMaturity): number | null {
  const facts = factsOf(h, maturity);
  if (facts.approved) return null;
  const configured = policy.decay.halfLifeDays[facts.maturity][facts.source];
  return configured !== null && configured > 0 ? configured : null;
}

/** `0.5 ^ (age / halfLife)` since `lastReinforcedAt`; exactly 1 when the hint does not decay. */
export function decayWeight(h: Hint | HintRecord, ctx: { now: number; policy: PolicyConfig; maturity?: HintMaturity }): number {
  const halfLife = halfLifeDays(h, ctx.policy, ctx.maturity);
  if (halfLife === null) return 1;
  const facts = factsOf(h, ctx.maturity);
  return Math.pow(0.5, ageDays(facts.lastReinforcedAt, ctx.now) / halfLife);
}

/**
 * Spec §6.2: `(priority/100) × confidence × decayWeight × scopeWeight ×
 * sourceWeight × relevance`. Relevance is the query's contribution (§4.2
 * step 4) and comes from the caller; everything else is the hint's own.
 */
export function effectiveScore(
  h: Hint | HintRecord,
  ctx: { now: number; policy: PolicyConfig; relevance: number; maturity?: HintMaturity },
): number {
  const { policy } = ctx;
  return (
    (h.priority / 100) *
    h.confidence *
    decayWeight(h, ctx) *
    policy.recall.scopeWeight[h.scope] *
    policy.recall.sourceWeight[h.source] *
    ctx.relevance
  );
}

/** The public name of `effectiveScore` (spec §2.8). */
export const scoreHint: typeof effectiveScore = effectiveScore;

/**
 * The maturity a record has earned but not yet been given, or `null`.
 * Only active hints mature (§3.2). `captured → consolidated` is the
 * short-term pass's rule (§5.7): applied often enough, or reinforced at
 * all. `consolidated → established` (§6.2) needs reinforcements spread over
 * time — the span is measured from creation, since the record keeps no
 * first-reinforcement instant and creation is the first statement of the
 * value — or sustained application with nothing ever contradicting it.
 * Demotion never happens, so `established` returns `null`.
 */
export function promotionDue(record: HintRecord, ctx: { now: number; policy: PolicyConfig }): HintMaturity | null {
  if (record.status !== "active") return null;
  const { promotion } = ctx.policy;
  switch (record.maturity) {
    case "captured":
      return record.applied >= promotion.consolidatedMinApplied || record.reinforcements >= 1 ? "consolidated" : null;
    case "consolidated": {
      const spanDays = ageDays(record.createdAt, Date.parse(record.lastReinforcedAt));
      const byReinforcement =
        record.reinforcements >= promotion.establishedMinReinforcements && spanDays >= promotion.establishedMinSpanDays;
      const byApplication = record.applied >= promotion.establishedMinApplied && record.contradictions === 0;
      return byReinforcement || byApplication ? "established" : null;
    }
    case "established":
      return null;
  }
}

/**
 * Spec §6.2: retire when the decay weight has fallen below `retireBelow`
 * and the hint was not applied within the last half-life. A hint that is
 * still being applied is still useful, however long ago it was last
 * restated; one that is neither restated nor used is forgotten.
 */
export function retirementDue(record: HintRecord, ctx: { now: number; policy: PolicyConfig }): boolean {
  if (record.status !== "active") return false;
  const halfLife = halfLifeDays(record, ctx.policy);
  if (halfLife === null) return false;
  if (decayWeight(record, ctx) >= ctx.policy.decay.retireBelow) return false;
  const appliedWithinHalfLife = record.lastAppliedAt !== undefined && ageDays(record.lastAppliedAt, ctx.now) < halfLife;
  return !appliedWithinHalfLife;
}
