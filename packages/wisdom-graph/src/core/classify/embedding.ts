/**
 * embedding.ts — the optional second opinion on a classification.
 *
 * Keyword scoring is fast and predictable but literal; an embedding can tell
 * that "decumulation" and "drawing down my savings" are the same topic. The
 * re-rank is a pure blend on scores the classifier already produced —
 * `embedBlend × cosine + (1 − embedBlend) × keyword` per node (spec §4.2
 * step 3) — and nothing more, because everything around it is the engine's
 * concern: whether to embed at all (`refine`, an `EmbeddingPort`, node
 * embeddings on the snapshot, budget left), the query-vector cache, and the
 * timeout that keeps the keyword result when the port is slow.
 *
 * It leaves the input untouched — the same object — whenever it has nothing
 * to blend: no query vector, or a snapshot without node embeddings. That is
 * what lets `graph.refine()` promise to return its input on any failure
 * without a copy or a flag. A node without an embedding in a snapshot that
 * has them scores cosine 0, not "unchanged": mixing the two scales would let
 * an un-embedded node outrank an embedded one purely by omission.
 */

import type { PolicyConfig } from "../policy";
import { ROOT_PATH } from "../graph/paths";
import type { SubjectSnapshot } from "../graph/snapshot";
import { EMPTY_SIGNALS, normaliseScores, toTopic, type Classification, type ScoredNode } from "./index";

/**
 * Cosine similarity in [−1, 1]; 0 for an empty, zero-length or mismatched
 * pair, so a bad vector can only fail to help, never throw.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const value = dot / Math.sqrt(normA * normB);
  return Math.max(-1, Math.min(1, value));
}

/**
 * Blend `classification` with the cosine of `queryVector` against each active
 * node's embedding and rebuild the topic with method "embedding". Returns the
 * input itself when there is no vector or the snapshot has no embeddings.
 */
export function rerankByEmbedding(
  classification: Classification,
  queryVector: readonly number[] | null | undefined,
  snapshot: SubjectSnapshot,
  policy: PolicyConfig,
): Classification {
  if (!queryVector || queryVector.length === 0 || !snapshot.hasEmbeddings) return classification;
  const blend = Math.max(0, Math.min(1, policy.classify.embedBlend));
  const keyword = new Map(classification.scored.map((n) => [n.path, n]));

  const blended: ScoredNode[] = [];
  for (const node of snapshot.nodes) {
    if (node.status !== "active" || node.path === ROOT_PATH) continue;
    // Negative similarity is "unrelated", not "penalise": clamp at 0 so a
    // keyword-matched node cannot be dragged below an unmatched one.
    const similarity = node.embedding ? Math.max(0, cosine(queryVector, node.embedding)) : 0;
    const prior = keyword.get(node.path);
    const total = blend * similarity + (1 - blend) * (prior?.score ?? 0);
    if (total <= 0) continue;
    blended.push({
      path: node.path,
      total,
      score: 0,
      signals: { ...(prior?.signals ?? EMPTY_SIGNALS), embedding: similarity },
    });
  }

  const ranked = normaliseScores(blended);
  return Object.freeze({
    topic: toTopic(ranked, snapshot, policy, "embedding"),
    scored: Object.freeze(ranked.map((n) => Object.freeze({ ...n, signals: Object.freeze(n.signals) }))),
    queryTokens: classification.queryTokens,
  });
}
