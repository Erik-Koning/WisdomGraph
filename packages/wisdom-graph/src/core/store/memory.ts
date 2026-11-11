/**
 * memory.ts — the reference StorePort: every rule of spec §7.1 in the
 * simplest form that can be read as the contract.
 *
 * It is the store the engine's own tests run against and the one a consumer
 * uses in theirs (must-have 9), so it favours obviousness over speed: one
 * bucket of Maps per subject, linear scans, and copies at every boundary.
 *
 * Why it is shaped this way:
 *
 *   - `applyBatch` is clone-apply-swap. The subject bucket is copied, the ops
 *     run against the copy, and only a fully successful batch replaces the
 *     reference — so a throwing op (path clash, slot clash) or a version
 *     conflict leaves the store exactly as it was. That is what
 *     "all-or-nothing" means for a store with no transaction log.
 *   - Rows are never mutated in place: a patch builds a new row. A bucket
 *     copied for one batch may therefore share untouched rows with its
 *     predecessor without either seeing the other's writes.
 *   - Every read returns `structuredClone`d values. The recall pipeline
 *     deep-freezes what it returns; if that froze the store's own rows, the
 *     next patch would throw. Copies at the boundary make the port behave
 *     like a database, where nothing you read aliases the table.
 *   - The slot-uniqueness invariant (§3.1; Postgres' partial unique index) is
 *     checked per op, exactly where Postgres would raise. A reference store
 *     that accepted a second active hint on the same key would let an
 *     organiser bug pass every unit test and fail in production.
 *   - `signal` is honoured at entry only. The store models a database that
 *     cannot cancel a running statement (§7.3): the caller's race is the
 *     budget, and a load that lost the race still completes and warms the
 *     recall cache — the behaviour §4.2 relies on.
 *   - Leases are `leaseUntil` timestamps compared with the caller's `now`,
 *     not the clock, so ledger tests move time with a number. A lease
 *     belongs to the `processing` state: `updateEvent` to any other status
 *     releases it (what Postgres' `SET status = $1, lease_until = NULL`
 *     does), so a backoff retry or a feedback requeue becomes leasable when
 *     its `retryAt` passes, not when a stale 60 s lease happens to lapse.
 *   - A row is filed under the batch's `ref` only if it says it belongs
 *     there. Postgres inserts the row's own subject_id; a reference store
 *     that accepted a mis-addressed row would let the two stores disagree.
 *   - Retention never destroys work: `purge` deletes only `done` events
 *     (pending, processing and failed rows are what `drain()` picks up), and
 *     `scrubEvents` leaves `consolidate` rows alone — they carry no text, so
 *     stamping them would over-count and make explain() flag internals.
 *   - `latencyMs` and `failNext` exist for the budget and never-reject tests:
 *     one delays every method by a fixed wait, the other makes exactly the
 *     next call reject. Both are claimed synchronously at entry so the
 *     outcome of concurrent calls is deterministic.
 *   - `snapshot()` / `load()` serialise the whole store through the same row
 *     validators the engine uses and the same invariants `applyBatch`
 *     enforces (addressing, one node per path, one active hint per slot,
 *     one row per key), so a fixture cannot hold what the store would refuse
 *     to write.
 */

import { VersionConflictError, systemClock } from "../ports";
import type {
  ClockPort,
  GraphSnapshotData,
  HintPatch,
  LeaseQuery,
  NodePatch,
  StoreOp,
  StorePort,
  StoredEvent,
  StoredEventBody,
  StoredEventPatch,
  SubjectRef,
} from "../ports";
import type { AuditEntry, EventStatus, HintRecord, HintStatus, TopicNode, TurnEvent } from "../types";
import { validateStoredEventBody } from "../schema/event";
import { MAX_PROVENANCE_IDS, validateHintRecord } from "../schema/hint";
import { validateNode } from "../schema/node";
import { proposalValidator } from "../schema/proposal";
import { arr, int, isoDate, json, nullable, obj, oneOf, opt, record, str, type Validator } from "../schema/validate";

// ── Options and the serialised form ──────────────────────────────────────────

export interface MemoryStoreOptions {
  /** Await this many milliseconds before every method (budget tests). */
  latencyMs?: number;
  /** Source of `createdAt` / `updatedAt` / patch timestamps; default the system clock. */
  clock?: ClockPort;
}

/** One subject's state inside a `MemoryStoreSnapshot` (the kg_subjects row plus its nodes and hints). */
export interface MemoryStoreSubject {
  tenantId: string | null;
  subjectId: string;
  version: number;
  slotAliases: Record<string, string>;
  tombstones: string[];
  eventsSinceConsolidation: number;
  /** When `consolidationCounter: reset` last ran — the role kg_subjects.last_consolidated_event plays. */
  lastConsolidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  nodes: TopicNode[];
  hints: HintRecord[];
}

/** Tag on every serialised store, so `load()` can refuse a file that is not one. */
export const MEMORY_STORE_FORMAT = "wisdom-graph/memory-store@1";

/** What `snapshot()` returns and `load()` accepts: the whole store as plain JSON. */
export interface MemoryStoreSnapshot {
  format: typeof MEMORY_STORE_FORMAT;
  subjects: MemoryStoreSubject[];
  events: StoredEvent[];
  audit: AuditEntry[];
}

// ── Internal shape ───────────────────────────────────────────────────────────

type SubjectMeta = Omit<MemoryStoreSubject, "nodes" | "hints">;

interface SubjectBucket {
  meta: SubjectMeta;
  nodes: Map<string, TopicNode>;
  hints: Map<string, HintRecord>;
}

const EVENT_STATUSES = ["pending", "processing", "done", "failed"] as const;
/** Every status a lease may pick up when the caller names none: anything not finished. */
const LEASABLE_STATUSES: readonly EventStatus[] = ["pending", "failed", "processing"];
/** The consolidation pass may store up to 24 ops (§5.7); an extraction proposal is a subset. */
const STORED_PROPOSAL_MAX_OPS = 24;

/** Null and "" are the same tenant at the store boundary (spec §7.1). */
function tenantKey(tenantId: string | null | undefined): string {
  return tenantId ?? "";
}

function subjectKey(ref: SubjectRef): string {
  return `${tenantKey(ref.tenantId)}|${ref.subjectId}`;
}

function subjectLabel(ref: SubjectRef): string {
  return `${tenantKey(ref.tenantId) || "(no tenant)"}/${ref.subjectId}`;
}

/** Whether a row (node, hint, audit entry) names the subject it is being filed under. */
function sameSubject(row: SubjectRef, ref: SubjectRef): boolean {
  return tenantKey(row.tenantId) === tenantKey(ref.tenantId) && row.subjectId === ref.subjectId;
}

function misfiled(row: SubjectRef, ref: SubjectRef): string {
  return `belongs to ${subjectLabel(row)}, not ${subjectLabel(ref)}`;
}

function eventKey(tenantId: string | null | undefined, id: string): string {
  return `${tenantKey(tenantId)}|${id}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The keys of `patch` that carry a value: `undefined` means "not patched", never "clear". */
function defined<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function ms(iso: string): number {
  return Date.parse(iso);
}

/** Newest-last append with the §2.2 cap; an id already present is not repeated, so a replayed event converges. */
function appendCapped(list: string[], id: string): string[] {
  if (list.includes(id)) return list;
  return [...list, id].slice(-MAX_PROVENANCE_IDS);
}

/** The applicability key of the slot-uniqueness invariant (§3.1); JSON-encoded so no id can forge a boundary. */
function slotKey(hint: HintRecord): string {
  return JSON.stringify([hint.nodePath, hint.slot, hint.scope, hint.agent ?? "", hint.clientId ?? ""]);
}

/** The active hint already holding `hint`'s slot key under another id, if any (Postgres: kg_hints_slot_active). */
function slotClash(hints: Map<string, HintRecord>, hint: HintRecord): HintRecord | undefined {
  const key = slotKey(hint);
  for (const other of hints.values()) {
    if (other.id !== hint.id && other.status === "active" && slotKey(other) === key) return other;
  }
  return undefined;
}

function slotConflictMessage(hint: HintRecord, other: HintRecord): string {
  return (
    `slot conflict: hint ${hint.id} and active hint ${other.id} both claim ` +
    `${hint.nodePath} ${hint.slot} (scope ${hint.scope}${hint.agent ? `, agent ${hint.agent}` : ""}` +
    `${hint.clientId ? `, client ${hint.clientId}` : ""}); supersede or retire ${other.id} first`
  );
}

function assertSlotFree(hints: Map<string, HintRecord>, hint: HintRecord): void {
  const other = slotClash(hints, hint);
  if (other) throw new Error(slotConflictMessage(hint, other));
}

/** The node already holding `node.path` under another id, if any (Postgres: UNIQUE (tenant_id, subject_id, path)). */
function pathClash(nodes: Map<string, TopicNode>, node: TopicNode): TopicNode | undefined {
  for (const existing of nodes.values()) {
    if (existing.path === node.path && existing.id !== node.id) return existing;
  }
  return undefined;
}

function pathConflictMessage(node: TopicNode, holder: TopicNode): string {
  return `path ${node.path} already belongs to node ${holder.id}, not ${node.id}`;
}

function cosine(a: number[], b: number[]): number {
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
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

function freshBucket(ref: SubjectRef, now: string): SubjectBucket {
  return {
    meta: {
      tenantId: ref.tenantId,
      subjectId: ref.subjectId,
      version: 0,
      slotAliases: {},
      tombstones: [],
      eventsSinceConsolidation: 0,
      lastConsolidatedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    nodes: new Map(),
    hints: new Map(),
  };
}

/** A working copy: meta and collections copied, rows shared (they are never mutated in place). */
function copyBucket(bucket: SubjectBucket): SubjectBucket {
  return {
    meta: { ...bucket.meta, slotAliases: { ...bucket.meta.slotAliases }, tombstones: [...bucket.meta.tombstones] },
    nodes: new Map(bucket.nodes),
    hints: new Map(bucket.hints),
  };
}

function patchNode(existing: TopicNode, patch: NodePatch, now: string): TopicNode {
  return { ...existing, ...defined(patch), version: existing.version + 1, updatedAt: now };
}

/** What a `patchHint` op means, shared with the Postgres store so both stores agree on counters, caps and provenance. */
export function patchHint(existing: HintRecord, patch: HintPatch, now: string): HintRecord {
  const { reinforcements, contradictions, applied, provenance, ...scalars } = patch;
  const next: HintRecord = { ...existing, ...defined(scalars), version: existing.version + 1, updatedAt: now };
  if (reinforcements) next.reinforcements = existing.reinforcements + reinforcements.add;
  if (contradictions) next.contradictions = existing.contradictions + contradictions.add;
  if (applied) next.applied = existing.applied + applied.add;
  if (provenance) {
    const merged = { ...existing.provenance };
    if (provenance.appendEventId !== undefined) merged.eventIds = appendCapped(existing.provenance.eventIds, provenance.appendEventId);
    if (provenance.appendRunId !== undefined) merged.runIds = appendCapped(existing.provenance.runIds, provenance.appendRunId);
    if (provenance.approval !== undefined) merged.approval = { ...provenance.approval };
    next.provenance = merged;
  }
  return next;
}

/** One op against the working copy. Throws to abort the batch; the caller discards the copy. */
function applyOp(work: SubjectBucket, ref: SubjectRef, op: StoreOp, now: string, audit: AuditEntry[]): void {
  switch (op.op) {
    case "upsertNode": {
      if (!sameSubject(op.node, ref)) throw new Error(`upsertNode: node ${op.node.id} ${misfiled(op.node, ref)}`);
      const node = clone(op.node);
      const holder = pathClash(work.nodes, node);
      if (holder) throw new Error(`upsertNode: ${pathConflictMessage(node, holder)}`);
      work.nodes.set(node.id, node);
      return;
    }
    case "patchNode": {
      const existing = work.nodes.get(op.nodeId);
      if (existing) work.nodes.set(op.nodeId, patchNode(existing, clone(op.patch), now));
      return;
    }
    case "upsertHint": {
      if (!sameSubject(op.hint, ref)) throw new Error(`upsertHint: hint ${op.hint.id} ${misfiled(op.hint, ref)}`);
      if (work.meta.tombstones.includes(op.hint.id)) return;
      const hint = clone(op.hint);
      if (hint.status === "active") assertSlotFree(work.hints, hint);
      work.hints.set(hint.id, hint);
      return;
    }
    case "patchHint": {
      const existing = work.hints.get(op.hintId);
      if (!existing) return;
      const next = patchHint(existing, clone(op.patch), now);
      if (next.status === "active") assertSlotFree(work.hints, next);
      work.hints.set(op.hintId, next);
      return;
    }
    case "setSlotAlias": {
      // A prototype key would rewrite the alias map's prototype instead of adding an entry.
      if (op.from === "__proto__") throw new Error('setSlotAlias: "__proto__" is not a slot');
      work.meta.slotAliases[op.from] = op.to;
      return;
    }
    case "addTombstone": {
      if (!work.meta.tombstones.includes(op.hintId)) work.meta.tombstones.push(op.hintId);
      return;
    }
    case "consolidationCounter": {
      if (op.action === "increment") work.meta.eventsSinceConsolidation += 1;
      else {
        work.meta.eventsSinceConsolidation = 0;
        work.meta.lastConsolidatedAt = now;
      }
      return;
    }
    case "audit": {
      if (!sameSubject(op.entry, ref)) throw new Error(`audit: entry ${op.entry.id} ${misfiled(op.entry, ref)}`);
      audit.push(clone(op.entry));
      return;
    }
  }
}

// ── Serialised-form validation ───────────────────────────────────────────────

const subjectValidator: Validator<MemoryStoreSubject> = obj<MemoryStoreSubject>({
  tenantId: nullable(str()),
  subjectId: str({ min: 1, max: 256 }),
  version: int({ min: 0 }),
  slotAliases: record(str({ min: 1 })),
  tombstones: arr(str({ min: 1 })),
  eventsSinceConsolidation: int({ min: 0 }),
  lastConsolidatedAt: nullable(isoDate()),
  createdAt: isoDate(),
  updatedAt: isoDate(),
  nodes: arr(validateNode),
  hints: arr(validateHintRecord),
});

const storedEventValidator: Validator<StoredEvent> = obj<StoredEvent>({
  tenantId: nullable(str()),
  event: validateStoredEventBody,
  status: oneOf(EVENT_STATUSES),
  attempts: int({ min: 0 }),
  error: opt(str()),
  leaseUntil: opt(isoDate()),
  retryAt: opt(isoDate()),
  proposal: opt(nullable(proposalValidator({ maxOps: STORED_PROPOSAL_MAX_OPS }))),
  result: opt(
    obj<NonNullable<StoredEvent["result"]>>({
      accepted: int({ min: 0 }),
      rejected: arr(obj<{ op: string; reason: string }>({ op: str(), reason: str() })),
    }),
  ),
  scrubbedAt: opt(isoDate()),
  createdAt: isoDate(),
  updatedAt: isoDate(),
});

const auditEntryValidator: Validator<AuditEntry> = obj<AuditEntry>({
  id: str({ min: 1, max: 128 }),
  tenantId: nullable(str()),
  subjectId: str({ min: 1, max: 256 }),
  at: isoDate(),
  actor: str({ min: 1, max: 256 }),
  action: str({ min: 1, max: 128 }),
  hintId: opt(str({ min: 1, max: 128 })),
  nodePath: opt(str({ min: 1 })),
  eventId: opt(str({ min: 1, max: 128 })),
  detail: record(json()),
});

const snapshotValidator: Validator<MemoryStoreSnapshot> = obj<MemoryStoreSnapshot>({
  format: oneOf([MEMORY_STORE_FORMAT]),
  subjects: arr(subjectValidator),
  events: arr(storedEventValidator),
  audit: arr(auditEntryValidator),
});

/** Every `load()` failure points at the offending field the way the validators do. */
function invalidSnapshot(detail: string): TypeError {
  return new TypeError(`MemoryStore.load: invalid snapshot — ${detail}`);
}

// ── The store ────────────────────────────────────────────────────────────────

export class MemoryStore implements StorePort {
  // Every private member is `@internal` and the build strips them from the
  // declarations. A class with a private member is a nominal type, and each
  // subpath's rolled-up `.d.ts` carries its own copy of this class (the
  // testing entry's `advisorFixture().store`), so a consumer moving a store from
  // one entry to another would hit "separate declarations of a private
  // property" even though the runtime is one class in a shared chunk. With
  // nothing private declared, the copies are structurally identical and
  // interchangeable.
  /** @internal */
  private subjects = new Map<string, SubjectBucket>();
  /** @internal */
  private events = new Map<string, StoredEvent>();
  /** @internal */
  private audit: AuditEntry[] = [];
  /** @internal */
  private failure: { error: unknown } | undefined;
  /** @internal */
  private readonly latencyMs: number;
  /** @internal */
  private readonly clock: ClockPort;

  constructor(opts: MemoryStoreOptions = {}) {
    this.latencyMs = Math.max(0, opts.latencyMs ?? 0);
    this.clock = opts.clock ?? systemClock;
  }

  /** Make exactly the next method call reject with `err`, after its latency wait. */
  failNext(err: unknown): void {
    this.failure = { error: err };
  }

  // ── Hooks ──

  /**
   * Every method starts here. The pending failure is claimed synchronously so
   * that, of several concurrent calls, the first to enter is the one that
   * fails; an already-aborted signal is refused before any wait, as a driver
   * refuses to start a statement it has been told not to run.
   * @internal
   */
  private async enter(signal?: AbortSignal): Promise<void> {
    const failure = this.failure;
    this.failure = undefined;
    if (failure === undefined && signal?.aborted) throw abortReason(signal);
    if (this.latencyMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
    if (failure !== undefined) throw failure.error;
  }

  /** @internal */
  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** @internal */
  private subjectEvents(ref: SubjectRef): [string, StoredEvent][] {
    const tenant = tenantKey(ref.tenantId);
    return [...this.events.entries()].filter(
      ([, row]) => tenantKey(row.tenantId) === tenant && row.event.subjectId === ref.subjectId,
    );
  }

  /** Oldest first by `createdAt`; insertion order breaks ties (stable sort). @internal */
  private static oldestFirst(rows: [string, StoredEvent][]): [string, StoredEvent][] {
    return [...rows].sort(([, a], [, b]) => ms(a.createdAt) - ms(b.createdAt));
  }

  // ── Recall ──

  async loadSnapshot(ref: SubjectRef, opts: { signal?: AbortSignal; statuses?: HintStatus[] } = {}): Promise<GraphSnapshotData | null> {
    await this.enter(opts.signal);
    const bucket = this.subjects.get(subjectKey(ref));
    if (!bucket) return null;
    const statuses = new Set<HintStatus>(opts.statuses ?? ["active"]);
    const nodes = [...bucket.nodes.values()].filter((n) => n.status === "active" || n.status === "merged");
    const hints = [...bucket.hints.values()].filter((h) => statuses.has(h.status));
    return clone({
      ref: { tenantId: ref.tenantId, subjectId: ref.subjectId },
      version: bucket.meta.version,
      slotAliases: bucket.meta.slotAliases,
      tombstones: bucket.meta.tombstones,
      eventsSinceConsolidation: bucket.meta.eventsSinceConsolidation,
      nodes,
      hints,
    });
  }

  // ── Writes ──

  async applyBatch(ref: SubjectRef, ops: StoreOp[], opts: { expectVersion?: number; signal?: AbortSignal } = {}): Promise<{ version: number }> {
    await this.enter(opts.signal);
    const key = subjectKey(ref);
    const current = this.subjects.get(key);
    const actual = current?.meta.version ?? 0;
    if (opts.expectVersion !== undefined && opts.expectVersion !== actual) {
      throw new VersionConflictError(opts.expectVersion, actual);
    }
    const now = this.now();
    const work = current ? copyBucket(current) : freshBucket(ref, now);
    const audit: AuditEntry[] = [];
    for (const op of ops) applyOp(work, ref, op, now, audit);
    work.meta.version = actual + 1;
    work.meta.updatedAt = now;
    this.subjects.set(key, work);
    this.audit.push(...audit);
    return { version: work.meta.version };
  }

  async getHint(ref: SubjectRef, hintId: string): Promise<HintRecord | null> {
    await this.enter();
    const hint = this.subjects.get(subjectKey(ref))?.hints.get(hintId);
    return hint ? clone(hint) : null;
  }

  async deleteHint(ref: SubjectRef, hintId: string): Promise<boolean> {
    await this.enter();
    const key = subjectKey(ref);
    const bucket = this.subjects.get(key);
    if (!bucket || !bucket.hints.has(hintId)) return false;
    const hints = new Map(bucket.hints);
    hints.delete(hintId);
    this.subjects.set(key, { ...bucket, hints });
    return true;
  }

  async deleteSubject(ref: SubjectRef): Promise<void> {
    await this.enter();
    this.subjects.delete(subjectKey(ref));
    for (const [key] of this.subjectEvents(ref)) this.events.delete(key);
    const tenant = tenantKey(ref.tenantId);
    this.audit = this.audit.filter((entry) => !(tenantKey(entry.tenantId) === tenant && entry.subjectId === ref.subjectId));
  }

  // ── Event ledger ──

  async claimEvent(tenantId: string | null, ev: StoredEventBody): Promise<"claimed" | "duplicate"> {
    await this.enter();
    const key = eventKey(tenantId, ev.id);
    if (this.events.has(key)) return "duplicate";
    const now = this.now();
    this.events.set(key, { tenantId, event: clone(ev), status: "pending", attempts: 0, createdAt: now, updatedAt: now });
    return "claimed";
  }

  async leaseEvents(q: LeaseQuery): Promise<StoredEvent[]> {
    await this.enter();
    const tenant = tenantKey(q.tenantId);
    const statuses = new Set<EventStatus>(q.statuses ?? LEASABLE_STATUSES);
    const ids = q.ids === undefined ? undefined : new Set(q.ids);
    const candidates = MemoryStore.oldestFirst(
      [...this.events.entries()].filter(
        ([, row]) =>
          tenantKey(row.tenantId) === tenant &&
          (ids === undefined || ids.has(row.event.id)) &&
          (q.subjectId === undefined || row.event.subjectId === q.subjectId) &&
          statuses.has(row.status) &&
          !(row.leaseUntil !== undefined && ms(row.leaseUntil) > q.now) &&
          !(row.retryAt !== undefined && ms(row.retryAt) > q.now),
      ),
    );
    const now = this.now();
    const leaseUntil = new Date(q.now + q.leaseMs).toISOString();
    const leased: StoredEvent[] = [];
    for (const [key, row] of candidates.slice(0, Math.max(0, q.limit))) {
      const next: StoredEvent = { ...row, status: "processing", leaseUntil, updatedAt: now };
      this.events.set(key, next);
      leased.push(clone(next));
    }
    return leased;
  }

  async updateEvent(tenantId: string | null, id: string, patch: StoredEventPatch): Promise<void> {
    await this.enter();
    const key = eventKey(tenantId, id);
    const row = this.events.get(key);
    if (!row) return;
    const next: StoredEvent = { ...row, ...defined(clone(patch)), updatedAt: this.now() };
    // The lease is the processing state's; leaving that state releases it unless the same patch renews it.
    if (patch.status !== undefined && patch.status !== "processing" && patch.leaseUntil === undefined) delete next.leaseUntil;
    this.events.set(key, next);
  }

  async getEvent(tenantId: string | null, id: string): Promise<StoredEvent | null> {
    await this.enter();
    const row = this.events.get(eventKey(tenantId, id));
    return row ? clone(row) : null;
  }

  async getTurn(ref: SubjectRef, runId: string): Promise<TurnEvent | null> {
    await this.enter();
    for (const [, row] of MemoryStore.oldestFirst(this.subjectEvents(ref))) {
      if (row.event.type === "turn" && row.event.runId === runId) return clone(row.event);
    }
    return null;
  }

  async listEvents(ref: SubjectRef, q: { limit: number; statuses?: EventStatus[] }): Promise<StoredEvent[]> {
    await this.enter();
    const statuses = q.statuses === undefined ? undefined : new Set(q.statuses);
    return MemoryStore.oldestFirst(this.subjectEvents(ref))
      .map(([, row]) => row)
      .filter((row) => statuses === undefined || statuses.has(row.status))
      .reverse()
      .slice(0, Math.max(0, q.limit))
      .map(clone);
  }

  async scrubEvents(ref: SubjectRef, opts: { olderThan?: string } = {}): Promise<number> {
    await this.enter();
    const threshold = opts.olderThan === undefined ? undefined : ms(opts.olderThan);
    const now = this.now();
    let scrubbed = 0;
    for (const [key, row] of this.subjectEvents(ref)) {
      if (row.scrubbedAt !== undefined || row.event.type === "consolidate") continue;
      if (threshold !== undefined && !(ms(row.createdAt) < threshold)) continue;
      const event = clone(row.event);
      if (event.type === "turn") {
        event.userText = "";
        event.assistantText = "";
      } else if (event.type === "feedback" && event.text !== undefined) {
        event.text = "";
      }
      // The proposal quotes the same text (ops, rationale, notes): it goes with it.
      this.events.set(key, { ...row, event, proposal: null, scrubbedAt: now, updatedAt: now });
      scrubbed += 1;
    }
    return scrubbed;
  }

  // ── Governance ──

  async listAudit(ref: SubjectRef, limit: number): Promise<AuditEntry[]> {
    await this.enter();
    const tenant = tenantKey(ref.tenantId);
    return this.audit
      .filter((entry) => tenantKey(entry.tenantId) === tenant && entry.subjectId === ref.subjectId)
      .sort((a, b) => ms(a.at) - ms(b.at))
      .reverse()
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  async purge(q: { tenantId: string | null; eventsOlderThan?: string; auditOlderThan?: string }): Promise<{ events: number; audit: number }> {
    await this.enter();
    const tenant = tenantKey(q.tenantId);
    let events = 0;
    if (q.eventsOlderThan !== undefined) {
      const threshold = ms(q.eventsOlderThan);
      for (const [key, row] of this.events.entries()) {
        if (tenantKey(row.tenantId) === tenant && row.status === "done" && ms(row.createdAt) < threshold) {
          this.events.delete(key);
          events += 1;
        }
      }
    }
    let audit = 0;
    if (q.auditOlderThan !== undefined) {
      const threshold = ms(q.auditOlderThan);
      const before = this.audit.length;
      this.audit = this.audit.filter((entry) => !(tenantKey(entry.tenantId) === tenant && ms(entry.at) < threshold));
      audit = before - this.audit.length;
    }
    return { events, audit };
  }

  // ── Vectors ──

  /** Brute-force cosine over the subject's active nodes that carry an embedding. */
  async searchNodesByEmbedding(ref: SubjectRef, vector: number[], limit: number): Promise<{ nodeId: string; score: number }[]> {
    await this.enter();
    const bucket = this.subjects.get(subjectKey(ref));
    if (!bucket) return [];
    return [...bucket.nodes.values()]
      .filter((node): node is TopicNode & { embedding: number[] } => node.status === "active" && node.embedding !== undefined)
      .map((node) => ({ nodeId: node.id, score: cosine(vector, node.embedding) }))
      .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
      .slice(0, Math.max(0, limit));
  }

  // ── Serialisation ──

  /** The whole store as plain JSON (a deep copy), for fixtures and golden files. */
  snapshot(): MemoryStoreSnapshot {
    return clone({
      format: MEMORY_STORE_FORMAT,
      subjects: [...this.subjects.values()].map((bucket) => ({
        ...bucket.meta,
        nodes: [...bucket.nodes.values()],
        hints: [...bucket.hints.values()],
      })),
      events: [...this.events.values()],
      audit: [...this.audit],
    });
  }

  /**
   * Replace the store's contents with a validated snapshot. Every row goes
   * through the engine's own validators and the slot invariant, so a bad
   * fixture fails here with a pointer to the field, not later inside recall.
   */
  load(s: unknown): void {
    const result = snapshotValidator(s);
    if (!result.ok) {
      throw invalidSnapshot(result.issues.map((issue) => `${issue.path || "/"}: ${issue.message}`).join("; "));
    }
    const subjects = new Map<string, SubjectBucket>();
    result.value.subjects.forEach(({ nodes, hints, ...meta }, i) => {
      const at = `/subjects/${i}`;
      const key = subjectKey(meta);
      if (subjects.has(key)) throw invalidSnapshot(`${at}: ${subjectLabel(meta)} appears twice`);
      const bucket: SubjectBucket = { meta, nodes: new Map(), hints: new Map() };
      nodes.forEach((node, j) => {
        if (!sameSubject(node, meta)) throw invalidSnapshot(`${at}/nodes/${j}: node ${node.id} ${misfiled(node, meta)}`);
        if (bucket.nodes.has(node.id)) throw invalidSnapshot(`${at}/nodes/${j}/id: node ${node.id} appears twice`);
        const holder = pathClash(bucket.nodes, node);
        if (holder) throw invalidSnapshot(`${at}/nodes/${j}/path: ${pathConflictMessage(node, holder)}`);
        bucket.nodes.set(node.id, node);
      });
      hints.forEach((hint, j) => {
        if (!sameSubject(hint, meta)) throw invalidSnapshot(`${at}/hints/${j}: hint ${hint.id} ${misfiled(hint, meta)}`);
        if (bucket.hints.has(hint.id)) throw invalidSnapshot(`${at}/hints/${j}/id: hint ${hint.id} appears twice`);
        const other = hint.status === "active" ? slotClash(bucket.hints, hint) : undefined;
        if (other) throw invalidSnapshot(`${at}/hints/${j}/slot: ${slotConflictMessage(hint, other)}`);
        bucket.hints.set(hint.id, hint);
      });
      subjects.set(key, bucket);
    });
    const events = new Map<string, StoredEvent>();
    result.value.events.forEach((row, i) => {
      const key = eventKey(row.tenantId, row.event.id);
      if (events.has(key)) throw invalidSnapshot(`/events/${i}: event ${row.event.id} appears twice for tenant ${JSON.stringify(row.tenantId)}`);
      events.set(key, row);
    });
    this.subjects = subjects;
    this.events = events;
    this.audit = [...result.value.audit];
    this.failure = undefined;
  }
}
