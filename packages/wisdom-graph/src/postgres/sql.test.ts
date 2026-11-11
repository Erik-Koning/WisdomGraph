/**
 * Every builder in sql.ts, sent through the recording client and asserted
 * on statement text and parameters; one sweep proves every statement names
 * `tenant_id` and numbers its placeholders to match its parameters. The
 * decoders are tested against rows shaped the way Postgres returns them —
 * snake_case, timestamps with numeric offsets, bigints as text — because
 * that normalisation is what lets the contract suite compare rows by value.
 */
import { describe, expect, it } from "vitest";
import type { SubjectRef } from "../core/ports";
import type { HintRecord, TopicNode } from "../core/types";
import { FIXTURE_T0, fixtureAudit, fixtureFeedback, fixtureHint, fixtureNode, fixtureTurn } from "../testing/fixtures";
import { FakeSqlClient } from "./fake-client";
import * as sql from "./sql";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const acme: SubjectRef = { tenantId: "acme", subjectId: "rm_42" };
const NOW = Date.UTC(2026, 0, 1, 12);
const iso = (ms: number): string => new Date(ms).toISOString();
const plain: sql.SqlMode = { pgvector: false };
const vectors: sql.SqlMode = { pgvector: true };

/** Send a statement through the fake and hand back what it recorded. */
async function sent(statement: sql.SqlStatement): Promise<{ text: string; params: unknown[] | undefined }> {
  const client = new FakeSqlClient();
  await client.query(statement.text, statement.params);
  const recorded = client.queries[0];
  if (!recorded) throw new Error("nothing recorded");
  return { text: recorded.text, params: recorded.params };
}

const node = fixtureNode(ref, "/consult_advice", { keywords: ["advice"], properties: { "region.default": "CA" }, embedding: [0.1, 0.2] });
const hint = fixtureHint(ref, { nodePath: "/consult_advice", slot: "disclaimers", value: "omit", text: "Omits disclaimers.", scope: "agent", agent: "consult_advice" });
const turn = fixtureTurn(ref.subjectId, "turn_1");

/** One invocation of every builder, so the sweep below cannot miss one. */
function everyStatement(): [name: string, statement: sql.SqlStatement][] {
  return [
    ["ensureSubject", sql.ensureSubject(ref)],
    ["bumpVersion", sql.bumpVersion(ref, 3)],
    ["readVersion", sql.readVersion(ref)],
    ["setSlotAlias", sql.setSlotAlias(ref, "voice", "tone")],
    ["addTombstone", sql.addTombstone(ref, "h_gone")],
    ["consolidationCounter increment", sql.consolidationCounter(ref, "increment")],
    ["consolidationCounter reset", sql.consolidationCounter(ref, "reset")],
    ["snapshotQuery", sql.snapshotQuery(ref, ["active"], plain)],
    ["snapshotQuery pgvector", sql.snapshotQuery(ref, ["active"], vectors)],
    ["nodePathHolder", sql.nodePathHolder(ref, node)],
    ["upsertNodeRow", sql.upsertNodeRow(ref, node, plain)],
    ["upsertNodeRow pgvector", sql.upsertNodeRow(ref, node, vectors)],
    ["patchNodeRow", sql.patchNodeRow(ref, node.id, { title: "Advice" }, plain)],
    ["upsertNodeVector", sql.upsertNodeVector(ref, node.id, [0.1, 0.2])],
    ["deleteNodeVector", sql.deleteNodeVector(ref, node.id)],
    ["searchNodes", sql.searchNodes(ref, [1, 0], 5)],
    ["slotHolder", sql.slotHolder(ref, hint)],
    ["upsertHintRow", sql.upsertHintRow(ref, hint)],
    ["updateHintRow", sql.updateHintRow(ref, hint)],
    ["selectHint", sql.selectHint(ref, hint.id)],
    ["deleteHintRow", sql.deleteHintRow(ref, hint.id)],
    ["insertAudit", sql.insertAudit(ref, fixtureAudit(ref, "a_1"))],
    ["listAudit", sql.listAudit(ref, 10)],
    ["purgeAudit", sql.purgeAudit(null, iso(NOW))],
    ...sql.deleteSubjectRows(ref).map((s, i): [string, sql.SqlStatement] => [`deleteSubjectRows[${i}]`, s]),
    ["claimEvent", sql.claimEvent(null, turn)],
    ["leaseEvents", sql.leaseEvents({ tenantId: null, limit: 2, leaseMs: 1000, now: NOW })],
    ["updateEvent", sql.updateEvent(null, "turn_1", { status: "done" })],
    ["selectEvent", sql.selectEvent(null, "turn_1")],
    ["selectTurn", sql.selectTurn(ref, "run_turn_1")],
    ["listEvents", sql.listEvents(ref, { limit: 5 })],
    ["scrubEvents", sql.scrubEvents(ref)],
    ["purgeEvents", sql.purgeEvents(null, iso(NOW))],
  ];
}

describe("sql builders: tenant isolation sweep", () => {
  it.each(everyStatement())("%s names tenant_id and numbers its placeholders to match its params", async (_name, statement) => {
    const { text, params } = await sent(statement);
    expect(text).toMatch(/tenant_id/);
    const placeholders = new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect([...placeholders].sort((a, b) => a - b)).toEqual((params ?? []).map((_, i) => i + 1));
  });

  it("covers every exported builder", () => {
    const builders = Object.entries(sql)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .filter((name) => !/^(decode|tenant|vectorLiteral|dataOf)/.test(name));
    const covered = new Set(everyStatement().map(([name]) => name.split(/[ [\]]/)[0]));
    for (const name of builders) expect(covered.has(name), `builder ${name} is not in the sweep`).toBe(true);
  });
});

describe("sql builders: kg_subjects", () => {
  it("ensureSubject inserts the row once, with '' for a null tenant", async () => {
    expect(await sent(sql.ensureSubject(ref))).toEqual({
      text: "INSERT INTO kg_subjects (tenant_id, subject_id) VALUES ($1, $2) ON CONFLICT (tenant_id, subject_id) DO NOTHING",
      params: ["", "rm_42"],
    });
    expect((await sent(sql.ensureSubject(acme))).params).toEqual(["acme", "rm_42"]);
  });

  it("bumpVersion updates only when the expected version matches and returns the new one", async () => {
    expect(await sent(sql.bumpVersion(ref, 3))).toEqual({
      text:
        "UPDATE kg_subjects SET version = version + 1, updated_at = now() " +
        "WHERE tenant_id = $1 AND subject_id = $2 AND ($3::bigint IS NULL OR version = $3::bigint) RETURNING version",
      params: ["", "rm_42", 3],
    });
    expect((await sent(sql.bumpVersion(ref))).params).toEqual(["", "rm_42", null]);
  });

  it("readVersion reads the stored version for the conflict error", async () => {
    expect(await sent(sql.readVersion(acme))).toEqual({
      text: "SELECT version FROM kg_subjects WHERE tenant_id = $1 AND subject_id = $2",
      params: ["acme", "rm_42"],
    });
  });

  it("setSlotAlias merges one alias into the jsonb map", async () => {
    const { text, params } = await sent(sql.setSlotAlias(ref, "voice", "tone"));
    expect(text).toContain("slot_aliases = slot_aliases || jsonb_build_object($3::text, $4::text)");
    expect(text).toContain("WHERE tenant_id = $1 AND subject_id = $2");
    expect(params).toEqual(["", "rm_42", "voice", "tone"]);
  });

  it("addTombstone appends once and keeps an existing id in place", async () => {
    const { text, params } = await sent(sql.addTombstone(ref, "h_gone"));
    expect(text).toContain("tombstones = CASE WHEN $3::text = ANY (tombstones) THEN tombstones ELSE array_append(tombstones, $3::text) END");
    expect(params).toEqual(["", "rm_42", "h_gone"]);
  });

  it("consolidationCounter increments by one, or resets and stamps last_consolidated_event", async () => {
    expect((await sent(sql.consolidationCounter(ref, "increment"))).text).toContain(
      "SET events_since_consolidation = events_since_consolidation + 1, updated_at = now()",
    );
    expect((await sent(sql.consolidationCounter(ref, "reset"))).text).toContain(
      "SET events_since_consolidation = 0, last_consolidated_event = now()::text, updated_at = now()",
    );
  });
});

describe("sql builders: snapshot", () => {
  it("is the spec's one statement: subject row, live nodes, hints in the requested statuses", async () => {
    expect(await sent(sql.snapshotQuery(ref, ["active", "pending"], plain))).toEqual({
      text:
        "SELECT (SELECT row_to_json(s) FROM kg_subjects s WHERE s.tenant_id = $1 AND s.subject_id = $2) AS subject, " +
        "(SELECT COALESCE(json_agg(n), '[]') FROM kg_nodes n WHERE n.tenant_id = $1 AND n.subject_id = $2 AND n.status IN ('active','merged')) AS nodes, " +
        "(SELECT COALESCE(json_agg(h), '[]') FROM kg_hints h WHERE h.tenant_id = $1 AND h.subject_id = $2 AND h.status = ANY ($3::text[])) AS hints",
      params: ["", "rm_42", ["active", "pending"]],
    });
  });

  it("adds the vectors sub-select only with pgvector, reading vec as text", async () => {
    const { text, params } = await sent(sql.snapshotQuery(acme, ["active"], vectors));
    expect(text).toContain(
      ", (SELECT COALESCE(json_agg(json_build_object('node_id', v.node_id, 'vec', v.vec::text)), '[]') FROM kg_node_vectors v WHERE v.tenant_id = $1 AND v.subject_id = $2) AS vectors",
    );
    expect(params).toEqual(["acme", "rm_42", ["active"]]);
    expect((await sent(sql.snapshotQuery(acme, ["active"], plain))).text).not.toContain("kg_node_vectors");
  });
});

describe("sql builders: kg_nodes", () => {
  it("nodePathHolder looks for another id on the same path", async () => {
    expect(await sent(sql.nodePathHolder(ref, node))).toEqual({
      text: "SELECT id FROM kg_nodes WHERE tenant_id = $1 AND subject_id = $2 AND path = $3 AND id <> $4 LIMIT 1",
      params: ["", "rm_42", "/consult_advice", node.id],
    });
  });

  it("upsertNodeRow writes every column with a cast, stringifies jsonb, and replaces on id within the same subject", async () => {
    const { text, params } = await sent(sql.upsertNodeRow(ref, node, plain));
    expect(text).toMatch(
      /^INSERT INTO kg_nodes \(id, tenant_id, subject_id, path, parent_path, slug, level, locked, title, description, keywords, patterns, agents, properties, status, merged_into, stats, embedding_json, version, created_at, updated_at\) VALUES \(\$1::text, \$2::text, \$3::text, \$4::text, \$5::text, \$6::text, \$7::smallint, \$8::boolean, \$9::text, \$10::text, \$11::text\[\], \$12::text\[\], \$13::text\[\], \$14::jsonb, \$15::text, \$16::text, \$17::jsonb, \$18::jsonb, \$19::int, \$20::timestamptz, \$21::timestamptz\) ON CONFLICT \(id\) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, subject_id = EXCLUDED.subject_id, path = EXCLUDED.path/,
    );
    expect(text).toContain("updated_at = EXCLUDED.updated_at WHERE kg_nodes.tenant_id = EXCLUDED.tenant_id AND kg_nodes.subject_id = EXCLUDED.subject_id");
    expect(text).not.toContain("id = EXCLUDED.id,");
    expect(params).toEqual([
      node.id,
      "",
      "rm_42",
      "/consult_advice",
      "/",
      "consult_advice",
      1,
      true,
      "Consult advice",
      "",
      ["advice"],
      [],
      [],
      '{"region.default":"CA"}',
      "active",
      null,
      '{"activeHints":0}',
      "[0.1,0.2]",
      1,
      FIXTURE_T0,
      FIXTURE_T0,
    ]);
  });

  it("upsertNodeRow never writes embedding_json with pgvector (one storage location)", async () => {
    const { params } = await sent(sql.upsertNodeRow(ref, node, vectors));
    expect(params?.[17]).toBeNull();
  });

  it("patchNodeRow sets only the patched columns, always bumps version and updated_at", async () => {
    const full = await sent(
      sql.patchNodeRow(ref, "n_1", {
        title: "T",
        description: "D",
        keywords: ["k"],
        agents: ["a"],
        properties: { p: 1 },
        status: "merged",
        mergedInto: "/x",
        stats: { activeHints: 2 },
        embedding: [1, 2],
      }, plain),
    );
    expect(full.text).toBe(
      "UPDATE kg_nodes SET title = $4::text, description = $5::text, keywords = $6::text[], agents = $7::text[], properties = $8::jsonb, " +
        "status = $9::text, merged_into = $10::text, stats = $11::jsonb, embedding_json = $12::jsonb, version = version + 1, updated_at = now() " +
        "WHERE tenant_id = $1 AND subject_id = $2 AND id = $3",
    );
    expect(full.params).toEqual(["", "rm_42", "n_1", "T", "D", ["k"], ["a"], '{"p":1}', "merged", "/x", '{"activeHints":2}', "[1,2]"]);
    const empty = await sent(sql.patchNodeRow(ref, "n_1", {}, plain));
    expect(empty.text).toBe("UPDATE kg_nodes SET version = version + 1, updated_at = now() WHERE tenant_id = $1 AND subject_id = $2 AND id = $3");
    const vectorMode = await sent(sql.patchNodeRow(ref, "n_1", { embedding: [1, 2], title: "T" }, vectors));
    expect(vectorMode.text).not.toContain("embedding_json");
    expect(vectorMode.params).toEqual(["", "rm_42", "n_1", "T"]);
  });
});

describe("sql builders: kg_node_vectors", () => {
  it("upsertNodeVector writes the vector only for a node that exists in the subject", async () => {
    const { text, params } = await sent(sql.upsertNodeVector(acme, "n_1", [0.5, 0.25]));
    expect(text).toBe(
      "INSERT INTO kg_node_vectors (node_id, tenant_id, subject_id, vec) SELECT $1::text, $2::text, $3::text, $4::vector " +
        "WHERE EXISTS (SELECT 1 FROM kg_nodes WHERE id = $1 AND tenant_id = $2 AND subject_id = $3) " +
        "ON CONFLICT (node_id) DO UPDATE SET vec = EXCLUDED.vec WHERE kg_node_vectors.tenant_id = EXCLUDED.tenant_id AND kg_node_vectors.subject_id = EXCLUDED.subject_id",
    );
    expect(params).toEqual(["n_1", "acme", "rm_42", "[0.5,0.25]"]);
  });

  it("deleteNodeVector removes the subject's vector for a node", async () => {
    expect(await sent(sql.deleteNodeVector(ref, "n_1"))).toEqual({
      text: "DELETE FROM kg_node_vectors WHERE node_id = $1 AND tenant_id = $2 AND subject_id = $3",
      params: ["n_1", "", "rm_42"],
    });
  });

  it("searchNodes ranks active nodes by cosine distance and reports similarity", async () => {
    const { text, params } = await sent(sql.searchNodes(ref, [1, 0], 5));
    expect(text).toContain("SELECT v.node_id, 1 - (v.vec <=> $3::vector) AS score FROM kg_node_vectors v");
    expect(text).toContain("JOIN kg_nodes n ON n.id = v.node_id AND n.tenant_id = v.tenant_id AND n.subject_id = v.subject_id");
    expect(text).toContain("WHERE v.tenant_id = $1 AND v.subject_id = $2 AND n.status = 'active' ORDER BY v.vec <=> $3::vector, v.node_id LIMIT $4::int");
    expect(params).toEqual(["", "rm_42", "[1,0]", 5]);
    expect((await sent(sql.searchNodes(ref, [1, 0], -3))).params?.[3]).toBe(0);
  });
});

describe("sql builders: kg_hints", () => {
  it("slotHolder matches the applicability key of an active hint under another id, unless the id is tombstoned", async () => {
    const { text, params } = await sent(sql.slotHolder(ref, hint));
    expect(text).toBe(
      "SELECT h.id FROM kg_hints h WHERE h.tenant_id = $1 AND h.subject_id = $2 AND h.node_path = $4 AND h.slot = $5 AND h.scope = $6 " +
        "AND COALESCE(h.agent, '') = $7 AND COALESCE(h.client_id, '') = $8 AND h.status = 'active' AND h.id <> $3 " +
        "AND NOT EXISTS (SELECT 1 FROM kg_subjects s WHERE s.tenant_id = $1 AND s.subject_id = $2 AND $3 = ANY (s.tombstones)) LIMIT 1",
    );
    expect(params).toEqual(["", "rm_42", hint.id, "/consult_advice", "disclaimers", "agent", "consult_advice", ""]);
    const client = fixtureHint(ref, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone.", scope: "client", clientId: "client_A" });
    expect((await sent(sql.slotHolder(ref, client))).params?.slice(6)).toEqual(["", "client_A"]);
  });

  it("upsertHintRow inserts through a SELECT gated on the subject's tombstones and replaces on id", async () => {
    const { text, params } = await sent(sql.upsertHintRow(ref, hint));
    expect(text).toMatch(
      /^INSERT INTO kg_hints \(id, tenant_id, subject_id, node_id, node_path, slot, value, text, kind, lane, scope, agent, client_id, source, confidence, priority, status, approval, maturity, needs_review, supersedes, superseded_by, retired_reason, reinforcements, contradictions, applied, provenance, version, created_at, updated_at, last_reinforced_at, last_applied_at\) SELECT \$1::text, \$2::text, \$3::text, \$4::text, \$5::text, \$6::text, \$7::text, \$8::text, \$9::text, \$10::text, \$11::text, \$12::text, \$13::text, \$14::text, \$15::real, \$16::smallint, \$17::text, \$18::text, \$19::text, \$20::boolean, \$21::text, \$22::text, \$23::text, \$24::int, \$25::int, \$26::int, \$27::jsonb, \$28::int, \$29::timestamptz, \$30::timestamptz, \$31::timestamptz, \$32::timestamptz /,
    );
    expect(text).toContain("WHERE NOT EXISTS (SELECT 1 FROM kg_subjects s WHERE s.tenant_id = $2 AND s.subject_id = $3 AND $1 = ANY (s.tombstones)) ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id");
    expect(text).toContain("last_applied_at = EXCLUDED.last_applied_at WHERE kg_hints.tenant_id = EXCLUDED.tenant_id AND kg_hints.subject_id = EXCLUDED.subject_id");
    expect(params).toEqual([
      hint.id,
      "",
      "rm_42",
      hint.nodeId,
      "/consult_advice",
      "disclaimers",
      "omit",
      "Omits disclaimers.",
      "preference",
      "agent",
      "agent",
      "consult_advice",
      null,
      "explicit",
      0.8,
      60,
      "active",
      "auto",
      "captured",
      false,
      null,
      null,
      null,
      0,
      0,
      0,
      JSON.stringify(hint.provenance),
      1,
      FIXTURE_T0,
      FIXTURE_T0,
      FIXTURE_T0,
      null,
    ]);
  });

  it("updateHintRow rewrites every column but the key, with updated_at from the database", async () => {
    const patched: HintRecord = { ...hint, supersedes: "h_old", retiredReason: "obsolete", lastAppliedAt: iso(NOW), reinforcements: 4 };
    const { text, params } = await sent(sql.updateHintRow(ref, patched));
    expect(text).toMatch(/^UPDATE kg_hints SET node_id = \$1::text, node_path = \$2::text, slot = \$3::text, value = \$4::text, text = \$5::text/);
    expect(text).toContain("provenance = $24::jsonb, version = $25::int, created_at = $26::timestamptz, last_reinforced_at = $27::timestamptz, last_applied_at = $28::timestamptz, updated_at = now()");
    expect(text).toContain("WHERE tenant_id = $30 AND subject_id = $31 AND id = $29");
    const setClause = text.slice(0, text.indexOf(" WHERE "));
    expect(setClause).not.toMatch(/\b(id|tenant_id|subject_id|updated_at) = \$/);
    expect(params?.slice(-3)).toEqual([hint.id, "", "rm_42"]);
    expect(params?.[17]).toBe("h_old");
    expect(params?.[19]).toBe("obsolete");
    expect(params?.[20]).toBe(4);
    expect(params?.[27]).toBe(iso(NOW));
  });

  it("selectHint and deleteHintRow address the row by subject and id", async () => {
    expect(await sent(sql.selectHint(acme, "h_1"))).toEqual({
      text: "SELECT row_to_json(h) AS data FROM kg_hints h WHERE h.tenant_id = $1 AND h.subject_id = $2 AND h.id = $3",
      params: ["acme", "rm_42", "h_1"],
    });
    expect(await sent(sql.deleteHintRow(ref, "h_1"))).toEqual({
      text: "DELETE FROM kg_hints WHERE tenant_id = $1 AND subject_id = $2 AND id = $3 RETURNING id",
      params: ["", "rm_42", "h_1"],
    });
  });
});

describe("sql builders: kg_audit and subject deletion", () => {
  it("insertAudit writes the entry once, with optional columns as NULL", async () => {
    const entry = fixtureAudit(ref, "a_1", { action: "hint.created", hintId: "h_1", detail: { reason: "x" } }, iso(NOW));
    expect(await sent(sql.insertAudit(ref, entry))).toEqual({
      text:
        "INSERT INTO kg_audit (id, tenant_id, subject_id, at, actor, action, hint_id, node_path, event_id, detail) " +
        "VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb) ON CONFLICT (id) DO NOTHING",
      params: ["a_1", "", "rm_42", iso(NOW), "system:test", "hint.created", "h_1", null, null, '{"reason":"x"}'],
    });
  });

  it("listAudit reads newest first up to a non-negative limit", async () => {
    const { text, params } = await sent(sql.listAudit(ref, 10));
    expect(text).toBe(
      "SELECT row_to_json(a) AS data FROM kg_audit a WHERE a.tenant_id = $1 AND a.subject_id = $2 ORDER BY a.at DESC, a.id DESC LIMIT $3::int",
    );
    expect(params).toEqual(["", "rm_42", 10]);
    expect((await sent(sql.listAudit(ref, -1))).params?.[2]).toBe(0);
  });

  it("purgeAudit deletes one tenant's rows older than the instant", async () => {
    expect(await sent(sql.purgeAudit("acme", iso(NOW)))).toEqual({
      text: "DELETE FROM kg_audit WHERE tenant_id = $1 AND at < $2::timestamptz RETURNING id",
      params: ["acme", iso(NOW)],
    });
  });

  it("deleteSubjectRows clears hints, events and audit by key and the subject row last (nodes cascade)", async () => {
    const statements = sql.deleteSubjectRows(acme);
    expect(statements.map((s) => s.text)).toEqual([
      "DELETE FROM kg_hints WHERE tenant_id = $1 AND subject_id = $2",
      "DELETE FROM kg_events WHERE tenant_id = $1 AND subject_id = $2",
      "DELETE FROM kg_audit WHERE tenant_id = $1 AND subject_id = $2",
      "DELETE FROM kg_subjects WHERE tenant_id = $1 AND subject_id = $2",
    ]);
    for (const s of statements) expect(s.params).toEqual(["acme", "rm_42"]);
  });
});

describe("sql builders: kg_events", () => {
  it("claimEvent inserts once per (tenant, id) and returns the id only when it did", async () => {
    expect(await sent(sql.claimEvent(null, turn))).toEqual({
      text:
        "INSERT INTO kg_events (tenant_id, id, subject_id, kind, run_id, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb) " +
        "ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id",
      params: ["", "turn_1", "rm_42", "turn", "run_turn_1", JSON.stringify(turn)],
    });
    const feedback = fixtureFeedback(ref.subjectId, "fb_1");
    expect((await sent(sql.claimEvent("acme", feedback))).params).toEqual(["acme", "fb_1", "rm_42", "feedback", "run_fb_1", JSON.stringify(feedback)]);
    const consolidate = { type: "consolidate" as const, id: "c_1", subjectId: ref.subjectId, nodePath: "/" };
    expect((await sent(sql.claimEvent(null, consolidate))).params).toEqual(["", "c_1", "rm_42", "consolidate", null, JSON.stringify(consolidate)]);
  });

  it("leaseEvents picks oldest first with SKIP LOCKED, hides future leases and retries, and stamps now + leaseMs", async () => {
    const { text, params } = await sent(sql.leaseEvents({ tenantId: null, limit: 2, leaseMs: 60_000, now: NOW }));
    expect(text).toBe(
      "UPDATE kg_events e SET status = 'processing', lease_until = $7::timestamptz, updated_at = now() FROM (" +
        "SELECT tenant_id, id FROM kg_events WHERE tenant_id = $1 AND status = ANY ($2::text[]) " +
        "AND (lease_until IS NULL OR lease_until <= $3::timestamptz) AND (retry_at IS NULL OR retry_at <= $3::timestamptz) " +
        "AND ($4::text[] IS NULL OR id = ANY ($4::text[])) AND ($5::text IS NULL OR subject_id = $5::text) " +
        "ORDER BY created_at, id LIMIT $6::int FOR UPDATE SKIP LOCKED) picked " +
        "WHERE e.tenant_id = picked.tenant_id AND e.id = picked.id RETURNING row_to_json(e) AS data",
    );
    expect(params).toEqual(["", ["pending", "failed", "processing"], iso(NOW), null, null, 2, iso(NOW + 60_000)]);
    const narrowed = await sent(
      sql.leaseEvents({ tenantId: "acme", limit: -1, leaseMs: 1, now: NOW, ids: ["e1"], subjectId: "rm_9", statuses: ["failed"] }),
    );
    expect(narrowed.params).toEqual(["acme", ["failed"], iso(NOW), ["e1"], "rm_9", 0, iso(NOW + 1)]);
  });

  it.each<[name: string, patch: Parameters<typeof sql.updateEvent>[2], set: string, params: unknown[]]>([
    ["attempts alone leaves the lease", { attempts: 1 }, "attempts = $3::int, updated_at = now()", [1]],
    ["failed releases the lease and sets retry_at", { status: "failed", error: "boom", retryAt: iso(NOW) }, "status = $3::text, error = $4::text, lease_until = NULL, retry_at = $5::timestamptz, updated_at = now()", ["failed", "boom", iso(NOW)]],
    ["processing with a lease renews it", { status: "processing", leaseUntil: iso(NOW) }, "status = $3::text, lease_until = $4::timestamptz, updated_at = now()", ["processing", iso(NOW)]],
    ["pending with a lease in the same patch keeps that lease", { status: "pending", leaseUntil: iso(NOW) }, "status = $3::text, lease_until = $4::timestamptz, updated_at = now()", ["pending", iso(NOW)]],
    ["done releases the lease", { status: "done" }, "status = $3::text, lease_until = NULL, updated_at = now()", ["done"]],
    ["proposal null clears it", { proposal: null }, "proposal = $3::jsonb, updated_at = now()", [null]],
    ["proposal and result are jsonb text", { proposal: { ops: [] }, result: { accepted: 1, rejected: [] } }, "proposal = $3::jsonb, result = $4::jsonb, updated_at = now()", ['{"ops":[]}', '{"accepted":1,"rejected":[]}']],
    ["an empty patch still touches updated_at", {}, "updated_at = now()", []],
  ])("updateEvent: %s", async (_name, patch, set, extra) => {
    const { text, params } = await sent(sql.updateEvent("acme", "e1", patch));
    expect(text).toBe(`UPDATE kg_events SET ${set} WHERE tenant_id = $1 AND id = $2`);
    expect(params).toEqual(["acme", "e1", ...extra]);
  });

  it("selectEvent, selectTurn and listEvents read rows as JSON", async () => {
    expect(await sent(sql.selectEvent(null, "e1"))).toEqual({
      text: "SELECT row_to_json(e) AS data FROM kg_events e WHERE e.tenant_id = $1 AND e.id = $2",
      params: ["", "e1"],
    });
    expect(await sent(sql.selectTurn(ref, "run_7"))).toEqual({
      text:
        "SELECT payload AS data FROM kg_events WHERE tenant_id = $1 AND subject_id = $2 AND kind = 'turn' AND run_id = $3 " +
        "ORDER BY created_at, id LIMIT 1",
      params: ["", "rm_42", "run_7"],
    });
    const all = await sent(sql.listEvents(ref, { limit: 5 }));
    expect(all.text).toBe(
      "SELECT row_to_json(e) AS data FROM kg_events e WHERE e.tenant_id = $1 AND e.subject_id = $2 " +
        "AND ($3::text[] IS NULL OR e.status = ANY ($3::text[])) ORDER BY e.created_at DESC, e.id DESC LIMIT $4::int",
    );
    expect(all.params).toEqual(["", "rm_42", null, 5]);
    expect((await sent(sql.listEvents(ref, { limit: 5, statuses: ["done", "failed"] }))).params).toEqual(["", "rm_42", ["done", "failed"], 5]);
  });

  it("scrubEvents blanks turn and feedback text, drops the proposal, stamps unscrubbed rows, and leaves consolidate rows alone", async () => {
    const { text, params } = await sent(sql.scrubEvents(ref, iso(NOW)));
    expect(text).toBe(
      "UPDATE kg_events SET payload = CASE kind " +
        `WHEN 'turn' THEN payload || '{"userText":"","assistantText":""}'::jsonb ` +
        `WHEN 'feedback' THEN CASE WHEN payload ? 'text' THEN payload || '{"text":""}'::jsonb ELSE payload END ` +
        "ELSE payload END, proposal = NULL, scrubbed_at = now(), updated_at = now() " +
        "WHERE tenant_id = $1 AND subject_id = $2 AND kind IN ('turn','feedback') AND scrubbed_at IS NULL " +
        "AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz) RETURNING id",
    );
    expect(params).toEqual(["", "rm_42", iso(NOW)]);
    expect((await sent(sql.scrubEvents(ref))).params).toEqual(["", "rm_42", null]);
  });

  it("purgeEvents deletes only done rows older than the instant", async () => {
    expect(await sent(sql.purgeEvents(null, iso(NOW)))).toEqual({
      text: "DELETE FROM kg_events WHERE tenant_id = $1 AND status = 'done' AND created_at < $2::timestamptz RETURNING id",
      params: ["", iso(NOW)],
    });
  });
});

// ── Decoders ─────────────────────────────────────────────────────────────────

/** A hint the way `row_to_json(h)` renders it: snake_case, timestamps with an offset, jsonb already parsed. */
function pgHintRow(record: HintRecord, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pgTime = (isoZ: string): string => isoZ.replace(/\.000Z$/, "+00:00");
  return {
    id: record.id,
    tenant_id: record.tenantId ?? "",
    subject_id: record.subjectId,
    node_id: record.nodeId,
    node_path: record.nodePath,
    slot: record.slot,
    value: record.value,
    text: record.text,
    kind: record.kind,
    lane: record.lane,
    scope: record.scope,
    agent: record.agent ?? null,
    client_id: record.clientId ?? null,
    source: record.source,
    confidence: record.confidence,
    priority: record.priority,
    status: record.status,
    approval: record.approval,
    maturity: record.maturity,
    needs_review: record.needsReview,
    supersedes: record.supersedes ?? null,
    superseded_by: record.supersededBy ?? null,
    retired_reason: record.retiredReason ?? null,
    reinforcements: record.reinforcements,
    contradictions: record.contradictions,
    applied: record.applied,
    provenance: record.provenance,
    version: record.version,
    created_at: pgTime(record.createdAt),
    updated_at: pgTime(record.updatedAt),
    last_reinforced_at: pgTime(record.lastReinforcedAt),
    last_applied_at: record.lastAppliedAt === undefined ? null : pgTime(record.lastAppliedAt),
    ...overrides,
  };
}

function pgNodeRow(record: TopicNode, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: record.id,
    tenant_id: record.tenantId ?? "",
    subject_id: record.subjectId,
    path: record.path,
    parent_path: record.parentPath,
    slug: record.slug,
    level: record.level,
    locked: record.locked,
    title: record.title,
    description: record.description,
    keywords: record.keywords,
    patterns: record.patterns,
    agents: record.agents,
    properties: record.properties,
    status: record.status,
    merged_into: record.mergedInto ?? null,
    stats: record.stats,
    embedding_json: record.embedding ?? null,
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ...overrides,
  };
}

describe("sql decoders", () => {
  it("tenant '' ↔ null at the boundary", () => {
    expect(sql.tenantColumn(null)).toBe("");
    expect(sql.tenantColumn(undefined)).toBe("");
    expect(sql.tenantColumn("acme")).toBe("acme");
    expect(sql.tenantOut("")).toBeNull();
    expect(sql.tenantOut(null)).toBeNull();
    expect(sql.tenantOut(undefined)).toBeNull();
    expect(sql.tenantOut("acme")).toBe("acme");
  });

  it("decodeHint maps a pg row back to the record it was written from, omitting NULL optionals and normalising timestamps", () => {
    expect(sql.decodeHint(pgHintRow(hint))).toEqual(hint);
    const client = fixtureHint(acme, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone.", scope: "client", clientId: "client_A", supersedes: "h_0", lastAppliedAt: iso(NOW) });
    const decoded = sql.decodeHint(pgHintRow(client));
    expect(decoded).toEqual(client);
    expect(decoded.tenantId).toBe("acme");
    expect(Object.keys(decoded)).not.toContain("agent");
    expect(Object.keys(decoded)).not.toContain("supersededBy");
  });

  it("decodeHint accepts Date objects, bigint-as-text counters and jsonb-as-text, and leaves an unparseable value alone", () => {
    const decoded = sql.decodeHint(
      pgHintRow(hint, {
        created_at: new Date(FIXTURE_T0),
        reinforcements: "12",
        provenance: JSON.stringify(hint.provenance),
        updated_at: "not a date",
        confidence: "high",
      }),
    );
    expect(decoded.createdAt).toBe(FIXTURE_T0);
    expect(decoded.reinforcements).toBe(12);
    expect(decoded.provenance).toEqual(hint.provenance);
    expect(decoded.updatedAt).toBe("not a date");
    expect(decoded.confidence).toBe("high");
    // Not a row at all: every column reads as absent, which the validator will name field by field.
    expect(sql.decodeHint(null)).toEqual(sql.decodeHint(undefined));
    expect(sql.decodeHint("junk")).toMatchObject({ tenantId: null });
    expect(Object.keys(sql.decodeHint(null))).not.toContain("agent");
  });

  it("decodeNode maps a pg row back to the node, with embedding_json as the embedding", () => {
    expect(sql.decodeNode(pgNodeRow(node))).toEqual(node);
    const merged = fixtureNode(ref, "/consult_kyp", { status: "merged", mergedInto: "/consult_advice" });
    expect(sql.decodeNode(pgNodeRow(merged))).toEqual(merged);
    const root = fixtureNode(acme, "/");
    const decodedRoot = sql.decodeNode(pgNodeRow(root, { created_at: "2026-01-01T00:00:00+00:00", level: "0", properties: "{}" }));
    expect(decodedRoot).toEqual(root);
    expect(Object.keys(decodedRoot)).not.toContain("embedding");
    expect(Object.keys(decodedRoot)).not.toContain("mergedInto");
  });

  it("decodeEvent reads the ledger row: proposal NULL is null, other NULL optionals are omitted", () => {
    const decoded = sql.decodeEvent({
      tenant_id: "",
      subject_id: ref.subjectId,
      id: "e1",
      kind: "turn",
      payload: turn,
      status: "failed",
      attempts: "2",
      error: "boom",
      lease_until: null,
      retry_at: "2026-01-01T12:00:05+00:00",
      proposal: null,
      result: { accepted: 1, rejected: [] },
      scrubbed_at: null,
      created_at: "2026-01-01T12:00:00.123456+00:00",
      updated_at: new Date(NOW),
    });
    expect(decoded).toEqual({
      tenantId: null,
      event: turn,
      status: "failed",
      attempts: 2,
      error: "boom",
      retryAt: iso(NOW + 5000),
      proposal: null,
      result: { accepted: 1, rejected: [] },
      createdAt: "2026-01-01T12:00:00.123Z",
      updatedAt: iso(NOW),
    });
    expect(Object.keys(decoded)).not.toContain("leaseUntil");
    expect(sql.decodeEvent({ payload: JSON.stringify(turn), proposal: JSON.stringify({ ops: [] }) })).toMatchObject({ event: turn, proposal: { ops: [] } });
  });

  it("decodeAudit and decodeSubject map their rows, reading bigint text as a number", () => {
    const entry = fixtureAudit(acme, "a_1", { hintId: "h_1", nodePath: "/", eventId: "e1", detail: { reason: "x" } }, iso(NOW));
    expect(sql.decodeAudit({ ...entry, tenant_id: "acme", subject_id: entry.subjectId, hint_id: "h_1", node_path: "/", event_id: "e1", at: "2026-01-01T12:00:00+00:00" })).toEqual(entry);
    const bare = sql.decodeAudit({ id: "a_2", tenant_id: "", subject_id: "rm_42", at: iso(NOW), actor: "x", action: "y", hint_id: null, node_path: null, event_id: null, detail: {} });
    expect(Object.keys(bare).sort()).toEqual(["action", "actor", "at", "detail", "id", "subjectId", "tenantId"]);
    expect(sql.decodeSubject({ version: "7", slot_aliases: { a: "b" }, tombstones: ["h"], events_since_consolidation: 3 })).toEqual({
      version: 7,
      slotAliases: { a: "b" },
      tombstones: ["h"],
      eventsSinceConsolidation: 3,
    });
    expect(sql.decodeVersion({ version: "3" })).toBe(3);
    expect(sql.decodeVersion({ version: 4 })).toBe(4);
    expect(sql.decodeVersion(undefined)).toBe(0);
  });

  it("decodeVectors keeps only well-formed {node_id, vec} rows", () => {
    const vectors = sql.decodeVectors([
      { node_id: "n_1", vec: "[0.1,0.2]" },
      { node_id: "n_2", vec: [1, 0] },
      { node_id: "n_3", vec: "not json" },
      { node_id: 4, vec: "[1]" },
      { node_id: "n_5", vec: "[1,\"x\"]" },
      "junk",
    ]);
    expect([...vectors.entries()]).toEqual([
      ["n_1", [0.1, 0.2]],
      ["n_2", [1, 0]],
    ]);
    expect(sql.decodeVectors("nope").size).toBe(0);
  });

  it("decodeSnapshot is null with no subject row and nothing under it, else the subject's state with '' → null", () => {
    expect(sql.decodeSnapshot({ subject: null, nodes: [], hints: [] }, ref)).toBeNull();
    expect(sql.decodeSnapshot(undefined, ref)).toBeNull();
    const subject = { tenant_id: "", subject_id: "rm_42", version: "5", slot_aliases: { voice: "tone" }, tombstones: ["h_gone"], events_since_consolidation: 2 };
    const decoded = sql.decodeSnapshot({ subject, nodes: [pgNodeRow(node)], hints: [pgHintRow(hint)] }, { tenantId: "", subjectId: "rm_42" });
    expect(decoded).toEqual({
      ref: { tenantId: null, subjectId: "rm_42" },
      version: 5,
      slotAliases: { voice: "tone" },
      tombstones: ["h_gone"],
      eventsSinceConsolidation: 2,
      nodes: [node],
      hints: [hint],
    });
    // A subject row alone is a graph at its version; the driver may hand the columns back as text.
    expect(sql.decodeSnapshot({ subject: JSON.stringify(subject), nodes: "[]", hints: "[]" }, acme)).toMatchObject({ ref: acme, version: 5, nodes: [], hints: [] });
  });

  it("decodeSnapshot folds pgvector rows into their nodes and passes bad hint rows through for compileSnapshot", () => {
    const bare = fixtureNode(ref, "/consult_advice");
    const other = fixtureNode(ref, "/consult_kyp");
    const subject = { version: 1, slot_aliases: {}, tombstones: [], events_since_consolidation: 0 };
    const { slot, ...withoutSlot } = pgHintRow(hint);
    void slot;
    const decoded = sql.decodeSnapshot(
      { subject, nodes: [pgNodeRow(bare), pgNodeRow(other)], hints: [withoutSlot], vectors: [{ node_id: bare.id, vec: "[0.5,0.5]" }] },
      ref,
    );
    expect(decoded?.nodes).toEqual([{ ...bare, embedding: [0.5, 0.5] }, other]);
    expect(decoded?.hints).toHaveLength(1);
    expect(decoded?.hints[0]?.slot).toBeUndefined();
    expect(decoded?.hints[0]?.id).toBe(hint.id);
  });

  it("decodeTurn returns the payload object or null", () => {
    expect(sql.decodeTurn(turn)).toEqual(turn);
    expect(sql.decodeTurn(undefined)).toBeNull();
    expect(sql.decodeTurn("x")).toBeNull();
    expect(sql.dataOf({ data: JSON.stringify(turn) })).toEqual(turn);
    expect(sql.dataOf(undefined)).toBeUndefined();
  });
});
