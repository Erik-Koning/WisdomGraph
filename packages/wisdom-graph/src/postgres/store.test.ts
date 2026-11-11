/**
 * PostgresStore through the recording client: the transaction bracketing
 * every batch gets, `release()` on every path out, the version conflict as
 * a rolled-back `VersionConflictError`, the constructor's refusal of a
 * connect-less pool and the logged opt-out, the one-query snapshot with its
 * '' → null mapping, and how each read maps rows to port shapes. The SQL
 * text itself is pinned in sql.test.ts; here the assertions are about which
 * statements run, in what order, on which connection, and what comes back.
 */
import { describe, expect, it } from "vitest";
import { VersionConflictError } from "../core/ports";
import type { StoreOp, SubjectRef } from "../core/ports";
import { CollectingLogger } from "../testing/fakes";
import { FIXTURE_T0, fixtureAudit, fixtureHint, fixtureNode, fixtureTurn } from "../testing/fixtures";
import { FakeSqlClient } from "./fake-client";
import { PostgresStore, createPostgresStore } from "./store";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const other: SubjectRef = { tenantId: null, subjectId: "rm_99" };
const NOW = Date.UTC(2026, 0, 1, 12);
const iso = (ms: number): string => new Date(ms).toISOString();

const root = fixtureNode(ref, "/");
const warm = fixtureHint(ref, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
const upsertNode = (node = root): StoreOp => ({ op: "upsertNode", node });
const upsertHint = (hint = warm): StoreOp => ({ op: "upsertHint", hint });

/** A hint row as the fake's `SELECT row_to_json(h)` would return it. */
function hintData(record: typeof warm, overrides: Record<string, unknown> = {}): { rows: unknown[] } {
  return {
    rows: [
      {
        data: {
          id: record.id,
          tenant_id: "",
          subject_id: record.subjectId,
          node_id: record.nodeId,
          node_path: record.nodePath,
          slot: record.slot,
          value: record.value,
          text: record.text,
          kind: record.kind,
          lane: record.lane,
          scope: record.scope,
          agent: null,
          client_id: null,
          source: record.source,
          confidence: record.confidence,
          priority: record.priority,
          status: record.status,
          approval: record.approval,
          maturity: record.maturity,
          needs_review: false,
          supersedes: null,
          superseded_by: null,
          retired_reason: null,
          reinforcements: record.reinforcements,
          contradictions: record.contradictions,
          applied: record.applied,
          provenance: record.provenance,
          version: record.version,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
          last_reinforced_at: record.lastReinforcedAt,
          last_applied_at: null,
          ...overrides,
        },
      },
    ],
  };
}

const heads = (texts: string[]): string[] => texts.map((t) => t.split(" ").slice(0, 3).join(" "));

describe("PostgresStore constructor", () => {
  it("throws TypeError when the pool has no connect(), unless allowNonAtomic — which logs exactly one warning", () => {
    const fake = new FakeSqlClient();
    expect(() => new PostgresStore(fake.queryOnly())).toThrow(TypeError);
    expect(() => new PostgresStore(fake.queryOnly())).toThrow("PostgresStore requires a pool with connect()");
    const logger = new CollectingLogger();
    expect(() => new PostgresStore(fake.queryOnly(), { allowNonAtomic: true, logger })).not.toThrow();
    expect(logger.entries).toEqual([{ level: "warn", obj: { lib: "wisdom-graph", op: "store.init", store: "postgres" }, msg: "store.non-atomic" }]);
    // A real pool never warns, whatever the flag says.
    const quiet = new CollectingLogger();
    void new PostgresStore(fake, { allowNonAtomic: true, logger: quiet });
    expect(quiet.entries).toEqual([]);
    expect(fake.queries).toEqual([]);
  });

  it("validates statementTimeoutMs and vectorDimensions at construction", () => {
    const fake = new FakeSqlClient();
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => new PostgresStore(fake, { statementTimeoutMs: bad })).toThrow(TypeError);
    }
    for (const bad of [0, -2, 1.5]) {
      expect(() => new PostgresStore(fake, { vectorDimensions: bad })).toThrow(TypeError);
    }
    expect(() => new PostgresStore(fake, { statementTimeoutMs: 0, vectorDimensions: 3 })).not.toThrow();
  });

  it("defines searchNodesByEmbedding only with pgvector; createPostgresStore is the same constructor", () => {
    const fake = new FakeSqlClient();
    expect(new PostgresStore(fake).searchNodesByEmbedding).toBeUndefined();
    expect(new PostgresStore(fake, { pgvector: true }).searchNodesByEmbedding).toBeTypeOf("function");
    expect(createPostgresStore(fake, { pgvector: true })).toBeInstanceOf(PostgresStore);
  });
});

describe("PostgresStore.applyBatch on a connected client", () => {
  it("brackets BEGIN / ensure / UPDATE … RETURNING version / ops / COMMIT on one client and releases it cleanly", async () => {
    const fake = new FakeSqlClient().when(/RETURNING version/, { rows: [{ version: "7" }] });
    const store = new PostgresStore(fake);
    await expect(store.applyBatch(ref, [upsertNode(), { op: "audit", entry: fixtureAudit(ref, "a_1") }], { expectVersion: 6 })).resolves.toEqual({ version: 7 });
    expect(fake.texts("pool")).toEqual([]);
    expect(heads(fake.texts("client:1"))).toEqual([
      "BEGIN",
      "INSERT INTO kg_subjects",
      "UPDATE kg_subjects SET",
      "SELECT id FROM",
      "INSERT INTO kg_nodes",
      "INSERT INTO kg_audit",
      "COMMIT",
    ]);
    expect(fake.queries[2]).toMatchObject({ text: expect.stringMatching(/^UPDATE kg_subjects SET version = version \+ 1,.*RETURNING version$/), params: ["", "rm_42", 6] });
    expect(fake.releases).toEqual([{ client: 1, err: undefined, argCount: 0 }]);
    expect(fake.connections).toBe(1);
  });

  it("prefixes the transaction with SET LOCAL statement_timeout when configured", async () => {
    const fake = new FakeSqlClient();
    await new PostgresStore(fake, { statementTimeoutMs: 250 }).applyBatch(ref, []);
    expect(fake.texts("client:1").slice(0, 2)).toEqual(["BEGIN", "SET LOCAL statement_timeout = 250"]);
    const none = new FakeSqlClient();
    await new PostgresStore(none).applyBatch(ref, []);
    expect(none.texts("client:1").some((t) => /statement_timeout/.test(t))).toBe(false);
  });
});

describe("PostgresStore with statementTimeoutMs", () => {
  const subjectRow = { tenant_id: "", subject_id: "rm_42", version: "3", slot_aliases: {}, tombstones: [], events_since_consolidation: 0 };

  it("runs every single statement — the recall snapshot, a hint read, a lease — inside its own SET LOCAL transaction, releasing the client", async () => {
    const fake = new FakeSqlClient()
      .when(/^SELECT \(SELECT row_to_json\(s\)/, { rows: [{ subject: subjectRow, nodes: [], hints: [] }] })
      .when(/^SELECT row_to_json\(h\)/, hintData(warm));
    const store = new PostgresStore(fake, { statementTimeoutMs: 250 });
    await expect(store.loadSnapshot(ref)).resolves.toMatchObject({ version: 3 });
    await expect(store.getHint(ref, warm.id)).resolves.toEqual(warm);
    await expect(store.leaseEvents({ tenantId: null, limit: 5, leaseMs: 1_000, now: NOW })).resolves.toEqual([]);
    expect(fake.texts("pool")).toEqual([]);
    for (const [client, statement] of [
      ["client:1", "SELECT (SELECT row_to_json(s)"],
      ["client:2", "SELECT row_to_json(h) AS"],
      ["client:3", "UPDATE kg_events e"],
    ] as const) {
      expect(heads(fake.texts(client))).toEqual(["BEGIN", "SET LOCAL statement_timeout", statement, "COMMIT"]);
    }
    expect(fake.releases).toEqual([
      { client: 1, err: undefined, argCount: 0 },
      { client: 2, err: undefined, argCount: 0 },
      { client: 3, err: undefined, argCount: 0 },
    ]);
  });

  it("without the option every single statement goes straight through the pool", async () => {
    const fake = new FakeSqlClient().when(/^SELECT \(SELECT row_to_json\(s\)/, { rows: [{ subject: subjectRow, nodes: [], hints: [] }] });
    const store = new PostgresStore(fake);
    await store.loadSnapshot(ref);
    await store.getHint(ref, warm.id);
    await store.leaseEvents({ tenantId: null, limit: 5, leaseMs: 1_000, now: NOW });
    expect(fake.queries.every((q) => q.route === "pool")).toBe(true);
    expect(fake.connections).toBe(0);
  });

  it("a read the database cut off at the timeout is rolled back, released, and rejected with the driver's error", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const fake = new FakeSqlClient().when(/^SELECT \(SELECT row_to_json\(s\)/, timeout);
    const store = new PostgresStore(fake, { statementTimeoutMs: 250 });
    await expect(store.loadSnapshot(ref)).rejects.toBe(timeout);
    expect(heads(fake.texts("client:1"))).toEqual(["BEGIN", "SET LOCAL statement_timeout", "SELECT (SELECT row_to_json(s)", "ROLLBACK"]);
    expect(fake.releases).toEqual([{ client: 1, err: undefined, argCount: 0 }]);
  });

  it("a read abandoned by its signal still ends its transaction and releases the client once the database answers", async () => {
    let finish: (() => void) | undefined;
    const fake = new FakeSqlClient().when(/^SELECT \(SELECT row_to_json\(s\)/, () => new Promise((resolve) => {
      finish = () => resolve({ rows: [{ subject: null, nodes: [], hints: [] }] });
    }));
    const store = new PostgresStore(fake, { statementTimeoutMs: 250 });
    const controller = new AbortController();
    const pending = store.loadSnapshot(ref, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("budget"));
    await expect(pending).rejects.toThrow("budget");
    expect(fake.releases).toEqual([]);
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heads(fake.texts("client:1"))).toEqual(["BEGIN", "SET LOCAL statement_timeout", "SELECT (SELECT row_to_json(s)", "COMMIT"]);
    expect(fake.releases).toEqual([{ client: 1, err: undefined, argCount: 0 }]);
  });

  it("with allowNonAtomic there is no transaction to scope the timeout to, so none is sent", async () => {
    const fake = new FakeSqlClient();
    const store = new PostgresStore(fake.queryOnly(), { allowNonAtomic: true, statementTimeoutMs: 250, logger: new CollectingLogger() });
    await store.loadSnapshot(ref);
    await store.applyBatch(ref, []);
    expect(fake.queries.every((q) => q.route === "pool")).toBe(true);
    expect(fake.texts().some((t) => /statement_timeout/.test(t))).toBe(false);
  });

  it("rolls back and throws VersionConflictError with the stored version when the bump touches zero rows", async () => {
    const fake = new FakeSqlClient().when(/RETURNING version/, { rows: [] }).when(/^SELECT version FROM kg_subjects/, { rows: [{ version: "4" }] });
    const store = new PostgresStore(fake);
    const conflict = store.applyBatch(ref, [upsertNode()], { expectVersion: 2 });
    await expect(conflict).rejects.toBeInstanceOf(VersionConflictError);
    await expect(conflict).rejects.toMatchObject({ expected: 2, actual: 4 });
    expect(heads(fake.texts("client:1"))).toEqual(["BEGIN", "INSERT INTO kg_subjects", "UPDATE kg_subjects SET", "SELECT version FROM", "ROLLBACK"]);
    expect(fake.releases).toEqual([{ client: 1, err: undefined, argCount: 0 }]);
  });

  it("reports actual 0 when the subject has no row yet, and a vanished row without an expectation as a plain error", async () => {
    const fake = new FakeSqlClient().when(/RETURNING version/, { rows: [] });
    const store = new PostgresStore(fake);
    await expect(store.applyBatch(ref, [], { expectVersion: 3 })).rejects.toMatchObject({ name: "VersionConflictError", expected: 3, actual: 0 });
    await expect(store.applyBatch(ref, [])).rejects.toThrow(/could not be bumped/);
    expect(fake.texts("client:2")).toContain("ROLLBACK");
  });

  it("rolls back when an op fails and rethrows the op's error: a path held by another node", async () => {
    const fake = new FakeSqlClient().when(/^SELECT id FROM kg_nodes/, { rows: [{ id: "n_holder" }] });
    const store = new PostgresStore(fake);
    await expect(store.applyBatch(ref, [upsertHint(), upsertNode()])).rejects.toThrow("upsertNode: path / already belongs to node n_holder, not " + root.id);
    const texts = fake.texts("client:1");
    expect(texts.at(-1)).toBe("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
    expect(fake.releases).toHaveLength(1);
  });

  it("checks the slot invariant before an active upsert and names the holder; pending hints skip the check", async () => {
    const fake = new FakeSqlClient().when(/^SELECT h\.id FROM kg_hints/, { rows: [{ id: "h_first" }] });
    const store = new PostgresStore(fake);
    await expect(store.applyBatch(ref, [upsertHint()])).rejects.toThrow(
      `slot conflict: hint ${warm.id} and active hint h_first both claim / tone (scope global); supersede or retire h_first first`,
    );
    expect(fake.texts("client:1").at(-1)).toBe("ROLLBACK");
    const pending = new FakeSqlClient().when(/^SELECT h\.id FROM kg_hints/, { rows: [{ id: "h_first" }] });
    await new PostgresStore(pending).applyBatch(ref, [upsertHint({ ...warm, status: "pending" })]);
    expect(heads(pending.texts("client:1"))).toEqual(["BEGIN", "INSERT INTO kg_subjects", "UPDATE kg_subjects SET", "INSERT INTO kg_hints", "COMMIT"]);
  });

  it("hands the client back with the error when ROLLBACK itself fails, so the pool discards the connection", async () => {
    const dead = new Error("connection terminated");
    const fake = new FakeSqlClient().when(/^INSERT INTO kg_nodes/, new Error("disk full")).when(/^ROLLBACK$/, dead);
    await expect(new PostgresStore(fake).applyBatch(ref, [upsertNode()])).rejects.toThrow("disk full");
    expect(fake.releases).toEqual([{ client: 1, err: dead, argCount: 1 }]);
  });

  it("propagates a COMMIT failure without a ROLLBACK and still releases", async () => {
    const fake = new FakeSqlClient().when(/^COMMIT$/, new Error("serialization failure"));
    await expect(new PostgresStore(fake).applyBatch(ref, [])).rejects.toThrow("serialization failure");
    expect(fake.texts("client:1")).not.toContain("ROLLBACK");
    expect(fake.releases).toEqual([{ client: 1, err: undefined, argCount: 0 }]);
  });

  it("rejects with the pool's error when connect() fails, having released nothing", async () => {
    const fake = new FakeSqlClient();
    fake.connectError = new Error("pool exhausted");
    await expect(new PostgresStore(fake).applyBatch(ref, [])).rejects.toThrow("pool exhausted");
    expect(fake.releases).toEqual([]);
    expect(fake.queries).toEqual([]);
  });

  it("refuses a misfiled row or a prototype alias before touching the database", async () => {
    const fake = new FakeSqlClient();
    const store = new PostgresStore(fake);
    await expect(store.applyBatch(ref, [upsertNode(), { op: "upsertNode", node: fixtureNode(other, "/") }])).rejects.toThrow(/belongs to \(no tenant\)\/rm_99, not \(no tenant\)\/rm_42/);
    await expect(store.applyBatch(ref, [{ op: "upsertHint", hint: fixtureHint({ tenantId: "acme", subjectId: ref.subjectId }, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." }) }])).rejects.toThrow(/belongs to acme\/rm_42/);
    await expect(store.applyBatch(ref, [{ op: "audit", entry: fixtureAudit(other, "a_1") }])).rejects.toThrow(/audit: entry a_1 belongs to/);
    await expect(store.applyBatch(ref, [{ op: "setSlotAlias", from: "__proto__", to: "x" }])).rejects.toThrow('"__proto__" is not a slot');
    expect(fake.queries).toEqual([]);
    expect(fake.connections).toBe(0);
    // "" and null are the same tenant, so that pair is filed.
    await store.applyBatch({ tenantId: "", subjectId: ref.subjectId }, [upsertNode()]);
    expect(fake.connections).toBe(1);
  });

  it("emits the subject-level ops in order", async () => {
    const fake = new FakeSqlClient();
    await new PostgresStore(fake).applyBatch(ref, [
      { op: "setSlotAlias", from: "voice", to: "tone" },
      { op: "addTombstone", hintId: "h_gone" },
      { op: "consolidationCounter", action: "increment" },
      { op: "consolidationCounter", action: "reset" },
    ]);
    const texts = fake.texts("client:1").slice(3, -1);
    expect(texts[0]).toContain("slot_aliases = slot_aliases ||");
    expect(texts[1]).toContain("tombstones = CASE WHEN");
    expect(texts[2]).toContain("events_since_consolidation + 1");
    expect(texts[3]).toContain("events_since_consolidation = 0");
  });

  it("patchHint reads the row, applies the memory store's patch semantics, and writes the whole row back", async () => {
    const existing = { ...warm, reinforcements: 1, provenance: { ...warm.provenance, eventIds: ["ev_fixture"], runIds: [] } };
    const fake = new FakeSqlClient().when(/^SELECT row_to_json\(h\)/, hintData(existing));
    await new PostgresStore(fake).applyBatch(ref, [
      { op: "patchHint", hintId: warm.id, patch: { priority: 90, reinforcements: { add: 2 }, provenance: { appendEventId: "turn_9", appendRunId: "run_9" }, status: "active" } },
    ]);
    expect(heads(fake.texts("client:1"))).toEqual([
      "BEGIN",
      "INSERT INTO kg_subjects",
      "UPDATE kg_subjects SET",
      "SELECT row_to_json(h) AS",
      "SELECT h.id FROM",
      "UPDATE kg_hints SET",
      "COMMIT",
    ]);
    const update = fake.queries.find((q) => q.text.startsWith("UPDATE kg_hints SET"));
    expect(update?.params).toContain(90);
    expect(update?.params).toContain(3);
    expect(update?.params).toContain(JSON.stringify({ ...existing.provenance, eventIds: ["ev_fixture", "turn_9"], runIds: ["run_9"] }));
    expect(update?.params).toContain(existing.version + 1);
    expect(update?.params?.slice(-3)).toEqual([warm.id, "", "rm_42"]);
  });

  it("patchHint is a no-op for an unknown id and skips the slot check for a non-active result", async () => {
    const missing = new FakeSqlClient();
    await new PostgresStore(missing).applyBatch(ref, [{ op: "patchHint", hintId: "h_missing", patch: { priority: 1 } }]);
    expect(heads(missing.texts("client:1"))).toEqual(["BEGIN", "INSERT INTO kg_subjects", "UPDATE kg_subjects SET", "SELECT row_to_json(h) AS", "COMMIT"]);
    const retiring = new FakeSqlClient().when(/^SELECT row_to_json\(h\)/, hintData(warm));
    await new PostgresStore(retiring).applyBatch(ref, [{ op: "patchHint", hintId: warm.id, patch: { status: "retired", retiredReason: "obsolete" } }]);
    expect(heads(retiring.texts("client:1"))).not.toContain("SELECT h.id FROM");
    const update = retiring.queries.find((q) => q.text.startsWith("UPDATE kg_hints SET"));
    expect(update?.params).toContain("retired");
    expect(update?.params).toContain("obsolete");
  });

  it("patchHint that re-activates a hint into a held slot is a slot conflict", async () => {
    const fake = new FakeSqlClient().when(/^SELECT row_to_json\(h\)/, hintData({ ...warm, status: "superseded" })).when(/^SELECT h\.id FROM kg_hints/, { rows: [{ id: "h_second" }] });
    await expect(new PostgresStore(fake).applyBatch(ref, [{ op: "patchHint", hintId: warm.id, patch: { status: "active" } }])).rejects.toThrow(/slot conflict: hint .* and active hint h_second/);
    expect(fake.texts("client:1").at(-1)).toBe("ROLLBACK");
  });

  it("patchNode runs one UPDATE; unknown ids are the database's no-op", async () => {
    const fake = new FakeSqlClient();
    await new PostgresStore(fake).applyBatch(ref, [{ op: "patchNode", nodeId: "n_x", patch: { title: "T", embedding: [1, 2] } }]);
    const update = fake.queries.find((q) => q.text.startsWith("UPDATE kg_nodes SET"));
    expect(update?.text).toContain("embedding_json = $5::jsonb");
    expect(update?.params).toEqual(["", "rm_42", "n_x", "T", "[1,2]"]);
    expect(fake.texts("client:1").some((t) => /kg_node_vectors/.test(t))).toBe(false);
  });
});

describe("PostgresStore with pgvector", () => {
  it("routes embeddings to kg_node_vectors and never to embedding_json", async () => {
    const fake = new FakeSqlClient();
    const store = new PostgresStore(fake, { pgvector: true, vectorDimensions: 2 });
    await store.applyBatch(ref, [
      upsertNode({ ...root, embedding: [0.5, 0.5] }),
      upsertNode(fixtureNode(ref, "/consult_advice")),
      { op: "patchNode", nodeId: root.id, patch: { embedding: [1, 0], title: "Root" } },
      { op: "patchNode", nodeId: root.id, patch: { title: "Root again" } },
    ]);
    const texts = fake.texts("client:1");
    expect(heads(texts)).toEqual([
      "BEGIN",
      "INSERT INTO kg_subjects",
      "UPDATE kg_subjects SET",
      "SELECT id FROM",
      "INSERT INTO kg_nodes",
      "INSERT INTO kg_node_vectors",
      "SELECT id FROM",
      "INSERT INTO kg_nodes",
      "DELETE FROM kg_node_vectors",
      "UPDATE kg_nodes SET",
      "INSERT INTO kg_node_vectors",
      "UPDATE kg_nodes SET",
      "COMMIT",
    ]);
    const nodeInserts = fake.queries.filter((q) => q.text.startsWith("INSERT INTO kg_nodes"));
    for (const insert of nodeInserts) expect(insert.params?.[17]).toBeNull();
    expect(fake.queries.find((q) => q.text.startsWith("INSERT INTO kg_node_vectors"))?.params).toEqual([root.id, "", "rm_42", "[0.5,0.5]"]);
    expect(fake.queries.filter((q) => q.text.startsWith("UPDATE kg_nodes SET")).some((q) => /embedding_json/.test(q.text))).toBe(false);
  });

  it("refuses an embedding of the wrong width before any statement", async () => {
    const fake = new FakeSqlClient();
    const store = new PostgresStore(fake, { pgvector: true, vectorDimensions: 3 });
    await expect(store.applyBatch(ref, [upsertNode({ ...root, embedding: [1, 0] })])).rejects.toThrow("embedding has 2 dimensions; kg_node_vectors.vec is vector(3)");
    await expect(store.applyBatch(ref, [{ op: "patchNode", nodeId: root.id, patch: { embedding: [1] } }])).rejects.toThrow(/vector\(3\)/);
    await expect(store.searchNodesByEmbedding?.(ref, [1], 5)).rejects.toThrow(/vector\(3\)/);
    expect(fake.queries).toEqual([]);
    // Without a declared width the database is the judge.
    await new PostgresStore(fake, { pgvector: true }).applyBatch(ref, [upsertNode({ ...root, embedding: [1, 0] })]);
    expect(fake.queries.length).toBeGreaterThan(0);
  });

  it("searchNodesByEmbedding maps rows to { nodeId, score } with a numeric score", async () => {
    const fake = new FakeSqlClient().when(/^SELECT v\.node_id/, { rows: [{ node_id: "n_1", score: 0.9 }, { node_id: "n_2", score: "0.25" }, { bogus: true }] });
    const store = new PostgresStore(fake, { pgvector: true });
    await expect(store.searchNodesByEmbedding?.(ref, [1, 0], 2)).resolves.toEqual([
      { nodeId: "n_1", score: 0.9 },
      { nodeId: "n_2", score: 0.25 },
    ]);
    expect(fake.queries[0]?.params).toEqual(["", "rm_42", "[1,0]", 2]);
  });
});

describe("PostgresStore with allowNonAtomic", () => {
  it("runs the batch as sequential statements through query(), without BEGIN/COMMIT, and without ROLLBACK on failure", async () => {
    const fake = new FakeSqlClient().when(/RETURNING version/, { rows: [{ version: 2 }] });
    const store = new PostgresStore(fake.queryOnly(), { allowNonAtomic: true });
    await expect(store.applyBatch(ref, [upsertNode()], { expectVersion: 1 })).resolves.toEqual({ version: 2 });
    expect(heads(fake.texts("pool"))).toEqual(["INSERT INTO kg_subjects", "UPDATE kg_subjects SET", "SELECT id FROM", "INSERT INTO kg_nodes"]);
    expect(fake.connections).toBe(0);

    fake.when(/RETURNING version/, { rows: [] }).when(/^SELECT version FROM/, { rows: [{ version: 5 }] });
    await expect(store.applyBatch(ref, [upsertNode()], { expectVersion: 1 })).rejects.toMatchObject({ name: "VersionConflictError", expected: 1, actual: 5 });
    expect(fake.texts()).not.toContain("ROLLBACK");
    expect(fake.texts()).not.toContain("BEGIN");
  });

  it("deleteSubject runs its deletes sequentially too", async () => {
    const fake = new FakeSqlClient();
    await new PostgresStore(fake.queryOnly(), { allowNonAtomic: true }).deleteSubject(ref);
    expect(heads(fake.texts("pool"))).toEqual(["DELETE FROM kg_hints", "DELETE FROM kg_events", "DELETE FROM kg_audit", "DELETE FROM kg_subjects"]);
  });
});

describe("PostgresStore signals", () => {
  it("refuses an already-aborted signal before sending anything", async () => {
    const fake = new FakeSqlClient();
    const store = new PostgresStore(fake);
    const controller = new AbortController();
    const reason = new Error("deadline");
    controller.abort(reason);
    await expect(store.loadSnapshot(ref, { signal: controller.signal })).rejects.toBe(reason);
    await expect(store.applyBatch(ref, [], { signal: controller.signal })).rejects.toBe(reason);
    const nameless = new AbortController();
    nameless.abort();
    await expect(store.loadSnapshot(ref, { signal: nameless.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.queries).toEqual([]);
  });

  it("races a running read against the signal; the statement still completes afterwards", async () => {
    let finish: (() => void) | undefined;
    const fake = new FakeSqlClient().when(/^SELECT \(SELECT row_to_json\(s\)/, () => new Promise((resolve) => {
      finish = () => resolve({ rows: [{ subject: null, nodes: [], hints: [] }] });
    }));
    const store = new PostgresStore(fake);
    const controller = new AbortController();
    const pending = store.loadSnapshot(ref, { signal: controller.signal });
    controller.abort(new Error("budget"));
    await expect(pending).rejects.toThrow("budget");
    expect(fake.queries).toHaveLength(1);
    finish?.();
  });

  it("races a batch against the signal while the transaction runs to completion in the background", async () => {
    let finish: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fake = new FakeSqlClient().when(/^INSERT INTO kg_nodes/, () => settled.then(() => ({ rows: [] })));
    const store = new PostgresStore(fake);
    const controller = new AbortController();
    const pending = store.applyBatch(ref, [upsertNode()], { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("budget"));
    await expect(pending).rejects.toThrow("budget");
    expect(fake.texts("client:1")).not.toContain("COMMIT");
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.texts("client:1").at(-1)).toBe("COMMIT");
    expect(fake.releases).toHaveLength(1);
  });
});

describe("PostgresStore.loadSnapshot", () => {
  const subjectRow = { tenant_id: "", subject_id: "rm_42", version: "3", slot_aliases: { voice: "tone" }, tombstones: ["h_gone"], events_since_consolidation: 2 };

  it("is exactly one query on the pool, defaulting to active hints", async () => {
    const fake = new FakeSqlClient().when(/^SELECT \(SELECT row_to_json\(s\)/, { rows: [{ subject: subjectRow, nodes: [], hints: [] }] });
    const store = new PostgresStore(fake);
    await expect(store.loadSnapshot(ref)).resolves.toEqual({
      ref,
      version: 3,
      slotAliases: { voice: "tone" },
      tombstones: ["h_gone"],
      eventsSinceConsolidation: 2,
      nodes: [],
      hints: [],
    });
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]).toMatchObject({ route: "pool", params: ["", "rm_42", ["active"]] });
    expect(fake.connections).toBe(0);
    await store.loadSnapshot({ tenantId: "acme", subjectId: "rm_42" }, { statuses: ["active", "pending"] });
    expect(fake.queries[1]?.params).toEqual(["acme", "rm_42", ["active", "pending"]]);
  });

  it("returns null when there is no subject row and nothing under it", async () => {
    const fake = new FakeSqlClient().when(/^SELECT \(SELECT row_to_json\(s\)/, { rows: [{ subject: null, nodes: [], hints: [] }] });
    await expect(new PostgresStore(fake).loadSnapshot(ref)).resolves.toBeNull();
    const empty = new FakeSqlClient();
    await expect(new PostgresStore(empty).loadSnapshot(ref)).resolves.toBeNull();
  });

  it("maps '' back to a null tenant and keeps a bad hint row for compileSnapshot to drop", async () => {
    const node = fixtureNode(ref, "/consult_advice");
    const fake = new FakeSqlClient().when(/^SELECT \(SELECT row_to_json\(s\)/, {
      rows: [
        {
          subject: subjectRow,
          nodes: [{ ...node, tenant_id: "", subject_id: node.subjectId, parent_path: "/", merged_into: null, embedding_json: null, created_at: node.createdAt, updated_at: node.updatedAt }],
          hints: [{ id: "h_bad", tenant_id: "", subject_id: "rm_42", node_path: "/", confidence: 7 }],
        },
      ],
    });
    const snapshot = await new PostgresStore(fake).loadSnapshot({ tenantId: "", subjectId: "rm_42" });
    expect(snapshot?.ref).toEqual({ tenantId: null, subjectId: "rm_42" });
    expect(snapshot?.nodes).toEqual([node]);
    expect(snapshot?.hints).toHaveLength(1);
    expect(snapshot?.hints[0]).toMatchObject({ id: "h_bad", tenantId: null, nodePath: "/", confidence: 7 });
  });

  it("with pgvector reads the vectors sub-select and folds vectors into nodes", async () => {
    const node = fixtureNode(ref, "/");
    const fake = new FakeSqlClient().when(/^SELECT \(SELECT row_to_json\(s\)/, {
      rows: [
        {
          subject: subjectRow,
          nodes: [{ ...node, tenant_id: "", subject_id: node.subjectId, parent_path: null, merged_into: null, embedding_json: null, created_at: node.createdAt, updated_at: node.updatedAt }],
          hints: [],
          vectors: [{ node_id: node.id, vec: "[0.25,0.75]" }],
        },
      ],
    });
    const snapshot = await new PostgresStore(fake, { pgvector: true }).loadSnapshot(ref);
    expect(fake.queries[0]?.text).toContain("kg_node_vectors");
    expect(snapshot?.nodes[0]?.embedding).toEqual([0.25, 0.75]);
  });
});

describe("PostgresStore reads and ledger", () => {
  it("getHint decodes the row or returns null", async () => {
    const fake = new FakeSqlClient().when(/^SELECT row_to_json\(h\)/, hintData(warm, { created_at: "2026-01-01T00:00:00+00:00" }));
    const store = new PostgresStore(fake);
    await expect(store.getHint(ref, warm.id)).resolves.toEqual(warm);
    fake.when(/^SELECT row_to_json\(h\)/, { rows: [] });
    await expect(store.getHint(ref, warm.id)).resolves.toBeNull();
    expect(fake.queries.every((q) => q.route === "pool")).toBe(true);
  });

  it("deleteHint reports whether a row was deleted", async () => {
    const fake = new FakeSqlClient().when(/^DELETE FROM kg_hints/, { rows: [{ id: "h_1" }] });
    const store = new PostgresStore(fake);
    await expect(store.deleteHint(ref, "h_1")).resolves.toBe(true);
    fake.when(/^DELETE FROM kg_hints/, { rows: [] });
    await expect(store.deleteHint(ref, "h_1")).resolves.toBe(false);
  });

  it("deleteSubject runs its four deletes in one transaction", async () => {
    const fake = new FakeSqlClient();
    await new PostgresStore(fake).deleteSubject(ref);
    expect(heads(fake.texts("client:1"))).toEqual(["BEGIN", "DELETE FROM kg_hints", "DELETE FROM kg_events", "DELETE FROM kg_audit", "DELETE FROM kg_subjects", "COMMIT"]);
    expect(fake.releases).toHaveLength(1);
  });

  it("claimEvent is claimed when the insert returned a row and duplicate otherwise", async () => {
    const fake = new FakeSqlClient().when(/^INSERT INTO kg_events/, { rows: [{ id: "e1" }] });
    const store = new PostgresStore(fake);
    await expect(store.claimEvent(null, fixtureTurn(ref.subjectId, "e1"))).resolves.toBe("claimed");
    fake.when(/^INSERT INTO kg_events/, { rows: [] });
    await expect(store.claimEvent(null, fixtureTurn(ref.subjectId, "e1"))).resolves.toBe("duplicate");
  });

  it("leaseEvents decodes the returned rows oldest first regardless of RETURNING order", async () => {
    const row = (id: string, createdAt: string) => ({
      data: { tenant_id: "", id, subject_id: ref.subjectId, kind: "turn", payload: fixtureTurn(ref.subjectId, id), status: "processing", attempts: 0, lease_until: iso(NOW + 1000), created_at: createdAt, updated_at: createdAt },
    });
    const fake = new FakeSqlClient().when(/^UPDATE kg_events e SET status = 'processing'/, { rows: [row("e2", iso(NOW + 1)), row("e1", iso(NOW))] });
    const leased = await new PostgresStore(fake).leaseEvents({ tenantId: null, limit: 2, leaseMs: 1000, now: NOW });
    expect(leased.map((r) => r.event.id)).toEqual(["e1", "e2"]);
    expect(leased[0]).toMatchObject({ tenantId: null, status: "processing", leaseUntil: iso(NOW + 1000), proposal: null });
  });

  it("updateEvent, getEvent, getTurn and listEvents go through the pool and decode", async () => {
    const turn = fixtureTurn(ref.subjectId, "e1", { runId: "run_7" });
    const eventRow = { data: { tenant_id: "", id: "e1", subject_id: ref.subjectId, kind: "turn", payload: turn, status: "done", attempts: 1, proposal: { ops: [] }, created_at: iso(NOW), updated_at: iso(NOW) } };
    const fake = new FakeSqlClient().when(/^SELECT row_to_json\(e\) AS data FROM kg_events e WHERE e\.tenant_id = \$1 AND e\.id/, { rows: [eventRow] }).when(/^SELECT payload AS data/, { rows: [{ data: turn }] }).when(/ORDER BY e\.created_at DESC/, { rows: [eventRow, eventRow] });
    const store = new PostgresStore(fake);
    await expect(store.updateEvent(null, "e1", { status: "done" })).resolves.toBeUndefined();
    await expect(store.getEvent(null, "e1")).resolves.toMatchObject({ tenantId: null, event: turn, status: "done", attempts: 1, proposal: { ops: [] } });
    await expect(store.getTurn(ref, "run_7")).resolves.toEqual(turn);
    await expect(store.listEvents(ref, { limit: 2 })).resolves.toHaveLength(2);
    fake.when(/^SELECT payload AS data/, { rows: [] }).when(/^SELECT row_to_json\(e\)/, { rows: [] });
    await expect(store.getTurn(ref, "run_none")).resolves.toBeNull();
    await expect(store.getEvent(null, "missing")).resolves.toBeNull();
    expect(fake.queries.every((q) => q.route === "pool")).toBe(true);
  });

  it("scrubEvents and purge count returned ids; purge sends nothing without a threshold", async () => {
    const fake = new FakeSqlClient().when(/^UPDATE kg_events SET payload/, { rows: [{ id: "e1" }, { id: "e2" }] }).when(/^DELETE FROM kg_events/, { rows: [{ id: "e1" }] }).when(/^DELETE FROM kg_audit/, { rows: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] });
    const store = new PostgresStore(fake);
    await expect(store.scrubEvents(ref, { olderThan: iso(NOW) })).resolves.toBe(2);
    await expect(store.purge({ tenantId: null })).resolves.toEqual({ events: 0, audit: 0 });
    expect(fake.queries).toHaveLength(1);
    await expect(store.purge({ tenantId: null, eventsOlderThan: iso(NOW) })).resolves.toEqual({ events: 1, audit: 0 });
    await expect(store.purge({ tenantId: null, auditOlderThan: iso(NOW) })).resolves.toEqual({ events: 0, audit: 3 });
    await expect(store.purge({ tenantId: null, eventsOlderThan: iso(NOW), auditOlderThan: iso(NOW) })).resolves.toEqual({ events: 1, audit: 3 });
  });

  it("listAudit decodes entries", async () => {
    const entry = fixtureAudit(ref, "a_1", { hintId: "h_1" }, FIXTURE_T0);
    const fake = new FakeSqlClient().when(/^SELECT row_to_json\(a\)/, { rows: [{ data: { ...entry, tenant_id: "", subject_id: entry.subjectId, hint_id: "h_1", node_path: null, event_id: null } }] });
    await expect(new PostgresStore(fake).listAudit(ref, 5)).resolves.toEqual([entry]);
  });

  it("rejects with the driver's error, unwrapped", async () => {
    const boom = new Error("connection refused");
    const fake = new FakeSqlClient().when(/./, boom);
    const store = new PostgresStore(fake);
    await expect(store.loadSnapshot(ref)).rejects.toBe(boom);
    await expect(store.getHint(ref, "h")).rejects.toBe(boom);
    await expect(store.applyBatch(ref, [])).rejects.toBe(boom);
  });
});
