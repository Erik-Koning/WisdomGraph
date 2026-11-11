/**
 * store.ts — `PostgresStore`: the spec §7.1 port over an injected pool.
 *
 * The memory store is the contract's reference; this store's job is to give
 * the same answers from Postgres, with the guarantees a database adds.
 *
 *   - A batch is a transaction on a dedicated client (§7.3, decision 11):
 *     `BEGIN`, the version bump, the ops, `COMMIT`; `ROLLBACK` on any throw;
 *     `release()` in `finally`. A pool without `connect()` cannot promise
 *     that, so the constructor refuses it unless `allowNonAtomic` opts into
 *     sequential statements — logged once, never silent.
 *   - The version bump is also the lock. `UPDATE kg_subjects … WHERE version
 *     = $expect RETURNING version` takes the subject's row lock for the rest
 *     of the transaction, so two batches on one subject run one after the
 *     other and the second sees the first's version; zero rows back means a
 *     conflict, rolled back and reported with the version actually stored.
 *   - What the memory store checks in JavaScript is checked here before any
 *     SQL is sent: a row addressed to another subject, a prototype key as a
 *     slot alias, an embedding of the wrong width. Both stores refuse the
 *     same batches with the same messages.
 *   - `patchHint` is read-modify-write through the memory store's own patch
 *     function: the counters, caps and provenance rules are defined once,
 *     and the transaction's row lock makes the read-then-write safe.
 *   - `signal` is refused at entry and raced during: `pg` cannot cancel a
 *     running statement, so a call that lost the race still completes in
 *     the background — a read still warms the cache, a write still commits
 *     or rolls back — while the caller gets its abort reason on time. What
 *     bounds that background work is `statementTimeoutMs`, and it covers
 *     every statement: a batch's transaction is prefixed with `SET LOCAL
 *     statement_timeout`, and a lone statement — the recall snapshot above
 *     all — runs inside a short transaction of its own to carry the same.
 *   - Rows are decoded, not validated. `compileSnapshot` drops and logs a bad
 *     row (§7.3); the store hands it over with its pointer intact.
 *   - `searchNodesByEmbedding` exists only with pgvector, so the engine's
 *     feature check reads the truth: without it, cosine runs in memory over
 *     `node.embedding` from `embedding_json`.
 */

import { VersionConflictError, noopLogger } from "../core/ports";
import type {
  GraphSnapshotData,
  LeaseQuery,
  LoggerPort,
  StoreOp,
  StorePort,
  StoredEvent,
  StoredEventBody,
  StoredEventPatch,
  SubjectRef,
} from "../core/ports";
import type { AuditEntry, EventStatus, HintRecord, HintStatus, TurnEvent } from "../core/types";
import { patchHint as applyHintPatch } from "../core/store/memory";
import { hasConnect, type PgClientLike, type PgPoolClientLike, type PgPoolLike, type PgQueryResult } from "./client";
import * as sql from "./sql";

export interface PostgresStoreOptions {
  /** Vectors live in `kg_node_vectors` and `searchNodesByEmbedding` is defined (§7.3). */
  pgvector?: boolean;
  /** Width of `kg_node_vectors.vec`, when known: a mis-sized embedding is refused before the database sees it. */
  vectorDimensions?: number;
  /** Accept a pool without `connect()` and run batches as sequential statements (documented degradation, logged once). */
  allowNonAtomic?: boolean;
  /**
   * `SET LOCAL statement_timeout` for every statement the store sends: a
   * batch's transaction is prefixed with it, and a single statement (the
   * recall snapshot, a hint read, a lease) runs inside its own short
   * transaction to carry it — three extra round trips, so a slow read is
   * cut off by the database rather than holding a connection past the
   * budget the caller stopped waiting at. Ignored with `allowNonAtomic`.
   */
  statementTimeoutMs?: number;
  logger?: LoggerPort;
}

type Runner = (statement: sql.SqlStatement) => Promise<PgQueryResult>;

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Rejects as soon as `signal` aborts; the statement behind `promise` runs on regardless (§7.3). */
function raced<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function refuseIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isRow(u: unknown): u is Record<string, unknown> {
  return typeof u === "object" && u !== null && !Array.isArray(u);
}

function sameSubject(row: SubjectRef, ref: SubjectRef): boolean {
  return sql.tenantColumn(row.tenantId) === sql.tenantColumn(ref.tenantId) && row.subjectId === ref.subjectId;
}

function subjectLabel(ref: SubjectRef): string {
  return `${sql.tenantColumn(ref.tenantId) || "(no tenant)"}/${ref.subjectId}`;
}

function misfiled(row: SubjectRef, ref: SubjectRef): string {
  return `belongs to ${subjectLabel(row)}, not ${subjectLabel(ref)}`;
}

function slotConflict(hint: Pick<HintRecord, "id" | "nodePath" | "slot" | "scope" | "agent" | "clientId">, holder: string): Error {
  return new Error(
    `slot conflict: hint ${hint.id} and active hint ${holder} both claim ` +
      `${hint.nodePath} ${hint.slot} (scope ${hint.scope}${hint.agent ? `, agent ${hint.agent}` : ""}` +
      `${hint.clientId ? `, client ${hint.clientId}` : ""}); supersede or retire ${holder} first`,
  );
}

function firstId(result: PgQueryResult): string | undefined {
  const row = result.rows[0];
  return isRow(row) && typeof row.id === "string" ? row.id : undefined;
}

export class PostgresStore implements StorePort {
  /** Present only with pgvector, so a feature check on the port reads the truth. */
  readonly searchNodesByEmbedding?: (ref: SubjectRef, vector: number[], limit: number) => Promise<{ nodeId: string; score: number }[]>;
  private readonly pool: PgClientLike;
  private readonly connect: (() => Promise<PgPoolClientLike>) | undefined;
  private readonly mode: sql.SqlMode;
  private readonly vectorDimensions: number | undefined;
  private readonly statementTimeoutMs: number | undefined;

  constructor(pool: PgPoolLike | PgClientLike, opts: PostgresStoreOptions = {}) {
    const logger = opts.logger ?? noopLogger;
    this.pool = pool;
    this.connect = hasConnect(pool) ? pool.connect.bind(pool) : undefined;
    if (this.connect === undefined) {
      if (!opts.allowNonAtomic) throw new TypeError("PostgresStore requires a pool with connect()");
      logger.warn({ lib: "wisdom-graph", op: "store.init", store: "postgres" }, "store.non-atomic");
    }
    if (opts.statementTimeoutMs !== undefined && (!Number.isInteger(opts.statementTimeoutMs) || opts.statementTimeoutMs < 0)) {
      throw new TypeError(`statementTimeoutMs must be a non-negative integer, got ${String(opts.statementTimeoutMs)}`);
    }
    if (opts.vectorDimensions !== undefined && (!Number.isInteger(opts.vectorDimensions) || opts.vectorDimensions <= 0)) {
      throw new TypeError(`vectorDimensions must be a positive integer, got ${String(opts.vectorDimensions)}`);
    }
    this.statementTimeoutMs = opts.statementTimeoutMs;
    this.vectorDimensions = opts.vectorDimensions;
    this.mode = { pgvector: opts.pgvector === true };
    if (this.mode.pgvector) this.searchNodesByEmbedding = (ref, vector, limit) => this.search(ref, vector, limit);
  }

  // ── Plumbing ──

  private send(statement: sql.SqlStatement): Promise<PgQueryResult> {
    return this.pool.query(statement.text, statement.params);
  }

  /**
   * One statement on its own. Through the pool, unless a statement timeout
   * is configured: `SET LOCAL` lives only inside a transaction, so the
   * statement then runs on a dedicated client between `BEGIN` and `COMMIT`.
   * That is what makes the timeout cover the recall snapshot — the read a
   * caller abandons at its budget and `pg` cannot cancel.
   */
  private query(statement: sql.SqlStatement): Promise<PgQueryResult> {
    if (this.statementTimeoutMs === undefined || this.connect === undefined) return this.send(statement);
    return this.write((run) => run(statement));
  }

  /**
   * A transaction on a dedicated client, or — only with `allowNonAtomic` —
   * the same statements one by one through the pool, with no timeout: there
   * is no transaction to scope one to. A client whose ROLLBACK failed is
   * released with the error so the pool discards the connection instead of
   * reusing a session in an unknown state.
   */
  private async write<T>(fn: (run: Runner) => Promise<T>): Promise<T> {
    if (this.connect === undefined) return fn((statement) => this.send(statement));
    const client = await this.connect();
    let broken: unknown;
    try {
      await client.query("BEGIN");
      let result: T;
      try {
        if (this.statementTimeoutMs !== undefined) await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
        result = await fn((statement) => client.query(statement.text, statement.params));
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          broken = rollbackError;
        }
        throw error;
      }
      await client.query("COMMIT");
      return result;
    } finally {
      if (broken === undefined) client.release();
      else client.release(broken);
    }
  }

  private checkEmbedding(embedding: number[] | undefined): void {
    if (!this.mode.pgvector || embedding === undefined || this.vectorDimensions === undefined) return;
    if (embedding.length !== this.vectorDimensions) {
      throw new Error(`embedding has ${embedding.length} dimensions; kg_node_vectors.vec is vector(${this.vectorDimensions})`);
    }
  }

  /** What can be refused without asking the database — checked for the whole batch before any statement is sent. */
  private checkOp(ref: SubjectRef, op: StoreOp): void {
    switch (op.op) {
      case "upsertNode":
        if (!sameSubject(op.node, ref)) throw new Error(`upsertNode: node ${op.node.id} ${misfiled(op.node, ref)}`);
        this.checkEmbedding(op.node.embedding);
        return;
      case "patchNode":
        this.checkEmbedding(op.patch.embedding);
        return;
      case "upsertHint":
        if (!sameSubject(op.hint, ref)) throw new Error(`upsertHint: hint ${op.hint.id} ${misfiled(op.hint, ref)}`);
        return;
      case "audit":
        if (!sameSubject(op.entry, ref)) throw new Error(`audit: entry ${op.entry.id} ${misfiled(op.entry, ref)}`);
        return;
      case "setSlotAlias":
        // A prototype key would rewrite the alias map's prototype when the snapshot is read back.
        if (op.from === "__proto__") throw new Error('setSlotAlias: "__proto__" is not a slot');
        return;
      default:
        return;
    }
  }

  /** One op inside the batch. Throws to abort it; the transaction runner rolls back. */
  private async applyOp(run: Runner, ref: SubjectRef, op: StoreOp): Promise<void> {
    switch (op.op) {
      case "upsertNode": {
        const holder = firstId(await run(sql.nodePathHolder(ref, op.node)));
        if (holder !== undefined) throw new Error(`upsertNode: path ${op.node.path} already belongs to node ${holder}, not ${op.node.id}`);
        await run(sql.upsertNodeRow(ref, op.node, this.mode));
        if (this.mode.pgvector) {
          await run(op.node.embedding ? sql.upsertNodeVector(ref, op.node.id, op.node.embedding) : sql.deleteNodeVector(ref, op.node.id));
        }
        return;
      }
      case "patchNode": {
        await run(sql.patchNodeRow(ref, op.nodeId, op.patch, this.mode));
        if (this.mode.pgvector && op.patch.embedding !== undefined) await run(sql.upsertNodeVector(ref, op.nodeId, op.patch.embedding));
        return;
      }
      case "upsertHint": {
        if (op.hint.status === "active") {
          const holder = firstId(await run(sql.slotHolder(ref, op.hint)));
          if (holder !== undefined) throw slotConflict(op.hint, holder);
        }
        await run(sql.upsertHintRow(ref, op.hint));
        return;
      }
      case "patchHint": {
        const found = sql.dataOf((await run(sql.selectHint(ref, op.hintId))).rows[0]);
        if (found === undefined || found === null) return;
        const existing = sql.decodeHint(found);
        // `updated_at` is set by the statement from the database clock; the value passed here never reaches a column.
        const next = applyHintPatch(existing, op.patch, existing.updatedAt);
        if (next.status === "active") {
          const holder = firstId(await run(sql.slotHolder(ref, next)));
          if (holder !== undefined) throw slotConflict(next, holder);
        }
        await run(sql.updateHintRow(ref, next));
        return;
      }
      case "setSlotAlias":
        await run(sql.setSlotAlias(ref, op.from, op.to));
        return;
      case "addTombstone":
        await run(sql.addTombstone(ref, op.hintId));
        return;
      case "consolidationCounter":
        await run(sql.consolidationCounter(ref, op.action));
        return;
      case "audit":
        await run(sql.insertAudit(ref, op.entry));
        return;
    }
  }

  // ── Recall ──

  async loadSnapshot(ref: SubjectRef, opts: { signal?: AbortSignal; statuses?: HintStatus[] } = {}): Promise<GraphSnapshotData | null> {
    refuseIfAborted(opts.signal);
    const result = await raced(this.query(sql.snapshotQuery(ref, opts.statuses ?? ["active"], this.mode)), opts.signal);
    return sql.decodeSnapshot(result.rows[0], ref);
  }

  // ── Writes ──

  async applyBatch(ref: SubjectRef, ops: StoreOp[], opts: { expectVersion?: number; signal?: AbortSignal } = {}): Promise<{ version: number }> {
    refuseIfAborted(opts.signal);
    for (const op of ops) this.checkOp(ref, op);
    const expected = opts.expectVersion;
    return raced(
      this.write(async (run) => {
        await run(sql.ensureSubject(ref));
        const bumped = (await run(sql.bumpVersion(ref, expected))).rows[0];
        if (bumped === undefined) {
          if (expected === undefined) throw new Error(`applyBatch: kg_subjects row for ${subjectLabel(ref)} could not be bumped`);
          const actual = sql.decodeVersion((await run(sql.readVersion(ref))).rows[0]);
          throw new VersionConflictError(expected, actual);
        }
        for (const op of ops) await this.applyOp(run, ref, op);
        return { version: sql.decodeVersion(bumped) };
      }),
      opts.signal,
    );
  }

  async getHint(ref: SubjectRef, hintId: string): Promise<HintRecord | null> {
    const data = sql.dataOf((await this.query(sql.selectHint(ref, hintId))).rows[0]);
    return data === undefined || data === null ? null : sql.decodeHint(data);
  }

  async deleteHint(ref: SubjectRef, hintId: string): Promise<boolean> {
    return (await this.query(sql.deleteHintRow(ref, hintId))).rows.length > 0;
  }

  async deleteSubject(ref: SubjectRef): Promise<void> {
    await this.write(async (run) => {
      for (const statement of sql.deleteSubjectRows(ref)) await run(statement);
    });
  }

  // ── Event ledger ──

  async claimEvent(tenantId: string | null, ev: StoredEventBody): Promise<"claimed" | "duplicate"> {
    return (await this.query(sql.claimEvent(tenantId, ev))).rows.length > 0 ? "claimed" : "duplicate";
  }

  /** Oldest first, as the statement picked them: `RETURNING` order is not promised, so the rows are ordered here. */
  async leaseEvents(q: LeaseQuery): Promise<StoredEvent[]> {
    const rows = (await this.query(sql.leaseEvents(q))).rows.map((row) => sql.decodeEvent(sql.dataOf(row)));
    return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.event.id).localeCompare(String(b.event.id)));
  }

  async updateEvent(tenantId: string | null, id: string, patch: StoredEventPatch): Promise<void> {
    await this.query(sql.updateEvent(tenantId, id, patch));
  }

  async getEvent(tenantId: string | null, id: string): Promise<StoredEvent | null> {
    const data = sql.dataOf((await this.query(sql.selectEvent(tenantId, id))).rows[0]);
    return data === undefined || data === null ? null : sql.decodeEvent(data);
  }

  async getTurn(ref: SubjectRef, runId: string): Promise<TurnEvent | null> {
    return sql.decodeTurn(sql.dataOf((await this.query(sql.selectTurn(ref, runId))).rows[0]));
  }

  async listEvents(ref: SubjectRef, q: { limit: number; statuses?: EventStatus[] }): Promise<StoredEvent[]> {
    return (await this.query(sql.listEvents(ref, q))).rows.map((row) => sql.decodeEvent(sql.dataOf(row)));
  }

  async scrubEvents(ref: SubjectRef, opts: { olderThan?: string } = {}): Promise<number> {
    return (await this.query(sql.scrubEvents(ref, opts.olderThan))).rows.length;
  }

  // ── Governance ──

  async listAudit(ref: SubjectRef, limit: number): Promise<AuditEntry[]> {
    return (await this.query(sql.listAudit(ref, limit))).rows.map((row) => sql.decodeAudit(sql.dataOf(row)));
  }

  async purge(q: { tenantId: string | null; eventsOlderThan?: string; auditOlderThan?: string }): Promise<{ events: number; audit: number }> {
    const events = q.eventsOlderThan === undefined ? 0 : (await this.query(sql.purgeEvents(q.tenantId, q.eventsOlderThan))).rows.length;
    const audit = q.auditOlderThan === undefined ? 0 : (await this.query(sql.purgeAudit(q.tenantId, q.auditOlderThan))).rows.length;
    return { events, audit };
  }

  // ── Vectors (pgvector) ──

  private async search(ref: SubjectRef, vector: number[], limit: number): Promise<{ nodeId: string; score: number }[]> {
    this.checkEmbedding(vector);
    return (await this.query(sql.searchNodes(ref, vector, limit))).rows.flatMap((row) =>
      isRow(row) && typeof row.node_id === "string" ? [{ nodeId: row.node_id, score: Number(row.score) }] : [],
    );
  }
}

export function createPostgresStore(pool: PgPoolLike | PgClientLike, opts?: PostgresStoreOptions): PostgresStore {
  return new PostgresStore(pool, opts);
}
