/**
 * recall/explain.ts — "what does the assistant know about me", and why it said so.
 *
 * Spec §10.3. `explain()` is the governance surface the consumer's caveat
 * asks for ("expose explain() so an advisor can see and delete what's
 * stored"), so it is built for a human reader rather than a prompt: the
 * whole tree with every node's live hints, the pending and retired ones
 * set apart, the recent ledger and audit rows, and — when a question is
 * given — a dry-run recall that shows exactly what would render and what
 * happened to every candidate that did not.
 *
 * It reads the store directly (`statuses: all`, bypassing the cache),
 * because a viewer wants the truth as of now, not as of the last recall,
 * and because superseded and retired rows are never in a recall snapshot.
 * The dry run, though, must equal a real recall on the same rows: it goes
 * through the same `classifyRequest` / `assembleRecall` / `buildRecall` the
 * pipeline uses, on a snapshot whose extra statuses the candidate gate
 * ignores, so a mismatch between the two would be a bug, not a design.
 *
 * `why` is a sentence of facts separated by `·` — source, scope, approval,
 * lifecycle, counts, decay, and who suppressed it — in a fixed order, so a
 * viewer scanning a hundred hints reads the same shape every time. The
 * suppression it names is the recall-time conflict pass run over the
 * subject's live hints at relevance 1: the ordering a query would see,
 * before relevance and caps decide what fits.
 */

import type { SubjectRef } from "../ports";
import type { ConflictRule, ExplainNode, Explanation, Hint, HintExplanation, HintRecord, RecallTrace } from "../types";
import { HINT_STATUSES } from "../schema/hint";
import { ROOT_PATH } from "../graph/paths";
import { compileSnapshot, toHint, type SnapshotNode, type SubjectSnapshot } from "../graph/snapshot";
import { decayWeight, effectiveScore } from "../policy/decay";
import { resolveConflicts } from "../policy/conflict";
import {
  SHARED_TTL_FACTOR,
  assembleRecall,
  buildRecall,
  classifyRequest,
  normaliseRequest,
  sharedRef,
  snapshotLoader,
  type RecallContext,
} from "./recall";

export interface ExplainOptions {
  clientId?: string | null;
  /** When given, a dry-run recall of this question is attached as `trace`. */
  text?: string;
  includeRetired?: boolean;
  /** Restrict `tree` to this node and its descendants. */
  topicPath?: string;
}

/** Ledger rows shown (§10.3). */
export const RECENT_EVENTS = 20;
/** Audit rows shown (§10.3). */
export const RECENT_AUDIT = 50;

type Suppression = { hintId: string; rule: ConflictRule };

function scopeOf(record: HintRecord): string {
  switch (record.scope) {
    case "global":
      return "global";
    case "category":
      return `category-scoped (${record.nodePath})`;
    case "agent":
      return `agent-scoped (${record.agent ?? "?"})`;
    case "client":
      return `client-scoped (${record.clientId ?? "?"})`;
  }
}

function approvalOf(record: HintRecord): string {
  const approval = record.provenance.approval;
  switch (record.approval) {
    case "approved":
      return approval === undefined ? "approved" : `approved by ${approval.by} on ${approval.at.slice(0, 10)}`;
    case "rejected":
      return approval === undefined ? "rejected" : `rejected by ${approval.by} on ${approval.at.slice(0, 10)}`;
    case "auto":
      return "auto";
  }
}

function lifecycleOf(record: HintRecord): string | undefined {
  switch (record.status) {
    case "active":
      return undefined;
    case "pending":
      return record.supersedes === undefined ? "pending" : `pending (challenges ${record.supersedes})`;
    case "superseded":
      return record.supersededBy === undefined ? "superseded" : `superseded by ${record.supersededBy}`;
    case "retired":
      return record.retiredReason === undefined ? "retired" : `retired (${record.retiredReason})`;
  }
}

/** The `why` string of §10.3, in a fixed order. */
export function whyOf(record: HintRecord, decay: number, suppressedBy: Suppression | null): string {
  const parts: string[] = [record.source, scopeOf(record), approvalOf(record)];
  const lifecycle = lifecycleOf(record);
  if (lifecycle !== undefined) parts.push(lifecycle);
  if (record.needsReview) parts.push("needs review");
  if (record.reinforcements > 0) parts.push(`reinforced ${record.reinforcements}×`);
  if (record.applied > 0) parts.push(`applied ${record.applied}×`);
  parts.push(`decay ${decay.toFixed(2)}`);
  if (suppressedBy !== null) parts.push(`suppressed by ${suppressedBy.hintId} (${suppressedBy.rule})`);
  return parts.join(" · ");
}

/**
 * Who beats whom among the subject's live hints, at relevance 1. Client
 * hints take part only for the client being explained: two clients'
 * preferences never render together, so they never conflict.
 */
export function suppressions(snapshot: SubjectSnapshot, ctx: RecallContext, now: number, clientId: string | null): Map<string, Suppression> {
  const hints: Hint[] = [];
  for (const record of snapshot.records) {
    if (record.status !== "active") continue;
    if (record.scope === "client" && (clientId === null || record.clientId !== clientId)) continue;
    const hint = toHint(record);
    if (hint !== null) hints.push(hint);
  }
  const { suppressed } = resolveConflicts(hints, ctx.policy, now);
  return new Map(suppressed.map((s) => [s.hintId, { hintId: s.by, rule: s.rule }]));
}

function explainHint(record: HintRecord, ctx: RecallContext, now: number, suppressed: ReadonlyMap<string, Suppression>): HintExplanation {
  const scoring = { now, policy: ctx.policy };
  const decay = decayWeight(record, scoring);
  const suppressedBy = suppressed.get(record.id) ?? null;
  return {
    hint: record,
    effectiveScore: effectiveScore(record, { ...scoring, relevance: 1 }),
    decayWeight: decay,
    suppressedBy,
    why: whyOf(record, decay, suppressedBy),
  };
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The active nodes as a tree from `root`, each with its live hints, children in path order. */
function buildTree(root: SnapshotNode, snapshot: SubjectSnapshot, hintsByPath: ReadonlyMap<string, HintExplanation[]>): ExplainNode {
  const children = snapshot.nodes.filter((n) => n.status === "active" && n.parentPath === root.path).sort(byPath);
  const { virtual, ...node } = root;
  void virtual;
  return {
    node,
    hints: hintsByPath.get(root.path) ?? [],
    children: children.map((child) => buildTree(child, snapshot, hintsByPath)),
  };
}

async function dryRun(ctx: RecallContext, snapshot: SubjectSnapshot, ref: SubjectRef, text: string, clientId: string | null, now: number): Promise<RecallTrace> {
  const req = normaliseRequest({ subjectId: ref.subjectId, clientId, text, budgetMs: 0 }, `explain:${ref.subjectId}`);
  const shared = sharedRef(ctx, ref.subjectId);
  let sharedSnapshot: SubjectSnapshot | null = null;
  if (shared !== null) {
    const lookup = ctx.cache.lookup(shared);
    sharedSnapshot =
      lookup.state === "miss"
        ? await ctx.cache.load(shared, snapshotLoader(ctx, shared), { ttlMs: ctx.cache.ttlMs * SHARED_TTL_FACTOR })
        : lookup.snapshot;
  }
  const { topic } = classifyRequest(ctx, snapshot, req, ref);
  const assembly = assembleRecall(ctx, { snapshot, shared: sharedSnapshot, req, topic, now });
  const recall = buildRecall(assembly, topic, {
    requestId: req.requestId,
    status: "ok",
    elapsedMs: 0,
    cache: "none",
    classifier: topic.method,
    refined: false,
  });
  return { topic, candidates: assembly.trace, recall };
}

/**
 * Spec §10.3. Reads the whole subject (every hint status) straight from the
 * store, never the LLM. Rejects only when the store does.
 */
export async function explain(ctx: RecallContext, subjectId: string, opts: ExplainOptions = {}): Promise<Explanation> {
  const ref: SubjectRef = { tenantId: ctx.tenantId, subjectId };
  const clientId = typeof opts.clientId === "string" ? opts.clientId : null;
  const data = await ctx.store.loadSnapshot(ref, { statuses: [...HINT_STATUSES] });
  const snapshot = compileSnapshot(data, ctx.policy, ctx.logger, { ref, categories: ctx.categories, clock: ctx.clock });
  const now = ctx.clock.now();

  const suppressed = suppressions(snapshot, ctx, now, clientId);
  const live = new Map<string, HintExplanation[]>();
  const pendingApproval: HintExplanation[] = [];
  const retired: HintExplanation[] = [];
  const slots = new Set<string>();
  let activeHints = 0;
  for (const record of snapshot.records) {
    const explanation = explainHint(record, ctx, now, suppressed);
    switch (record.status) {
      case "active": {
        activeHints += 1;
        slots.add(record.slot);
        const list = live.get(record.nodePath);
        if (list) list.push(explanation);
        else live.set(record.nodePath, [explanation]);
        break;
      }
      case "pending":
        pendingApproval.push(explanation);
        break;
      case "superseded":
      case "retired":
        retired.push(explanation);
        break;
    }
  }
  for (const list of live.values()) list.sort((a, b) => b.effectiveScore - a.effectiveScore || (a.hint.id < b.hint.id ? -1 : 1));

  const rootPath = opts.topicPath ?? ROOT_PATH;
  const root = snapshot.nodesByPath.get(rootPath);
  const tree = root !== undefined && root.status === "active" ? [buildTree(root, snapshot, live)] : [];

  const [events, audit] = await Promise.all([
    ctx.store.listEvents(ref, { limit: RECENT_EVENTS }),
    ctx.store.listAudit(ref, RECENT_AUDIT),
  ]);
  const recentEvents: Explanation["recentEvents"] = events.map((row) => ({
    id: row.event.id,
    kind: row.event.type,
    ...(row.event.type !== "consolidate" ? { runId: row.event.runId } : {}),
    at: row.event.at ?? row.createdAt,
    status: row.status,
    ...(row.result !== undefined ? { accepted: row.result.accepted, rejected: row.result.rejected.length } : {}),
    ...(row.scrubbedAt !== undefined ? { scrubbedAt: row.scrubbedAt } : {}),
  }));

  const trace = typeof opts.text === "string" ? await dryRun(ctx, snapshot, ref, opts.text, clientId, now) : undefined;

  return {
    subjectId,
    tenantId: ctx.tenantId,
    generatedAt: new Date(now).toISOString(),
    tree,
    pendingApproval,
    retired: opts.includeRetired === true ? retired : [],
    recentEvents,
    audit,
    ...(trace !== undefined ? { trace } : {}),
    stats: {
      // Stored nodes only: the root and category overlay (§3.1) is configuration, not what the subject knows.
      nodes: snapshot.nodes.filter((n) => n.status === "active" && !n.virtual).length,
      activeHints,
      pending: pendingApproval.length,
      retired: retired.length,
      slots: [...slots].sort(),
    },
  };
}
