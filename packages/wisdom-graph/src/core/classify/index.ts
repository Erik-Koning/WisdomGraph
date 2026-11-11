/**
 * classify/index.ts — which topic a query is about, with no LLM and no I/O.
 *
 * Must-have 3 forbids a model call on the recall path, and the whole recall
 * has a 150 ms lane, so classification is an inverted keyword index built
 * once per snapshot and a scoring pass that touches only the postings the
 * query's tokens select (spec §4.2 step 3). It is deliberately shallow: the
 * router — not this classifier — decides which specialist runs, and the
 * always-candidate rule keeps every agent's hints in play regardless, so the
 * classifier's job is to pick the branch whose *category* and *node* hints
 * apply, not to be right about intent.
 *
 * The scoring reads the spec's formula literally. Field weights scale a
 * token's idf (title 3, keywords 2, description 1, property values 0.5, hint
 * values 1), a seed-pattern hit is a pseudo-token worth 5 × idf so a regex the
 * operator wrote outranks a couple of incidental keywords, and the flat
 * bonuses — agent mention 4, category hint 5, continuity 0.3, depth 0.1 per
 * level — are added on the same raw scale: a category the consumer signalled
 * is worth about two distinctive keywords, continuity only breaks ties, and
 * depth prefers the more specific of two equal nodes. Children credit their
 * ancestors at 0.5 of their own score, so a query about RRIF withdrawals
 * lights the retirement node *and* the advice category above it.
 *
 * Continuity and depth are bonuses on nodes the query reached, never a
 * reason to score a node. A greeting after a product question still matches
 * nothing and stays "direct" with confidence 0: the previous topic is a
 * tie-breaker between candidates the text produced, not a candidate itself,
 * because the ring remembers the last eight recalls and would otherwise make
 * every short follow-up inherit a full-confidence topic it never mentioned.
 *
 * The root is never scored. It is not a topic — its hints are global and
 * apply to every query — and letting every child credit it would make "/"
 * the winner of any broad question, which is exactly the "direct" outcome
 * the confidence threshold already expresses.
 */

import type { PolicyConfig } from "../policy";
import type { ClassifyMethod, HintRecord, JsonValue, NeutralMessage, Surface, Topic, TopicNode } from "../types";
import { normalizeText, tokenize } from "../text/normalize";
import { ROOT_PATH, ancestors, categoryOf, join } from "../graph/paths";
import { compileSeedPattern } from "../graph/seed";
import type { SubjectSnapshot } from "../graph/snapshot";

// ── Weights (spec §4.2 step 3) ───────────────────────────────────────────────

export const FIELD_WEIGHTS = Object.freeze({
  pattern: 5,
  title: 3,
  keyword: 2,
  description: 1,
  property: 0.5,
  hintValue: 1,
});

export const BONUSES = Object.freeze({
  agentMention: 4,
  categoryHint: 5,
  depthPerLevel: 0.1,
  /** A child's own score credits each proper ancestor by this factor. */
  ancestorCredit: 0.5,
  /** The previous user turn's tokens count this much of the current turn's. */
  previousTurn: 0.5,
});

/** `topic.nodePaths` holds at most this many paths (§2.5). */
export const MAX_NODE_PATHS = 3;

// ── The index ────────────────────────────────────────────────────────────────

/** What the query contributes: weighted tokens for the postings, normalised text for the patterns. */
export interface QueryTerms {
  tokens: ReadonlyMap<string, number>;
  text: string;
}

/** Tokens of `text` at weight 1, plus the previous user turn's at `previousTurn` (max wins on overlap). */
export function queryTerms(text: string, previousUserText?: string): QueryTerms {
  const tokens = new Map<string, number>();
  for (const token of tokenize(text)) tokens.set(token, 1);
  if (previousUserText !== undefined) {
    for (const token of tokenize(previousUserText)) {
      if (!tokens.has(token)) tokens.set(token, BONUSES.previousTurn);
    }
  }
  return { tokens, text: normalizeText(text) };
}

interface IndexedNode {
  path: string;
  level: number;
  patterns: RegExp[];
}

interface Posting {
  idf: number;
  hits: { node: number; weight: number }[];
}

/** A node's field scores for one query, before ancestor credit and bonuses. */
export interface FieldScore {
  keyword: number;
  pattern: number;
}

/** A seed pattern the index could not compile; recorded, never thrown (recall must not reject). */
export interface RejectedPattern {
  path: string;
  source: string;
  reason: string;
}

/** String leaves of a JSON value, for the properties bag. */
function jsonLeaves(value: JsonValue, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) jsonLeaves(v, out);
  else if (value !== null) for (const v of Object.values(value)) jsonLeaves(v, out);
}

/**
 * Inverted keyword index over a snapshot's active, non-root nodes. Built once
 * per snapshot compile; `score` is the only thing the hot path calls.
 */
export class ClassifierIndex {
  readonly nodes: readonly IndexedNode[];
  readonly rejectedPatterns: readonly RejectedPattern[];
  private readonly postings: ReadonlyMap<string, Posting>;
  private readonly byPath: ReadonlyMap<string, number>;

  constructor(nodes: readonly TopicNode[], records: readonly HintRecord[]) {
    const valuesByPath = new Map<string, string[]>();
    for (const record of records) {
      if (record.status !== "active") continue;
      const list = valuesByPath.get(record.nodePath);
      if (list) list.push(record.value);
      else valuesByPath.set(record.nodePath, [record.value]);
    }

    const indexed: IndexedNode[] = [];
    const rejected: RejectedPattern[] = [];
    const postings = new Map<string, Posting>();
    const byPath = new Map<string, number>();

    for (const node of nodes) {
      if (node.status !== "active" || node.path === ROOT_PATH) continue;
      const index = indexed.length;
      const patterns: RegExp[] = [];
      for (const source of node.patterns) {
        try {
          patterns.push(compileSeedPattern(source));
        } catch (e) {
          rejected.push({ path: node.path, source, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      indexed.push({ path: node.path, level: node.level, patterns });
      byPath.set(node.path, index);

      // Max, not sum, per (token, node): a word in both the title and the
      // keywords is one signal at its best weight, not two.
      const weights = new Map<string, number>();
      const add = (text: string, weight: number): void => {
        for (const token of tokenize(text)) {
          const current = weights.get(token);
          if (current === undefined || current < weight) weights.set(token, weight);
        }
      };
      add(node.title, FIELD_WEIGHTS.title);
      for (const keyword of node.keywords) add(keyword, FIELD_WEIGHTS.keyword);
      add(node.description, FIELD_WEIGHTS.description);
      const leaves: string[] = [];
      jsonLeaves(node.properties, leaves);
      for (const leaf of leaves) add(leaf, FIELD_WEIGHTS.property);
      for (const value of valuesByPath.get(node.path) ?? []) add(value, FIELD_WEIGHTS.hintValue);

      for (const [token, weight] of weights) {
        const posting = postings.get(token);
        if (posting) posting.hits.push({ node: index, weight });
        else postings.set(token, { idf: 0, hits: [{ node: index, weight }] });
      }
    }

    const total = indexed.length;
    for (const posting of postings.values()) posting.idf = ClassifierIndex.idf(total, posting.hits.length);

    this.nodes = indexed;
    this.rejectedPatterns = rejected;
    this.postings = postings;
    this.byPath = byPath;
  }

  /** `ln(1 + N / df)`: a token unique to one node weighs `ln(1 + N)`, one in every node `ln 2`. */
  static idf(total: number, documentFrequency: number): number {
    return documentFrequency === 0 ? 0 : Math.log(1 + total / documentFrequency);
  }

  /** Number of indexed nodes. */
  get size(): number {
    return this.nodes.length;
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  /** The tokens known to the index, for tests and `explain()`. */
  tokens(): string[] {
    return [...this.postings.keys()];
  }

  /** How many indexed nodes carry `token`; 0 for a token the graph has never seen (ingest's keyword refresh ranks by it). */
  documentFrequency(token: string): number {
    return this.postings.get(token)?.hits.length ?? 0;
  }

  /**
   * Raw field scores per node path for `query`: `Σ idf × fieldWeight ×
   * queryWeight` over the postings its tokens select, plus a pattern
   * pseudo-token at `5 × idf` for every node whose seed regex hits the text.
   * Only nodes with a non-zero score appear.
   */
  score(query: QueryTerms): Map<string, FieldScore> {
    const keyword = new Float64Array(this.nodes.length);
    for (const [token, queryWeight] of query.tokens) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      for (const hit of posting.hits) keyword[hit.node] = (keyword[hit.node] ?? 0) + posting.idf * hit.weight * queryWeight;
    }

    const patternHits: number[] = [];
    if (query.text.length > 0) {
      this.nodes.forEach((node, index) => {
        if (node.patterns.some((p) => p.test(query.text))) patternHits.push(index);
      });
    }
    const patternScore = FIELD_WEIGHTS.pattern * ClassifierIndex.idf(this.nodes.length, patternHits.length);

    const out = new Map<string, FieldScore>();
    this.nodes.forEach((node, index) => {
      const k = keyword[index] ?? 0;
      if (k > 0) out.set(node.path, { keyword: k, pattern: 0 });
    });
    for (const index of patternHits) {
      const node = this.nodes[index];
      if (!node) continue;
      const entry = out.get(node.path);
      if (entry) entry.pattern = patternScore;
      else out.set(node.path, { keyword: 0, pattern: patternScore });
    }
    return out;
  }
}

// ── Classification ───────────────────────────────────────────────────────────

export interface ClassifyContext {
  policy: PolicyConfig;
  /** Recent messages; the last user turn other than the query contributes tokens at 0.5, tool names become category hints. */
  recentTurns?: readonly NeutralMessage[];
  /** Node paths from this subject's recent topics (the cache entry's continuity ring). */
  recentPaths?: readonly string[];
  surface?: Surface;
  /** The consumer's map from surface to the category it implies (spec-silent; empty by default). */
  surfaceCategories?: Readonly<Partial<Record<Surface, string>>>;
  /** Category names the consumer signalled explicitly; each gets the category-hint bonus. */
  categoryHints?: readonly string[];
}

export interface NodeSignals {
  /** Seed-pattern hit: `5 × idf`. */
  pattern: number;
  /** `Σ idf × fieldWeight × queryWeight` over the node's own fields. */
  keyword: number;
  /** Credit from descendants' own scores. */
  ancestor: number;
  agentMention: number;
  continuity: number;
  categoryHint: number;
  depth: number;
  /** Cosine similarity, present only after an embedding re-rank. */
  embedding?: number;
}

export interface ScoredNode {
  path: string;
  /** The raw sum of the signals. */
  total: number;
  /** `total` divided by the best node's total, so the best is 1. */
  score: number;
  signals: NodeSignals;
}

export interface Classification {
  topic: Topic;
  /** Every node with a non-zero score, best first. */
  scored: readonly ScoredNode[];
  /** The query tokens that were looked up, for `explain()`. */
  queryTokens: readonly string[];
}

/** Signals of a node nothing has scored yet; the re-rank starts from it for nodes the keyword pass never saw. */
export const EMPTY_SIGNALS: NodeSignals = Object.freeze({
  pattern: 0,
  keyword: 0,
  ancestor: 0,
  agentMention: 0,
  continuity: 0,
  categoryHint: 0,
  depth: 0,
});

/** The signals the query itself produced — everything but the two bonuses that only rank nodes already reached. */
function reached(s: NodeSignals): number {
  return s.keyword + s.pattern + s.ancestor + s.agentMention + s.categoryHint;
}

/**
 * The last `user` message in `turns` whose text is not the query itself. A
 * consumer that passes the whole tail of the thread includes the current
 * message; folding case and whitespace keeps that copy from counting twice.
 */
export function previousUserTurn(turns: readonly NeutralMessage[] | undefined, query: string): string | undefined {
  if (!turns) return undefined;
  const current = normalizeText(query).toLowerCase();
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || turn.role !== "user") continue;
    if (normalizeText(turn.content).toLowerCase() === current) continue;
    return turn.content;
  }
  return undefined;
}

/** Tool names in `turns`: `tool` messages' names and assistants' tool calls. */
export function toolNames(turns: readonly NeutralMessage[] | undefined): string[] {
  const out: string[] = [];
  for (const turn of turns ?? []) {
    if (turn.role === "tool" && turn.name) out.push(turn.name);
    for (const call of turn.toolCalls ?? []) out.push(call.name);
  }
  return out;
}

/** Sort best first; equal totals fall back to the path so the order is deterministic. */
function byTotalDesc(a: ScoredNode, b: ScoredNode): number {
  return b.total - a.total || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** `total / best` for every node, best first. Returns a fresh, sorted array. */
export function normaliseScores(nodes: ScoredNode[]): ScoredNode[] {
  const sorted = [...nodes].sort(byTotalDesc);
  const best = sorted[0]?.total ?? 0;
  return sorted.map((n) => ({ ...n, score: best > 0 ? n.total / best : 0 }));
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/**
 * A frozen array under the mutable type `Topic` declares. `Recall` is
 * deep-frozen before it is returned (§2.5), so a consumer already cannot
 * push onto these; freezing here only makes the topic safe on its own.
 */
function frozenList(items: string[]): string[] {
  return Object.freeze(items) as string[];
}

const DIRECT_TOPIC = (confidence: number, method: ClassifyMethod): Topic =>
  Object.freeze({ category: "direct", agents: frozenList([]), confidence, nodePaths: frozenList([]), method });

/**
 * The `Topic` a sorted, normalised score list implies (spec §4.2 step 3).
 * `method` overrides the derived one; the re-rank passes "embedding".
 * Otherwise it records what decided: a consumer's category hint on the
 * winner, or continuity when the winner would not lead without it — a
 * runner-up it only beats by the bonus, or nothing from the query at all
 * (depth alone is not a match), which is never "keyword".
 */
export function toTopic(scored: readonly ScoredNode[], snapshot: SubjectSnapshot, policy: PolicyConfig, method?: ClassifyMethod): Topic {
  const best = scored[0];
  const second = scored[1];
  if (!best) return DIRECT_TOPIC(0, "none");
  const denominator = best.total + (second?.total ?? 0);
  const confidence = denominator > 0 ? Math.min(1, Math.max(0, best.total / denominator)) : 0;

  let decided: ClassifyMethod = method ?? "keyword";
  if (method === undefined) {
    const byContinuity = best.total - best.signals.continuity <= (second?.total ?? 0) || reached(best.signals) <= 0;
    if (best.signals.categoryHint > 0) decided = "category-hint";
    else if (best.signals.continuity > 0 && byContinuity) decided = "continuity";
  }

  if (confidence < policy.classify.minConfidence) return DIRECT_TOPIC(confidence, decided);

  const nodePaths = scored
    .filter((n) => n.score >= policy.classify.secondaryRatio)
    .slice(0, MAX_NODE_PATHS)
    .map((n) => n.path);
  const category = categoryOf(best.path) ?? "direct";
  const agents: string[] = [];
  for (const path of nodePaths) for (const agent of snapshot.nodesByPath.get(path)?.agents ?? []) agents.push(agent);
  if (snapshot.categoryNames.has(category)) agents.push(category);
  return Object.freeze({
    category,
    agents: frozenList(unique(agents)),
    confidence,
    nodePaths: frozenList(nodePaths),
    method: decided,
  });
}

/**
 * Score every indexed node for `query` and derive the topic. Synchronous, no
 * I/O, no LLM; the only inputs besides the snapshot are the query, the recent
 * turns and the signals the consumer or the cache entry passed in `ctx`.
 */
export function classify(snapshot: SubjectSnapshot, query: string, ctx: ClassifyContext): Classification {
  const { policy } = ctx;
  const terms = queryTerms(query, previousUserTurn(ctx.recentTurns, query));
  const fields = snapshot.index.score(terms);

  const signals = new Map<string, NodeSignals>();
  const signalsOf = (path: string): NodeSignals => {
    let s = signals.get(path);
    if (!s) {
      s = { ...EMPTY_SIGNALS };
      signals.set(path, s);
    }
    return s;
  };

  for (const [path, field] of fields) {
    const s = signalsOf(path);
    s.keyword = field.keyword;
    s.pattern = field.pattern;
  }

  // Children credit their ancestors from their own field scores only, so the
  // credit never compounds up a deep branch.
  for (const [path, field] of fields) {
    const own = field.keyword + field.pattern;
    for (const ancestor of ancestors(path)) {
      if (ancestor === ROOT_PATH || !snapshot.index.has(ancestor)) continue;
      signalsOf(ancestor).ancestor += BONUSES.ancestorCredit * own;
    }
  }

  const hinted = new Set<string>();
  for (const name of ctx.categoryHints ?? []) hinted.add(name);
  const fromSurface = ctx.surface !== undefined ? ctx.surfaceCategories?.[ctx.surface] : undefined;
  if (fromSurface !== undefined) hinted.add(fromSurface);
  for (const name of toolNames(ctx.recentTurns)) hinted.add(name);

  for (const category of snapshot.categories) {
    if (!snapshot.index.has(category.path)) continue;
    if (hinted.has(category.name)) signalsOf(category.path).categoryHint = BONUSES.categoryHint;
    if (terms.text.length > 0 && category.mention.test(terms.text)) signalsOf(category.path).agentMention = BONUSES.agentMention;
  }

  // Only a node the query reached earns the continuity bonus: the ring is a
  // tie-breaker, not a signal, so a query that matches nothing stays direct.
  for (const path of unique(ctx.recentPaths ?? [])) {
    const s = signals.get(path);
    if (s !== undefined && reached(s) > 0) s.continuity = policy.classify.continuityBonus;
  }

  const scored: ScoredNode[] = [];
  for (const [path, s] of signals) {
    if (reached(s) <= 0) continue;
    const level = snapshot.nodesByPath.get(path)?.level ?? 0;
    s.depth = BONUSES.depthPerLevel * level;
    scored.push({ path, total: reached(s) + s.continuity + s.depth, score: 0, signals: s });
  }

  const ranked = normaliseScores(scored);
  return Object.freeze({
    topic: toTopic(ranked, snapshot, policy),
    scored: Object.freeze(ranked.map((n) => Object.freeze({ ...n, signals: Object.freeze(n.signals) }))),
    queryTokens: Object.freeze([...terms.tokens.keys()]),
  });
}

/** The level-1 path of a configured category name. */
export function categoryPath(name: string): string {
  return join(ROOT_PATH, name);
}
