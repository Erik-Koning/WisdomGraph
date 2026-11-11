/**
 * ingest/consolidate.ts — the consolidation timescale: the rule-based
 * short-term pass and the model-backed long-term pass.
 *
 * Spec §5.7. Real-time capture is deliberately permissive — a crowded node
 * never blocks a hint, a near-duplicate is stored rather than argued over
 * — so something slower has to keep the graph well organised. Two passes
 * do, at two costs:
 *
 *   - **`consolidate()` is arithmetic and runs often.** Every
 *     `consolidateEveryEvents` events (or whenever a node overflows) it
 *     folds supersession chains, merges duplicates on a node, promotes
 *     `captured` hints the subject keeps using, retires inferred hints
 *     feedback has beaten down, teaches nodes the vocabulary their hints
 *     keep using, and retires nodes that have stood empty for a month. It
 *     calls no model and reads nothing but the subject's rows, so it can
 *     run inside the ingest lane right after the event that made it due.
 *   - **`refine()` asks a model and runs from a cron.** Splitting a crowded
 *     node into sub-topics, moving a hint where it belongs, aliasing two
 *     slots that mean one dimension — those are judgements, and they are
 *     made by the `consolidate@1` prompt over one node at a time. The pass
 *     is never a bare method call: each node becomes a `kind: "consolidate"`
 *     row that the ledger leases, plans, applies and retries exactly as a
 *     turn (decision 30), so a crash mid-pass replays with the proposal the
 *     row already holds, and two engines on one store never tidy the same
 *     node at once. Its ops are gated by the same organiser as extraction:
 *     the model cannot reach the store by a softer road, and a locked node
 *     is as untouchable here as it is at capture time.
 *
 * Two readings the spec leaves open are fixed here. "Same slot+value across
 * scopes where the wider scope is redundant" is taken literally: on one
 * node the narrower-scoped copy is kept, since it is the one recall would
 * choose whenever both apply (§6.3's scope rule). And a duplicate merge
 * keeps the survivor's *row* — id included — rather than minting a new one,
 * because the consumer's `appliedHintIds` and pending feedback point at
 * that id; the loser's counters and provenance are folded into it. The
 * survivor is the approved one when either is, then the human-stated one,
 * then the higher confidence: what a human decided or said is never the
 * copy that goes.
 *
 * Nothing here is an event of the subject's history: audit rows are
 * stamped `system:consolidate` (the model pass's rows `llm:consolidate@1`)
 * and the rule pass appends no event id to provenance. It is idempotent by
 * construction — a merged loser is retired, a promoted hint is promoted —
 * so a pass that runs twice writes nothing the second time but the counter
 * reset.
 */

import { deterministicId, fnv1a32Hex } from "../ids";
import type { PolicyConfig } from "../policy";
import {
  VersionConflictError,
  type ConsolidateEvent,
  type HintPatch,
  type LlmPort,
  type SpanLike,
  type StoreOp,
  type StoredEvent,
  type SubjectRef,
} from "../ports";
import type { ConsolidationReport, HintMaturity, HintRecord, HintScope, HintSource, HintStatus, JsonValue, TopicNode } from "../types";
import type { Proposal } from "../schema/proposal";
import { KEYWORD_PATTERN } from "../schema/node";
import { jaccard, stemLite, tokenize } from "../text/normalize";
import { ROOT_PATH } from "../graph/paths";
import { compileSnapshot, type SubjectSnapshot } from "../graph/snapshot";
import { ageDays, promotionDue } from "../policy/decay";
import { cacheKey } from "../recall/cache";
import { snapshotLoader } from "../recall/recall";
import {
  EXTRACTION_ATTEMPTS,
  UNPARSEABLE,
  complete,
  extractJson,
  fetchExtraRecords,
  isUnparseableProposal,
  proposalEnvelope,
  referencedHintIds,
  unparseableProposal,
  type Envelope,
} from "./extract";
import { eventAudit } from "./feedback";
import {
  KEYWORD_REFRESH_MAX,
  flagOverflow,
  processEvent,
  takeFlagged,
  type ConsolidationHooks,
  type ConsolidationPlanner,
  type ExtractionResult,
  type IngestContext,
} from "./ingest";
import { agentVocabulary, mergeKeywords, validateProposal, type OrganiserContext } from "./organiser";
import { CONSOLIDATION_MAX_TOKENS, CONSOLIDATION_PROMPT_VERSION, buildConsolidationPrompt, retryPrompt } from "./prompts";

// ── Constants ────────────────────────────────────────────────────────────────

/** The actor on the rule pass's audit rows (§10.4). */
export const CONSOLIDATE_ACTOR = "system:consolidate";
/** The actor on the model pass's audit rows. */
export const CONSOLIDATE_LLM_ACTOR = `llm:${CONSOLIDATION_PROMPT_VERSION}`;
/** A hint-value token must recur in this many of a node's hints before the node learns it as a keyword. */
export const KEYWORD_MIN_RECURRENCE = 2;
/** Every status: the rule pass folds superseded chains and must see retired rows to know a node is empty. */
export const ALL_STATUSES: readonly HintStatus[] = ["active", "pending", "superseded", "retired"];
/** Supersession chains longer than this are folded as far as this; a cycle can never spin. */
const MAX_CHAIN_HOPS = 16;

const SCOPE_RANK: Readonly<Record<HintScope, number>> = Object.freeze({ global: 0, category: 1, agent: 2, client: 3 });
const SOURCE_RANK: Readonly<Record<HintSource, number>> = Object.freeze({ inferred: 0, explicit: 1 });
const MATURITY_RANK: Readonly<Record<HintMaturity, number>> = Object.freeze({ captured: 0, consolidated: 1, established: 2 });
const MATURITIES: readonly HintMaturity[] = ["captured", "consolidated", "established"];

const NOOP_SPAN: SpanLike = Object.freeze({ setAttribute: () => undefined, addEvent: () => undefined, recordException: () => undefined, end: () => undefined });

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // Observability never fails a pass.
  }
}

function startSpan(ctx: IngestContext, name: string, attributes: Record<string, string | number | boolean>): SpanLike {
  try {
    return ctx.tracer.startSpan(name, { attributes });
  } catch {
    return NOOP_SPAN;
  }
}

function debug(ctx: IngestContext, obj: object, msg: string): void {
  safe(() => (ctx.logger.debug ?? ctx.logger.info).call(ctx.logger, obj, msg));
}

function later(a: string, b: string): string {
  return a >= b ? a : b;
}

// ── System audit rows ────────────────────────────────────────────────────────

/** What a pass writes about itself: the stamp every audit row of one run shares. */
export interface PassContext {
  ref: SubjectRef;
  policy: PolicyConfig;
  /** Epoch ms of the run. */
  now: number;
  /** ISO-8601 of `now`; every row and audit entry carries it. */
  at: string;
}

/**
 * An audit op for a system pass. The pass is not an event, so the id derives
 * from the pass name, the instant and a sequence number: stable across a
 * re-plan at the same instant (a version conflict applies nothing, so no
 * row exists to collide with) and unique across runs.
 */
export function systemAudit(
  pass: string,
  actor: string,
  ctx: PassContext,
  seq: number,
  action: string,
  fields: { hintId?: string; nodePath?: string; detail?: Record<string, JsonValue> },
): StoreOp {
  const { ref } = ctx;
  return {
    op: "audit",
    entry: {
      id: deterministicId("a", ref.tenantId, ref.subjectId, pass, ctx.at, seq),
      tenantId: ref.tenantId,
      subjectId: ref.subjectId,
      at: ctx.at,
      actor,
      action,
      ...(fields.hintId !== undefined ? { hintId: fields.hintId } : {}),
      ...(fields.nodePath !== undefined ? { nodePath: fields.nodePath } : {}),
      detail: fields.detail ?? {},
    },
  };
}

// ── Node bookkeeping shared with maintain() ──────────────────────────────────

/** A mutable view of the subject's nodes during one pass: rows plus the active hint count each will end with. */
export class NodeLedger {
  readonly nodes = new Map<string, TopicNode>();
  private readonly counts = new Map<string, number>();
  private readonly touched = new Set<string>();

  constructor(snapshot: SubjectSnapshot, hints: Iterable<HintRecord>) {
    for (const node of snapshot.nodes) {
      if (node.virtual) continue;
      const { virtual, ...row } = node;
      void virtual;
      this.nodes.set(row.path, row);
    }
    for (const hint of hints) if (hint.status === "active") this.counts.set(hint.nodePath, (this.counts.get(hint.nodePath) ?? 0) + 1);
  }

  activeHints(path: string): number {
    return this.counts.get(path) ?? 0;
  }

  /** Record a change in a node's active hints. */
  shift(path: string, delta: number): void {
    if (delta === 0) return;
    this.counts.set(path, Math.max(0, this.activeHints(path) + delta));
    this.touched.add(path);
  }

  retire(path: string): void {
    const node = this.nodes.get(path);
    if (node !== undefined) this.nodes.set(path, { ...node, status: "retired" });
  }

  active(): TopicNode[] {
    return [...this.nodes.values()].filter((n) => n.status === "active");
  }

  hasActiveChild(path: string): boolean {
    for (const node of this.nodes.values()) if (node.status === "active" && node.parentPath === path) return true;
    return false;
  }

  /** `patchNode { stats }` for every active node whose count moved and still disagrees with its row. */
  statsOps(): StoreOp[] {
    const ops: StoreOp[] = [];
    for (const path of this.touched) {
      const node = this.nodes.get(path);
      if (node === undefined || node.status !== "active") continue;
      const activeHints = this.activeHints(path);
      if (node.stats.activeHints === activeHints) continue;
      ops.push({ op: "patchNode", nodeId: node.id, patch: { stats: { ...node.stats, activeHints } } });
    }
    return ops;
  }
}

/** When a node was last written by ingest, for GC age: its last ingest stamp, else its creation. */
function lastTouched(node: TopicNode): string {
  return node.stats.lastIngestAt ?? node.createdAt;
}

/**
 * Spec §5.7 node GC: an unlocked node with no active or pending hint, no
 * active child, and no ingest write for `nodeGcDays`. Deepest first, so a
 * parent whose only child goes in this pass is judged on its own emptiness
 * — and still on its own age. Returns the paths retired; the ledger is
 * updated as it goes.
 */
export function gcNodes(ledger: NodeLedger, live: Iterable<HintRecord>, ctx: PassContext): string[] {
  const occupied = new Set<string>();
  for (const hint of live) if (hint.status === "active" || hint.status === "pending") occupied.add(hint.nodePath);
  const candidates = ledger.active().filter((n) => !n.locked && n.path !== ROOT_PATH).sort((a, b) => b.level - a.level || (a.path < b.path ? -1 : 1));
  const retired: string[] = [];
  for (const node of candidates) {
    if (occupied.has(node.path) || ledger.hasActiveChild(node.path)) continue;
    if (ageDays(lastTouched(node), ctx.now) < ctx.policy.ingest.nodeGcDays) continue;
    ledger.retire(node.path);
    retired.push(node.path);
  }
  return retired;
}

// ── The rule pass (§5.7, short-term) ─────────────────────────────────────────

export interface ConsolidationPlan {
  ops: StoreOp[];
  /** Hints retired as duplicates of a survivor. */
  merged: number;
  /** `captured → consolidated`. */
  promoted: number;
  /** Inferred hints retired for confidence below `retireConfidenceBelow`. */
  retired: number;
  /** Superseded rows whose pointer was shortened to the chain's end. */
  folded: number;
  nodesRetired: number;
  /** Nodes whose keyword list grew. */
  keywordsRefreshed: number;
  /** Ops that change graph rows: everything but audit and the counter. */
  graphOps: number;
}

/** Two active hints on one node that say the same thing (§5.7): same lane and audience, near-duplicate text, or one value under one slot across the two scopes recall would otherwise rank. */
function duplicates(a: HintRecord, b: HintRecord, policy: PolicyConfig): boolean {
  if (a.lane !== b.lane || (a.agent ?? "") !== (b.agent ?? "") || (a.clientId ?? "") !== (b.clientId ?? "")) return false;
  if (a.approval === "approved" && b.approval === "approved") return false;
  if (a.scope === b.scope) return jaccard(a.text, b.text) >= policy.recall.dedupeJaccard;
  const widerAndNarrower = SCOPE_RANK[a.scope] + SCOPE_RANK[b.scope] === SCOPE_RANK.global + SCOPE_RANK.category;
  return widerAndNarrower && a.slot === b.slot && a.value === b.value;
}

/** Which of two duplicates keeps its row: approved, then human-stated, then the narrower scope, then confidence, reinforcements, age, id. */
function survivorOf(a: HintRecord, b: HintRecord): [HintRecord, HintRecord] {
  const keys = (h: HintRecord): number[] => [h.approval === "approved" ? 1 : 0, SOURCE_RANK[h.source], SCOPE_RANK[h.scope], h.confidence, h.reinforcements, -Date.parse(h.createdAt)];
  const ka = keys(a);
  const kb = keys(b);
  for (let i = 0; i < ka.length; i += 1) {
    const x = ka[i] ?? 0;
    const y = kb[i] ?? 0;
    if (x !== y) return x > y ? [a, b] : [b, a];
  }
  return a.id <= b.id ? [a, b] : [b, a];
}

/**
 * The words a node's hints keep using: tokens (stems compared) that appear
 * in at least `KEYWORD_MIN_RECURRENCE` distinct active hint values and are
 * not already keywords, most recurrent first, at most `KEYWORD_REFRESH_MAX`.
 * Recurrence is the bar because the classifier already weighs every value
 * on its own; only a word the node's hints share is worth a keyword's weight.
 */
export function recurringValueWords(node: TopicNode, values: readonly string[]): string[] {
  const known = new Set<string>();
  for (const keyword of node.keywords) for (const token of tokenize(keyword)) known.add(token);
  const recurrence = new Map<string, { word: string; hints: number }>();
  for (const value of values) {
    const seen = new Set<string>();
    for (const word of tokenize(value, { stem: false })) {
      if (word.length < 3 || /^\d+$/.test(word) || !KEYWORD_PATTERN.test(word)) continue;
      const stem = stemLite(word);
      if (known.has(stem) || seen.has(stem)) continue;
      seen.add(stem);
      const entry = recurrence.get(stem);
      if (entry) entry.hints += 1;
      else recurrence.set(stem, { word, hints: 1 });
    }
  }
  return [...recurrence.values()]
    .filter((e) => e.hints >= KEYWORD_MIN_RECURRENCE)
    .sort((a, b) => b.hints - a.hints || (a.word < b.word ? -1 : 1))
    .slice(0, KEYWORD_REFRESH_MAX)
    .map((e) => e.word);
}

/**
 * Spec §5.7's short-term pass over one snapshot, as store ops. Pure: the
 * same rows at the same instant give the same ops. Order matters and is
 * the spec's — low-confidence retirements before merges (a doomed hint is
 * not worth a survivor's provenance), merges before promotions (a
 * survivor's summed reinforcements may promote it), hints before nodes
 * (a node is judged on what it will hold).
 */
export function planConsolidation(snapshot: SubjectSnapshot, ctx: PassContext): ConsolidationPlan {
  const { policy } = ctx;
  const ops: StoreOp[] = [];
  let seq = 0;
  const audit = (action: string, fields: { hintId?: string; nodePath?: string; detail?: Record<string, JsonValue> }): void => {
    ops.push(systemAudit("consolidate", CONSOLIDATE_ACTOR, ctx, seq++, action, fields));
  };
  const patch = (hint: HintRecord, p: HintPatch): void => {
    ops.push({ op: "patchHint", hintId: hint.id, patch: p });
  };
  const hints = new Map<string, HintRecord>(snapshot.records.map((r) => [r.id, r]));
  const ledger = new NodeLedger(snapshot, hints.values());
  const plan: ConsolidationPlan = { ops, merged: 0, promoted: 0, retired: 0, folded: 0, nodesRetired: 0, keywordsRefreshed: 0, graphOps: 0 };

  // Fold supersession chains: every superseded row points at the chain's end.
  for (const record of snapshot.records) {
    if (record.status !== "superseded" || record.supersededBy === undefined) continue;
    let terminal = record.supersededBy;
    const visited = new Set<string>([record.id]);
    for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
      const next = hints.get(terminal);
      if (next === undefined || next.status !== "superseded" || next.supersededBy === undefined || visited.has(next.id)) break;
      visited.add(next.id);
      terminal = next.supersededBy;
    }
    if (terminal === record.supersededBy) continue;
    patch(record, { supersededBy: terminal });
    hints.set(record.id, { ...record, supersededBy: terminal });
    audit("hint.folded", { hintId: record.id, nodePath: record.nodePath, detail: { from: record.supersededBy, to: terminal } });
    plan.folded += 1;
  }

  // Retire inferred hints feedback has beaten below the floor (§6.1 item 4, swept).
  const floor = policy.feedback.retireConfidenceBelow;
  for (const record of snapshot.records) {
    if (record.status !== "active" || record.source !== "inferred" || record.approval === "approved" || !(record.confidence < floor)) continue;
    patch(record, { status: "retired", retiredReason: "feedback" });
    hints.set(record.id, { ...record, status: "retired", retiredReason: "feedback" });
    ledger.shift(record.nodePath, -1);
    audit("hint.retired", { hintId: record.id, nodePath: record.nodePath, detail: { reason: "feedback", confidence: record.confidence, below: floor } });
    plan.retired += 1;
  }

  // Merge duplicates on a node into the survivor's row.
  const byPath = new Map<string, HintRecord[]>();
  for (const record of hints.values()) {
    if (record.status !== "active") continue;
    const list = byPath.get(record.nodePath);
    if (list) list.push(record);
    else byPath.set(record.nodePath, [record]);
  }
  for (const [path, list] of byPath) {
    // Pairs in id order, each side read back from `hints` so a survivor's merged counters carry into its next comparison.
    const ids = list.map((h) => h.id).sort();
    const gone = new Set<string>();
    ids.forEach((idA, i) => {
      for (const idB of ids.slice(i + 1)) {
        const a = hints.get(idA);
        const b = hints.get(idB);
        if (a === undefined || b === undefined || gone.has(a.id) || gone.has(b.id) || !duplicates(a, b, policy)) continue;
        const [survivor, loser] = survivorOf(a, b);
        gone.add(loser.id);
        patch(loser, { status: "retired", retiredReason: "merged" });
        hints.set(loser.id, { ...loser, status: "retired", retiredReason: "merged" });
        audit("hint.retired", { hintId: loser.id, nodePath: path, detail: { reason: "merged", into: survivor.id, slot: loser.slot } });

        const maturity = MATURITIES[Math.max(MATURITY_RANK[survivor.maturity], MATURITY_RANK[loser.maturity])] ?? survivor.maturity;
        const merged: HintPatch = {
          confidence: Math.max(survivor.confidence, loser.confidence),
          priority: Math.max(survivor.priority, loser.priority),
          ...(loser.reinforcements > 0 ? { reinforcements: { add: loser.reinforcements } } : {}),
          ...(loser.applied > 0 ? { applied: { add: loser.applied } } : {}),
          ...(maturity !== survivor.maturity ? { maturity } : {}),
          ...(loser.needsReview && !survivor.needsReview ? { needsReview: true } : {}),
          lastReinforcedAt: later(survivor.lastReinforcedAt, loser.lastReinforcedAt),
          ...(loser.lastAppliedAt !== undefined ? { lastAppliedAt: later(survivor.lastAppliedAt ?? "", loser.lastAppliedAt) } : {}),
        };
        patch(survivor, merged);
        // Provenance is unioned one id per patch: the port appends a single id at a time.
        const eventIds = [...survivor.provenance.eventIds];
        const runIds = [...survivor.provenance.runIds];
        for (const id of loser.provenance.eventIds) {
          if (eventIds.includes(id)) continue;
          eventIds.push(id);
          patch(survivor, { provenance: { appendEventId: id } });
        }
        for (const id of loser.provenance.runIds) {
          if (runIds.includes(id)) continue;
          runIds.push(id);
          patch(survivor, { provenance: { appendRunId: id } });
        }
        const next: HintRecord = {
          ...survivor,
          confidence: merged.confidence ?? survivor.confidence,
          priority: merged.priority ?? survivor.priority,
          reinforcements: survivor.reinforcements + loser.reinforcements,
          applied: survivor.applied + loser.applied,
          maturity,
          needsReview: survivor.needsReview || loser.needsReview,
          lastReinforcedAt: merged.lastReinforcedAt ?? survivor.lastReinforcedAt,
          provenance: { ...survivor.provenance, eventIds, runIds },
        };
        hints.set(survivor.id, next);
        ledger.shift(path, -1);
        audit("hint.merged", { hintId: survivor.id, nodePath: path, detail: { merged: loser.id, slot: survivor.slot, reinforcements: next.reinforcements } });
        plan.merged += 1;
      }
    });
  }

  // Promote what the subject keeps using or has restated (§5.7, §6.2).
  for (const record of hints.values()) {
    if (record.status !== "active" || record.maturity !== "captured") continue;
    if (promotionDue(record, { now: ctx.now, policy }) !== "consolidated") continue;
    patch(record, { maturity: "consolidated" });
    hints.set(record.id, { ...record, maturity: "consolidated" });
    audit("hint.promoted", { hintId: record.id, nodePath: record.nodePath, detail: { from: "captured", to: "consolidated", applied: record.applied, reinforcements: record.reinforcements } });
    plan.promoted += 1;
  }

  // Teach nodes the words their hints keep using.
  const valuesByPath = new Map<string, string[]>();
  for (const record of hints.values()) {
    if (record.status !== "active") continue;
    const list = valuesByPath.get(record.nodePath);
    if (list) list.push(record.value);
    else valuesByPath.set(record.nodePath, [record.value]);
  }
  const seeds = new Map(snapshot.categories.map((c) => [c.path, new Set(c.keywords)]));
  for (const node of ledger.active()) {
    if (node.path === ROOT_PATH) continue;
    const added = recurringValueWords(node, valuesByPath.get(node.path) ?? []);
    if (added.length === 0) continue;
    const keywords = mergeKeywords(node.keywords, added, seeds.get(node.path) ?? new Set());
    if (keywords.length === node.keywords.length && keywords.every((k, i) => k === node.keywords[i])) continue;
    ops.push({ op: "patchNode", nodeId: node.id, patch: { keywords } });
    audit("node.keywords", { nodePath: node.path, detail: { added } });
    plan.keywordsRefreshed += 1;
  }

  // Retire nodes that have stood empty (§5.7).
  for (const path of gcNodes(ledger, hints.values(), ctx)) {
    const node = snapshot.nodesByPath.get(path);
    if (node === undefined) continue;
    ops.push({ op: "patchNode", nodeId: node.id, patch: { status: "retired" } });
    audit("node.retired", { nodePath: path, detail: { reason: "empty", lastTouched: lastTouched(node), nodeGcDays: policy.ingest.nodeGcDays } });
    plan.nodesRetired += 1;
  }

  ops.push(...ledger.statsOps());
  ops.push({ op: "consolidationCounter", action: "reset" });
  plan.graphOps = ops.filter((op) => op.op !== "audit" && op.op !== "consolidationCounter").length;
  return plan;
}

/** Paths whose active hints exceed `caps.maxActiveHintsPerNode` (§5.7's overflow trigger), from a snapshot's own rows. */
export function overCapPaths(snapshot: SubjectSnapshot, policy: PolicyConfig): string[] {
  const counts = new Map<string, number>();
  for (const record of snapshot.records) if (record.status === "active") counts.set(record.nodePath, (counts.get(record.nodePath) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > policy.caps.maxActiveHintsPerNode).map(([path]) => path);
}

// ── consolidate(): the pass as the engine runs it ────────────────────────────

export interface ConsolidateOptions {
  signal?: AbortSignal;
  /** Also run the model pass over over-cap and flagged nodes (default false: the rule pass alone, as when triggered by ingest). */
  llm?: boolean;
}

function emptyReport(subjectId: string): ConsolidationReport {
  return { subjectId, merged: 0, promoted: 0, retired: 0, opsAccepted: 0, opsRejected: 0, usedLlm: false };
}

/** A fresh compile of every row of the subject, bypassing the recall cache: a pass must see the store's truth, retired rows included. */
async function fullSnapshot(ctx: IngestContext, ref: SubjectRef, signal: AbortSignal | undefined): Promise<SubjectSnapshot> {
  const data = await ctx.store.loadSnapshot(ref, { statuses: [...ALL_STATUSES], ...(signal !== undefined ? { signal } : {}) });
  return compileSnapshot(data, ctx.policy, ctx.logger, { ref, categories: ctx.categories, clock: ctx.clock });
}

/** Plan against the store's version and apply under it; one conflict re-plans against a fresh load, a second propagates. */
async function rulePass(ctx: IngestContext, ref: SubjectRef, signal: AbortSignal | undefined): Promise<ConsolidationPlan | null> {
  let snapshot = await fullSnapshot(ctx, ref, signal);
  if (!snapshot.exists) return null;
  const pass = (): ConsolidationPlan => {
    const now = ctx.clock.now();
    return planConsolidation(snapshot, { ref, policy: ctx.policy, now, at: iso(now) });
  };
  let plan = pass();
  try {
    await ctx.store.applyBatch(ref, plan.ops, { expectVersion: snapshot.version, ...(signal !== undefined ? { signal } : {}) });
  } catch (e) {
    if (!(e instanceof VersionConflictError)) throw e;
    snapshot = await fullSnapshot(ctx, ref, signal);
    plan = pass();
    await ctx.store.applyBatch(ref, plan.ops, { expectVersion: snapshot.version, ...(signal !== undefined ? { signal } : {}) });
  }
  ctx.cache.invalidate(ref);
  return plan;
}

/**
 * Spec §2.7 `maintenance.consolidate` and §5.7's short-term pass: the rule
 * pass over the subject, then — only when asked — the model pass over the
 * nodes that are over cap or were flagged. The counter is reset by the rule
 * pass even when it found nothing to do: a pass ran. A subject with no rows
 * is left with none. Errors propagate to the caller; the ingest trigger
 * catches and logs them.
 */
export async function consolidate(ctx: IngestContext, subjectId: string, opts: ConsolidateOptions = {}): Promise<ConsolidationReport> {
  const ref: SubjectRef = { tenantId: ctx.tenantId, subjectId };
  const span = startSpan(ctx, "wisdom.consolidate", { "wisdom.subject_hash": fnv1a32Hex(subjectId) });
  const started = ctx.clock.now();
  const report = emptyReport(subjectId);
  try {
    const plan = await rulePass(ctx, ref, opts.signal);
    if (plan !== null) {
      // A subject with rows is one a nameless `maintain()` sweeps from now on; a name with no rows is not.
      ctx.subjects.add(subjectId);
      report.merged = plan.merged;
      report.promoted = plan.promoted;
      report.retired = plan.retired;
      report.opsAccepted = plan.graphOps;
    }
    if (opts.llm === true) {
      const outcome = await refine(ctx, ref, { ...(opts.signal !== undefined ? { signal: opts.signal } : {}) });
      // `merged` is what this call merged, whichever pass did it: the rule pass's duplicates and the model's merge ops.
      report.merged += outcome.merged;
      report.opsAccepted += outcome.opsAccepted;
      report.opsRejected += outcome.opsRejected;
      report.usedLlm = outcome.usedLlm;
    }
    const elapsedMs = ctx.clock.now() - started;
    safe(() => ctx.logger.info({ lib: "wisdom-graph", op: "consolidate", tenantId: ctx.tenantId, ...report, folded: plan?.folded ?? 0, nodesRetired: plan?.nodesRetired ?? 0, elapsedMs }, "consolidate.done"));
    safe(() => {
      span.setAttribute("wisdom.merged", report.merged);
      span.setAttribute("wisdom.promoted", report.promoted);
      span.setAttribute("wisdom.retired", report.retired);
      span.setAttribute("wisdom.ops_accepted", report.opsAccepted);
      span.setAttribute("wisdom.ops_rejected", report.opsRejected);
      span.setAttribute("wisdom.used_llm", report.usedLlm);
      span.setAttribute("wisdom.elapsed_ms", elapsedMs);
    });
    return report;
  } catch (e) {
    safe(() => span.recordException(e));
    throw e;
  } finally {
    safe(() => span.end());
  }
}

// ── refine(): the model pass through the ledger (§5.7, long-term) ────────────

export interface RefineOptions {
  signal?: AbortSignal;
  /** Nodes to review besides the over-cap and flagged ones. */
  paths?: readonly string[];
}

export interface RefineOutcome {
  /** True when the model was called at least once — a replayed row reuses its stored proposal and does not count. */
  usedLlm: boolean;
  /** Rows claimed and run. */
  events: number;
  opsAccepted: number;
  opsRejected: number;
  /** `merge_hints` and `merge_nodes` ops the organiser accepted. */
  merged: number;
  /** Paths whose row was already claimed at this instant or could not be scheduled. */
  skipped: string[];
}

function emptyOutcome(): RefineOutcome {
  return { usedLlm: false, events: 0, opsAccepted: 0, opsRejected: 0, merged: 0, skipped: [] };
}

/** Accepted merge ops of a finished row: those the proposal named, less those the organiser refused. */
function mergesOf(row: StoredEvent): number {
  const ops: readonly unknown[] = Array.isArray(row.proposal?.ops) ? row.proposal.ops : [];
  const isMerge = (name: unknown): boolean => name === "merge_hints" || name === "merge_nodes";
  const proposed = ops.filter((op) => isMerge(typeof op === "object" && op !== null ? (op as { op?: unknown }).op : undefined)).length;
  const refused = (row.result?.rejected ?? []).filter((r) => isMerge(r.op)).length;
  return Math.max(0, proposed - refused);
}

/** One row through the ledger: the queue's lane when there is one, a single attempt inline, and `null` when it could not be scheduled. */
async function runRow(ctx: IngestContext, ref: SubjectRef, eventId: string): Promise<boolean> {
  let local = 0;
  const attempt = async () => {
    local += 1;
    return processEvent(ctx, { eventId, subjectId: ref.subjectId, extract: "auto", local });
  };
  if (ctx.retry.inline) {
    if (ctx.queue.isClosed) return false;
    await attempt();
    return true;
  }
  const enqueued = ctx.queue.enqueue(cacheKey(ref), attempt);
  if (!enqueued.accepted) {
    safe(() => ctx.logger.warn({ lib: "wisdom-graph", op: "consolidate", tenantId: ctx.tenantId, subjectId: ref.subjectId, eventId, reason: enqueued.reason }, "consolidate.unscheduled"));
    return false;
  }
  await enqueued.outcome;
  return true;
}

/**
 * Spec §5.7's long-term pass. For every node over cap or flagged (plus any
 * the caller names), one `kind: "consolidate"` row is claimed and run
 * through the ledger — leased, planned, applied, retried on the backoff
 * schedule — and its result read back from the row. The row id derives
 * from the node and the instant, so two passes at one instant claim one
 * row and the second finds it a duplicate. Nothing happens without an
 * `LlmPort` and the seam. Must not be called from inside a queue job of
 * the same subject: the row would wait for the job that waits for it.
 */
export async function refine(ctx: IngestContext, ref: SubjectRef, opts: RefineOptions = {}): Promise<RefineOutcome> {
  const outcome = emptyOutcome();
  if (ctx.llm === undefined || ctx.consolidation === undefined) return outcome;
  const lookup = ctx.cache.lookup(ref);
  const snapshot = lookup.state === "hit" ? lookup.snapshot : await ctx.cache.load(ref, snapshotLoader(ctx, ref));
  const flagged = takeFlagged(ctx, ref);
  const wanted = [...overCapPaths(snapshot, ctx.policy), ...flagged, ...(opts.paths ?? [])];
  const paths = [...new Set(wanted)].filter((path) => snapshot.nodesByPath.get(path)?.status === "active");
  if (paths.length === 0) return outcome;
  const log = { lib: "wisdom-graph", op: "consolidate", tenantId: ctx.tenantId, subjectId: ref.subjectId };
  const callsBefore = ctx.stats.llmCalls;
  // A flag is a promise to look at the node. One this pass could not keep —
  // the signal aborted, the queue refused the row, the store failed — goes
  // back for the next pass. A duplicate claim is kept by the ledger instead:
  // another engine holds the row for this very instant and its retries see
  // it through. A flag for a node that is gone was dropped above.
  const owed = new Set(flagged.filter((path) => paths.includes(path)));

  try {
    for (const nodePath of paths) {
      if (opts.signal?.aborted) {
        outcome.skipped.push(nodePath);
        continue;
      }
      const now = ctx.clock.now();
      const event: ConsolidateEvent = { type: "consolidate", id: deterministicId("c", ctx.tenantId, ref.subjectId, nodePath, now), subjectId: ref.subjectId, nodePath, at: iso(now) };
      const claim = await ctx.store.claimEvent(ctx.tenantId, event);
      if (claim === "duplicate") {
        debug(ctx, { ...log, eventId: event.id, nodePath }, "consolidate.duplicate");
        outcome.skipped.push(nodePath);
        owed.delete(nodePath);
        continue;
      }
      ctx.stats.ingested += 1;
      const ran = await runRow(ctx, ref, event.id);
      if (!ran) {
        outcome.skipped.push(nodePath);
        continue;
      }
      owed.delete(nodePath);
      outcome.events += 1;
      const row = await ctx.store.getEvent(ctx.tenantId, event.id);
      if (row?.status !== "done" || row.result === undefined) continue;
      outcome.opsAccepted += row.result.accepted;
      outcome.opsRejected += row.result.rejected.length;
      outcome.merged += mergesOf(row);
    }
  } finally {
    flagOverflow(ctx, ref, [...owed]);
  }
  outcome.usedLlm = ctx.stats.llmCalls > callsBefore;
  return outcome;
}

// ── The planner behind a consolidate row ─────────────────────────────────────

/** An `LlmPort` that counts what it forwards, so the row's `llmCalls` counts calls, not passes. */
function counting(llm: LlmPort): { llm: LlmPort; calls: () => number } {
  let calls = 0;
  return {
    llm: {
      complete: (prompt, opts) => {
        calls += 1;
        return llm.complete(prompt, opts);
      },
    },
    calls: () => calls,
  };
}

/**
 * The `consolidate@1` call: one attempt and one retry with the problem
 * echoed, exactly as extraction (§5.5 "Parsing"), over the node's outline
 * and the full op set. Resolves the proposal as written or `null` when
 * neither reply was one; rejects when the model itself fails.
 */
export async function runConsolidation(
  llm: LlmPort,
  snapshot: SubjectSnapshot,
  nodePath: string,
  ctx: { policy: PolicyConfig; clock: IngestContext["clock"]; signal?: AbortSignal; logger: IngestContext["logger"]; tokenizer?: IngestContext["tokenizer"]; tenantId: string | null; eventId: string },
): Promise<Proposal | null> {
  const prompt = buildConsolidationPrompt({
    snapshot,
    policy: ctx.policy,
    nodePath,
    agents: agentVocabulary(snapshot),
    ...(ctx.tokenizer !== undefined ? { tokenizer: ctx.tokenizer } : {}),
  });
  const log = { lib: "wisdom-graph", op: "consolidate", tenantId: ctx.tenantId, subjectId: snapshot.ref.subjectId, eventId: ctx.eventId, nodePath };
  const callCtx = { policy: ctx.policy, clock: ctx.clock, logger: ctx.logger, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}), ...(ctx.tokenizer !== undefined ? { tokenizer: ctx.tokenizer } : {}) };
  let attemptPrompt = prompt;
  for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt += 1) {
    const text = await complete(llm, attemptPrompt, callCtx, "consolidate", log, CONSOLIDATION_MAX_TOKENS);
    const parsed = extractJson(text);
    const envelope: Envelope = parsed.ok ? proposalEnvelope(parsed.value) : parsed;
    if (envelope.ok) return envelope.value;
    safe(() => (ctx.logger.debug ?? ctx.logger.info).call(ctx.logger, { ...log, attempt, problems: [envelope.reason] }, "llm.invalid-proposal"));
    attemptPrompt = retryPrompt(prompt, [envelope.reason]);
  }
  return null;
}

/** What the organiser needs for a consolidate row: purpose, version, actor, and the subject's approval rules. */
export function consolidationOrganiserContext(ctx: IngestContext, ref: SubjectRef, eventId: string, at: string): OrganiserContext {
  return {
    ref,
    policy: ctx.policy,
    purpose: "consolidate",
    eventId,
    at,
    // The model wrote it, so its new statements rank as inferred (§5.5); merges keep their inputs' sources.
    source: "inferred",
    clientId: null,
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    actor: CONSOLIDATE_LLM_ACTOR,
    ...(ctx.requireApproval !== undefined ? { requireApproval: ctx.requireApproval } : {}),
    shared: ctx.sharedSubjectId !== null && ctx.sharedSubjectId === ref.subjectId,
    event: null,
  };
}

/**
 * The seam the ledger calls for a `consolidate` row: reuse the row's
 * proposal or call the model, gate the ops through the organiser, and
 * answer with store ops and counts — the extraction seam's contract, over
 * the consolidation prompt. A node that is no longer active (merged or
 * retired since the row was claimed) yields an empty proposal, stored so a
 * replay makes no call either.
 */
export const planConsolidateEvent: ConsolidationPlanner = async (ctx, input) => {
  const { ref, event, snapshot } = input;
  const at = event.at ?? iso(ctx.clock.now());
  const empty = (proposal: Proposal | null, usedLlm: boolean, llmCalls: number): ExtractionResult => ({ ops: [], accepted: 0, rejected: [], proposal, usedLlm, llmCalls });
  const llm = ctx.llm;
  if (llm === undefined) return empty(input.storedProposal, false, 0);
  const log = { lib: "wisdom-graph", op: "consolidate", tenantId: ctx.tenantId, subjectId: ref.subjectId, eventId: event.id, nodePath: event.nodePath };

  const node = snapshot.nodesByPath.get(event.nodePath);
  if (node === undefined || node.status !== "active") {
    debug(ctx, log, "consolidate.node-gone");
    return empty(input.storedProposal ?? { ops: [], notes: `node ${event.nodePath} is not active` }, false, 0);
  }

  let proposal = input.storedProposal;
  let usedLlm = false;
  let llmCalls = 0;
  if (proposal === null) {
    usedLlm = true;
    const counted = counting(llm);
    try {
      proposal = await runConsolidation(counted.llm, snapshot, event.nodePath, {
        policy: ctx.policy,
        clock: ctx.clock,
        signal: input.signal,
        logger: ctx.logger,
        ...(ctx.tokenizer !== undefined ? { tokenizer: ctx.tokenizer } : {}),
        tenantId: ctx.tenantId,
        eventId: event.id,
      });
    } catch (e) {
      ctx.stats.llmCalls += counted.calls();
      throw e;
    }
    llmCalls = counted.calls();
  }

  if (proposal === null || isUnparseableProposal(proposal)) {
    safe(() => ctx.logger.warn({ ...log, op: UNPARSEABLE.op, reason: UNPARSEABLE.reason, index: -1 }, "proposal.rejected"));
    const ops = usedLlm
      ? [eventAudit(ref, { eventId: event.id, seq: "unparseable", at, actor: CONSOLIDATE_LLM_ACTOR, action: "op.rejected", detail: { op: UNPARSEABLE.op, reason: UNPARSEABLE.reason, attempts: EXTRACTION_ATTEMPTS } })]
      : [];
    return { ops, accepted: 0, rejected: [{ ...UNPARSEABLE }], proposal: proposal ?? unparseableProposal(), usedLlm, llmCalls };
  }

  const extraRecords = await fetchExtraRecords(ctx.store, ref, snapshot, referencedHintIds(proposal, ref, event.id));
  const result = validateProposal(proposal, snapshot, { ...consolidationOrganiserContext(ctx, ref, event.id, at), extraRecords });
  for (const r of result.rejected) {
    safe(() => ctx.logger.warn({ ...log, op: r.op, reason: r.reason, index: r.index, ...(r.detail !== undefined ? { detail: r.detail } : {}) }, "proposal.rejected"));
  }
  for (const r of result.rewrites) {
    debug(ctx, { ...log, index: r.index, from: r.from, to: r.to, reason: r.reason, ...(r.target !== undefined ? { target: r.target } : {}) }, "proposal.rewritten");
  }
  return {
    ops: result.accepted,
    accepted: result.acceptedCount,
    rejected: result.rejected.map((r) => ({ op: r.op, reason: r.reason })),
    proposal,
    usedLlm,
    llmCalls,
    needsConsolidation: result.needsConsolidation,
  };
};

/** What the engine wires into `IngestContext.consolidation`: the row planner and the rule pass as the ingest trigger runs it. */
export const consolidationHooks: ConsolidationHooks = Object.freeze({
  plan: planConsolidateEvent,
  // Rule pass only: this runs inside the subject's queue job, and the model pass would wait on that very lane.
  due: (ctx: IngestContext, ref: SubjectRef) => consolidate(ctx, ref.subjectId, { llm: false }),
});
