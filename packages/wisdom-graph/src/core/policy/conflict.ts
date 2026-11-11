/**
 * policy/conflict.ts — which of two hints on the same slot applies.
 *
 * The consumer's rule is "contradictions resolve, never both apply". A slot
 * is a hint's conflict key (`format.lists`, `disclaimers`); when two
 * candidates for one query share a slot, exactly one may render and the
 * other is recorded in `charter.suppressed` with the rule that decided it,
 * so `explain()` can say *why* an advisor's older preference stopped
 * showing. The precedence table (spec §6.3) is a lexicographic comparator —
 * approval, scope, source, recency, score — preceded by the shared-subject
 * rule, and ends in the hint id so that it is total: two runs over the same
 * snapshot always suppress the same hint.
 *
 * "Both apply" is the part the table leaves implicit, and it matters because
 * of the always-candidate rule (§4.2 step 4): every configured agent's hints
 * are candidates on every query, since the host router — not the classifier
 * — decides which specialist runs. Two agent-scoped hints for *different*
 * agents can never render in the same place, so treating them as a conflict
 * would permanently hide one agent's preference behind another's. A hint's
 * *audience* is therefore its agent when agent-scoped and "everyone"
 * otherwise, and two hints conflict only when they share a slot and could
 * render together: same audience, or either addressed to everyone. With no
 * agent-scoped hints in play this is exactly "one winner per slot".
 *
 * Resolution is greedy in precedence order: the strongest hint of a slot is
 * kept, and each weaker one is kept too unless a hint already kept conflicts
 * with it, in which case that kept hint is the winner recorded against it.
 * This keeps the comparator the single source of truth and makes the
 * outcome independent of input order.
 */

import type { PolicyConfig } from "../policy";
import type { Charter, ConflictRule, Hint, HintScope } from "../types";
import { depth } from "../graph/paths";
import { scoreHint } from "./decay";

/** Rule 2's order: client > agent > category > global. */
const SCOPE_RANK: Readonly<Record<HintScope, number>> = Object.freeze({ client: 3, agent: 2, category: 1, global: 0 });

/** The audience of a hint addressed to everyone who reads the charter. */
export const EVERYONE = "*";

export interface ConflictContext {
  policy: PolicyConfig;
  /** Epoch ms; decay for rule 5 is measured against it. */
  now: number;
  /** Rule 5's score per hint. Default: `scoreHint` at relevance 1 with the maturity unknown. */
  effective?: (h: Hint) => number;
  /** Ids of hints that came from the shared subject (§3.1, §6.3 last row). */
  shared?: ReadonlySet<string>;
}

/** Who a hint renders for: its agent when agent-scoped, otherwise everyone. */
export function audienceOf(h: Hint): string {
  return h.scope === "agent" && h.agent !== undefined ? h.agent : EVERYONE;
}

/** True when the two could appear in one rendered block. */
export function canCoRender(a: Hint, b: Hint): boolean {
  const x = audienceOf(a);
  const y = audienceOf(b);
  return x === y || x === EVERYONE || y === EVERYONE;
}

/** Same slot and able to render together — the recall-time definition of a conflict. */
export function conflicts(a: Hint, b: Hint): boolean {
  return a.slot === b.slot && canCoRender(a, b);
}

export interface Verdict {
  winner: Hint;
  loser: Hint;
  rule: ConflictRule;
}

/** Epoch ms of an ISO instant for rule 4; an unparseable one is the oldest possible. */
function reinforcedAt(h: Hint): number {
  const at = Date.parse(h.provenance.lastReinforcedAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function verdict(aWins: boolean, a: Hint, b: Hint, rule: ConflictRule): Verdict {
  return aWins ? { winner: a, loser: b, rule } : { winner: b, loser: a, rule };
}

/**
 * The §6.3 table applied to two hints, with the rule that decided. `null`
 * only when both are the same hint (same id), which no rule can order.
 */
export function precedence(a: Hint, b: Hint, ctx: ConflictContext): Verdict | null {
  if (a.id === b.id) return null;

  // Shared-subject rule: a shared hint loses to any primary hint of the slot
  // unless it is approved and the primary is not — in which case rule 1
  // decides in the shared hint's favour anyway.
  const aShared = ctx.shared?.has(a.id) ?? false;
  const bShared = ctx.shared?.has(b.id) ?? false;
  if (aShared !== bShared) {
    const shared = aShared ? a : b;
    const primary = aShared ? b : a;
    const sharedPrevails = shared.approval === "approved" && primary.approval !== "approved";
    if (!sharedPrevails) return verdict(!aShared, a, b, "shared-subject");
  }

  // 1. approval
  if (a.approval !== b.approval) return verdict(a.approval === "approved", a, b, "approval");

  // 2. scope; among category hints, the deeper node is the more specific one
  const scopeA = SCOPE_RANK[a.scope];
  const scopeB = SCOPE_RANK[b.scope];
  if (scopeA !== scopeB) return verdict(scopeA > scopeB, a, b, "scope");
  if (a.scope === "category") {
    const depthA = depth(a.nodePath);
    const depthB = depth(b.nodePath);
    if (depthA !== depthB) return verdict(depthA > depthB, a, b, "scope");
  }

  // 3. source
  if (a.source !== b.source) return verdict(a.source === "explicit", a, b, "source");

  // 4. recency
  const atA = reinforcedAt(a);
  const atB = reinforcedAt(b);
  if (atA !== atB) return verdict(atA > atB, a, b, "recency");

  // 5. score, then the lower id
  const effective = ctx.effective ?? ((h: Hint): number => scoreHint(h, { now: ctx.now, policy: ctx.policy, relevance: 1 }));
  const scoreA = effective(a);
  const scoreB = effective(b);
  if (scoreA !== scoreB) return verdict(scoreA > scoreB, a, b, "score");
  return verdict(a.id < b.id, a, b, "score");
}

/** Sort comparator over the same table: negative when `a` prevails. */
export function compareHints(a: Hint, b: Hint, ctx: ConflictContext): number {
  const v = precedence(a, b, ctx);
  if (v === null) return 0;
  return v.winner === a ? -1 : 1;
}

/**
 * One winner per slot per audience (see the header). `hints` may arrive in
 * any order; duplicates by id are folded to one. `opts` lets the charter
 * assembler pass the effective scores it already computed and the ids that
 * came from the shared subject; the public three-argument form (spec §2.8)
 * scores at relevance 1.
 */
export function resolveConflicts(
  hints: readonly Hint[],
  policy: PolicyConfig,
  now: number,
  opts: Pick<ConflictContext, "effective" | "shared"> = {},
): { kept: Hint[]; suppressed: Charter["suppressed"] } {
  const ctx: ConflictContext = { policy, now, ...opts };
  const bySlot = new Map<string, Hint[]>();
  const seen = new Set<string>();
  for (const hint of hints) {
    if (seen.has(hint.id)) continue;
    seen.add(hint.id);
    const list = bySlot.get(hint.slot);
    if (list) list.push(hint);
    else bySlot.set(hint.slot, [hint]);
  }

  const kept: Hint[] = [];
  const suppressed: Charter["suppressed"] = [];
  for (const group of bySlot.values()) {
    const ordered = [...group].sort((a, b) => compareHints(a, b, ctx));
    const winners: Hint[] = [];
    for (const hint of ordered) {
      const beatenBy = winners.find((w) => conflicts(w, hint));
      if (beatenBy === undefined) {
        winners.push(hint);
        continue;
      }
      const v = precedence(beatenBy, hint, ctx);
      // `beatenBy` precedes `hint` in the order, so it is the winner; the
      // rule is whatever separated the two.
      suppressed.push({ hintId: hint.id, by: beatenBy.id, rule: v?.rule ?? "score" });
    }
    kept.push(...winners);
  }
  return { kept, suppressed };
}
