/**
 * sql.ts — every statement the Postgres store runs, as pure builders, and
 * the decoders that turn the rows they read back into port shapes.
 *
 * A builder returns `{ text, params }` and never touches a client, so the
 * whole SQL surface is testable with a recording fake: what the store sends
 * is asserted statement by statement, and one sweep proves that every
 * statement names `tenant_id` — the mechanical form of spec §7.3's tenant
 * isolation. The encoders and decoders for a table sit next to each other
 * because they are two directions of the same column map and must be
 * reviewed together.
 *
 * Choices that are not obvious from the SQL:
 *
 *   - `null` and `''` are the same tenant (§7.1, decision 9). Builders write
 *     `''`; decoders hand back `null`. Nothing outside this file sees `''`.
 *   - jsonb parameters are stringified here, not left to the driver.
 *     node-postgres turns a JS array into a Postgres array, so an embedding
 *     or a proposal handed over raw would arrive as `text[]` and fail the
 *     jsonb cast. Stringifying makes every builder driver-agnostic.
 *   - Every parameter in an `INSERT … SELECT` list carries an explicit cast:
 *     a bare `$n` in a SELECT list types as `unknown` → `text` and is then
 *     refused by a typed column. The SELECT form is needed wherever a write
 *     is conditional — a hint insert gated on the subject's tombstones, a
 *     vector insert gated on its node existing.
 *   - Reads come back as JSON (`row_to_json`, `json_agg`) so the row shape is
 *     the same whether the driver's type parsers are default or overridden;
 *     the decoders normalise timestamps to `toISOString()` form, which is
 *     what the validators and the fixtures compare, and read bigint columns
 *     as numbers.
 *   - Decoders map columns and nothing more. A row that came back wrong
 *     reaches `compileSnapshot` with its pointer intact and is dropped and
 *     logged there (§7.3); repairing it here would hide a corrupt table.
 *   - The path and slot invariants are checked with a SELECT before the
 *     write, so the error names the holder exactly as the memory store's
 *     does and the contract suite reads the same message from both stores.
 *     The unique constraints stay as the backstop for anything that slips
 *     past.
 *   - Timestamps the store owns (`updated_at`, `scrubbed_at`, an event's
 *     `created_at`) come from the database's `now()`; the only instants that
 *     travel as parameters are the ones the caller defines — a row's own
 *     `createdAt`, a lease computed from the caller's `now`.
 */

import type { GraphSnapshotData, LeaseQuery, NodePatch, StoredEvent, StoredEventBody, StoredEventPatch, SubjectRef } from "../core/ports";
import type { AuditEntry, EventStatus, HintRecord, HintStatus, TopicNode, TurnEvent } from "../core/types";

export interface SqlStatement {
  text: string;
  params: unknown[];
}

/** Which of the two vector storage locations is in use (§7.3: one or the other, never both). */
export interface SqlMode {
  pgvector: boolean;
}

/** Every status a lease may pick up when the caller names none: anything not finished (matches the memory store). */
export const LEASABLE_STATUSES: readonly EventStatus[] = ["pending", "failed", "processing"];

// ── Parameters and the tenant boundary ───────────────────────────────────────

/** Collects parameters and hands back their placeholders, so a dynamic SET list cannot misnumber them. */
class Params {
  readonly list: unknown[] = [];

  add(value: unknown): string {
    this.list.push(value);
    return `$${this.list.length}`;
  }
}

/** `null` and `""` are the same tenant at the store boundary; the column holds `''`. */
export function tenantColumn(tenantId: string | null | undefined): string {
  return tenantId ?? "";
}

/** The column value as the port reports it: `''` becomes `null`. */
export function tenantOut(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function jsonb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** pgvector's text form, which is also JSON: `[0.1,0.2]`. */
export function vectorLiteral(vector: number[]): string {
  return JSON.stringify(vector);
}

function refParams(p: Params, ref: SubjectRef): { tenant: string; subject: string } {
  return { tenant: p.add(tenantColumn(ref.tenantId)), subject: p.add(ref.subjectId) };
}

// ── kg_subjects ──────────────────────────────────────────────────────────────

/** The subject row, created on first write at version 0 (§7.3: "insert the subject row if missing"). */
export function ensureSubject(ref: SubjectRef): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  return {
    text: `INSERT INTO kg_subjects (tenant_id, subject_id) VALUES (${tenant}, ${subject}) ON CONFLICT (tenant_id, subject_id) DO NOTHING`,
    params: p.list,
  };
}

/**
 * The optimistic bump: zero rows back means the version the caller expected
 * is not the one stored (or, with no expectation, that the row vanished).
 * The row lock this takes is what serialises concurrent batches on one subject.
 */
export function bumpVersion(ref: SubjectRef, expectVersion?: number): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const expected = p.add(expectVersion ?? null);
  return {
    text:
      `UPDATE kg_subjects SET version = version + 1, updated_at = now() ` +
      `WHERE tenant_id = ${tenant} AND subject_id = ${subject} AND (${expected}::bigint IS NULL OR version = ${expected}::bigint) RETURNING version`,
    params: p.list,
  };
}

/** What the version actually is, for the conflict error's `actual`. */
export function readVersion(ref: SubjectRef): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  return { text: `SELECT version FROM kg_subjects WHERE tenant_id = ${tenant} AND subject_id = ${subject}`, params: p.list };
}

export function setSlotAlias(ref: SubjectRef, from: string, to: string): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  return {
    text:
      `UPDATE kg_subjects SET slot_aliases = slot_aliases || jsonb_build_object(${p.add(from)}::text, ${p.add(to)}::text), updated_at = now() ` +
      `WHERE tenant_id = ${tenant} AND subject_id = ${subject}`,
    params: p.list,
  };
}

/** Appends once: an id already present keeps its position, so the list reads in the order hints were forgotten. */
export function addTombstone(ref: SubjectRef, hintId: string): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const id = p.add(hintId);
  return {
    text:
      `UPDATE kg_subjects SET tombstones = CASE WHEN ${id}::text = ANY (tombstones) THEN tombstones ELSE array_append(tombstones, ${id}::text) END, updated_at = now() ` +
      `WHERE tenant_id = ${tenant} AND subject_id = ${subject}`,
    params: p.list,
  };
}

/** `reset` records when it ran in `last_consolidated_event`: the op carries no event id, and the instant is what explain() wants. */
export function consolidationCounter(ref: SubjectRef, action: "increment" | "reset"): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const set =
    action === "increment"
      ? "events_since_consolidation = events_since_consolidation + 1"
      : "events_since_consolidation = 0, last_consolidated_event = now()::text";
  return { text: `UPDATE kg_subjects SET ${set}, updated_at = now() WHERE tenant_id = ${tenant} AND subject_id = ${subject}`, params: p.list };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/** Spec §7.3's one round-trip: subject row, live nodes, hints in the requested statuses, and vectors only with pgvector. */
export function snapshotQuery(ref: SubjectRef, statuses: HintStatus[], mode: SqlMode): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const wanted = p.add(statuses);
  const columns = [
    `(SELECT row_to_json(s) FROM kg_subjects s WHERE s.tenant_id = ${tenant} AND s.subject_id = ${subject}) AS subject`,
    `(SELECT COALESCE(json_agg(n), '[]') FROM kg_nodes n WHERE n.tenant_id = ${tenant} AND n.subject_id = ${subject} AND n.status IN ('active','merged')) AS nodes`,
    `(SELECT COALESCE(json_agg(h), '[]') FROM kg_hints h WHERE h.tenant_id = ${tenant} AND h.subject_id = ${subject} AND h.status = ANY (${wanted}::text[])) AS hints`,
  ];
  if (mode.pgvector) {
    columns.push(
      `(SELECT COALESCE(json_agg(json_build_object('node_id', v.node_id, 'vec', v.vec::text)), '[]') FROM kg_node_vectors v WHERE v.tenant_id = ${tenant} AND v.subject_id = ${subject}) AS vectors`,
    );
  }
  return { text: `SELECT ${columns.join(", ")}`, params: p.list };
}

// ── kg_nodes ─────────────────────────────────────────────────────────────────

type Column = readonly [name: string, cast: string];

const NODE_COLUMNS: readonly Column[] = [
  ["id", "text"],
  ["tenant_id", "text"],
  ["subject_id", "text"],
  ["path", "text"],
  ["parent_path", "text"],
  ["slug", "text"],
  ["level", "smallint"],
  ["locked", "boolean"],
  ["title", "text"],
  ["description", "text"],
  ["keywords", "text[]"],
  ["patterns", "text[]"],
  ["agents", "text[]"],
  ["properties", "jsonb"],
  ["status", "text"],
  ["merged_into", "text"],
  ["stats", "jsonb"],
  ["embedding_json", "jsonb"],
  ["version", "int"],
  ["created_at", "timestamptz"],
  ["updated_at", "timestamptz"],
];

/** Column values in `NODE_COLUMNS` order. `embedding_json` is written only without pgvector (§7.3: one storage location). */
function nodeValues(ref: SubjectRef, node: TopicNode, mode: SqlMode): unknown[] {
  return [
    node.id,
    tenantColumn(ref.tenantId),
    ref.subjectId,
    node.path,
    node.parentPath,
    node.slug,
    node.level,
    node.locked,
    node.title,
    node.description,
    node.keywords,
    node.patterns,
    node.agents,
    jsonb(node.properties),
    node.status,
    node.mergedInto ?? null,
    jsonb(node.stats),
    mode.pgvector ? null : jsonb(node.embedding),
    node.version,
    node.createdAt,
    node.updatedAt,
  ];
}

/** `col = EXCLUDED.col` for every column but the key, and a guard so a colliding id in another tenant is never overwritten. */
function conflictUpdate(table: string, columns: readonly Column[], key: string): string {
  const sets = columns
    .map(([name]) => name)
    .filter((name) => name !== key)
    .map((name) => `${name} = EXCLUDED.${name}`);
  return `ON CONFLICT (${key}) DO UPDATE SET ${sets.join(", ")} WHERE ${table}.tenant_id = EXCLUDED.tenant_id AND ${table}.subject_id = EXCLUDED.subject_id`;
}

/** The node already holding this path under another id, if any — the memory store's `pathClash`, as a query. */
export function nodePathHolder(ref: SubjectRef, node: Pick<TopicNode, "id" | "path">): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  return {
    text: `SELECT id FROM kg_nodes WHERE tenant_id = ${tenant} AND subject_id = ${subject} AND path = ${p.add(node.path)} AND id <> ${p.add(node.id)} LIMIT 1`,
    params: p.list,
  };
}

/** Insert or replace by id: the whole row is the caller's, as `upsertNode` replaces the whole node. */
export function upsertNodeRow(ref: SubjectRef, node: TopicNode, mode: SqlMode): SqlStatement {
  const p = new Params();
  const values = nodeValues(ref, node, mode);
  const placeholders = NODE_COLUMNS.map(([, cast], i) => `${p.add(values[i])}::${cast}`);
  return {
    text:
      `INSERT INTO kg_nodes (${NODE_COLUMNS.map(([name]) => name).join(", ")}) VALUES (${placeholders.join(", ")}) ` +
      conflictUpdate("kg_nodes", NODE_COLUMNS, "id"),
    params: p.list,
  };
}

/** Only the patched fields, plus the version bump and `updated_at` a patch always carries. Embedding goes to the vector table with pgvector. */
export function patchNodeRow(ref: SubjectRef, nodeId: string, patch: NodePatch, mode: SqlMode): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const id = p.add(nodeId);
  const sets: string[] = [];
  if (patch.title !== undefined) sets.push(`title = ${p.add(patch.title)}::text`);
  if (patch.description !== undefined) sets.push(`description = ${p.add(patch.description)}::text`);
  if (patch.keywords !== undefined) sets.push(`keywords = ${p.add(patch.keywords)}::text[]`);
  if (patch.agents !== undefined) sets.push(`agents = ${p.add(patch.agents)}::text[]`);
  if (patch.properties !== undefined) sets.push(`properties = ${p.add(jsonb(patch.properties))}::jsonb`);
  if (patch.status !== undefined) sets.push(`status = ${p.add(patch.status)}::text`);
  if (patch.mergedInto !== undefined) sets.push(`merged_into = ${p.add(patch.mergedInto)}::text`);
  if (patch.stats !== undefined) sets.push(`stats = ${p.add(jsonb(patch.stats))}::jsonb`);
  if (patch.embedding !== undefined && !mode.pgvector) sets.push(`embedding_json = ${p.add(jsonb(patch.embedding))}::jsonb`);
  sets.push("version = version + 1", "updated_at = now()");
  return {
    text: `UPDATE kg_nodes SET ${sets.join(", ")} WHERE tenant_id = ${tenant} AND subject_id = ${subject} AND id = ${id}`,
    params: p.list,
  };
}

// ── kg_node_vectors (pgvector only) ──────────────────────────────────────────

/** Written only for a node that exists, so a patch of an unknown id stays the no-op the contract requires. */
export function upsertNodeVector(ref: SubjectRef, nodeId: string, embedding: number[]): SqlStatement {
  const p = new Params();
  const id = p.add(nodeId);
  const { tenant, subject } = refParams(p, ref);
  const vec = p.add(vectorLiteral(embedding));
  return {
    text:
      `INSERT INTO kg_node_vectors (node_id, tenant_id, subject_id, vec) SELECT ${id}::text, ${tenant}::text, ${subject}::text, ${vec}::vector ` +
      `WHERE EXISTS (SELECT 1 FROM kg_nodes WHERE id = ${id} AND tenant_id = ${tenant} AND subject_id = ${subject}) ` +
      `ON CONFLICT (node_id) DO UPDATE SET vec = EXCLUDED.vec WHERE kg_node_vectors.tenant_id = EXCLUDED.tenant_id AND kg_node_vectors.subject_id = EXCLUDED.subject_id`,
    params: p.list,
  };
}

/** An `upsertNode` without an embedding replaces the node without one: the vector goes too. */
export function deleteNodeVector(ref: SubjectRef, nodeId: string): SqlStatement {
  const p = new Params();
  const id = p.add(nodeId);
  const { tenant, subject } = refParams(p, ref);
  return { text: `DELETE FROM kg_node_vectors WHERE node_id = ${id} AND tenant_id = ${tenant} AND subject_id = ${subject}`, params: p.list };
}

/** Cosine similarity over the subject's active nodes; ordered by the distance operator so the hnsw index applies. */
export function searchNodes(ref: SubjectRef, vector: number[], limit: number): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const vec = p.add(vectorLiteral(vector));
  return {
    text:
      `SELECT v.node_id, 1 - (v.vec <=> ${vec}::vector) AS score FROM kg_node_vectors v ` +
      `JOIN kg_nodes n ON n.id = v.node_id AND n.tenant_id = v.tenant_id AND n.subject_id = v.subject_id ` +
      `WHERE v.tenant_id = ${tenant} AND v.subject_id = ${subject} AND n.status = 'active' ` +
      `ORDER BY v.vec <=> ${vec}::vector, v.node_id LIMIT ${p.add(Math.max(0, limit))}::int`,
    params: p.list,
  };
}

// ── kg_hints ─────────────────────────────────────────────────────────────────

const HINT_COLUMNS: readonly Column[] = [
  ["id", "text"],
  ["tenant_id", "text"],
  ["subject_id", "text"],
  ["node_id", "text"],
  ["node_path", "text"],
  ["slot", "text"],
  ["value", "text"],
  ["text", "text"],
  ["kind", "text"],
  ["lane", "text"],
  ["scope", "text"],
  ["agent", "text"],
  ["client_id", "text"],
  ["source", "text"],
  ["confidence", "real"],
  ["priority", "smallint"],
  ["status", "text"],
  ["approval", "text"],
  ["maturity", "text"],
  ["needs_review", "boolean"],
  ["supersedes", "text"],
  ["superseded_by", "text"],
  ["retired_reason", "text"],
  ["reinforcements", "int"],
  ["contradictions", "int"],
  ["applied", "int"],
  ["provenance", "jsonb"],
  ["version", "int"],
  ["created_at", "timestamptz"],
  ["updated_at", "timestamptz"],
  ["last_reinforced_at", "timestamptz"],
  ["last_applied_at", "timestamptz"],
];

function hintValues(ref: SubjectRef, hint: HintRecord): unknown[] {
  return [
    hint.id,
    tenantColumn(ref.tenantId),
    ref.subjectId,
    hint.nodeId,
    hint.nodePath,
    hint.slot,
    hint.value,
    hint.text,
    hint.kind,
    hint.lane,
    hint.scope,
    hint.agent ?? null,
    hint.clientId ?? null,
    hint.source,
    hint.confidence,
    hint.priority,
    hint.status,
    hint.approval,
    hint.maturity,
    hint.needsReview,
    hint.supersedes ?? null,
    hint.supersededBy ?? null,
    hint.retiredReason ?? null,
    hint.reinforcements,
    hint.contradictions,
    hint.applied,
    jsonb(hint.provenance),
    hint.version,
    hint.createdAt,
    hint.updatedAt,
    hint.lastReinforcedAt,
    hint.lastAppliedAt ?? null,
  ];
}

/**
 * The active hint already holding this hint's applicability key under
 * another id (§3.1's slot invariant; the partial unique index in SQL). Reads
 * as "no holder" for a tombstoned id, because the upsert it guards will not
 * happen either.
 */
export function slotHolder(ref: SubjectRef, hint: Pick<HintRecord, "id" | "nodePath" | "slot" | "scope" | "agent" | "clientId">): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const id = p.add(hint.id);
  return {
    text:
      `SELECT h.id FROM kg_hints h WHERE h.tenant_id = ${tenant} AND h.subject_id = ${subject} ` +
      `AND h.node_path = ${p.add(hint.nodePath)} AND h.slot = ${p.add(hint.slot)} AND h.scope = ${p.add(hint.scope)} ` +
      `AND COALESCE(h.agent, '') = ${p.add(hint.agent ?? "")} AND COALESCE(h.client_id, '') = ${p.add(hint.clientId ?? "")} ` +
      `AND h.status = 'active' AND h.id <> ${id} ` +
      `AND NOT EXISTS (SELECT 1 FROM kg_subjects s WHERE s.tenant_id = ${tenant} AND s.subject_id = ${subject} AND ${id} = ANY (s.tombstones)) LIMIT 1`,
    params: p.list,
  };
}

/** Insert or replace by id, skipped when the subject has tombstoned the id — including by an earlier op of the same batch. */
export function upsertHintRow(ref: SubjectRef, hint: HintRecord): SqlStatement {
  const p = new Params();
  const values = hintValues(ref, hint);
  const placeholders = HINT_COLUMNS.map(([, cast], i) => `${p.add(values[i])}::${cast}`);
  // $1 is the id and $2/$3 the subject key, by `HINT_COLUMNS` order.
  return {
    text:
      `INSERT INTO kg_hints (${HINT_COLUMNS.map(([name]) => name).join(", ")}) SELECT ${placeholders.join(", ")} ` +
      `WHERE NOT EXISTS (SELECT 1 FROM kg_subjects s WHERE s.tenant_id = $2 AND s.subject_id = $3 AND $1 = ANY (s.tombstones)) ` +
      conflictUpdate("kg_hints", HINT_COLUMNS, "id"),
    params: p.list,
  };
}

/** The whole row after a patch, with `updated_at` from the database rather than the patched record. */
export function updateHintRow(ref: SubjectRef, hint: HintRecord): SqlStatement {
  const p = new Params();
  const values = hintValues(ref, hint);
  const sets = HINT_COLUMNS.flatMap(([name, cast], i) => {
    if (name === "id" || name === "tenant_id" || name === "subject_id" || name === "updated_at") return [];
    return [`${name} = ${p.add(values[i])}::${cast}`];
  });
  sets.push("updated_at = now()");
  const id = p.add(hint.id);
  const { tenant, subject } = refParams(p, ref);
  return {
    text: `UPDATE kg_hints SET ${sets.join(", ")} WHERE tenant_id = ${tenant} AND subject_id = ${subject} AND id = ${id}`,
    params: p.list,
  };
}

export function selectHint(ref: SubjectRef, hintId: string): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  return {
    text: `SELECT row_to_json(h) AS data FROM kg_hints h WHERE h.tenant_id = ${tenant} AND h.subject_id = ${subject} AND h.id = ${p.add(hintId)}`,
    params: p.list,
  };
}

export function deleteHintRow(ref: SubjectRef, hintId: string): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  return {
    text: `DELETE FROM kg_hints WHERE tenant_id = ${tenant} AND subject_id = ${subject} AND id = ${p.add(hintId)} RETURNING id`,
    params: p.list,
  };
}

// ── kg_audit ─────────────────────────────────────────────────────────────────

/** A replayed event mints the same audit ids (decision 12), so a repeat is a no-op rather than a duplicate-key error. */
export function insertAudit(ref: SubjectRef, entry: AuditEntry): SqlStatement {
  const p = new Params();
  return {
    text:
      `INSERT INTO kg_audit (id, tenant_id, subject_id, at, actor, action, hint_id, node_path, event_id, detail) VALUES (` +
      [
        p.add(entry.id),
        p.add(tenantColumn(ref.tenantId)),
        p.add(ref.subjectId),
        `${p.add(entry.at)}::timestamptz`,
        p.add(entry.actor),
        p.add(entry.action),
        p.add(entry.hintId ?? null),
        p.add(entry.nodePath ?? null),
        p.add(entry.eventId ?? null),
        `${p.add(jsonb(entry.detail))}::jsonb`,
      ].join(", ") +
      `) ON CONFLICT (id) DO NOTHING`,
    params: p.list,
  };
}

export function listAudit(ref: SubjectRef, limit: number): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  return {
    text:
      `SELECT row_to_json(a) AS data FROM kg_audit a WHERE a.tenant_id = ${tenant} AND a.subject_id = ${subject} ` +
      `ORDER BY a.at DESC, a.id DESC LIMIT ${p.add(Math.max(0, limit))}::int`,
    params: p.list,
  };
}

export function purgeAudit(tenantId: string | null, olderThan: string): SqlStatement {
  const p = new Params();
  return {
    text: `DELETE FROM kg_audit WHERE tenant_id = ${p.add(tenantColumn(tenantId))} AND at < ${p.add(olderThan)}::timestamptz RETURNING id`,
    params: p.list,
  };
}

// ── Subject deletion ─────────────────────────────────────────────────────────

/** Hints, events and audit are deleted by key; nodes (and their vectors) cascade from the subject row. */
export function deleteSubjectRows(ref: SubjectRef): SqlStatement[] {
  return ["kg_hints", "kg_events", "kg_audit", "kg_subjects"].map((table) => {
    const p = new Params();
    const { tenant, subject } = refParams(p, ref);
    return { text: `DELETE FROM ${table} WHERE tenant_id = ${tenant} AND subject_id = ${subject}`, params: p.list };
  });
}

// ── kg_events ────────────────────────────────────────────────────────────────

/** `claimed` when a row comes back, `duplicate` when the key already existed (the first body is kept). */
export function claimEvent(tenantId: string | null, ev: StoredEventBody): SqlStatement {
  const p = new Params();
  const runId = ev.type === "consolidate" ? null : ev.runId;
  return {
    text:
      `INSERT INTO kg_events (tenant_id, id, subject_id, kind, run_id, payload) VALUES (` +
      `${p.add(tenantColumn(tenantId))}, ${p.add(ev.id)}, ${p.add(ev.subjectId)}, ${p.add(ev.type)}, ${p.add(runId)}, ${p.add(jsonb(ev))}::jsonb` +
      `) ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`,
    params: p.list,
  };
}

/**
 * Decision 13's queue pattern: pick oldest-first with `FOR UPDATE SKIP
 * LOCKED` so two workers never lease the same row, then mark the picked rows
 * processing with a lease computed from the caller's `now`. A lease or a
 * retry instant still in the future (strictly after `now`) hides the row.
 */
export function leaseEvents(q: LeaseQuery): SqlStatement {
  const p = new Params();
  const tenant = p.add(tenantColumn(q.tenantId));
  const statuses = p.add(q.statuses ?? [...LEASABLE_STATUSES]);
  const now = p.add(new Date(q.now).toISOString());
  const ids = p.add(q.ids ?? null);
  const subject = p.add(q.subjectId ?? null);
  const limit = p.add(Math.max(0, q.limit));
  const leaseUntil = p.add(new Date(q.now + q.leaseMs).toISOString());
  return {
    text:
      `UPDATE kg_events e SET status = 'processing', lease_until = ${leaseUntil}::timestamptz, updated_at = now() FROM (` +
      `SELECT tenant_id, id FROM kg_events WHERE tenant_id = ${tenant} AND status = ANY (${statuses}::text[]) ` +
      `AND (lease_until IS NULL OR lease_until <= ${now}::timestamptz) AND (retry_at IS NULL OR retry_at <= ${now}::timestamptz) ` +
      `AND (${ids}::text[] IS NULL OR id = ANY (${ids}::text[])) AND (${subject}::text IS NULL OR subject_id = ${subject}::text) ` +
      `ORDER BY created_at, id LIMIT ${limit}::int FOR UPDATE SKIP LOCKED) picked ` +
      `WHERE e.tenant_id = picked.tenant_id AND e.id = picked.id RETURNING row_to_json(e) AS data`,
    params: p.list,
  };
}

/** Only the named fields change; leaving `processing` releases the lease unless the same patch renews it (§7.1 port doc). */
export function updateEvent(tenantId: string | null, id: string, patch: StoredEventPatch): SqlStatement {
  const p = new Params();
  const tenant = p.add(tenantColumn(tenantId));
  const key = p.add(id);
  const sets: string[] = [];
  if (patch.status !== undefined) sets.push(`status = ${p.add(patch.status)}::text`);
  if (patch.error !== undefined) sets.push(`error = ${p.add(patch.error)}::text`);
  if (patch.attempts !== undefined) sets.push(`attempts = ${p.add(patch.attempts)}::int`);
  if (patch.leaseUntil !== undefined) sets.push(`lease_until = ${p.add(patch.leaseUntil)}::timestamptz`);
  else if (patch.status !== undefined && patch.status !== "processing") sets.push("lease_until = NULL");
  if (patch.retryAt !== undefined) sets.push(`retry_at = ${p.add(patch.retryAt)}::timestamptz`);
  if (patch.proposal !== undefined) sets.push(`proposal = ${p.add(jsonb(patch.proposal))}::jsonb`);
  if (patch.result !== undefined) sets.push(`result = ${p.add(jsonb(patch.result))}::jsonb`);
  sets.push("updated_at = now()");
  return { text: `UPDATE kg_events SET ${sets.join(", ")} WHERE tenant_id = ${tenant} AND id = ${key}`, params: p.list };
}

export function selectEvent(tenantId: string | null, id: string): SqlStatement {
  const p = new Params();
  return {
    text: `SELECT row_to_json(e) AS data FROM kg_events e WHERE e.tenant_id = ${p.add(tenantColumn(tenantId))} AND e.id = ${p.add(id)}`,
    params: p.list,
  };
}

/** The subject's oldest turn with this run id — the payload as stored, so a scrubbed turn comes back blank. */
export function selectTurn(ref: SubjectRef, runId: string): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  return {
    text:
      `SELECT payload AS data FROM kg_events WHERE tenant_id = ${tenant} AND subject_id = ${subject} AND kind = 'turn' AND run_id = ${p.add(runId)} ` +
      `ORDER BY created_at, id LIMIT 1`,
    params: p.list,
  };
}

export function listEvents(ref: SubjectRef, q: { limit: number; statuses?: EventStatus[] }): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const statuses = p.add(q.statuses ?? null);
  return {
    text:
      `SELECT row_to_json(e) AS data FROM kg_events e WHERE e.tenant_id = ${tenant} AND e.subject_id = ${subject} ` +
      `AND (${statuses}::text[] IS NULL OR e.status = ANY (${statuses}::text[])) ` +
      `ORDER BY e.created_at DESC, e.id DESC LIMIT ${p.add(Math.max(0, q.limit))}::int`,
    params: p.list,
  };
}

/**
 * Blanks the text a turn or feedback carried, drops the stored proposal —
 * the model's ops, rationale and notes quote the same user text (§9.2), so a
 * scrub that kept them would keep what retention promised to remove — stamps
 * the row, and leaves `consolidate` rows alone: they hold no user text.
 */
export function scrubEvents(ref: SubjectRef, olderThan?: string): SqlStatement {
  const p = new Params();
  const { tenant, subject } = refParams(p, ref);
  const threshold = p.add(olderThan ?? null);
  return {
    text:
      `UPDATE kg_events SET payload = CASE kind ` +
      `WHEN 'turn' THEN payload || '{"userText":"","assistantText":""}'::jsonb ` +
      `WHEN 'feedback' THEN CASE WHEN payload ? 'text' THEN payload || '{"text":""}'::jsonb ELSE payload END ` +
      `ELSE payload END, proposal = NULL, scrubbed_at = now(), updated_at = now() ` +
      `WHERE tenant_id = ${tenant} AND subject_id = ${subject} AND kind IN ('turn','feedback') AND scrubbed_at IS NULL ` +
      `AND (${threshold}::timestamptz IS NULL OR created_at < ${threshold}::timestamptz) RETURNING id`,
    params: p.list,
  };
}

/** Retention deletes finished work only; pending, processing and failed rows are what `drain()` still owes the ledger. */
export function purgeEvents(tenantId: string | null, olderThan: string): SqlStatement {
  const p = new Params();
  return {
    text: `DELETE FROM kg_events WHERE tenant_id = ${p.add(tenantColumn(tenantId))} AND status = 'done' AND created_at < ${p.add(olderThan)}::timestamptz RETURNING id`,
    params: p.list,
  };
}

// ── Decoding rows ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function isRow(u: unknown): u is Row {
  return typeof u === "object" && u !== null && !Array.isArray(u);
}

/** A json/jsonb column, whether the driver parsed it or handed back text; unparseable text is left for the validator. */
function jsonOf(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** A timestamp in `toISOString()` form from a `Date` or any text Postgres emits; anything unparseable is left as it came. */
function isoOf(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : value.toISOString();
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  return value;
}

/** An integer column: bigint arrives as text from `pg`, as a number from JSON. */
function intOf(value: unknown): unknown {
  return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * The decoded row is trusted structurally, not semantically: `compileSnapshot`
 * re-validates every row (§7.3) and drops one that disagrees with the type,
 * so decoding maps columns and leaves judgement to the validator.
 */
function asRow<T>(value: Row): T {
  return value as T;
}

/** The `data` column of a `row_to_json(...) AS data` read, parsed. */
export function dataOf(row: unknown): unknown {
  return isRow(row) ? jsonOf(row.data) : undefined;
}

export function decodeVersion(row: unknown): number {
  const value = isRow(row) ? intOf(row.version) : undefined;
  return typeof value === "number" ? value : 0;
}

export function decodeNode(raw: unknown): TopicNode {
  const row = isRow(raw) ? raw : {};
  const out: Row = {
    id: row.id,
    tenantId: tenantOut(row.tenant_id),
    subjectId: row.subject_id,
    path: row.path,
    parentPath: row.parent_path ?? null,
    slug: row.slug,
    title: row.title,
    description: row.description,
    keywords: row.keywords,
    patterns: row.patterns,
    agents: row.agents,
    properties: jsonOf(row.properties),
    level: intOf(row.level),
    locked: row.locked,
    status: row.status,
    stats: jsonOf(row.stats),
    version: intOf(row.version),
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
  if (present(row.merged_into)) out.mergedInto = row.merged_into;
  const embedding = jsonOf(row.embedding_json);
  if (present(embedding)) out.embedding = embedding;
  return asRow<TopicNode>(out);
}

export function decodeHint(raw: unknown): HintRecord {
  const row = isRow(raw) ? raw : {};
  const out: Row = {
    id: row.id,
    tenantId: tenantOut(row.tenant_id),
    subjectId: row.subject_id,
    nodeId: row.node_id,
    nodePath: row.node_path,
    slot: row.slot,
    value: row.value,
    text: row.text,
    kind: row.kind,
    lane: row.lane,
    scope: row.scope,
    source: row.source,
    confidence: row.confidence,
    priority: intOf(row.priority),
    status: row.status,
    approval: row.approval,
    maturity: row.maturity,
    needsReview: row.needs_review,
    reinforcements: intOf(row.reinforcements),
    contradictions: intOf(row.contradictions),
    applied: intOf(row.applied),
    provenance: jsonOf(row.provenance),
    version: intOf(row.version),
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
    lastReinforcedAt: isoOf(row.last_reinforced_at),
  };
  const optional: [key: string, value: unknown][] = [
    ["agent", row.agent],
    ["clientId", row.client_id],
    ["supersedes", row.supersedes],
    ["supersededBy", row.superseded_by],
    ["retiredReason", row.retired_reason],
    ["lastAppliedAt", isoOf(row.last_applied_at)],
  ];
  for (const [key, value] of optional) if (present(value)) out[key] = value;
  return asRow<HintRecord>(out);
}

/** `proposal` is the one nullable field: a column NULL reads as `null`, as an explicit `proposal: null` patch would. */
export function decodeEvent(raw: unknown): StoredEvent {
  const row = isRow(raw) ? raw : {};
  const out: Row = {
    tenantId: tenantOut(row.tenant_id),
    event: jsonOf(row.payload),
    status: row.status,
    attempts: intOf(row.attempts),
    proposal: present(row.proposal) ? jsonOf(row.proposal) : null,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
  const optional: [key: string, value: unknown][] = [
    ["error", row.error],
    ["leaseUntil", isoOf(row.lease_until)],
    ["retryAt", isoOf(row.retry_at)],
    ["result", jsonOf(row.result)],
    ["scrubbedAt", isoOf(row.scrubbed_at)],
  ];
  for (const [key, value] of optional) if (present(value)) out[key] = value;
  return asRow<StoredEvent>(out);
}

export function decodeAudit(raw: unknown): AuditEntry {
  const row = isRow(raw) ? raw : {};
  const out: Row = {
    id: row.id,
    tenantId: tenantOut(row.tenant_id),
    subjectId: row.subject_id,
    at: isoOf(row.at),
    actor: row.actor,
    action: row.action,
    detail: jsonOf(row.detail),
  };
  const optional: [key: string, value: unknown][] = [
    ["hintId", row.hint_id],
    ["nodePath", row.node_path],
    ["eventId", row.event_id],
  ];
  for (const [key, value] of optional) if (present(value)) out[key] = value;
  return asRow<AuditEntry>(out);
}

export interface DecodedSubject {
  version: number;
  slotAliases: Record<string, string>;
  tombstones: string[];
  eventsSinceConsolidation: number;
}

export function decodeSubject(raw: unknown): DecodedSubject {
  const row = isRow(raw) ? raw : {};
  return asRow<DecodedSubject>({
    version: intOf(row.version),
    slotAliases: jsonOf(row.slot_aliases),
    tombstones: row.tombstones,
    eventsSinceConsolidation: intOf(row.events_since_consolidation),
  });
}

/** `{ node_id, vec }` rows from the vectors sub-select; a `vec` that is not a JSON array is skipped. */
export function decodeVectors(raw: unknown): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!isRow(entry) || typeof entry.node_id !== "string") continue;
    const vec = jsonOf(entry.vec);
    if (Array.isArray(vec) && vec.every((x) => typeof x === "number")) out.set(entry.node_id, vec);
  }
  return out;
}

/**
 * The one snapshot row → `GraphSnapshotData`. `null` when there is no subject
 * row and nothing under it (§7.3). Vectors, present only with pgvector, are
 * folded into their nodes so the engine reads `node.embedding` in both modes.
 */
export function decodeSnapshot(raw: unknown, ref: SubjectRef): GraphSnapshotData | null {
  const row = isRow(raw) ? raw : {};
  const subject = jsonOf(row.subject);
  const nodesRaw = jsonOf(row.nodes);
  const hintsRaw = jsonOf(row.hints);
  const nodes = Array.isArray(nodesRaw) ? nodesRaw.map(decodeNode) : [];
  const hints = Array.isArray(hintsRaw) ? hintsRaw.map(decodeHint) : [];
  if (!present(subject) && nodes.length === 0 && hints.length === 0) return null;
  const meta = decodeSubject(subject);
  const vectors = decodeVectors(jsonOf(row.vectors));
  for (const node of nodes) {
    const embedding = vectors.get(node.id);
    if (embedding !== undefined) node.embedding = embedding;
  }
  return {
    ref: { tenantId: tenantOut(tenantColumn(ref.tenantId)), subjectId: ref.subjectId },
    version: meta.version ?? 0,
    slotAliases: meta.slotAliases ?? {},
    tombstones: meta.tombstones ?? [],
    eventsSinceConsolidation: meta.eventsSinceConsolidation ?? 0,
    nodes,
    hints,
  };
}

/** A turn payload as stored; `null` when the read found no row. */
export function decodeTurn(raw: unknown): TurnEvent | null {
  return isRow(raw) ? asRow<TurnEvent>(raw) : null;
}
