/**
 * The store against a real database, gated on WISDOM_PG_URL: the shared §7.1
 * contract suite, `setup()` idempotency, and — when WISDOM_PG_PGVECTOR is
 * also set — the contract again in pgvector mode with 2-wide vectors so the
 * suite's tiny embeddings fit. Without the variable every test is skipped
 * and nothing is imported or connected, so the default `npm test` touches no
 * network (must-have 9).
 *
 * The package has no `pg` dependency (zero runtime deps; the driver is the
 * consumer's). The driver is loaded here by name at run time, so a developer
 * runs `npm i --no-save pg` and points WISDOM_PG_URL at a scratch database.
 * Each run works in its own schema, created here and dropped at the end, so
 * a shared database is left as it was found.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeContractTests } from "../testing/store-contract";
import type { PgPoolLike } from "./client";
import { setup } from "./migrations";
import { PostgresStore } from "./store";

type Pool = PgPoolLike & { end(): Promise<void> };
interface PgModule {
  Pool: new (config: { connectionString: string; options?: string; max?: number }) => Pool;
}

const url = process.env.WISDOM_PG_URL;
const withPgvector = process.env.WISDOM_PG_PGVECTOR !== undefined && process.env.WISDOM_PG_PGVECTOR !== "";
const describeIf = url ? describe : describe.skip;

/**
 * Load the driver by name at run time, so nothing in `src/` names the package
 * statically. WISDOM_PG_DRIVER may point at a `pg` installed elsewhere (an
 * absolute path to its entry file), so the workspace need not carry it.
 */
async function loadPg(): Promise<PgModule> {
  const driver = process.env.WISDOM_PG_DRIVER ?? "pg";
  let loaded: { default?: Partial<PgModule> } & Partial<PgModule>;
  try {
    loaded = await import(/* @vite-ignore */ driver);
  } catch (error) {
    throw new Error(
      "WISDOM_PG_URL is set but the pg driver could not be loaded; run `npm i --no-save pg` or set WISDOM_PG_DRIVER to its entry file",
      { cause: error },
    );
  }
  const Pool = loaded.Pool ?? loaded.default?.Pool;
  if (Pool === undefined) throw new Error("the pg module exposes no Pool constructor");
  return { Pool };
}

const TABLES = ["kg_subjects", "kg_nodes", "kg_hints", "kg_events", "kg_audit"];

describeIf("postgres integration", () => {
  const schema = `wg_test_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  let pool: Pool;

  beforeAll(async () => {
    const { Pool } = await loadPg();
    pool = new Pool({ connectionString: url as string, options: `-c search_path=${schema}`, max: 6 });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await setup(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  const truncate = async (): Promise<void> => {
    await pool.query(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
  };

  it("setup() is idempotent: the second run applies nothing", async () => {
    await expect(setup(pool)).resolves.toEqual({ applied: [], skipped: ["0001_schema"] });
    const { rows } = await pool.query("SELECT id FROM kg_migrations ORDER BY id");
    expect(rows).toEqual([{ id: "0001_schema" }]);
  });

  storeContractTests("postgres", async () => {
    await truncate();
    return { store: new PostgresStore(pool) };
  });

  it("enforces the slot invariant in the database as well: a direct duplicate insert is refused", async () => {
    await truncate();
    const store = new PostgresStore(pool);
    const ref = { tenantId: null, subjectId: "rm_db" };
    const { fixtureHint } = await import("../testing/fixtures");
    const first = fixtureHint(ref, { id: "h_a", nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
    await store.applyBatch(ref, [{ op: "upsertHint", hint: first }]);
    await expect(
      pool.query(
        "INSERT INTO kg_hints (id, tenant_id, subject_id, node_id, node_path, slot, value, text, kind, lane, scope, source, confidence, priority, provenance) " +
          "VALUES ('h_b', '', 'rm_db', 'n', '/', 'tone', 'brisk', 'Prefers a brisk tone.', 'preference', 'agent', 'global', 'explicit', 0.5, 50, '{}')",
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  (withPgvector ? describe : describe.skip)("with pgvector", () => {
    beforeAll(async () => {
      await expect(setup(pool, { pgvector: true, vectorDimensions: 2 })).resolves.toMatchObject({ applied: ["0002_pgvector"] });
    });

    storeContractTests("postgres+pgvector", async () => {
      await truncate();
      return { store: new PostgresStore(pool, { pgvector: true, vectorDimensions: 2 }) };
    });
  });
});
