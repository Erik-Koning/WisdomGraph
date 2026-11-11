/**
 * ingest/maintain.ts — the long-term timescale: what time alone does to a
 * subject's graph, run from a cron.
 *
 * Spec §5.7 and §6.2. The library owns no timers, so everything that
 * depends on *elapsed* time rather than on an event — a hint fading below
 * the retirement floor, a consolidated hint earning `established`, a node
 * standing empty for a month, text ageing past its retention — happens
 * here, when the host calls `maintenance.maintain()`. Decay itself is
 * never stored: the weight is a pure function of `lastReinforcedAt` and
 * the clock (`policy/decay.ts`), and recall computes it per query. What
 * this pass materialises is the *consequence* — the retirement — so that
 * a faded hint stops being loaded at all instead of being scored to
 * nothing on every turn.
 *
 * Three choices shape the pass:
 *
 *   - **The port cannot enumerate subjects.** `StorePort` (§7.1) has no
 *     "list subjects", so a run without a `subjectId` sweeps the subjects
 *     this engine has written for since it started plus the shared
 *     subject. A cron that wants every subject names each one; the
 *     tenant-wide audit purge runs regardless.
 *   - **Re-embedding remembers what it embedded.** Nothing on a node
 *     records when its vector was computed, so the pass keeps, per
 *     process, a hash of the text each node was last embedded from and
 *     re-embeds a node whose text no longer matches — or whose vector is
 *     missing or of the wrong dimension. The first run in a process embeds
 *     every active node once; each run after that touches only what
 *     changed. A stale vector after a restart is refreshed on that first
 *     run rather than trusted. The cost falls on a process that lives for
 *     one run — a serverless daily cron pays one full embed of every swept
 *     subject per run — and a cheaper check is not available without the
 *     node row recording when its vector was written, which the port does
 *     not carry; a host that minds the cost keeps the engine alive between
 *     runs or names the subjects that changed.
 *   - **Retention scrubs, it does not delete, events.** §10.4: the text of
 *     an event older than `eventRetentionDays` is blanked and the row kept
 *     as the idempotency tombstone `claimEvent` needs; audit rows older
 *     than `auditRetentionDays` are deleted. The report counts scrubbed
 *     events under `purgedEvents`.
 *
 * Then, when a model is available, the long-term consolidation pass runs
 * over the nodes that are over cap or were flagged (`consolidate.ts:
 * refine`). Audit rows are stamped `system:decay`.
 */

import { fnv1a32Hex } from "../ids";
import { VersionConflictError, type HintPatch, type SpanLike, type StoreOp, type SubjectRef } from "../ports";
import type { HintRecord, HintStatus, JsonValue, MaintenanceReport, TopicNode } from "../types";
import { ROOT_PATH } from "../graph/paths";
import { compileSnapshot, type SubjectSnapshot } from "../graph/snapshot";
import { decayWeight, promotionDue, retirementDue } from "../policy/decay";
import { cacheKey, describeError } from "../recall/cache";
import type { IngestContext } from "./ingest";
import { NodeLedger, gcNodes, refine, systemAudit, type PassContext } from "./consolidate";

/** The actor on this pass's audit rows (§10.4). */
export const MAINTAIN_ACTOR = "system:decay";
/** What the sweep loads: only live rows mature, decay or hold a node open. */
export const LIVE_STATUSES: readonly HintStatus[] = ["active", "pending"];
const DAY_MS = 86_400_000;

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

/** A retention window in days, or `null` when the policy keeps everything (or is nonsense). */
function retentionDays(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

// ── The sweep, as a plan ─────────────────────────────────────────────────────

export interface MaintenancePlan {
  ops: StoreOp[];
  /** Active hints judged. */
  examined: number;
  /** `consolidated → established`. */
  promoted: number;
  /** Retired for decay or contradictions. */
  retired: number;
  /** Explicit or approved hints newly flagged for review at the contradiction threshold. */
  flagged: number;
  nodesRetired: number;
  /** Active nodes once the plan applies: what re-embedding considers. */
  nodes: TopicNode[];
}

/**
 * Spec §6.2 over one snapshot, as store ops. Pure. Each active hint meets
 * one verdict, in this order: retirement for decay (never an approved
 * hint — its half-life is null), the contradiction threshold (§6.1 item 3,
 * swept for rows the write path did not see cross it), then promotion.
 * Nodes are judged after hints, on what they will hold.
 */
export function planMaintenance(snapshot: SubjectSnapshot, ctx: PassContext): MaintenancePlan {
  const { policy, now } = ctx;
  const ops: StoreOp[] = [];
  let seq = 0;
  const audit = (action: string, fields: { hintId?: string; nodePath?: string; detail?: Record<string, JsonValue> }): void => {
    ops.push(systemAudit("maintain", MAINTAIN_ACTOR, ctx, seq++, action, fields));
  };
  const patch = (hint: HintRecord, p: HintPatch): void => {
    ops.push({ op: "patchHint", hintId: hint.id, patch: p });
  };
  const hints = new Map<string, HintRecord>(snapshot.records.map((r) => [r.id, r]));
  const ledger = new NodeLedger(snapshot, hints.values());
  const plan: MaintenancePlan = { ops, examined: 0, promoted: 0, retired: 0, flagged: 0, nodesRetired: 0, nodes: [] };

  for (const record of snapshot.records) {
    if (record.status !== "active") continue;
    plan.examined += 1;
    if (retirementDue(record, { now, policy })) {
      patch(record, { status: "retired", retiredReason: "decayed" });
      hints.set(record.id, { ...record, status: "retired", retiredReason: "decayed" });
      ledger.shift(record.nodePath, -1);
      audit("hint.retired", {
        hintId: record.id,
        nodePath: record.nodePath,
        detail: { reason: "decayed", decayWeight: decayWeight(record, { now, policy }), lastReinforcedAt: record.lastReinforcedAt, ...(record.lastAppliedAt !== undefined ? { lastAppliedAt: record.lastAppliedAt } : {}) },
      });
      plan.retired += 1;
      continue;
    }
    if (record.contradictions >= policy.decay.contradictionsToRetire) {
      if (record.source === "inferred" && record.approval !== "approved") {
        patch(record, { status: "retired", retiredReason: "contradicted" });
        hints.set(record.id, { ...record, status: "retired", retiredReason: "contradicted" });
        ledger.shift(record.nodePath, -1);
        audit("hint.retired", { hintId: record.id, nodePath: record.nodePath, detail: { reason: "contradicted", contradictions: record.contradictions } });
        plan.retired += 1;
      } else if (!record.needsReview) {
        patch(record, { needsReview: true });
        hints.set(record.id, { ...record, needsReview: true });
        audit("hint.needs-review", { hintId: record.id, nodePath: record.nodePath, detail: { reason: "contradictions", contradictions: record.contradictions } });
        plan.flagged += 1;
      }
      continue;
    }
    if (record.maturity === "consolidated" && promotionDue(record, { now, policy }) === "established") {
      patch(record, { maturity: "established" });
      hints.set(record.id, { ...record, maturity: "established" });
      audit("hint.promoted", { hintId: record.id, nodePath: record.nodePath, detail: { from: "consolidated", to: "established", reinforcements: record.reinforcements, applied: record.applied } });
      plan.promoted += 1;
    }
  }

  for (const path of gcNodes(ledger, hints.values(), ctx)) {
    const node = snapshot.nodesByPath.get(path);
    if (node === undefined) continue;
    ops.push({ op: "patchNode", nodeId: node.id, patch: { status: "retired" } });
    audit("node.retired", { nodePath: path, detail: { reason: "empty", nodeGcDays: policy.ingest.nodeGcDays } });
    plan.nodesRetired += 1;
  }

  ops.push(...ledger.statsOps());
  plan.nodes = ledger.active();
  return plan;
}

// ── Re-embedding ─────────────────────────────────────────────────────────────

/** What a node's vector is computed from: the fields the classifier's keyword index also reads. */
export function embedText(node: Pick<TopicNode, "title" | "description" | "keywords">): string {
  return [node.title, node.description, node.keywords.join(", ")].filter((part) => part.length > 0).join(". ");
}

/**
 * Embed the active nodes whose vector is missing, of the wrong dimension,
 * or computed from text that has since changed (see the header), in one
 * call, and write the vectors without a version check — nothing else
 * writes `embedding`, so the patch is safe against any concurrent batch.
 * A vector the port returns malformed is skipped, not stored.
 */
export async function reembed(ctx: IngestContext, ref: SubjectRef, nodes: readonly TopicNode[], signal: AbortSignal | undefined): Promise<number> {
  const port = ctx.embeddings;
  if (port === undefined) return 0;
  const key = cacheKey(ref);
  const remembered = ctx.embedded.get(key) ?? new Map<string, string>();
  const stale: { node: TopicNode; text: string; hash: string }[] = [];
  for (const node of nodes) {
    if (node.path === ROOT_PATH || node.status !== "active") continue;
    const text = embedText(node);
    const hash = fnv1a32Hex(text);
    const vector = node.embedding;
    const missing = vector === undefined || vector.length === 0 || (port.dimensions !== undefined && vector.length !== port.dimensions);
    if (!missing && remembered.get(node.id) === hash) continue;
    stale.push({ node, text, hash });
  }
  if (stale.length === 0) return 0;
  const vectors = await port.embed(
    stale.map((s) => s.text),
    signal !== undefined ? { signal } : {},
  );
  const ops: StoreOp[] = [];
  const done: { id: string; hash: string }[] = [];
  stale.forEach((s, i) => {
    const vector = vectors[i];
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((x) => typeof x === "number" && Number.isFinite(x))) return;
    ops.push({ op: "patchNode", nodeId: s.node.id, patch: { embedding: [...vector] } });
    done.push({ id: s.node.id, hash: s.hash });
  });
  if (ops.length === 0) return 0;
  await ctx.store.applyBatch(ref, ops);
  for (const d of done) remembered.set(d.id, d.hash);
  ctx.embedded.set(key, remembered);
  ctx.cache.invalidate(ref);
  return ops.length;
}

// ── maintain() ───────────────────────────────────────────────────────────────

export interface MaintainOptions {
  subjectId?: string;
  signal?: AbortSignal;
}

async function liveSnapshot(ctx: IngestContext, ref: SubjectRef, signal: AbortSignal | undefined): Promise<SubjectSnapshot> {
  const data = await ctx.store.loadSnapshot(ref, { statuses: [...LIVE_STATUSES], ...(signal !== undefined ? { signal } : {}) });
  return compileSnapshot(data, ctx.policy, ctx.logger, { ref, categories: ctx.categories, clock: ctx.clock });
}

/** Plan and apply under the store's version; one conflict re-plans against a fresh load. `null` when the subject has no rows. */
async function sweep(ctx: IngestContext, ref: SubjectRef, signal: AbortSignal | undefined): Promise<MaintenancePlan | null> {
  let snapshot = await liveSnapshot(ctx, ref, signal);
  if (!snapshot.exists) return null;
  const pass = (): MaintenancePlan => {
    const now = ctx.clock.now();
    return planMaintenance(snapshot, { ref, policy: ctx.policy, now, at: iso(now) });
  };
  let plan = pass();
  const write = async (): Promise<void> => {
    if (plan.ops.length === 0) return;
    await ctx.store.applyBatch(ref, plan.ops, { expectVersion: snapshot.version, ...(signal !== undefined ? { signal } : {}) });
  };
  try {
    await write();
  } catch (e) {
    if (!(e instanceof VersionConflictError)) throw e;
    snapshot = await liveSnapshot(ctx, ref, signal);
    plan = pass();
    await write();
  }
  if (plan.ops.length > 0) ctx.cache.invalidate(ref);
  return plan;
}

/** Subjects a run without a name sweeps: what this engine has written for, and the shared subject. */
function sweepList(ctx: IngestContext): string[] {
  const out = new Set<string>(ctx.subjects);
  if (ctx.sharedSubjectId !== null) out.add(ctx.sharedSubjectId);
  return [...out];
}

/**
 * Spec §2.7 `maintenance.maintain`: per subject, the §6.2 sweep, node GC,
 * re-embedding, the event scrub, and the model pass; then the tenant-wide
 * audit purge. Reports what was done — an abort stops between subjects and
 * the report covers what finished. Store errors propagate: a cron should
 * see its run fail.
 */
export async function maintain(ctx: IngestContext, opts: MaintainOptions = {}): Promise<MaintenanceReport> {
  const started = ctx.clock.now();
  const span = startSpan(ctx, "wisdom.maintain", opts.subjectId !== undefined ? { "wisdom.subject_hash": fnv1a32Hex(opts.subjectId) } : {});
  const report: MaintenanceReport = {
    ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    examined: 0,
    promoted: 0,
    retired: 0,
    merged: 0,
    nodesRetired: 0,
    reembedded: 0,
    purgedEvents: 0,
    purgedAudit: 0,
    elapsedMs: 0,
  };
  const log = { lib: "wisdom-graph", op: "maintain", tenantId: ctx.tenantId };
  let flagged = 0;
  try {
    const subjects = opts.subjectId !== undefined ? [opts.subjectId] : sweepList(ctx);
    for (const subjectId of subjects) {
      if (opts.signal?.aborted) break;
      const ref: SubjectRef = { tenantId: ctx.tenantId, subjectId };
      ctx.subjects.add(subjectId);
      const plan = await sweep(ctx, ref, opts.signal);
      if (plan === null) continue;
      report.examined += plan.examined;
      report.promoted += plan.promoted;
      report.retired += plan.retired;
      report.nodesRetired += plan.nodesRetired;
      flagged += plan.flagged;
      report.reembedded += await reembed(ctx, ref, plan.nodes, opts.signal);
      const eventDays = retentionDays(ctx.policy.retention.eventRetentionDays);
      if (eventDays !== null) report.purgedEvents += await ctx.store.scrubEvents(ref, { olderThan: iso(ctx.clock.now() - eventDays * DAY_MS) });
      if (ctx.llm !== undefined) {
        const outcome = await refine(ctx, ref, opts.signal !== undefined ? { signal: opts.signal } : {});
        report.merged += outcome.merged;
      }
    }
    const auditDays = retentionDays(ctx.policy.retention.auditRetentionDays);
    if (auditDays !== null) {
      const purged = await ctx.store.purge({ tenantId: ctx.tenantId, auditOlderThan: iso(ctx.clock.now() - auditDays * DAY_MS) });
      report.purgedAudit += purged.audit;
    }
    report.elapsedMs = ctx.clock.now() - started;
    safe(() => ctx.logger.info({ ...log, ...report, flagged }, "maintain.done"));
    safe(() => {
      span.setAttribute("wisdom.examined", report.examined);
      span.setAttribute("wisdom.promoted", report.promoted);
      span.setAttribute("wisdom.retired", report.retired);
      span.setAttribute("wisdom.merged", report.merged);
      span.setAttribute("wisdom.nodes_retired", report.nodesRetired);
      span.setAttribute("wisdom.reembedded", report.reembedded);
      span.setAttribute("wisdom.purged_events", report.purgedEvents);
      span.setAttribute("wisdom.purged_audit", report.purgedAudit);
      span.setAttribute("wisdom.elapsed_ms", report.elapsedMs);
    });
    return report;
  } catch (e) {
    safe(() => ctx.logger.error({ ...log, ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}), error: describeError(e) }, "maintain.error"));
    safe(() => span.recordException(e));
    throw e;
  } finally {
    safe(() => span.end());
  }
}
