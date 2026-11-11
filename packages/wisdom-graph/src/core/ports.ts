/**
 * ports.ts — what the host injects, and what the library promises to call.
 *
 * Must-have 6: model governance, usage accounting, the `pg.Pool` and the
 * logger all live in the consumer, so the library reaches every external
 * effect through a small structural interface it never implements with a
 * real client. The ports are shaped after what the consumer already has
 * (pino for logs, OTel for spans, `complete(prompt, opts)` for models) so
 * adapting is one object literal, not an adapter class.
 *
 * `StorePort` (spec §7.1) is deliberately narrow — one read for recall, one
 * atomic write primitive, the event ledger — because a narrow port is what
 * makes the never-reject and one-round-trip guarantees checkable: recall can
 * only call `loadSnapshot`, and every write funnels through `applyBatch` so
 * the version check and the audit row happen in the same transaction.
 *
 * The noop ports let the engine run with nothing injected; `systemClock` is
 * the one default that touches the outside world, and it is replaced by a
 * `FakeClock` in every test that reasons about time.
 */

import type {
  Approval,
  AuditEntry,
  EventStatus,
  HintMaturity,
  HintProvenance,
  HintRecord,
  HintSource,
  HintStatus,
  IngestEvent,
  TopicNode,
  TurnEvent,
} from "./types";
import type { Proposal } from "./schema/proposal";

// ── 2.6 Injected ports ───────────────────────────────────────────────────────

export interface LlmPort {
  complete(
    prompt: string,
    opts: {
      json?: boolean;
      signal?: AbortSignal;
      maxTokens?: number;
      purpose?: "extract" | "consolidate";
    },
  ): Promise<string>;
}

export interface EmbeddingPort {
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<number[][]>;
  readonly dimensions?: number;
}

/** pino-shaped. */
export interface LoggerPort {
  debug?(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent?(name: string, attrs?: Record<string, string | number | boolean>): void;
  recordException(e: unknown): void;
  end(): void;
}

/** OTel-shaped, structural. */
export interface TracerPort {
  startSpan(name: string, opts?: { attributes?: Record<string, string | number | boolean> }): SpanLike;
}

/** Epoch milliseconds. */
export interface ClockPort {
  now(): number;
}

const noop = (): void => {};

export const noopLogger: LoggerPort = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop });

const noopSpan: SpanLike = Object.freeze({ setAttribute: noop, addEvent: noop, recordException: noop, end: noop });

export const noopTracer: TracerPort = Object.freeze({ startSpan: () => noopSpan });

export const systemClock: ClockPort = Object.freeze({ now: () => Date.now() });

// ── 7.1 Store port ───────────────────────────────────────────────────────────

export interface SubjectRef {
  tenantId: string | null;
  subjectId: string;
}

export type ConsolidateEvent = { type: "consolidate"; id: string; subjectId: string; nodePath: string; at?: string };
export type StoredEventBody = IngestEvent | ConsolidateEvent;

export interface StoredEvent {
  tenantId: string | null;
  /** Text fields may be scrubbed ("" + scrubbedAt) by retention. */
  event: StoredEventBody;
  status: EventStatus;
  attempts: number;
  error?: string;
  leaseUntil?: string;
  retryAt?: string;
  /** Persisted LLM output, reused on replay. */
  proposal?: Proposal | null;
  result?: { accepted: number; rejected: { op: string; reason: string }[] };
  scrubbedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GraphSnapshotData {
  ref: SubjectRef;
  /** kg_subjects.version, 0 when the subject row does not exist. */
  version: number;
  slotAliases: Record<string, string>;
  /** Forgotten hint ids (never re-created). */
  tombstones: string[];
  /** Drives consolidateEveryEvents. */
  eventsSinceConsolidation: number;
  /** Active + merged (merged needed to redirect). */
  nodes: TopicNode[];
  /** Statuses per query filter. */
  hints: HintRecord[];
}

export type NodePatch = Partial<
  Pick<TopicNode, "title" | "description" | "keywords" | "agents" | "properties" | "status" | "mergedInto" | "stats" | "embedding">
>;

export interface HintPatch {
  text?: string;
  value?: string;
  /** Set only upward (inferred → explicit) by the organiser when a human-stated proposal edits or restates an inferred hint in place (§6.1). */
  source?: HintSource;
  slot?: string;
  nodeId?: string;
  nodePath?: string;
  priority?: number;
  confidence?: number;
  status?: HintStatus;
  approval?: Approval;
  maturity?: HintMaturity;
  needsReview?: boolean;
  supersedes?: string;
  supersededBy?: string;
  retiredReason?: HintRecord["retiredReason"];
  reinforcements?: { add: number };
  contradictions?: { add: number };
  applied?: { add: number };
  lastReinforcedAt?: string;
  lastAppliedAt?: string;
  provenance?: { appendEventId?: string; appendRunId?: string; approval?: HintProvenance["approval"] };
}

export type StoreOp =
  | { op: "upsertNode"; node: TopicNode }
  | { op: "patchNode"; nodeId: string; patch: NodePatch }
  | { op: "upsertHint"; hint: HintRecord }
  | { op: "patchHint"; hintId: string; patch: HintPatch }
  | { op: "setSlotAlias"; from: string; to: string }
  | { op: "addTombstone"; hintId: string }
  | { op: "consolidationCounter"; action: "increment" | "reset" }
  | { op: "audit"; entry: AuditEntry };

export interface LeaseQuery {
  tenantId: string | null;
  limit: number;
  leaseMs: number;
  now: number;
  ids?: string[];
  subjectId?: string;
  statuses?: EventStatus[];
}

export type StoredEventPatch = Partial<
  Pick<StoredEvent, "status" | "error" | "attempts" | "leaseUntil" | "retryAt" | "proposal" | "result">
>;

export interface StorePort {
  // recall (the only read on the hot path)
  /** Default statuses ["active"]; null when the subject has no rows at all. */
  loadSnapshot(ref: SubjectRef, opts?: { signal?: AbortSignal; statuses?: HintStatus[] }): Promise<GraphSnapshotData | null>;
  // writes
  /** Atomic; bumps version; throws VersionConflictError when expectVersion mismatches. */
  applyBatch(ref: SubjectRef, ops: StoreOp[], opts?: { expectVersion?: number; signal?: AbortSignal }): Promise<{ version: number }>;
  getHint(ref: SubjectRef, hintId: string): Promise<HintRecord | null>;
  deleteHint(ref: SubjectRef, hintId: string): Promise<boolean>;
  /** Nodes, hints, events, audit for the subject. */
  deleteSubject(ref: SubjectRef): Promise<void>;
  // event ledger
  claimEvent(tenantId: string | null, ev: StoredEventBody): Promise<"claimed" | "duplicate">;
  /** Marks processing + lease_until; skips rows leased by others or with retry_at in the future. */
  leaseEvents(q: LeaseQuery): Promise<StoredEvent[]>;
  /**
   * A `status` other than "processing" releases the row's lease (lease_until → null) unless the same patch renews it,
   * so a backoff retry or a requeue is leasable as soon as `retryAt` passes.
   */
  updateEvent(tenantId: string | null, id: string, patch: StoredEventPatch): Promise<void>;
  getEvent(tenantId: string | null, id: string): Promise<StoredEvent | null>;
  getTurn(ref: SubjectRef, runId: string): Promise<TurnEvent | null>;
  listEvents(ref: SubjectRef, q: { limit: number; statuses?: EventStatus[] }): Promise<StoredEvent[]>;
  /** Blanks text fields and drops the stored proposal (it quotes the same text), keeps rows. */
  scrubEvents(ref: SubjectRef, opts?: { olderThan?: string }): Promise<number>;
  // governance
  listAudit(ref: SubjectRef, limit: number): Promise<AuditEntry[]>;
  /** Deletes `done` events and audit rows older than the given instants; pending, processing and failed rows are work and stay. */
  purge(q: { tenantId: string | null; eventsOlderThan?: string; auditOlderThan?: string }): Promise<{ events: number; audit: number }>;
  // optional vectors (large / shared subjects)
  searchNodesByEmbedding?(ref: SubjectRef, vector: number[], limit: number): Promise<{ nodeId: string; score: number }[]>;
}

/** Thrown by `applyBatch` when `expectVersion` does not match the stored version. */
export class VersionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`version conflict: expected ${expected}, found ${actual}`);
    this.name = "VersionConflictError";
  }
}
