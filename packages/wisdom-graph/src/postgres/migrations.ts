/**
 * migrations.ts — the `kg_*` schema as ordered migrations, rendered for the
 * consumer's migration owner or applied by `setup()` for development.
 *
 * Must-have 8 asks for two things at once: SQL the consumer's migration owner can
 * include in its own migration run, and a `setup(pool)` like
 * `PostgresSaver.setup()`. Both come from one list. `renderMigrationsSql`
 * concatenates it under `-- kg migration <id>` headers; `setup` applies
 * what `kg_migrations` does not yet record, each in its own transaction,
 * under a database-wide advisory lock so two instances booting together do
 * not race on DDL. Every statement is `IF NOT EXISTS`, so a rendered file
 * that was run by hand and a later `setup()` cannot fight: the second pass
 * changes nothing and records the id.
 *
 * `0002_pgvector` exists only when asked for. The vector dimension is baked
 * into the DDL because `vector(D)` is a column type, not a value; the store
 * is given the same number so it can refuse a mis-sized embedding before the
 * database does.
 *
 * One departure from spec §7.3's DDL: `kg_hints.node_id` carries no foreign
 * key to `kg_nodes`. The store contract (§7.1) allows a hint row whose node
 * has not been materialised — recall overlays virtual category nodes, and
 * the suite writes such rows — so the constraint would make the contract
 * unsatisfiable. Nodes and hints are deleted together by `deleteSubject`.
 */

import { noopLogger, type LoggerPort } from "../core/ports";
import { hasConnect, type PgPoolLike } from "./client";

export interface Migration {
  id: string;
  sql: string;
  requires?: "pgvector";
}

export interface MigrationOptions {
  pgvector?: boolean;
  /** Width of `kg_node_vectors.vec`; default 1536. */
  vectorDimensions?: number;
}

export interface SetupOptions extends MigrationOptions {
  logger?: LoggerPort;
}

export interface SetupResult {
  applied: string[];
  skipped: string[];
}

export const DEFAULT_VECTOR_DIMENSIONS = 1536;

/** The migrations ledger, created by `setup` before it reads it and shipped as the first statement of the rendered SQL. */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS kg_migrations (
  id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`;

const SCHEMA_SQL = `${MIGRATIONS_TABLE}

CREATE TABLE IF NOT EXISTS kg_subjects (
  tenant_id text NOT NULL DEFAULT '', subject_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  slot_aliases jsonb NOT NULL DEFAULT '{}', tombstones text[] NOT NULL DEFAULT '{}',
  last_consolidated_event text, events_since_consolidation int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id));

CREATE TABLE IF NOT EXISTS kg_nodes (
  id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT '', subject_id text NOT NULL,
  path text NOT NULL, parent_path text, slug text NOT NULL, level smallint NOT NULL, locked boolean NOT NULL DEFAULT false,
  title text NOT NULL, description text NOT NULL DEFAULT '',
  keywords text[] NOT NULL DEFAULT '{}', patterns text[] NOT NULL DEFAULT '{}', agents text[] NOT NULL DEFAULT '{}',
  properties jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'active', merged_into text,
  stats jsonb NOT NULL DEFAULT '{"activeHints":0}', embedding_json jsonb,
  version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, path),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES kg_subjects (tenant_id, subject_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS kg_nodes_snapshot ON kg_nodes (tenant_id, subject_id) WHERE status IN ('active','merged');

CREATE TABLE IF NOT EXISTS kg_hints (
  id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT '', subject_id text NOT NULL,
  node_id text NOT NULL, node_path text NOT NULL,
  slot text NOT NULL, value text NOT NULL, text text NOT NULL,
  kind text NOT NULL, lane text NOT NULL, scope text NOT NULL, agent text, client_id text,
  source text NOT NULL, confidence real NOT NULL, priority smallint NOT NULL,
  status text NOT NULL DEFAULT 'active', approval text NOT NULL DEFAULT 'auto', maturity text NOT NULL DEFAULT 'captured',
  needs_review boolean NOT NULL DEFAULT false,
  supersedes text, superseded_by text, retired_reason text,
  reinforcements int NOT NULL DEFAULT 0, contradictions int NOT NULL DEFAULT 0, applied int NOT NULL DEFAULT 0,
  provenance jsonb NOT NULL, version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  last_reinforced_at timestamptz NOT NULL DEFAULT now(), last_applied_at timestamptz,
  CONSTRAINT kg_hints_scope_agent CHECK (scope <> 'agent' OR agent IS NOT NULL),
  CONSTRAINT kg_hints_scope_client CHECK (scope <> 'client' OR client_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS kg_hints_snapshot ON kg_hints (tenant_id, subject_id, status);
CREATE INDEX IF NOT EXISTS kg_hints_node ON kg_hints (node_id);
CREATE UNIQUE INDEX IF NOT EXISTS kg_hints_slot_active ON kg_hints
  (tenant_id, subject_id, node_path, slot, scope, COALESCE(agent,''), COALESCE(client_id,'')) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS kg_events (
  tenant_id text NOT NULL DEFAULT '', id text NOT NULL, subject_id text NOT NULL, kind text NOT NULL, run_id text,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, error text,
  lease_until timestamptz, retry_at timestamptz, proposal jsonb, result jsonb, scrubbed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id));
CREATE INDEX IF NOT EXISTS kg_events_work ON kg_events (tenant_id, created_at) WHERE status IN ('pending','failed','processing');
CREATE INDEX IF NOT EXISTS kg_events_run ON kg_events (tenant_id, subject_id, run_id) WHERE kind = 'turn';
CREATE INDEX IF NOT EXISTS kg_events_subject ON kg_events (tenant_id, subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kg_audit (
  id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT '', subject_id text NOT NULL, at timestamptz NOT NULL,
  actor text NOT NULL, action text NOT NULL, hint_id text, node_path text, event_id text, detail jsonb NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS kg_audit_subject ON kg_audit (tenant_id, subject_id, at DESC);`;

function pgvectorSql(dimensions: number): string {
  return `CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS kg_node_vectors (
  node_id text PRIMARY KEY REFERENCES kg_nodes (id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT '', subject_id text NOT NULL, vec vector(${dimensions}) NOT NULL);
CREATE INDEX IF NOT EXISTS kg_node_vectors_hnsw ON kg_node_vectors USING hnsw (vec vector_cosine_ops);
CREATE INDEX IF NOT EXISTS kg_node_vectors_subject ON kg_node_vectors (tenant_id, subject_id);`;
}

/** A column width must be a positive integer; anything else would be interpolated into DDL. */
export function resolveVectorDimensions(value: number | undefined): number {
  const dimensions = value ?? DEFAULT_VECTOR_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new TypeError(`vectorDimensions must be a positive integer, got ${String(value)}`);
  return dimensions;
}

/** The ordered list; `0002_pgvector` only with `{ pgvector: true }`. */
export function migrations(opts: MigrationOptions = {}): Migration[] {
  const list: Migration[] = [{ id: "0001_schema", sql: SCHEMA_SQL }];
  if (opts.pgvector) list.push({ id: "0002_pgvector", sql: pgvectorSql(resolveVectorDimensions(opts.vectorDimensions)), requires: "pgvector" });
  return list;
}

/** Every migration under a `-- kg migration <id>` header, for a migration owner to include as one file. */
export function renderMigrationsSql(opts: MigrationOptions = {}): string {
  return migrations(opts)
    .map((m) => `-- kg migration ${m.id}${m.requires ? ` (requires ${m.requires})` : ""}\n${m.sql}\n`)
    .join("\n");
}

const LOCK = "SELECT pg_advisory_lock(hashtext('kg_migrations'))";
const UNLOCK = "SELECT pg_advisory_unlock(hashtext('kg_migrations'))";

function idOf(row: unknown): string | undefined {
  return typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" ? row.id : undefined;
}

/**
 * Apply what `kg_migrations` does not record, one transaction each, under
 * the advisory lock. Returns which ids ran and which were already there, so
 * a second call reports `{ applied: [], skipped: [...] }`.
 */
export async function setup(pool: PgPoolLike, opts: SetupOptions = {}): Promise<SetupResult> {
  if (!hasConnect(pool)) throw new TypeError("setup requires a pool with connect()");
  const logger = opts.logger ?? noopLogger;
  const wanted = migrations(opts);
  const client = await pool.connect();
  // A connection that failed mid-statement is handed back with the error so the pool discards it.
  let broken: unknown;
  try {
    await client.query(LOCK);
    try {
      await client.query(MIGRATIONS_TABLE);
      const recorded = await client.query("SELECT id FROM kg_migrations");
      const done = new Set(recorded.rows.map(idOf).filter((id): id is string => id !== undefined));
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const migration of wanted) {
        if (done.has(migration.id)) {
          skipped.push(migration.id);
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query("INSERT INTO kg_migrations (id) VALUES ($1)", [migration.id]);
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            broken = rollbackError;
          }
          throw error;
        }
        applied.push(migration.id);
        logger.info({ lib: "wisdom-graph", op: "setup", migration: migration.id }, "setup.applied");
      }
      return { applied, skipped };
    } finally {
      // The lock is session-scoped: a connection the pool will discard releases it by closing.
      if (broken === undefined) await client.query(UNLOCK);
    }
  } finally {
    if (broken === undefined) client.release();
    else client.release(broken);
  }
}
