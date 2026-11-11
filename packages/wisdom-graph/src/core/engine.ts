/**
 * engine.ts — the `WisdomGraph` the consumer holds.
 *
 * `createWisdomGraph` wires the injected ports (must-have 6) and the
 * configuration into one context and hands back the spec §2.7 interface.
 * The interesting logic lives in the modules it composes — the recall
 * pipeline, the snapshot cache, `explain()` — and this file is where the
 * cross-cutting decisions are made once:
 *
 *   - **Configuration is validated at construction, never on the hot path.**
 *     Categories are resolved (slugs, uniqueness, safe seed patterns, §9.2)
 *     and the policy merged here, so a `TypeError` surfaces where the
 *     operator wrote the config and a recall never has to.
 *   - **The engine is bound to one tenant** (§10.4): every `SubjectRef` it
 *     builds carries `tenantId`, and no method takes one.
 *   - **Governance writes go through `applyBatch` with their audit row**
 *     (§10.4): `forget` and `approve` build the ops and the audit entry
 *     together so the store commits both or neither, then invalidate the
 *     subject's cache entry so the next recall sees the decision.
 *
 *   - **The write path owns its own lifetime.** `ingest` admits through
 *     the ledger and schedules on a per-subject queue built here; `flush`
 *     waits for that queue and for background snapshot loads; `close`
 *     closes the queue (retry timers and jobs not yet started are dropped,
 *     their rows left for `drain()`), gives the jobs in flight `graceMs`
 *     to finish, then aborts the signal every model call was given so a
 *     hung model cannot hold the process, waits for those jobs to settle
 *     their rows, and closes the cache last — so a job in flight finishes
 *     against a live cache, a shutdown costs at most `graceMs` plus the
 *     store writes of `concurrency` attempts, and nothing runs after
 *     `close()` resolves.
 *   - **The slower timescales are wired, not owned, here.** The ledger
 *     reaches consolidation through a seam (`ingest/consolidate.ts`) the
 *     same way it reaches extraction, and `maintenance.consolidate` /
 *     `maintenance.maintain` are the host's entry points to the passes;
 *     the engine keeps only the per-process state they need (subjects seen,
 *     nodes flagged over cap, embedding hashes) and clears it with the
 *     subject when `forget(subjectId)` deletes one.
 *
 * `createNoopWisdomGraph` is the phase-1 engine the consumer plumbs
 * against before any store exists: every call succeeds with nothing.
 */

import { mergePolicy } from "./policy";
import { noopLogger, noopTracer, systemClock, type StoreOp, type StorePort, type SubjectRef } from "./ports";
import { admit, drain, resolveRetryPolicy, type IngestContext } from "./ingest/ingest";
import { extractEvent } from "./ingest/extract";
import { consolidate, consolidationHooks } from "./ingest/consolidate";
import { maintain } from "./ingest/maintain";
import { SubjectQueue, unrefTimer } from "./ingest/queue";
import type {
  AuditEntry,
  Charter,
  CompileOptions,
  ConsolidationReport,
  EngineStats,
  Explanation,
  HintLane,
  HintRecord,
  IngestEvent,
  IngestReceipt,
  JsonValue,
  MaintenanceReport,
  Recall,
  RecallRequest,
  WisdomGraph,
  WisdomGraphOptions,
} from "./types";
import { newId } from "./ids";
import { resolveCategories } from "./graph/seed";
import { LruMap, SnapshotCache, cacheKey, type SnapshotCacheOptions } from "./recall/cache";
import { compileCharter } from "./recall/compile";
import { QUERY_VECTOR_CACHE, emptyRecall, recall, refine, snapshotLoader } from "./recall/recall";
import { explain } from "./recall/explain";

function zeroStats(): EngineStats {
  return {
    recalls: 0,
    recallEmpty: 0,
    recallPartial: 0,
    cacheHits: 0,
    cacheMisses: 0,
    ingested: 0,
    duplicates: 0,
    processed: 0,
    failed: 0,
    llmCalls: 0,
    opsAccepted: 0,
    opsRejected: 0,
    queueDepth: 0,
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function consolidationReport(subjectId: string): ConsolidationReport {
  return { subjectId, merged: 0, promoted: 0, retired: 0, opsAccepted: 0, opsRejected: 0, usedLlm: false };
}

function maintenanceReport(subjectId: string | undefined): MaintenanceReport {
  return {
    ...(subjectId !== undefined ? { subjectId } : {}),
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
}

/**
 * The four §2.7 cache windows and nothing else. `SnapshotCache` also takes
 * `loadTimeoutMs`, but the spec does not offer it to the operator, so it is
 * not carried through by an untyped spread either.
 */
function cacheOptions(cache: WisdomGraphOptions["cache"]): Pick<SnapshotCacheOptions, "ttlMs" | "staleTtlMs" | "negativeTtlMs" | "maxSubjects"> {
  const { ttlMs, staleTtlMs, negativeTtlMs, maxSubjects } = cache ?? {};
  return {
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(staleTtlMs !== undefined ? { staleTtlMs } : {}),
    ...(negativeTtlMs !== undefined ? { negativeTtlMs } : {}),
    ...(maxSubjects !== undefined ? { maxSubjects } : {}),
  };
}

/** Structurally a `StorePort`: the one method recall needs must be there. */
function isStore(value: unknown): value is StorePort {
  return typeof value === "object" && value !== null && typeof (value as { loadSnapshot?: unknown }).loadSnapshot === "function";
}

/** Spec §2.7's `WisdomGraph`, over one store and one tenant. */
export class WisdomGraphEngine implements WisdomGraph {
  readonly options: WisdomGraphOptions;
  readonly ctx: IngestContext;
  private readonly closer = new AbortController();
  private closing: Promise<void> | undefined;

  constructor(opts: WisdomGraphOptions) {
    if (typeof opts !== "object" || opts === null) throw new TypeError("createWisdomGraph: options are required");
    if (!isStore(opts.store)) throw new TypeError("createWisdomGraph: `store` must implement StorePort");
    if (!Array.isArray(opts.categories)) throw new TypeError("createWisdomGraph: `categories` must be an array of CategorySpec");
    const clock = opts.clock ?? systemClock;
    const logger = opts.logger ?? noopLogger;
    const categories = resolveCategories(opts.categories).map((c) => ({
      name: c.name,
      title: c.title,
      description: c.description,
      keywords: c.keywords,
      patterns: c.patterns,
      lanes: c.lanes,
    }));
    this.options = opts;
    this.ctx = {
      store: opts.store,
      policy: mergePolicy(opts.policy),
      categories,
      tenantId: opts.tenantId ?? null,
      sharedSubjectId: opts.sharedSubjectId ?? null,
      cache: new SnapshotCache({ clock, logger, ...cacheOptions(opts.cache) }),
      clock,
      logger,
      tracer: opts.tracer ?? noopTracer,
      ...(opts.embeddings !== undefined ? { embeddings: opts.embeddings } : {}),
      ...(opts.tokenizer !== undefined ? { tokenizer: opts.tokenizer } : {}),
      ...(opts.surfaceCategories !== undefined ? { surfaceCategories: opts.surfaceCategories } : {}),
      queryVectors: new LruMap<number[]>(QUERY_VECTOR_CACHE),
      stats: zeroStats(),
      ...(opts.llm !== undefined ? { llm: opts.llm } : {}),
      extractor: extractEvent,
      consolidation: consolidationHooks,
      flagged: new Map(),
      subjects: new Set(),
      embedded: new Map(),
      queue: new SubjectQueue({
        ...(opts.queue?.concurrency !== undefined ? { concurrency: opts.queue.concurrency } : {}),
        ...(opts.queue?.maxPending !== undefined ? { maxPending: opts.queue.maxPending } : {}),
      }),
      retry: resolveRetryPolicy(opts.queue),
      sampler: Math.random,
      signal: this.closer.signal,
      ...(opts.requireApproval !== undefined ? { requireApproval: opts.requireApproval } : {}),
    };
  }

  private ref(subjectId: string): SubjectRef {
    return { tenantId: this.ctx.tenantId, subjectId };
  }

  private auditEntry(ref: SubjectRef, actor: string, action: string, fields: { hintId?: string; nodePath?: string; detail?: Record<string, JsonValue> }): AuditEntry {
    return {
      id: newId(),
      tenantId: ref.tenantId,
      subjectId: ref.subjectId,
      at: new Date(this.ctx.clock.now()).toISOString(),
      actor,
      action,
      ...(fields.hintId !== undefined ? { hintId: fields.hintId } : {}),
      ...(fields.nodePath !== undefined ? { nodePath: fields.nodePath } : {}),
      detail: fields.detail ?? {},
    };
  }

  recall(req: RecallRequest): Promise<Recall> {
    return recall(this.ctx, req);
  }

  refine(base: Recall, req: RecallRequest, opts?: { signal?: AbortSignal; budgetMs?: number }): Promise<Recall> {
    return refine(this.ctx, base, req, opts);
  }

  /** Spec §5.1: never rejects; the receipt says how far the event got. */
  ingest(ev: IngestEvent, opts?: { waitFor?: "recorded" | "processed"; extract?: "auto" | "force" | "skip" }): Promise<IngestReceipt> {
    return admit(this.ctx, ev, opts);
  }

  explain(subjectId: string, opts?: { clientId?: string | null; text?: string; includeRetired?: boolean; topicPath?: string }): Promise<Explanation> {
    return explain(this.ctx, subjectId, opts);
  }

  /**
   * Spec §10.4. With a hint id: hard-delete the row, tombstone the id so a
   * replayed event cannot bring it back, and audit `hint.forgotten` (only
   * when a row was actually removed, so a repeat is a no-op). Without one:
   * delete the subject entirely. Both invalidate the subject's cache entry.
   */
  async forget(subjectId: string, hintId?: string, opts: { actor?: string; reason?: string } = {}): Promise<void> {
    const ref = this.ref(subjectId);
    if (hintId === undefined) {
      await this.ctx.store.deleteSubject(ref);
      this.ctx.cache.invalidate(ref);
      this.ctx.subjects.delete(subjectId);
      this.ctx.flagged.delete(cacheKey(ref));
      this.ctx.embedded.delete(cacheKey(ref));
      return;
    }
    const deleted = await this.ctx.store.deleteHint(ref, hintId);
    const ops: StoreOp[] = [{ op: "addTombstone", hintId }];
    if (deleted) {
      const actor = opts.actor !== undefined ? `human:${opts.actor}` : "system:forget";
      const detail: Record<string, JsonValue> = opts.reason !== undefined ? { reason: opts.reason } : {};
      ops.push({ op: "audit", entry: this.auditEntry(ref, actor, "hint.forgotten", { hintId, detail }) });
    }
    await this.ctx.store.applyBatch(ref, ops);
    this.ctx.cache.invalidate(ref);
  }

  /**
   * Spec §10.4. `approved` activates the hint as human-approved and, when it
   * challenges an older hint (`supersedes`), marks that one superseded in
   * the same batch — first, because the two share a slot key and the store
   * allows one active holder. `rejected` retires it. Either way the
   * decision is written into provenance and audited under `human:<by>`.
   */
  async approve(subjectId: string, hintId: string, decision: { status: "approved" | "rejected"; by: string; note?: string }): Promise<void> {
    const ref = this.ref(subjectId);
    const hint = await this.ctx.store.getHint(ref, hintId);
    if (hint === null) throw new Error(`approve: hint ${hintId} not found for subject ${subjectId}`);
    if (hint.status !== "pending" && hint.status !== "active") {
      throw new Error(`approve: hint ${hintId} is ${hint.status}; only pending or active hints can be decided`);
    }
    const at = new Date(this.ctx.clock.now()).toISOString();
    const actor = `human:${decision.by}`;
    const approval = { by: decision.by, at, ...(decision.note !== undefined ? { note: decision.note } : {}) };
    const detail: Record<string, JsonValue> = decision.note !== undefined ? { note: decision.note } : {};
    const ops: StoreOp[] = [];
    if (decision.status === "approved") {
      const superseded = await this.supersededBy(ref, hint);
      if (superseded !== null) {
        ops.push({ op: "patchHint", hintId: superseded.id, patch: { status: "superseded", supersededBy: hintId } });
        ops.push({
          op: "audit",
          entry: this.auditEntry(ref, actor, "hint.superseded", { hintId: superseded.id, nodePath: superseded.nodePath, detail: { by: hintId } }),
        });
        detail.supersedes = superseded.id;
      }
      ops.push({ op: "patchHint", hintId, patch: { status: "active", approval: "approved", needsReview: false, provenance: { approval } } });
      ops.push({ op: "audit", entry: this.auditEntry(ref, actor, "hint.approved", { hintId, nodePath: hint.nodePath, detail }) });
    } else {
      ops.push({
        op: "patchHint",
        hintId,
        patch: { status: "retired", approval: "rejected", retiredReason: "rejected", needsReview: false, provenance: { approval } },
      });
      ops.push({ op: "audit", entry: this.auditEntry(ref, actor, "hint.rejected", { hintId, nodePath: hint.nodePath, detail }) });
    }
    await this.ctx.store.applyBatch(ref, ops);
    this.ctx.cache.invalidate(ref);
  }

  /** The active hint `hint` challenges, if it names one and it is still active. */
  private async supersededBy(ref: SubjectRef, hint: HintRecord): Promise<HintRecord | null> {
    if (hint.supersedes === undefined) return null;
    const old = await this.ctx.store.getHint(ref, hint.supersedes);
    return old !== null && old.status === "active" ? old : null;
  }

  /** Pure: one lane of a charter, the bucket rebuilt under this engine's caps and mirroring policy. */
  compile(charter: Charter, lane: HintLane, opts: CompileOptions & { agent?: string } = {}) {
    const tokenizer = opts.tokenizer ?? this.ctx.tokenizer;
    const { caps, recall } = this.ctx.policy;
    return compileCharter(charter, lane, { ...opts, ...(tokenizer !== undefined ? { tokenizer } : {}), caps, mirrorStyleToAgents: recall.mirrorStyleToAgents });
  }

  invalidate(subjectId?: string): void {
    this.ctx.cache.invalidate(subjectId === undefined ? undefined : this.ref(subjectId));
  }

  readonly maintenance = {
    /** Spec §5.2: re-lease `pending`/`failed` rows whose lease and retry time have passed and process them here. */
    drain: (opts?: { limit?: number; signal?: AbortSignal }): Promise<{ processed: number; failed: number }> => drain(this.ctx, opts),
    /** Spec §5.7's short-term pass now, and the model pass over over-cap and flagged nodes when `llm: true`. */
    consolidate: (subjectId: string, opts?: { signal?: AbortSignal; llm?: boolean }): Promise<ConsolidationReport> => consolidate(this.ctx, subjectId, opts),
    /**
     * Spec §6.2's sweep, node GC, re-embedding, retention and the model pass —
     * the daily cron's call. Re-embedding is memoised per process: the first
     * run in a process embeds every active node of each swept subject once,
     * so a cron that starts a fresh process per run pays one full embed per
     * run when an `EmbeddingPort` is configured.
     */
    maintain: (opts?: { subjectId?: string; signal?: AbortSignal }): Promise<MaintenanceReport> => maintain(this.ctx, opts),
    /** Load the subject into the cache unless it is fresh; joins a load already in flight. */
    warm: async (subjectId: string): Promise<void> => {
      const ref = this.ref(subjectId);
      if (this.ctx.cache.lookup(ref).state === "hit") return;
      await this.ctx.cache.load(ref, snapshotLoader(this.ctx, ref));
    },
  };

  /** Resolves once the in-process queue is empty and no background load is in flight. */
  async flush(): Promise<void> {
    await this.ctx.queue.idle();
    await this.ctx.cache.settled();
  }

  /**
   * Shut down (§2.7). The queue closes first — retry timers and jobs not
   * yet started end `cancelled`, their rows still `pending`/`failed` with
   * `retry_at` for `drain()` — then the jobs in flight get `graceMs`
   * (default `policy.ingest.llmTimeoutMs`, one model call's worth; `0`
   * interrupts at once) before the model signal aborts. An aborted attempt
   * fails into the backoff path like any other error, so its row keeps a
   * `retry_at` too; `close()` then waits for those attempts to settle and
   * closes the cache. Idempotent: every call resolves when the first
   * shutdown completes.
   */
  close(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.closing === undefined) this.closing = this.shutdown(opts.graceMs);
    return this.closing;
  }

  private async shutdown(graceMs: number | undefined): Promise<void> {
    this.ctx.queue.close();
    const grace = graceMs !== undefined && Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : this.ctx.policy.ingest.llmTimeoutMs;
    const abort = (): void => this.closer.abort(new Error("WisdomGraph closed"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only queued attempts are tracked; an `inline` attempt is interrupted at once, as before.
    if (this.ctx.queue.running === 0 || grace === 0) abort();
    else {
      timer = setTimeout(abort, grace);
      unrefTimer(timer);
    }
    try {
      await this.flush();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort();
      this.ctx.cache.close();
    }
  }

  stats(): EngineStats {
    return { ...this.ctx.stats, queueDepth: this.ctx.queue.depth };
  }
}

/** Spec §2.7. Throws `TypeError` at construction for a missing store or an invalid category. */
export function createWisdomGraph(opts: WisdomGraphOptions): WisdomGraph {
  return new WisdomGraphEngine(opts);
}

/**
 * Spec §2.7: the phase-1 engine. Every call succeeds with nothing — an
 * empty recall, a `recorded` receipt, an empty explanation — so the
 * consumer's plumbing can be wired and tested before a store exists.
 */
export function createNoopWisdomGraph(): WisdomGraph {
  const stats = zeroStats();
  const emptyExplanation = (subjectId: string): Explanation => ({
    subjectId,
    tenantId: null,
    generatedAt: new Date().toISOString(),
    tree: [],
    pendingApproval: [],
    retired: [],
    recentEvents: [],
    audit: [],
    stats: { nodes: 0, activeHints: 0, pending: 0, retired: 0, slots: [] },
  });
  return {
    recall: async (req) => {
      stats.recalls += 1;
      stats.recallEmpty += 1;
      return emptyRecall(req);
    },
    refine: async (base) => base,
    ingest: async (ev) => ({ eventId: stringOr(ev?.id, ""), status: "recorded" }),
    explain: async (subjectId) => emptyExplanation(subjectId),
    forget: async () => undefined,
    approve: async () => undefined,
    compile: (charter, lane, opts) => compileCharter(charter, lane, opts),
    invalidate: () => undefined,
    maintenance: {
      drain: async () => ({ processed: 0, failed: 0 }),
      consolidate: async (subjectId) => consolidationReport(subjectId),
      maintain: async (opts) => maintenanceReport(opts?.subjectId),
      warm: async () => undefined,
    },
    flush: async () => undefined,
    close: async () => undefined,
    stats: () => ({ ...stats }),
  };
}
