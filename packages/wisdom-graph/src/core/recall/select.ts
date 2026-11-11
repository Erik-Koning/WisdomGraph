/**
 * recall/select.ts — which stored hints are even in the running for a query.
 *
 * Spec §4.2 step 4. A snapshot holds every hint of a subject; a charter
 * wants only those that *apply* to this query, each with a relevance that
 * says how directly. Applicability has two axes and this module folds them
 * into one pass:
 *
 *   - **Where the hint hangs.** Hints hang off exactly one node (§3.1), and
 *     the node is the topical claim: a hint on `/consult_advice/retirement`
 *     is about retirement. It applies when the classifier matched that node
 *     (relevance 1) or a node below it (relevance decaying by the distance,
 *     since a parent's preference is a weaker fit for a child's question).
 *     The root is not a topic — its hints are the subject's global defaults
 *     and always apply at the flat `global` relevance. So does a hint with
 *     scope `global` wherever it hangs: that scope *is* the claim "applies
 *     everywhere", and §4.2 step 4 names root and global by one number, so
 *     the node such a hint sits on is bookkeeping, not a topical boost.
 *   - **Who the hint is for.** `scope` narrows further: `client` hints need
 *     the request's client, `agent` hints need their agent. Agent-scoped
 *     hints are the exception to the topical axis: the host router, not the
 *     classifier, decides which specialist runs, so every configured
 *     agent's hints stay candidates (at the low `alwaysAgent` relevance)
 *     even when the classifier put the query elsewhere. That is what keeps
 *     the middle injection point — the single-consult path — working on a
 *     misclassified turn.
 *
 * Status and approval are the visibility gates: `active` only (or `pending`
 * when the debugging switch `includePending` is on), `needsReview` withheld
 * unless the same switch is on, and `approvedOnly` narrowing to human-
 * approved hints when the caller asks for a strict charter. The shared
 * subject, when configured, contributes only its approved hints, scaled by
 * `relevance.shared`, and is flagged so the conflict pass can apply its rule.
 *
 * Nothing here scores: relevance is a factor the charter multiplies in.
 */

import type { PolicyConfig } from "../policy";
import type { Hint, HintMaturity, HintRecord, RecallRequest, Topic } from "../types";
import { ROOT_PATH, depth, isDescendant } from "../graph/paths";
import type { SubjectSnapshot } from "../graph/snapshot";

export interface Candidate {
  readonly hint: Hint;
  /** From the stored record; drives the half-life. */
  readonly maturity: HintMaturity;
  /** The query's contribution to the effective score (§4.2 step 4). */
  readonly relevance: number;
  /** True when the hint came from the shared subject. */
  readonly shared: boolean;
}

/** The request fields selection reads; a full `RecallRequest` satisfies it. */
export type SelectRequest = Pick<RecallRequest, "clientId" | "approvedOnly">;

/**
 * How directly a hint at `nodePath` relates to the matched nodes, or
 * `undefined` when it is on an unrelated branch. Root is flat `global`;
 * a matched node is `matched`; an ancestor of a matched node decays by
 * distance. The best over all matched nodes wins.
 */
export function nodeRelevance(nodePath: string, topic: Topic, policy: PolicyConfig): number | undefined {
  const { relevance } = policy.recall;
  if (nodePath === ROOT_PATH) return relevance.global;
  let best: number | undefined;
  const hintDepth = depth(nodePath);
  for (const matched of topic.nodePaths) {
    let r: number | undefined;
    if (matched === nodePath) r = relevance.matched;
    else if (isDescendant(matched, nodePath)) r = Math.pow(relevance.ancestorDecay, depth(matched) - hintDepth);
    if (r !== undefined && (best === undefined || r > best)) best = r;
  }
  return best;
}

/** The visibility gate (§3.2): status, review flag and — when the caller asks — approval. */
function visible(record: HintRecord, req: SelectRequest, policy: PolicyConfig): boolean {
  const { includePending } = policy.recall;
  if (record.status !== "active" && !(record.status === "pending" && includePending)) return false;
  if (record.needsReview && !includePending) return false;
  if (req.approvedOnly === true && record.approval !== "approved") return false;
  return true;
}

/**
 * The relevance a hint applies at, or `undefined` when its scope filter
 * fails for this query. `configured` is the always-candidate vocabulary:
 * the configured category names.
 */
function applicability(hint: Hint, topic: Topic, req: SelectRequest, policy: PolicyConfig, configured: ReadonlySet<string>): number | undefined {
  const { relevance } = policy.recall;
  switch (hint.scope) {
    case "global":
      return relevance.global;
    case "category":
      return nodeRelevance(hint.nodePath, topic, policy);
    case "agent": {
      if (hint.agent === undefined) return undefined;
      if (topic.agents.includes(hint.agent)) return nodeRelevance(hint.nodePath, topic, policy) ?? relevance.matched;
      return configured.has(hint.agent) ? relevance.alwaysAgent : undefined;
    }
    case "client": {
      if (hint.clientId === undefined || req.clientId === undefined || req.clientId === null) return undefined;
      if (hint.clientId !== req.clientId) return undefined;
      return nodeRelevance(hint.nodePath, topic, policy);
    }
  }
}

function collectFrom(
  snapshot: SubjectSnapshot,
  topic: Topic,
  req: SelectRequest,
  policy: PolicyConfig,
  configured: ReadonlySet<string>,
  shared: boolean,
  out: Candidate[],
): void {
  for (const hint of snapshot.hints) {
    const record = snapshot.recordsById.get(hint.id);
    if (record === undefined) continue;
    if (shared && record.approval !== "approved") continue;
    if (!visible(record, req, policy)) continue;
    const base = applicability(hint, topic, req, policy, configured);
    if (base === undefined) continue;
    out.push({
      hint,
      maturity: record.maturity,
      relevance: shared ? base * policy.recall.relevance.shared : base,
      shared,
    });
  }
}

/**
 * Every hint of the primary snapshot — and of the shared one, when given —
 * that applies to `topic` for `req`, with its relevance, in snapshot order.
 * Synchronous and allocation-light: one pass per snapshot, no scoring.
 */
export function collectCandidates(
  snapshot: SubjectSnapshot,
  shared: SubjectSnapshot | null,
  topic: Topic,
  req: SelectRequest,
  policy: PolicyConfig,
): Candidate[] {
  const out: Candidate[] = [];
  const configured = snapshot.categoryNames;
  collectFrom(snapshot, topic, req, policy, configured, false, out);
  if (shared !== null) collectFrom(shared, topic, req, policy, configured, true, out);
  return out;
}
