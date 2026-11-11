/**
 * store-contract.ts — the spec §7.1 StorePort contract as one shared suite.
 *
 * Two stores ship (memory, Postgres) and a consumer may bring a third. The
 * engine's guarantees — idempotent ingest, atomic batches under a version
 * check, tombstones that stop resurrection, leases that make two workers
 * safe — are only as true as the store beneath them, so the contract is a
 * suite every implementation runs rather than prose each one re-reads. A
 * behaviour is pinned here exactly once; a store that diverges fails by
 * name.
 *
 * The suite uses the test runner's globals (`describe`, `it`, `expect`,
 * `beforeEach`, `afterEach`) rather than importing a runner, because this
 * file ships in the `testing` subpath and must add no dependency. Run it
 * under vitest with `globals: true`, as this package does.
 *
 * Every test gets a fresh store from `makeStore` and calls `close` after, so
 * an integration run against a real database starts each test clean. Rows
 * come from the fixture builders so "a valid row" is defined once.
 *
 * Where the spec is silent the suite chooses the reading that keeps the
 * memory and Postgres stores identical, and pins it: a status patch other
 * than `processing` releases the row's lease; a row addressed to another
 * subject or tenant is refused; `purge` deletes only `done` events; and
 * `scrubEvents` ignores `consolidate` rows. A store without the optional
 * `searchNodesByEmbedding` reports that test as skipped, never as passed.
 */

import { VersionConflictError } from "../core/ports";
import type { StoreOp, StorePort, SubjectRef } from "../core/ports";
import type { EventStatus, HintRecord } from "../core/types";
import { fixtureAudit, fixtureFeedback, fixtureHint, fixtureNode, fixtureTurn } from "./fixtures";

export type StoreFactory = () => Promise<{ store: StorePort; close?: () => Promise<void> }>;

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const other: SubjectRef = { tenantId: null, subjectId: "rm_99" };
const tenantA: SubjectRef = { tenantId: "acme", subjectId: "rm_42" };

/** A fixed "now" for lease arithmetic: leases compare against the caller's number, never the wall clock. */
const NOW = Date.UTC(2026, 0, 1, 12);
const iso = (ms: number): string => new Date(ms).toISOString();

export function storeContractTests(name: string, makeStore: StoreFactory): void {
  describe(`StorePort contract: ${name}`, () => {
    let store: StorePort;
    let close: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const made = await makeStore();
      store = made.store;
      close = made.close;
    });

    afterEach(async () => {
      await close?.();
    });

    const node = (path: string, overrides: Parameters<typeof fixtureNode>[2] = {}) => fixtureNode(ref, path, overrides);
    const hint = (spec: Parameters<typeof fixtureHint>[1]) => fixtureHint(ref, spec);
    const upsertNode = (path: string): StoreOp => ({ op: "upsertNode", node: node(path) });
    const upsertHint = (record: HintRecord): StoreOp => ({ op: "upsertHint", hint: record });
    const activeHints = async (subject: SubjectRef = ref): Promise<HintRecord[]> => (await store.loadSnapshot(subject))?.hints ?? [];

    // ── claimEvent ──

    describe("claimEvent", () => {
      it("is idempotent per (tenantId, id): the second claim is a duplicate, another tenant is a fresh claim", async () => {
        const turn = fixtureTurn(ref.subjectId, "turn_1");
        await expect(store.claimEvent(null, turn)).resolves.toBe("claimed");
        await expect(store.claimEvent(null, turn)).resolves.toBe("duplicate");
        await expect(store.claimEvent("acme", turn)).resolves.toBe("claimed");
        const row = await store.getEvent(null, "turn_1");
        expect(row).toMatchObject({ tenantId: null, event: turn, status: "pending", attempts: 0 });
        expect(Date.parse(row?.createdAt ?? "")).not.toBeNaN();
        expect(Date.parse(row?.updatedAt ?? "")).not.toBeNaN();
      });

      it("keeps the first body when a duplicate carries different text", async () => {
        const turn = fixtureTurn(ref.subjectId, "turn_1", { userText: "first" });
        await store.claimEvent(null, turn);
        await expect(store.claimEvent(null, { ...turn, userText: "second" })).resolves.toBe("duplicate");
        expect((await store.getEvent(null, "turn_1"))?.event).toEqual(turn);
      });

      it("stores every body kind: turn, feedback and consolidate", async () => {
        await store.claimEvent(null, fixtureFeedback(ref.subjectId, "fb_1", { signal: "down", text: "too long" }));
        await store.claimEvent(null, { type: "consolidate", id: "cons_1", subjectId: ref.subjectId, nodePath: "/consult_advice" });
        expect((await store.getEvent(null, "fb_1"))?.event).toMatchObject({ type: "feedback", signal: "down", text: "too long" });
        expect((await store.getEvent(null, "cons_1"))?.event).toMatchObject({ type: "consolidate", nodePath: "/consult_advice" });
      });
    });

    // ── applyBatch ──

    describe("applyBatch", () => {
      it("creates the subject row and bumps the version on every batch, even an empty one", async () => {
        await expect(store.applyBatch(ref, [])).resolves.toEqual({ version: 1 });
        await expect(store.applyBatch(ref, [])).resolves.toEqual({ version: 2 });
        const snapshot = await store.loadSnapshot(ref);
        expect(snapshot).toEqual({
          ref,
          version: 2,
          slotAliases: {},
          tombstones: [],
          eventsSinceConsolidation: 0,
          nodes: [],
          hints: [],
        });
      });

      it("throws VersionConflictError when expectVersion mismatches, leaving nothing applied", async () => {
        const conflict = store.applyBatch(ref, [upsertNode("/")], { expectVersion: 3 });
        await expect(conflict).rejects.toBeInstanceOf(VersionConflictError);
        await expect(conflict).rejects.toMatchObject({ expected: 3, actual: 0 });
        await expect(store.loadSnapshot(ref)).resolves.toBeNull();

        await expect(store.applyBatch(ref, [upsertNode("/")], { expectVersion: 0 })).resolves.toEqual({ version: 1 });
        const stale = store.applyBatch(ref, [upsertNode("/consult_advice")], { expectVersion: 0 });
        await expect(stale).rejects.toMatchObject({ name: "VersionConflictError", expected: 0, actual: 1 });
        const snapshot = await store.loadSnapshot(ref);
        expect(snapshot?.version).toBe(1);
        expect(snapshot?.nodes.map((n) => n.path)).toEqual(["/"]);
      });

      it("is all-or-nothing: a failing op leaves the whole batch unapplied", async () => {
        await store.applyBatch(ref, [upsertNode("/")]);
        const clash = { ...node("/"), id: "n_other_id" };
        const batch = store.applyBatch(ref, [
          upsertHint(hint({ nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." })),
          { op: "setSlotAlias", from: "voice", to: "tone" },
          { op: "upsertNode", node: clash },
        ]);
        await expect(batch).rejects.toThrow(/path \/ already belongs to node/);
        const snapshot = await store.loadSnapshot(ref);
        expect(snapshot?.version).toBe(1);
        expect(snapshot?.hints).toEqual([]);
        expect(snapshot?.slotAliases).toEqual({});
        await expect(store.listAudit(ref, 10)).resolves.toEqual([]);
      });

      it("rejects a row addressed to another subject or tenant, applying nothing to either", async () => {
        // Postgres would insert the row's own subject_id; refusing it here keeps the two stores identical.
        const misfiled: StoreOp[] = [
          { op: "upsertNode", node: fixtureNode(other, "/") },
          upsertHint(fixtureHint(other, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." })),
          { op: "upsertNode", node: fixtureNode(tenantA, "/") },
          { op: "audit", entry: fixtureAudit(tenantA, "a_1") },
        ];
        for (const op of misfiled) {
          await expect(store.applyBatch(ref, [upsertNode("/consult_advice"), op]), op.op).rejects.toThrow(/belongs to/);
        }
        await expect(store.loadSnapshot(ref)).resolves.toBeNull();
        await expect(store.loadSnapshot(other)).resolves.toBeNull();
        await expect(store.loadSnapshot(tenantA)).resolves.toBeNull();
        await expect(store.listAudit(tenantA, 10)).resolves.toEqual([]);
        // null and "" name the same tenant (§7.1), so that pair is not a mismatch.
        await store.applyBatch({ tenantId: "", subjectId: ref.subjectId }, [upsertNode("/")]);
        expect((await store.loadSnapshot(ref))?.nodes).toHaveLength(1);
      });

      it("upsertNode inserts, replaces the node with the same id, and rejects a different id on the same path", async () => {
        const first = node("/consult_advice", { title: "Advice" });
        await store.applyBatch(ref, [{ op: "upsertNode", node: first }]);
        const replaced = { ...first, title: "Advice and planning", keywords: ["retirement"], version: 2 };
        await store.applyBatch(ref, [{ op: "upsertNode", node: replaced }]);
        expect((await store.loadSnapshot(ref))?.nodes).toEqual([replaced]);
        const imposter = { ...first, id: "n_imposter" };
        await expect(store.applyBatch(ref, [{ op: "upsertNode", node: imposter }])).rejects.toThrow(/already belongs/);
        expect((await store.loadSnapshot(ref))?.nodes).toEqual([replaced]);
      });

      it("skips upsertHint of a tombstoned id, whether the tombstone came earlier or in the same batch", async () => {
        const earlier = hint({ id: "h_forgotten", nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
        await store.applyBatch(ref, [{ op: "addTombstone", hintId: earlier.id }]);
        await store.applyBatch(ref, [upsertHint(earlier)]);
        await expect(store.getHint(ref, earlier.id)).resolves.toBeNull();

        const sameBatch = hint({ id: "h_forgotten_2", nodePath: "/", slot: "greeting", value: "first name", text: "Calls clients by first name." });
        await store.applyBatch(ref, [{ op: "addTombstone", hintId: sameBatch.id }, upsertHint(sameBatch)]);
        await expect(store.getHint(ref, sameBatch.id)).resolves.toBeNull();

        const snapshot = await store.loadSnapshot(ref);
        expect(snapshot?.tombstones).toEqual(["h_forgotten", "h_forgotten_2"]);
        expect(snapshot?.hints).toEqual([]);
      });

      it("patchNode applies every patchable field and bumps the row version", async () => {
        const original = node("/consult_advice");
        await store.applyBatch(ref, [{ op: "upsertNode", node: original }]);
        await store.applyBatch(ref, [
          {
            op: "patchNode",
            nodeId: original.id,
            patch: {
              title: "Advice (merged)",
              description: "Merged into knowledge.",
              keywords: ["advice", "planning"],
              agents: ["consult_advice", "consult_kyp"],
              properties: { "region.default": "CA" },
              status: "merged",
              mergedInto: "/consult_knowledge",
              stats: { activeHints: 3, lastIngestAt: iso(NOW) },
              embedding: [0.5, 0.5],
            },
          },
        ]);
        const [patched] = (await store.loadSnapshot(ref))?.nodes ?? [];
        expect(patched).toMatchObject({
          id: original.id,
          path: "/consult_advice",
          title: "Advice (merged)",
          description: "Merged into knowledge.",
          keywords: ["advice", "planning"],
          agents: ["consult_advice", "consult_kyp"],
          properties: { "region.default": "CA" },
          status: "merged",
          mergedInto: "/consult_knowledge",
          stats: { activeHints: 3, lastIngestAt: iso(NOW) },
          embedding: [0.5, 0.5],
          version: original.version + 1,
          createdAt: original.createdAt,
        });
      });

      it("patchHint applies scalars, add-counters, provenance appends and approval, and bumps the row version", async () => {
        const original = hint({
          nodePath: "/consult_advice",
          slot: "disclaimers",
          value: "omit",
          text: "Omits disclaimers.",
          scope: "agent",
          agent: "consult_advice",
          reinforcements: 1,
          contradictions: 0,
          applied: 2,
        });
        await store.applyBatch(ref, [upsertHint(original)]);
        await store.applyBatch(ref, [
          {
            op: "patchHint",
            hintId: original.id,
            patch: {
              text: "Omits regulatory disclaimers unless asked.",
              value: "omit unless asked",
              priority: 90,
              confidence: 0.95,
              status: "active",
              approval: "approved",
              maturity: "consolidated",
              needsReview: true,
              supersedes: "h_older",
              lastReinforcedAt: iso(NOW),
              lastAppliedAt: iso(NOW + 1),
              reinforcements: { add: 2 },
              contradictions: { add: 1 },
              applied: { add: 3 },
              provenance: { appendEventId: "fb_2", appendRunId: "run_2", approval: { by: "rm_admin", at: iso(NOW), note: "ok" } },
            },
          },
        ]);
        const patched = await store.getHint(ref, original.id);
        expect(patched).toMatchObject({
          text: "Omits regulatory disclaimers unless asked.",
          value: "omit unless asked",
          priority: 90,
          confidence: 0.95,
          approval: "approved",
          maturity: "consolidated",
          needsReview: true,
          supersedes: "h_older",
          lastReinforcedAt: iso(NOW),
          lastAppliedAt: iso(NOW + 1),
          reinforcements: 3,
          contradictions: 1,
          applied: 5,
          version: original.version + 1,
          provenance: {
            ...original.provenance,
            eventIds: [...original.provenance.eventIds, "fb_2"],
            runIds: ["run_2"],
            approval: { by: "rm_admin", at: iso(NOW), note: "ok" },
          },
        });
        // Fields the patch did not name are untouched.
        expect(patched?.slot).toBe("disclaimers");
        expect(patched?.createdAt).toBe(original.createdAt);
      });

      it("patchHint can move a hint to another node and slot, retire and supersede it", async () => {
        const moving = hint({ nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
        await store.applyBatch(ref, [upsertHint(moving)]);
        await store.applyBatch(ref, [
          {
            op: "patchHint",
            hintId: moving.id,
            patch: { nodeId: "n_new", nodePath: "/consult_advice", slot: "voice", status: "superseded", supersededBy: "h_new" },
          },
        ]);
        expect(await store.getHint(ref, moving.id)).toMatchObject({ nodeId: "n_new", nodePath: "/consult_advice", slot: "voice", status: "superseded", supersededBy: "h_new" });
        await store.applyBatch(ref, [{ op: "patchHint", hintId: moving.id, patch: { status: "retired", retiredReason: "obsolete" } }]);
        expect(await store.getHint(ref, moving.id)).toMatchObject({ status: "retired", retiredReason: "obsolete" });
      });

      it("caps provenance lists at 50, newest last, and never repeats an id", async () => {
        const record = hint({ nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
        await store.applyBatch(ref, [upsertHint(record)]);
        const ops: StoreOp[] = [];
        for (let i = 0; i < 60; i += 1) ops.push({ op: "patchHint", hintId: record.id, patch: { provenance: { appendEventId: `ev_${i}` } } });
        ops.push({ op: "patchHint", hintId: record.id, patch: { provenance: { appendEventId: "ev_59", appendRunId: "run_a" } } });
        ops.push({ op: "patchHint", hintId: record.id, patch: { provenance: { appendRunId: "run_a" } } });
        await store.applyBatch(ref, ops);
        const patched = await store.getHint(ref, record.id);
        expect(patched?.provenance.eventIds).toHaveLength(50);
        expect(patched?.provenance.eventIds.at(-1)).toBe("ev_59");
        expect(patched?.provenance.eventIds[0]).toBe("ev_10");
        expect(patched?.provenance.runIds).toEqual(["run_a"]);
      });

      it("treats patchHint and patchNode on an unknown id as a no-op while the rest of the batch applies", async () => {
        await store.applyBatch(ref, [
          { op: "patchHint", hintId: "h_missing", patch: { priority: 1 } },
          { op: "patchNode", nodeId: "n_missing", patch: { title: "x" } },
          upsertNode("/"),
        ]);
        const snapshot = await store.loadSnapshot(ref);
        expect(snapshot?.version).toBe(1);
        expect(snapshot?.nodes).toHaveLength(1);
        expect(snapshot?.hints).toEqual([]);
      });

      it("setSlotAlias writes aliases and addTombstone is idempotent", async () => {
        await store.applyBatch(ref, [
          { op: "setSlotAlias", from: "format.list", to: "format.lists" },
          { op: "setSlotAlias", from: "region", to: "region.default" },
          { op: "addTombstone", hintId: "h_gone" },
          { op: "addTombstone", hintId: "h_gone" },
        ]);
        await store.applyBatch(ref, [{ op: "setSlotAlias", from: "region", to: "region.home" }, { op: "addTombstone", hintId: "h_gone" }]);
        const snapshot = await store.loadSnapshot(ref);
        expect(snapshot?.slotAliases).toEqual({ "format.list": "format.lists", region: "region.home" });
        expect(snapshot?.tombstones).toEqual(["h_gone"]);
      });

      it("consolidationCounter increments by one and reset zeroes it", async () => {
        await store.applyBatch(ref, [{ op: "consolidationCounter", action: "increment" }]);
        await store.applyBatch(ref, [{ op: "consolidationCounter", action: "increment" }, { op: "consolidationCounter", action: "increment" }]);
        expect((await store.loadSnapshot(ref))?.eventsSinceConsolidation).toBe(3);
        await store.applyBatch(ref, [{ op: "consolidationCounter", action: "reset" }]);
        expect((await store.loadSnapshot(ref))?.eventsSinceConsolidation).toBe(0);
        await store.applyBatch(ref, [{ op: "consolidationCounter", action: "increment" }]);
        expect((await store.loadSnapshot(ref))?.eventsSinceConsolidation).toBe(1);
      });

      it("audit ops become rows readable through listAudit, newest first", async () => {
        const entries = [
          fixtureAudit(ref, "a_1", { action: "hint.created", hintId: "h_1" }, iso(NOW)),
          fixtureAudit(ref, "a_2", { action: "hint.reinforced", hintId: "h_1", eventId: "turn_2" }, iso(NOW + 1000)),
          fixtureAudit(ref, "a_3", { action: "op.rejected", detail: { reason: "not-canonical" } }, iso(NOW + 2000)),
        ];
        await store.applyBatch(ref, entries.map((entry) => ({ op: "audit", entry })));
        await expect(store.listAudit(ref, 10)).resolves.toEqual([entries[2], entries[1], entries[0]]);
        await expect(store.listAudit(ref, 2)).resolves.toEqual([entries[2], entries[1]]);
        await expect(store.listAudit(other, 10)).resolves.toEqual([]);
      });

      it("enforces one active hint per (nodePath, slot, scope, agent, clientId)", async () => {
        const first = hint({ id: "h_first", nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
        const second = hint({ id: "h_second", nodePath: "/", slot: "tone", value: "brisk", text: "Prefers a brisk tone." });
        await store.applyBatch(ref, [upsertHint(first)]);
        await expect(store.applyBatch(ref, [upsertHint(second)])).rejects.toThrow(/slot conflict/);
        expect((await activeHints()).map((h) => h.id)).toEqual(["h_first"]);

        // A different applicability key is not a conflict …
        const forClient = hint({ id: "h_client", nodePath: "/", slot: "tone", value: "brisk", text: "Prefers a brisk tone.", scope: "client", clientId: "client_A" });
        const pending = { ...second, id: "h_pending", status: "pending" as const };
        await store.applyBatch(ref, [upsertHint(forClient), upsertHint(pending)]);
        // … and neither is a pending challenger, nor a supersession done in order within one batch.
        await store.applyBatch(ref, [
          { op: "patchHint", hintId: "h_first", patch: { status: "superseded", supersededBy: "h_second" } },
          upsertHint({ ...second, supersedes: "h_first" }),
        ]);
        expect((await activeHints()).map((h) => h.id).sort()).toEqual(["h_client", "h_second"]);
        // Re-activating the superseded one now conflicts with its successor.
        await expect(store.applyBatch(ref, [{ op: "patchHint", hintId: "h_first", patch: { status: "active" } }])).rejects.toThrow(/slot conflict/);
      });
    });

    // ── loadSnapshot ──

    describe("loadSnapshot", () => {
      it("returns null for a subject with no rows", async () => {
        await expect(store.loadSnapshot(ref)).resolves.toBeNull();
        await store.claimEvent(null, fixtureTurn(ref.subjectId, "turn_1"));
        // An event alone is not a graph.
        await expect(store.loadSnapshot(ref)).resolves.toBeNull();
      });

      it("returns copies: mutating the result never leaks into the store", async () => {
        const root = node("/", { keywords: ["global"] });
        const record = hint({ nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
        await store.applyBatch(ref, [{ op: "upsertNode", node: root }, upsertHint(record), { op: "setSlotAlias", from: "voice", to: "tone" }]);
        const first = await store.loadSnapshot(ref);
        first?.nodes[0]?.keywords.push("mutated");
        if (first?.hints[0]) first.hints[0].text = "mutated";
        first?.tombstones.push("mutated");
        if (first) first.slotAliases.voice = "mutated";
        const second = await store.loadSnapshot(ref);
        expect(second?.nodes[0]?.keywords).toEqual(["global"]);
        expect(second?.hints[0]?.text).toBe(record.text);
        expect(second?.tombstones).toEqual([]);
        expect(second?.slotAliases).toEqual({ voice: "tone" });
        expect(second).not.toBe(first);
      });

      it("filters hints by status (default active) and never nodes (active + merged, retired dropped)", async () => {
        const mk = (id: string, status: HintRecord["status"]) =>
          hint({ id, nodePath: "/", slot: `slot.${id}`, value: "v", text: "Prefers v.", status });
        await store.applyBatch(ref, [
          { op: "upsertNode", node: node("/") },
          { op: "upsertNode", node: node("/consult_advice", { status: "merged", mergedInto: "/consult_knowledge" }) },
          { op: "upsertNode", node: node("/consult_kyp", { status: "retired" }) },
          upsertHint(mk("h_active", "active")),
          upsertHint(mk("h_pending", "pending")),
          upsertHint(mk("h_superseded", "superseded")),
          upsertHint(mk("h_retired", "retired")),
        ]);
        const ids = (hints: HintRecord[]) => hints.map((h) => h.id).sort();
        const byDefault = await store.loadSnapshot(ref);
        expect(ids(byDefault?.hints ?? [])).toEqual(["h_active"]);
        expect(byDefault?.nodes.map((n) => n.path).sort()).toEqual(["/", "/consult_advice"]);
        const some = await store.loadSnapshot(ref, { statuses: ["active", "pending"] });
        expect(ids(some?.hints ?? [])).toEqual(["h_active", "h_pending"]);
        const all = await store.loadSnapshot(ref, { statuses: ["active", "pending", "superseded", "retired"] });
        expect(ids(all?.hints ?? [])).toEqual(["h_active", "h_pending", "h_retired", "h_superseded"]);
        expect(all?.nodes).toHaveLength(2);
        const none = await store.loadSnapshot(ref, { statuses: [] });
        expect(none?.hints).toEqual([]);
        expect(none?.nodes).toHaveLength(2);
      });

      it("isolates subjects and tenants that share a subject id", async () => {
        await store.applyBatch(ref, [upsertNode("/"), upsertNode("/consult_advice")]);
        await store.applyBatch(tenantA, [{ op: "upsertNode", node: fixtureNode(tenantA, "/") }]);
        await store.applyBatch(other, [{ op: "upsertNode", node: fixtureNode(other, "/") }, { op: "consolidationCounter", action: "increment" }]);
        expect((await store.loadSnapshot(ref))?.nodes).toHaveLength(2);
        expect((await store.loadSnapshot(tenantA))?.nodes).toHaveLength(1);
        expect((await store.loadSnapshot(tenantA))?.ref).toEqual(tenantA);
        expect((await store.loadSnapshot(other))?.eventsSinceConsolidation).toBe(1);
        expect((await store.loadSnapshot(ref))?.eventsSinceConsolidation).toBe(0);
      });
    });

    // ── getHint / deleteHint ──

    describe("getHint / deleteHint", () => {
      it("getHint returns a copy or null; deleteHint reports whether a row existed and adds no tombstone", async () => {
        const record = hint({ nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
        await expect(store.getHint(ref, record.id)).resolves.toBeNull();
        await store.applyBatch(ref, [upsertHint(record)]);
        const got = await store.getHint(ref, record.id);
        expect(got).toEqual(record);
        if (got) got.text = "mutated";
        expect((await store.getHint(ref, record.id))?.text).toBe(record.text);
        await expect(store.getHint(other, record.id)).resolves.toBeNull();

        await expect(store.deleteHint(ref, record.id)).resolves.toBe(true);
        await expect(store.deleteHint(ref, record.id)).resolves.toBe(false);
        await expect(store.getHint(ref, record.id)).resolves.toBeNull();
        const snapshot = await store.loadSnapshot(ref);
        expect(snapshot?.hints).toEqual([]);
        expect(snapshot?.tombstones).toEqual([]);
        // Without a tombstone the id may come back (forget() adds the tombstone in the same step).
        await store.applyBatch(ref, [upsertHint(record)]);
        await expect(store.getHint(ref, record.id)).resolves.toEqual(record);
      });
    });

    // ── leaseEvents ──

    describe("leaseEvents", () => {
      const claimMany = async (ids: string[], subjectId: string = ref.subjectId): Promise<void> => {
        for (const id of ids) await store.claimEvent(null, fixtureTurn(subjectId, id));
      };

      it("leases oldest first up to limit, marks rows processing and sets leaseUntil = now + leaseMs", async () => {
        await claimMany(["e1", "e2", "e3"]);
        const leased = await store.leaseEvents({ tenantId: null, limit: 2, leaseMs: 60_000, now: NOW });
        expect(leased.map((row) => row.event.id)).toEqual(["e1", "e2"]);
        for (const row of leased) {
          expect(row.status).toBe("processing");
          expect(row.leaseUntil).toBe(iso(NOW + 60_000));
        }
        expect((await store.getEvent(null, "e1"))?.status).toBe("processing");
        expect((await store.getEvent(null, "e3"))?.status).toBe("pending");
        expect(await store.leaseEvents({ tenantId: null, limit: 0, leaseMs: 1, now: NOW })).toEqual([]);
      });

      it("never returns a row whose lease_until is in the future, and returns it again once the lease expires", async () => {
        await claimMany(["e1", "e2"]);
        const first = await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1_000, now: NOW });
        expect(first).toHaveLength(2);
        await expect(store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1_000, now: NOW })).resolves.toEqual([]);
        await expect(store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1_000, now: NOW + 999 })).resolves.toEqual([]);
        // A crashed worker's `processing` row is leasable again once its lease has lapsed.
        const again = await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1_000, now: NOW + 1_001 });
        expect(again.map((row) => row.event.id)).toEqual(["e1", "e2"]);
        expect(again[0]?.leaseUntil).toBe(iso(NOW + 2_001));
      });

      it("never double-leases across concurrent calls", async () => {
        await claimMany(["e1", "e2", "e3", "e4", "e5"]);
        const [a, b, c] = await Promise.all([
          store.leaseEvents({ tenantId: null, limit: 2, leaseMs: 60_000, now: NOW }),
          store.leaseEvents({ tenantId: null, limit: 2, leaseMs: 60_000, now: NOW }),
          store.leaseEvents({ tenantId: null, limit: 2, leaseMs: 60_000, now: NOW }),
        ]);
        const ids = [...a, ...b, ...c].map((row) => row.event.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBe(5);
      });

      it("releases the lease when updateEvent leaves processing, so a retry or requeue is leasable once retry_at passes", async () => {
        const lease = async (now: number, statuses?: EventStatus[]): Promise<string[]> =>
          (await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 60_000, now, ...(statuses ? { statuses } : {}) })).map((r) => r.event.id);
        await claimMany(["e1"]);
        expect(await lease(NOW)).toEqual(["e1"]);
        // Attempts recorded mid-flight leave the lease alone.
        await store.updateEvent(null, "e1", { attempts: 1 });
        expect((await store.getEvent(null, "e1"))?.leaseUntil).toBe(iso(NOW + 60_000));
        expect(await lease(NOW + 1)).toEqual([]);
        // Backoff retry (§5.2): `failed` with a retry_at well inside the old lease — retry_at alone decides.
        await store.updateEvent(null, "e1", { status: "failed", error: "llm timeout", retryAt: iso(NOW + 1_000) });
        expect((await store.getEvent(null, "e1"))?.leaseUntil).toBeUndefined();
        expect(await lease(NOW + 999, ["pending", "failed"])).toEqual([]);
        expect(await lease(NOW + 2_000, ["pending", "failed"])).toEqual(["e1"]);
        // Feedback requeue (§5.4): back to `pending` while the new lease is live.
        await store.updateEvent(null, "e1", { status: "pending", retryAt: iso(NOW + 3_000) });
        expect((await store.getEvent(null, "e1"))?.leaseUntil).toBeUndefined();
        expect(await lease(NOW + 4_000)).toEqual(["e1"]);
        // Renewing while processing keeps the lease; finishing drops it.
        await store.updateEvent(null, "e1", { status: "processing", leaseUntil: iso(NOW + 90_000) });
        expect((await store.getEvent(null, "e1"))?.leaseUntil).toBe(iso(NOW + 90_000));
        await store.updateEvent(null, "e1", { status: "done" });
        expect(await store.getEvent(null, "e1")).toMatchObject({ status: "done" });
        expect((await store.getEvent(null, "e1"))?.leaseUntil).toBeUndefined();
      });

      it("never returns a row whose retry_at is in the future", async () => {
        await claimMany(["e1", "e2"]);
        await store.updateEvent(null, "e1", { retryAt: iso(NOW + 5_000) });
        // e2 is leased long enough that only retry_at decides whether e1 appears.
        expect((await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 60_000, now: NOW })).map((r) => r.event.id)).toEqual(["e2"]);
        expect((await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 60_000, now: NOW + 4_999 })).map((r) => r.event.id)).toEqual([]);
        expect((await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 60_000, now: NOW + 5_000 })).map((r) => r.event.id)).toEqual(["e1"]);
      });

      it("filters by ids, subjectId, statuses and tenant; done rows are never leased by default", async () => {
        await claimMany(["e1", "e2", "e3"]);
        await claimMany(["o1"], other.subjectId);
        await store.claimEvent("acme", fixtureTurn(ref.subjectId, "t1"));
        await store.updateEvent(null, "e2", { status: "done" });
        await store.updateEvent(null, "e3", { status: "failed", attempts: 3, error: "boom" });

        const byIds = await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1, now: NOW, ids: ["e1", "e2", "nope"] });
        expect(byIds.map((r) => r.event.id)).toEqual(["e1"]);

        const bySubject = await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1, now: NOW + 10, subjectId: other.subjectId });
        expect(bySubject.map((r) => r.event.id)).toEqual(["o1"]);

        const failedOnly = await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1, now: NOW + 20, statuses: ["failed"] });
        expect(failedOnly.map((r) => r.event.id)).toEqual(["e3"]);
        expect(failedOnly[0]?.attempts).toBe(3);

        const tenant = await store.leaseEvents({ tenantId: "acme", limit: 10, leaseMs: 1, now: NOW + 30 });
        expect(tenant.map((r) => r.event.id)).toEqual(["t1"]);

        const doneRequested = await store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1, now: NOW + 40, statuses: ["done"] });
        expect(doneRequested.map((r) => r.event.id)).toEqual(["e2"]);
      });
    });

    // ── updateEvent / getEvent / getTurn / listEvents / scrubEvents ──

    describe("event rows", () => {
      it("updateEvent patches status, attempts, error, lease, retry, proposal and result; unknown ids are a no-op", async () => {
        await store.claimEvent(null, fixtureTurn(ref.subjectId, "e1"));
        const proposal = { ops: [{ op: "noop" as const, rationale: "nothing new" }] };
        await store.updateEvent(null, "e1", { status: "processing", attempts: 1, leaseUntil: iso(NOW + 60_000), proposal });
        expect(await store.getEvent(null, "e1")).toMatchObject({ status: "processing", attempts: 1, leaseUntil: iso(NOW + 60_000), proposal });
        await store.updateEvent(null, "e1", { status: "failed", error: "llm timeout", retryAt: iso(NOW + 4_000), attempts: 2 });
        expect(await store.getEvent(null, "e1")).toMatchObject({ status: "failed", error: "llm timeout", retryAt: iso(NOW + 4_000), attempts: 2, proposal });
        await store.updateEvent(null, "e1", { status: "done", result: { accepted: 1, rejected: [{ op: "add_hint", reason: "not-canonical" }] }, proposal: null });
        expect(await store.getEvent(null, "e1")).toMatchObject({ status: "done", result: { accepted: 1, rejected: [{ op: "add_hint", reason: "not-canonical" }] }, proposal: null });
        await expect(store.updateEvent(null, "missing", { status: "done" })).resolves.toBeUndefined();
        await expect(store.getEvent(null, "missing")).resolves.toBeNull();
        await expect(store.getEvent("acme", "e1")).resolves.toBeNull();
      });

      it("getTurn finds the subject's turn by runId and ignores feedback, other subjects and unknown runs", async () => {
        const turn = fixtureTurn(ref.subjectId, "e1", { runId: "run_7", appliedHintIds: ["h_1"] });
        await store.claimEvent(null, turn);
        await store.claimEvent(null, fixtureFeedback(ref.subjectId, "fb_1", { runId: "run_8" }));
        await store.claimEvent(null, fixtureTurn(other.subjectId, "o1", { runId: "run_9" }));
        await expect(store.getTurn(ref, "run_7")).resolves.toEqual(turn);
        await expect(store.getTurn(ref, "run_8")).resolves.toBeNull();
        await expect(store.getTurn(ref, "run_9")).resolves.toBeNull();
        await expect(store.getTurn(other, "run_9")).resolves.toMatchObject({ id: "o1" });
        await expect(store.getTurn(ref, "run_none")).resolves.toBeNull();
      });

      it("listEvents returns the subject's rows newest first, filtered by status, up to limit", async () => {
        for (const id of ["e1", "e2", "e3"]) await store.claimEvent(null, fixtureTurn(ref.subjectId, id));
        await store.claimEvent(null, fixtureTurn(other.subjectId, "o1"));
        await store.updateEvent(null, "e2", { status: "done" });
        expect((await store.listEvents(ref, { limit: 10 })).map((r) => r.event.id)).toEqual(["e3", "e2", "e1"]);
        expect((await store.listEvents(ref, { limit: 2 })).map((r) => r.event.id)).toEqual(["e3", "e2"]);
        expect((await store.listEvents(ref, { limit: 10, statuses: ["pending"] })).map((r) => r.event.id)).toEqual(["e3", "e1"]);
        expect((await store.listEvents(ref, { limit: 10, statuses: ["done"] })).map((r) => r.event.id)).toEqual(["e2"]);
      });

      it("scrubEvents blanks text fields and the proposal, keeps rows, marks scrubbedAt and counts only newly scrubbed rows", async () => {
        await store.claimEvent(null, fixtureTurn(ref.subjectId, "e1", { userText: "secret", assistantText: "reply" }));
        await store.claimEvent(null, fixtureFeedback(ref.subjectId, "fb_1", { signal: "comment", text: "too long" }));
        await store.claimEvent(null, { type: "consolidate", id: "cons_1", subjectId: ref.subjectId, nodePath: "/consult_advice" });
        await store.claimEvent(null, fixtureTurn(other.subjectId, "o1", { userText: "keep" }));
        // A stored proposal quotes the user's words in its ops and rationale (§9.2): retention must take it with the text.
        const quoting = { ops: [{ op: "noop" as const, rationale: 'user said "secret"' }], notes: "the user wrote: secret" };
        await store.updateEvent(null, "e1", { status: "done", proposal: quoting, result: { accepted: 0, rejected: [] } });
        await store.updateEvent(null, "fb_1", { status: "failed", proposal: quoting });
        await store.updateEvent(null, "o1", { status: "done", proposal: quoting });
        await expect(store.scrubEvents(ref, { olderThan: iso(0) })).resolves.toBe(0);
        await expect(store.scrubEvents(ref, { olderThan: iso(Date.UTC(2100, 0, 1)) })).resolves.toBe(2);
        await expect(store.scrubEvents(ref)).resolves.toBe(0);
        const turn = await store.getEvent(null, "e1");
        expect(turn?.event).toMatchObject({ type: "turn", userText: "", assistantText: "" });
        expect(turn?.scrubbedAt).toBeDefined();
        expect(turn?.proposal).toBeNull();
        expect(JSON.stringify(turn)).not.toContain("secret");
        // Status, result and the row itself survive: a scrubbed row is a tombstone, not a retry.
        expect(turn).toMatchObject({ status: "done", result: { accepted: 0, rejected: [] } });
        const feedback = await store.getEvent(null, "fb_1");
        expect(feedback?.event).toMatchObject({ type: "feedback", text: "" });
        expect(feedback?.proposal).toBeNull();
        expect(feedback?.status).toBe("failed");
        const kept = await store.getEvent(null, "o1");
        expect(kept?.event).toMatchObject({ userText: "keep" });
        expect(kept?.proposal).toEqual(quoting);
        // A consolidate row carries no text: neither stamped nor counted.
        expect((await store.getEvent(null, "cons_1"))?.scrubbedAt).toBeUndefined();
        expect((await store.listEvents(ref, { limit: 10 }))).toHaveLength(3);
      });
    });

    // ── deleteSubject ──

    describe("deleteSubject", () => {
      it("leaves zero rows for the subject in every table, spares other subjects, and is idempotent", async () => {
        const record = hint({ nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
        await store.applyBatch(ref, [upsertNode("/"), upsertHint(record), { op: "audit", entry: fixtureAudit(ref, "a_1") }]);
        await store.claimEvent(null, fixtureTurn(ref.subjectId, "e1", { runId: "run_1" }));
        await store.applyBatch(other, [{ op: "upsertNode", node: fixtureNode(other, "/") }, { op: "audit", entry: fixtureAudit(other, "a_2") }]);
        await store.claimEvent(null, fixtureTurn(other.subjectId, "o1"));

        await store.deleteSubject(ref);
        await expect(store.loadSnapshot(ref)).resolves.toBeNull();
        await expect(store.getHint(ref, record.id)).resolves.toBeNull();
        await expect(store.getEvent(null, "e1")).resolves.toBeNull();
        await expect(store.getTurn(ref, "run_1")).resolves.toBeNull();
        await expect(store.listEvents(ref, { limit: 10 })).resolves.toEqual([]);
        await expect(store.listAudit(ref, 10)).resolves.toEqual([]);
        await expect(store.leaseEvents({ tenantId: null, limit: 10, leaseMs: 1, now: NOW, subjectId: ref.subjectId })).resolves.toEqual([]);

        expect((await store.loadSnapshot(other))?.nodes).toHaveLength(1);
        await expect(store.listAudit(other, 10)).resolves.toHaveLength(1);
        await expect(store.getEvent(null, "o1")).resolves.not.toBeNull();

        await expect(store.deleteSubject(ref)).resolves.toBeUndefined();
        // The subject can be rebuilt from scratch afterwards, at version 1.
        await expect(store.applyBatch(ref, [upsertNode("/")])).resolves.toEqual({ version: 1 });
      });
    });

    // ── purge ──

    describe("purge", () => {
      it("removes done events and audit older than the given instants for one tenant only; unprocessed work is never purged", async () => {
        for (const id of ["e_done", "e_pending", "e_processing", "e_failed"]) await store.claimEvent(null, fixtureTurn(ref.subjectId, id));
        await store.claimEvent("acme", fixtureTurn(ref.subjectId, "t_done"));
        await store.updateEvent(null, "e_done", { status: "done" });
        await store.updateEvent("acme", "t_done", { status: "done" });
        await store.leaseEvents({ tenantId: null, limit: 1, leaseMs: 60_000, now: NOW, ids: ["e_processing"] });
        await store.updateEvent(null, "e_failed", { status: "failed", attempts: 3, error: "boom" });
        await store.applyBatch(ref, [{ op: "audit", entry: fixtureAudit(ref, "a_1", {}, iso(NOW)) }, { op: "audit", entry: fixtureAudit(ref, "a_2", {}, iso(NOW + 1000)) }]);
        await expect(store.purge({ tenantId: null })).resolves.toEqual({ events: 0, audit: 0 });
        await expect(store.purge({ tenantId: null, eventsOlderThan: iso(0), auditOlderThan: iso(0) })).resolves.toEqual({ events: 0, audit: 0 });
        await expect(store.purge({ tenantId: null, auditOlderThan: iso(NOW + 500) })).resolves.toEqual({ events: 0, audit: 1 });
        expect((await store.listAudit(ref, 10)).map((e) => e.id)).toEqual(["a_2"]);
        const far = iso(Date.UTC(2100, 0, 1));
        await expect(store.purge({ tenantId: null, eventsOlderThan: far, auditOlderThan: far })).resolves.toEqual({ events: 1, audit: 1 });
        await expect(store.getEvent(null, "e_done")).resolves.toBeNull();
        // Pending, leased and failed rows are what drain() still owes the ledger (§5.2): retention leaves them alone.
        for (const id of ["e_pending", "e_processing", "e_failed"]) await expect(store.getEvent(null, id), id).resolves.not.toBeNull();
        await expect(store.getEvent("acme", "t_done")).resolves.not.toBeNull();
        await expect(store.listAudit(ref, 10)).resolves.toEqual([]);
      });
    });

    // ── searchNodesByEmbedding (optional) ──

    describe("searchNodesByEmbedding", () => {
      it("ranks the subject's active nodes by cosine similarity", async (ctx) => {
        // Optional in the port: a store without vectors is skipped by name, so a run distinguishes "verified" from "not applicable".
        if (store.searchNodesByEmbedding === undefined) return ctx.skip("store has no searchNodesByEmbedding");
        await store.applyBatch(ref, [
          { op: "upsertNode", node: node("/", { embedding: [1, 0] }) },
          { op: "upsertNode", node: node("/consult_advice", { embedding: [0, 1] }) },
          { op: "upsertNode", node: node("/consult_kyp", { embedding: [0.6, 0.8] }) },
          { op: "upsertNode", node: node("/consult_meetings") },
          { op: "upsertNode", node: node("/consult_newsroom", { embedding: [1, 0], status: "retired" }) },
        ]);
        const ranked = await store.searchNodesByEmbedding(ref, [1, 0], 10);
        expect(ranked.map((r) => r.nodeId)).toEqual([node("/").id, node("/consult_kyp").id, node("/consult_advice").id]);
        expect(ranked[0]?.score).toBeCloseTo(1, 6);
        expect(ranked[1]?.score).toBeCloseTo(0.6, 6);
        expect(ranked[2]?.score).toBeCloseTo(0, 6);
        await expect(store.searchNodesByEmbedding(ref, [1, 0], 1)).resolves.toHaveLength(1);
        await expect(store.searchNodesByEmbedding(other, [1, 0], 10)).resolves.toEqual([]);
      });
    });
  });
}
