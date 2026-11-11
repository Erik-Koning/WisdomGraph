/**
 * The migrations list and its two consumers: `renderMigrationsSql` (pinned by
 * a stored snapshot so a DDL change is a reviewed diff) and `setup`, driven
 * through the recording client — advisory lock, ledger table, one
 * transaction per missing migration, and a second run that applies nothing.
 */
import { describe, expect, it } from "vitest";
import { CollectingLogger } from "../testing/fakes";
import { FakeSqlClient } from "./fake-client";
import { DEFAULT_VECTOR_DIMENSIONS, migrations, renderMigrationsSql, resolveVectorDimensions, setup } from "./migrations";

describe("migrations()", () => {
  it("returns ordered, unique ids; 0002_pgvector only when requested", () => {
    expect(migrations().map((m) => m.id)).toEqual(["0001_schema"]);
    const withVectors = migrations({ pgvector: true });
    expect(withVectors.map((m) => m.id)).toEqual(["0001_schema", "0002_pgvector"]);
    expect(new Set(withVectors.map((m) => m.id)).size).toBe(withVectors.length);
    expect(withVectors[0]?.requires).toBeUndefined();
    expect(withVectors[1]?.requires).toBe("pgvector");
    expect(migrations({ pgvector: false }).map((m) => m.id)).toEqual(["0001_schema"]);
  });

  it("substitutes the vector dimension, defaulting to 1536", () => {
    expect(DEFAULT_VECTOR_DIMENSIONS).toBe(1536);
    expect(migrations({ pgvector: true })[1]?.sql).toContain("vec vector(1536) NOT NULL");
    expect(migrations({ pgvector: true, vectorDimensions: 3 })[1]?.sql).toContain("vec vector(3) NOT NULL");
    expect(migrations({ pgvector: true, vectorDimensions: 3 })[0]?.sql).not.toContain("vector(");
  });

  it("refuses a dimension that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => migrations({ pgvector: true, vectorDimensions: bad })).toThrow(TypeError);
      expect(() => resolveVectorDimensions(bad)).toThrow(/positive integer/);
    }
    expect(resolveVectorDimensions(undefined)).toBe(1536);
    // Without pgvector the dimension is irrelevant and not validated.
    expect(() => migrations({ vectorDimensions: 0 })).not.toThrow();
  });

  it("uses IF NOT EXISTS on every CREATE and prefixes every table with kg_", () => {
    const sql = renderMigrationsSql({ pgvector: true });
    const creates = [...sql.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX|EXTENSION)\b[^\n]*/g)].map((m) => m[0]);
    expect(creates.length).toBeGreaterThanOrEqual(15);
    for (const line of creates) expect(line, line).toMatch(/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|EXTENSION) IF NOT EXISTS /);
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables).toEqual(["kg_migrations", "kg_subjects", "kg_nodes", "kg_hints", "kg_events", "kg_audit", "kg_node_vectors"]);
    // Every data table carries the tenant column with its '' default (decision 9).
    for (const table of tables.filter((t) => t !== "kg_migrations")) {
      const body = sql.slice(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
      expect(body.slice(0, body.indexOf(");")), table).toContain("tenant_id text NOT NULL DEFAULT ''");
    }
    expect(sql).toContain("kg_hints_slot_active");
    expect(sql).toContain("WHERE status = 'active'");
  });
});

describe("renderMigrationsSql()", () => {
  it("wraps each migration in a comment header", () => {
    const plain = renderMigrationsSql();
    expect(plain.startsWith("-- kg migration 0001_schema\n")).toBe(true);
    expect(plain).not.toContain("0002_pgvector");
    const withVectors = renderMigrationsSql({ pgvector: true, vectorDimensions: 8 });
    expect(withVectors).toContain("\n-- kg migration 0002_pgvector (requires pgvector)\n");
    expect(withVectors).toContain("vector(8)");
    expect(withVectors.indexOf("0001_schema")).toBeLessThan(withVectors.indexOf("0002_pgvector"));
  });

  it("matches the stored snapshot (schema changes are reviewed diffs)", () => {
    expect(renderMigrationsSql()).toMatchSnapshot();
    expect(renderMigrationsSql({ pgvector: true })).toMatchSnapshot();
  });
});

describe("setup()", () => {
  const LOCK = "SELECT pg_advisory_lock(hashtext('kg_migrations'))";
  const UNLOCK = "SELECT pg_advisory_unlock(hashtext('kg_migrations'))";

  it("locks, creates the ledger, applies each missing migration in its own transaction, records it, unlocks and releases", async () => {
    const fake = new FakeSqlClient();
    const logger = new CollectingLogger();
    await expect(setup(fake, { logger })).resolves.toEqual({ applied: ["0001_schema"], skipped: [] });
    const [schema] = migrations();
    expect(fake.texts("client:1")).toEqual([
      LOCK,
      expect.stringMatching(/^CREATE TABLE IF NOT EXISTS kg_migrations/),
      "SELECT id FROM kg_migrations",
      "BEGIN",
      schema?.sql,
      "INSERT INTO kg_migrations (id) VALUES ($1)",
      "COMMIT",
      UNLOCK,
    ]);
    expect(fake.queries.find((q) => q.text.startsWith("INSERT INTO kg_migrations"))?.params).toEqual(["0001_schema"]);
    expect(fake.texts("pool")).toEqual([]);
    expect(fake.releases).toEqual([{ client: 1, err: undefined, argCount: 0 }]);
    expect(logger.entries).toEqual([{ level: "info", obj: { lib: "wisdom-graph", op: "setup", migration: "0001_schema" }, msg: "setup.applied" }]);
  });

  it("is idempotent: a second run applies nothing and opens no transaction", async () => {
    const fake = new FakeSqlClient().when(/^SELECT id FROM kg_migrations/, { rows: [{ id: "0001_schema" }] });
    await expect(setup(fake)).resolves.toEqual({ applied: [], skipped: ["0001_schema"] });
    expect(fake.texts("client:1")).toEqual([LOCK, expect.stringMatching(/^CREATE TABLE IF NOT EXISTS kg_migrations/), "SELECT id FROM kg_migrations", UNLOCK]);
    expect(fake.releases).toHaveLength(1);
  });

  it("applies only the pgvector migration when the schema is already recorded", async () => {
    const fake = new FakeSqlClient().when(/^SELECT id FROM kg_migrations/, { rows: [{ id: "0001_schema" }, { id: 42 }, { nope: 1 }] });
    await expect(setup(fake, { pgvector: true, vectorDimensions: 4 })).resolves.toEqual({ applied: ["0002_pgvector"], skipped: ["0001_schema"] });
    const texts = fake.texts("client:1");
    expect(texts.filter((t) => t === "BEGIN")).toHaveLength(1);
    expect(texts.some((t) => t.includes("vec vector(4) NOT NULL"))).toBe(true);
    expect(fake.queries.find((q) => q.text.startsWith("INSERT INTO kg_migrations"))?.params).toEqual(["0002_pgvector"]);
  });

  it("rolls back a failing migration, records nothing for it, unlocks, releases and rethrows", async () => {
    const boom = new Error("permission denied for extension vector");
    const fake = new FakeSqlClient().when(/^CREATE EXTENSION IF NOT EXISTS vector/, boom);
    await expect(setup(fake, { pgvector: true })).rejects.toBe(boom);
    const texts = fake.texts("client:1");
    expect(texts.slice(-2)).toEqual(["ROLLBACK", UNLOCK]);
    expect(texts.filter((t) => t === "COMMIT")).toHaveLength(1);
    expect(fake.queries.filter((q) => q.text.startsWith("INSERT INTO kg_migrations")).map((q) => q.params)).toEqual([["0001_schema"]]);
    expect(fake.releases).toEqual([{ client: 1, err: undefined, argCount: 0 }]);
  });

  it("releases the client with the error and skips the unlock when ROLLBACK fails", async () => {
    const dead = new Error("connection terminated");
    // The failure must be inside a migration's transaction: the ledger's own CREATE runs before BEGIN.
    const fake = new FakeSqlClient().when(/CREATE TABLE IF NOT EXISTS kg_subjects/, new Error("disk full")).when(/^ROLLBACK$/, dead);
    await expect(setup(fake)).rejects.toThrow("disk full");
    expect(fake.texts("client:1")).not.toContain(UNLOCK);
    expect(fake.releases).toEqual([{ client: 1, err: dead, argCount: 1 }]);
  });

  it("requires a pool with connect()", async () => {
    const fake = new FakeSqlClient();
    // The runtime check is the point: a query-only client presented as a pool.
    const bare = fake.queryOnly() as Parameters<typeof setup>[0];
    await expect(setup(bare)).rejects.toThrow(TypeError);
    expect(fake.queries).toEqual([]);
  });
});
