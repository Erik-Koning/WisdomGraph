/**
 * recall/charter.ts — from candidates to the per-query charter and its lanes.
 *
 * Spec §4.2 steps 5–7. The charter is the consumer-facing promise of decision
 * #17: not just "here are some hints" but a record of everything that was
 * considered and what happened to it — who beat whom on a slot
 * (`suppressed`), what fell out and why (`dropped`), and whether a human
 * approved all of it (`approvalMix`). Every candidate leaves this function
 * with exactly one outcome, so `explain()` can replay a query as a trace.
 *
 * The order of the passes is the order of the guarantees:
 *
 *   1. **Score.** `effective` folds priority, confidence, decay, scope and
 *      source weights and the query's relevance into one number; anything
 *      under `minEffectiveScore` is stale and never competes.
 *   2. **Resolve.** One winner per slot per audience (`policy/conflict.ts`),
 *      using the scores just computed for rule 5.
 *   3. **Dedupe.** Different slots can still say the same thing; exact
 *      normalised text and then token-Jaccard catch that, keeping the higher
 *      score. Like conflicts, only hints that could render together are
 *      compared: the same audience or either addressed to everyone, and the
 *      same site — the router prompt (`preRoute`), or the answer prompts
 *      (`agent` and `responseStyle`, which mirroring lets share a bucket).
 *      Two agents may each keep their own copy of a preference, and the
 *      router keeping a statement a specialist also gets is no duplicate:
 *      nobody reads both blocks at once. The pass is quadratic in the kept
 *      hints and the hot path's dominant term, so it compares precomputed
 *      token sets per site and rejects most pairs on their size ratio alone.
 *   4. **Lanes and caps.** `preRoute` and `responseStyle` are single
 *      buckets; the `agent` lane is one bucket per agent plus one for
 *      everyone else. Agent-scoped hints go to their agent; every other
 *      agent-lane hint fans out to every agent bucket; and, when
 *      `mirrorStyleToAgents` is on, `responseStyle` hints are mirrored into
 *      the agent buckets too, because a single-consult turn skips synthesize
 *      and the specialist's preamble is the only place voice hints can land
 *      (requirements caveat #1). The named buckets are `topic.agents` plus
 *      every agent that has a kept hint of its own: the always-candidate
 *      rule exists so the router's choice is served even when the
 *      classifier disagreed, and a bucket that renders only the agent's own
 *      two hints without its subject's voice or global agent-lane defaults
 *      would defeat that. `agentDefaults` is the bucket of any agent the
 *      classifier did not name and no hint addresses — the specialist the
 *      router picked on a query that classified `direct`, or off the mark —
 *      and holds everything addressed to everyone: the fanned-out agent-lane
 *      hints and the mirrored voice. Nothing in the agent lane is ever
 *      dropped for want of a bucket; a global "always cites the source"
 *      reaches whichever specialist runs.
 *
 *      Buckets are sorted by effective, then priority, then id and filled
 *      greedily under the lane cap and `maxHintsPerLane`. The total cap
 *      counts a distinct entry once — a hint mirrored into three buckets
 *      costs the charter one line, because the consumer pays for prompt
 *      tokens per site, not per charter, and the caps that matter per site
 *      are the lane caps. Lanes fill in the order the turn reads them:
 *      router, specialists (named, then the defaults), synthesize. Because
 *      every bucket is a greedy fill over its candidates in rank order and
 *      `entries` keeps that order, `compile.ts` can rebuild any bucket from
 *      a `Charter` alone — which is what keeps `compileCharter` and the
 *      `Recall` renderers byte-for-byte equal.
 *
 * Nothing here is frozen; the caller freezes the `Recall` it builds from
 * the result (§2.5). The hints themselves are the snapshot's frozen values.
 */

import type { PolicyConfig } from "../policy";
import type { Charter, DropReason, Hint, RecallTrace, Topic } from "../types";
import { estimateTokens, type Tokenizer } from "../text/tokens";
import { normalizeText, tokenize } from "../text/normalize";
import { ROOT_PATH } from "../graph/paths";
import { decayWeight, effectiveScore } from "../policy/decay";
import { EVERYONE, audienceOf, canCoRender, resolveConflicts } from "../policy/conflict";
import type { Candidate } from "./select";

export interface ScoredCandidate extends Candidate {
  readonly decayWeight: number;
  readonly effective: number;
}

export interface AssembleContext {
  policy: PolicyConfig;
  /** Epoch ms: decay is measured against it and `generatedAt` is derived from it. */
  now: number;
  topic: Topic;
  subjectId: string;
  clientId?: string | null;
  /** Default `estimateTokens`. */
  tokenizer?: Tokenizer;
  /** Hint ids the snapshot dropped as invalid rows (§4.2 step 2); recorded as `dropped: "invalid-row"`. */
  invalidRowIds?: readonly string[];
}

/** The charter and the lanes a `Recall` is built from, plus the per-candidate trace `explain()` renders. */
export interface Assembly {
  charter: Charter;
  preRoute: Hint[];
  agentHints: Record<string, Hint[]>;
  /** The agent-lane bucket of any agent without one of its own (§4.2 step 6). */
  agentDefaults: Hint[];
  responseStyle: Hint[];
  trace: RecallTrace["candidates"];
}

/** Decay and effective score for every candidate (§6.2), in input order. */
export function scoreCandidates(candidates: readonly Candidate[], ctx: Pick<AssembleContext, "policy" | "now">): ScoredCandidate[] {
  return candidates.map((c) => {
    const scoring = { now: ctx.now, policy: ctx.policy, maturity: c.maturity };
    return {
      ...c,
      decayWeight: decayWeight(c.hint, scoring),
      effective: effectiveScore(c.hint, { ...scoring, relevance: c.relevance }),
    };
  });
}

/** Effective desc, priority desc, id asc — the order of every bucket and of `charter.entries`. */
function byRank(effective: ReadonlyMap<string, number>) {
  return (a: Hint, b: Hint): number =>
    (effective.get(b.id) ?? 0) - (effective.get(a.id) ?? 0) || b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Where a lane renders: the router prompt, or the answer prompts that mirroring lets share hints. */
type RenderSite = "router" | "answer";
function renderSite(h: Hint): RenderSite {
  return h.lane === "preRoute" ? "router" : "answer";
}

const NO_TOKENS: ReadonlySet<string> = new Set();

/**
 * Token-Jaccard at or above `threshold` over sets computed once per hint.
 * Jaccard can never exceed the size ratio of the two sets, so most pairs are
 * settled before a token is looked up; the ratio is a quotient of the same
 * integers the Jaccard is, so the bound never rounds past the threshold.
 */
function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>, threshold: number): boolean {
  if (a.size === 0 && b.size === 0) return true;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size / large.size < threshold) return false;
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / (small.size + large.size - shared) >= threshold;
}

/** Two hints say the same thing: identical normalised text, or token overlap at or above the policy's Jaccard. */
function sameStatement(a: Hint, b: Hint, norm: ReadonlyMap<string, string>, tokens: ReadonlyMap<string, ReadonlySet<string>>, threshold: number): boolean {
  if (norm.get(a.id) === norm.get(b.id)) return true;
  return overlaps(tokens.get(a.id) ?? NO_TOKENS, tokens.get(b.id) ?? NO_TOKENS, threshold);
}

/**
 * Score, resolve, dedupe, bucket and cap `candidates` for one query.
 * Deterministic for equal inputs; never throws on any candidate list.
 */
export function assembleCharter(candidates: readonly Candidate[], ctx: AssembleContext): Assembly {
  const { policy, topic } = ctx;
  const tokenizer = ctx.tokenizer ?? estimateTokens;

  // ── Score ──
  const unique: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.hint.id)) continue;
    seen.add(c.hint.id);
    unique.push(c);
  }
  const scored = scoreCandidates(unique, ctx);
  const effective = new Map(scored.map((s) => [s.hint.id, s.effective]));
  const sharedIds = new Set(scored.filter((s) => s.shared).map((s) => s.hint.id));

  const dropped: Charter["dropped"] = [];
  const droppedReason = new Map<string, DropReason>();
  const drop = (id: string, reason: DropReason): void => {
    dropped.push({ hintId: id, reason });
    droppedReason.set(id, reason);
  };
  for (const id of ctx.invalidRowIds ?? []) drop(id, "invalid-row");

  const live: Hint[] = [];
  for (const s of scored) {
    if (s.effective < policy.recall.minEffectiveScore) drop(s.hint.id, "stale");
    else live.push(s.hint);
  }

  // ── Resolve ──
  const { kept, suppressed } = resolveConflicts(live, policy, ctx.now, {
    effective: (h) => effective.get(h.id) ?? 0,
    shared: sharedIds,
  });

  // ── Dedupe ──
  const rank = byRank(effective);
  const norm = new Map(kept.map((h) => [h.id, normalizeText(h.text).toLowerCase()]));
  const tokens = new Map(kept.map((h) => [h.id, new Set(tokenize(h.text))]));
  const distinct: Hint[] = [];
  const bySite: Record<RenderSite, Hint[]> = { router: [], answer: [] };
  for (const hint of [...kept].sort(rank)) {
    const peers = bySite[renderSite(hint)];
    const twin = peers.find((d) => canCoRender(d, hint) && sameStatement(d, hint, norm, tokens, policy.recall.dedupeJaccard));
    if (twin === undefined) {
      distinct.push(hint);
      peers.push(hint);
    } else drop(hint.id, "duplicate");
  }

  // ── Lanes ──
  const agents = new Set<string>(topic.agents);
  for (const hint of distinct) {
    const audience = audienceOf(hint);
    if (audience !== EVERYONE) agents.add(audience);
  }
  const agentNames = [...agents].sort();

  const preRoute: Hint[] = [];
  const responseStyle: Hint[] = [];
  const buckets = new Map<string, Hint[]>(agentNames.map((a) => [a, []]));
  const defaults: Hint[] = [];
  for (const hint of distinct) {
    if (hint.lane === "preRoute") preRoute.push(hint);
    else if (hint.lane === "responseStyle") responseStyle.push(hint);
    else {
      const audience = audienceOf(hint);
      if (audience === EVERYONE) {
        defaults.push(hint);
        for (const name of agentNames) buckets.get(name)?.push(hint);
      } else buckets.get(audience)?.push(hint);
    }
  }
  if (policy.recall.mirrorStyleToAgents) {
    for (const hint of responseStyle) {
      const audience = audienceOf(hint);
      if (audience === EVERYONE) defaults.push(hint);
      for (const [name, bucket] of buckets) {
        if (audience === EVERYONE || audience === name) bucket.push(hint);
      }
    }
  }

  // ── Caps ──
  const tokensOf = new Map<string, number>();
  const cost = (hint: Hint): number => {
    let t = tokensOf.get(hint.id);
    if (t === undefined) {
      t = tokenizer(hint.text);
      tokensOf.set(hint.id, t);
    }
    return t;
  };
  const placed = new Set<string>();
  let total = 0;
  const fill = (bucket: Hint[], laneCap: number): Hint[] => {
    const out: Hint[] = [];
    let used = 0;
    for (const hint of bucket.sort(rank)) {
      if (out.length >= policy.caps.maxHintsPerLane) break;
      const t = cost(hint);
      if (used + t > laneCap) continue;
      const charged = placed.has(hint.id) ? 0 : t;
      if (total + charged > policy.caps.totalTokens) continue;
      out.push(hint);
      used += t;
      total += charged;
      placed.add(hint.id);
    }
    return out;
  };
  const preRouteLane = fill(preRoute, policy.caps.preRouteTokens);
  // An agent with nothing to say gets no bucket, so `compileAgentPreamble`
  // serves it `agentDefaults` instead of rendering nothing. The
  // record is built with `fromEntries`, which defines own keys: an agent
  // named `__proto__` (the schema allows any name) gets its bucket instead
  // of swapping the record's prototype and vanishing.
  const agentLanes: [string, Hint[]][] = [];
  for (const name of agentNames) {
    const filled = fill(buckets.get(name) ?? [], policy.caps.agentTokens);
    if (filled.length > 0) agentLanes.push([name, filled]);
  }
  const lanes = {
    preRoute: preRouteLane,
    agentHints: Object.fromEntries(agentLanes),
    agentDefaults: fill(defaults, policy.caps.agentTokens),
    responseStyle: fill(responseStyle, policy.caps.responseStyleTokens),
  };

  for (const hint of distinct) {
    if (!placed.has(hint.id) && !droppedReason.has(hint.id)) drop(hint.id, "budget");
  }

  // ── Charter ──
  // Records are listed by hint id so the charter is canonical: the same
  // candidates in any order produce the same value, which is what makes it
  // comparable across a dry-run trace and a real recall.
  const byId = <T extends { hintId: string }>(a: T, b: T): number => (a.hintId < b.hintId ? -1 : a.hintId > b.hintId ? 1 : 0);
  const entries = distinct.filter((h) => placed.has(h.id)).sort(rank);
  const approved = entries.filter((h) => h.approval === "approved").length;
  const approvalMix: Charter["approvalMix"] = approved === 0 ? "none" : approved === entries.length ? "approved-only" : "mixed";
  const charter: Charter = {
    subjectId: ctx.subjectId,
    clientId: ctx.clientId ?? null,
    generatedAt: new Date(ctx.now).toISOString(),
    topicPath: topic.nodePaths[0] ?? ROOT_PATH,
    entries,
    suppressed: suppressed.sort(byId),
    dropped: dropped.sort(byId),
    approvalMix,
    tokenEstimate: entries.reduce((sum, h) => sum + cost(h), 0),
  };

  // ── Trace ──
  const suppressedBy = new Map(suppressed.map((s) => [s.hintId, s]));
  const trace: RecallTrace["candidates"] = scored.map((s) => {
    const id = s.hint.id;
    const base = { hintId: id, relevance: s.relevance, decayWeight: s.decayWeight, effective: s.effective };
    const lost = suppressedBy.get(id);
    if (lost !== undefined) return { ...base, outcome: "suppressed", rule: lost.rule };
    const reason = droppedReason.get(id);
    if (reason !== undefined) return { ...base, outcome: "dropped", reason };
    return { ...base, outcome: "kept" };
  });

  return { charter, ...lanes, trace };
}
