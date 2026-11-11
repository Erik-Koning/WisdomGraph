/**
 * postgres/ — the subpath `@mosphere/wisdom-graph/postgres`.
 *
 * A `StorePort` over the consumer's own `pg.Pool` (must-have 8), reached
 * structurally so the package carries no driver, plus the `kg_*` schema as
 * migrations the consumer's migration owner can include or `setup()` can
 * apply. It imports `core/` by relative path and nothing else.
 *
 * Exports are curated to spec §2.9 and `surface.test.ts` pins them. The SQL
 * builders and row decoders in `sql.ts` stay internal: they are the store's
 * implementation, tested through a recording client, not a query API.
 */

export { PostgresStore, createPostgresStore } from "./store";
export type { PostgresStoreOptions } from "./store";
export type { PgClientLike, PgPoolClientLike, PgPoolLike, PgQueryResult } from "./client";
export { migrations, renderMigrationsSql, setup } from "./migrations";
export type { Migration, MigrationOptions, SetupOptions, SetupResult } from "./migrations";
