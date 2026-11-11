/*
 * client.ts — the shape of a `pg` pool, without `pg`.
 *
 * The consumer owns the one `pg.Pool` its whole backend shares (must-haves 6
 * and 8), so the library never imports the driver: it describes the two
 * methods it uses and lets `pg.Pool` satisfy them structurally. `query` is
 * the parameterised form only — `(text, params)` — because that is the one
 * form every driver wrapper, proxy and test double agrees on; the store never
 * builds a query config object.
 *
 * `connect()` is on the pool type rather than optional because transactions
 * need a dedicated client (spec §7.3): `BEGIN` on one pooled connection and
 * `COMMIT` on another is not a transaction. A query-only client is accepted
 * by `PostgresStore` only with `allowNonAtomic`, and the store discovers
 * which it was given with `hasConnect` at construction, not per call.
 */

/** What a statement returns: `rows` always; `rowCount` when the driver reports it (`pg` does, as `number | null`). */
export interface PgQueryResult {
  rows: unknown[];
  rowCount?: number | null;
}

export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
}

/** A client checked out of a pool: `release(err)` with a truthy `err` tells `pg` to discard the connection. */
export interface PgPoolClientLike extends PgClientLike {
  release(err?: unknown): void;
}

export interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgPoolClientLike>;
}

/** Whether `pool` can hand out a dedicated client — the structural test for "is a pool, not a bare client". */
export function hasConnect(pool: PgClientLike | PgPoolLike): pool is PgPoolLike {
  return "connect" in pool && typeof pool.connect === "function";
}
