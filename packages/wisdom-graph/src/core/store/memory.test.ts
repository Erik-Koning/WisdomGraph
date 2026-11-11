/**
 * The reference store's own behaviour: the §7.1 contract via the shared
 * suite, plus what only this implementation promises — the latency and
 * failure hooks the budget tests lean on, entry-only abort handling, the
 * clone-apply-swap guarantee, clock-driven timestamps and the validated
 * snapshot()/load() round trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_STORE_FORMAT, MemoryStore, type MemoryStoreSnapshot } from "./memory";
import { VersionConflictError, type StorePort, type SubjectRef } from "../ports";
import { FAKE_CLOCK_EPOCH, FakeClock } from "../../testing/fakes";
import { FIXTURE_T0, fixtureAudit, fixtureHint, fixtureNode, fixtureTurn, advisorFixture } from "../../testing/fixtures";
import { storeContractTests } from "../../testing/store-contract";

storeContractTests("memory", async () => ({ store: new MemoryStore({ clock: new FakeClock() }) }));

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };

/** One call per port method, so hook tests cover the whole surface. */
function everyMethod(store: MemoryStore): { name: keyof StorePort; call: () => Promise<unknown> }[] {
  return [
    { name: "loadSnapshot", call: () => store.loadSnapshot(ref) },
    { name: "applyBatch", call: () => store.applyBatch(ref, []) },
    { name: "getHint", call: () => store.getHint(ref, "h") },
    { name: "deleteHint", call: () => store.deleteHint(ref, "h") },
    { name: "deleteSubject", call: () => store.deleteSubject(ref) },
    { name: "claimEvent", call: () => store.claimEvent(null, fixtureTurn(ref.subjectId, "e1")) },
    { name: "leaseEvents", call: () => store.leaseEvents({ tenantId: null, limit: 1, leaseMs: 1, now: 0 }) },
    { name: "updateEvent", call: () => store.updateEvent(null, "e1", { status: "done" }) },
    { name: "getEvent", call: () => store.getEvent(null, "e1") },
    { name: "getTurn", call: () => store.getTurn(ref, "run_e1") },
    { name: "listEvents", call: () => store.listEvents(ref, { limit: 1 }) },
    { name: "scrubEvents", call: () => store.scrubEvents(ref) },
    { name: "listAudit", call: () => store.listAudit(ref, 1) },
    { name: "purge", call: () => store.purge({ tenantId: null }) },
    { name: "searchNodesByEmbedding", call: () => store.searchNodesByEmbedding(ref, [1], 1) },
  ];
}

describe("MemoryStore", () => {
  describe("latencyMs", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("delays every method by exactly latencyMs", async () => {
      const store = new MemoryStore({ latencyMs: 50, clock: new FakeClock() });
      for (const { name, call } of everyMethod(store)) {
        let settled = false;
        const p = call().then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await vi.advanceTimersByTimeAsync(49);
        expect(settled, `${name} settled early`).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(settled, `${name} did not settle at latencyMs`).toBe(true);
      }
    });

    it("treats a negative or absent latency as none", async () => {
      const immediate = new MemoryStore({ latencyMs: -5 });
      await expect(immediate.loadSnapshot(ref)).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("failNext", () => {
    it("makes exactly the next call reject with err, on every method", async () => {
      const store = new MemoryStore({ clock: new FakeClock() });
      for (const { name, call } of everyMethod(store)) {
        const err = new Error(`${name} down`);
        store.failNext(err);
        await expect(call(), name).rejects.toBe(err);
        await expect(call(), `${name} after failNext`).resolves.not.toBeInstanceOf(Error);
      }
    });

    it("rejects with a non-Error value as given", async () => {
      const store = new MemoryStore();
      store.failNext("string failure");
      await expect(store.getHint(ref, "h")).rejects.toBe("string failure");
    });

    it("is claimed by the first call to enter, even under latency, so a concurrent second call succeeds", async () => {
      vi.useFakeTimers();
      try {
        const store = new MemoryStore({ latencyMs: 20, clock: new FakeClock() });
        const err = new Error("first only");
        store.failNext(err);
        const first = store.loadSnapshot(ref);
        const second = store.loadSnapshot(ref);
        const outcomes = Promise.all([first.then(() => "ok", (e: unknown) => e), second.then(() => "ok", (e: unknown) => e)]);
        await vi.advanceTimersByTimeAsync(20);
        await expect(outcomes).resolves.toEqual([err, "ok"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("applies nothing when applyBatch is the call that fails", async () => {
      const store = new MemoryStore();
      store.failNext(new Error("write failed"));
      await expect(store.applyBatch(ref, [{ op: "upsertNode", node: fixtureNode(ref, "/") }])).rejects.toThrow("write failed");
      await expect(store.loadSnapshot(ref)).resolves.toBeNull();
    });
  });

  describe("signal", () => {
    it("rejects an already-aborted signal with its reason, before any work", async () => {
      const store = new MemoryStore();
      const controller = new AbortController();
      const reason = new Error("deadline");
      controller.abort(reason);
      await expect(store.loadSnapshot(ref, { signal: controller.signal })).rejects.toBe(reason);
      await expect(store.applyBatch(ref, [{ op: "upsertNode", node: fixtureNode(ref, "/") }], { signal: controller.signal })).rejects.toBe(reason);
      await expect(store.loadSnapshot(ref)).resolves.toBeNull();
    });

    it("falls back to an AbortError when the signal carries no reason", async () => {
      const store = new MemoryStore();
      // A real AbortSignal always carries a reason once aborted (abort() with no argument supplies an AbortError),
      // so the reason-less branch is reachable only through a hand-built signal-like — hence the cast.
      const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
      await expect(store.loadSnapshot(ref, { signal })).rejects.toMatchObject({ name: "AbortError" });
    });

    it("does not cancel a call that is already under way: a load that lost a race still completes", async () => {
      // §4.2: the recall that timed out moves on, but the completed load warms the cache.
      vi.useFakeTimers();
      try {
        const seed = new MemoryStore();
        await seed.applyBatch(ref, [{ op: "upsertNode", node: fixtureNode(ref, "/") }]);
        const store = new MemoryStore({ latencyMs: 500, clock: new FakeClock() });
        store.load(seed.snapshot());
        const controller = new AbortController();
        const load = store.loadSnapshot(ref, { signal: controller.signal });
        await vi.advanceTimersByTimeAsync(150);
        controller.abort(new Error("budget"));
        await vi.advanceTimersByTimeAsync(350);
        await expect(load).resolves.toMatchObject({ version: 1, nodes: [{ path: "/" }] });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("clone-apply-swap", () => {
    it("leaves the store byte-for-byte unchanged after a failing batch", async () => {
      const { store, subjectId } = advisorFixture();
      const subject: SubjectRef = { tenantId: null, subjectId };
      const before = store.snapshot();
      const [active] = (await store.loadSnapshot(subject))?.hints ?? [];
      if (!active) throw new Error("fixture has no active hint");
      const duplicate = { ...active, id: "h_dup" };
      await expect(
        store.applyBatch(subject, [
          { op: "setSlotAlias", from: "x", to: "y" },
          { op: "addTombstone", hintId: "h_new_tomb" },
          { op: "consolidationCounter", action: "reset" },
          { op: "audit", entry: fixtureAudit(subject, "a_fail") },
          { op: "upsertHint", hint: duplicate },
        ]),
      ).rejects.toThrow(/slot conflict/);
      expect(store.snapshot()).toEqual(before);
      await expect(store.applyBatch(subject, [], { expectVersion: 999 })).rejects.toBeInstanceOf(VersionConflictError);
      expect(store.snapshot()).toEqual(before);
    });

    it("never mutates a row it handed out or was handed in", async () => {
      const store = new MemoryStore();
      const node = fixtureNode(ref, "/", { keywords: ["a"] });
      const hint = fixtureHint(ref, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
      await store.applyBatch(ref, [
        { op: "upsertNode", node },
        { op: "upsertHint", hint },
      ]);
      node.keywords.push("leaked");
      hint.text = "leaked";
      const snapshot = await store.loadSnapshot(ref);
      expect(snapshot?.nodes[0]?.keywords).toEqual(["a"]);
      expect(snapshot?.hints[0]?.text).toBe("Prefers a warm tone.");
      await store.applyBatch(ref, [{ op: "patchHint", hintId: hint.id, patch: { priority: 99 } }]);
      // The earlier read is a snapshot, not a live view.
      expect(snapshot?.hints[0]?.priority).toBe(60);
    });

    it("refuses a prototype key as a slot alias", async () => {
      const store = new MemoryStore();
      await expect(store.applyBatch(ref, [{ op: "setSlotAlias", from: "__proto__", to: "x" }])).rejects.toThrow(/__proto__/);
      await expect(store.loadSnapshot(ref)).resolves.toBeNull();
    });
  });

  describe("clock", () => {
    it("stamps claims, leases, patches and the consolidation reset from the injected clock", async () => {
      const clock = new FakeClock();
      const store = new MemoryStore({ clock });
      await store.claimEvent(null, fixtureTurn(ref.subjectId, "e1"));
      expect(await store.getEvent(null, "e1")).toMatchObject({ createdAt: clock.iso(), updatedAt: clock.iso() });
      clock.tick(1_000);
      await store.updateEvent(null, "e1", { attempts: 1 });
      expect(await store.getEvent(null, "e1")).toMatchObject({ createdAt: FIXTURE_T0, updatedAt: clock.iso() });

      const hint = fixtureHint(ref, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
      await store.applyBatch(ref, [{ op: "upsertNode", node: fixtureNode(ref, "/") }, { op: "upsertHint", hint }]);
      clock.advanceDays(1);
      await store.applyBatch(ref, [
        { op: "patchHint", hintId: hint.id, patch: { priority: 1 } },
        { op: "patchNode", nodeId: fixtureNode(ref, "/").id, patch: { title: "Root" } },
        { op: "consolidationCounter", action: "reset" },
      ]);
      expect((await store.getHint(ref, hint.id))?.updatedAt).toBe(clock.iso());
      expect((await store.loadSnapshot(ref))?.nodes[0]?.updatedAt).toBe(clock.iso());
      const [subject] = store.snapshot().subjects;
      expect(subject).toMatchObject({ lastConsolidatedAt: clock.iso(), updatedAt: clock.iso(), createdAt: new Date(FAKE_CLOCK_EPOCH + 1_000).toISOString() });
    });
  });

  describe("searchNodesByEmbedding", () => {
    it("scores a zero vector as 0 and skips dimension-less nodes", async () => {
      const store = new MemoryStore();
      await store.applyBatch(ref, [
        { op: "upsertNode", node: fixtureNode(ref, "/", { embedding: [0, 0] }) },
        { op: "upsertNode", node: fixtureNode(ref, "/consult_advice", { embedding: [3, 4] }) },
        { op: "upsertNode", node: fixtureNode(ref, "/consult_kyp") },
      ]);
      const ranked = await store.searchNodesByEmbedding(ref, [0, 1], 10);
      expect(ranked).toEqual([
        { nodeId: fixtureNode(ref, "/consult_advice").id, score: 0.8 },
        { nodeId: fixtureNode(ref, "/").id, score: 0 },
      ]);
      await expect(store.searchNodesByEmbedding(ref, [0, 0], 10)).resolves.toEqual([
        { nodeId: fixtureNode(ref, "/").id, score: 0 },
        { nodeId: fixtureNode(ref, "/consult_advice").id, score: 0 },
      ]);
    });
  });

  describe("snapshot() / load()", () => {
    it("round-trips the whole store, including events and audit", async () => {
      const clock = new FakeClock();
      const store = new MemoryStore({ clock });
      await store.applyBatch(ref, [
        { op: "upsertNode", node: fixtureNode(ref, "/") },
        { op: "upsertHint", hint: fixtureHint(ref, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." }) },
        { op: "setSlotAlias", from: "voice", to: "tone" },
        { op: "addTombstone", hintId: "h_gone" },
        { op: "consolidationCounter", action: "increment" },
        { op: "audit", entry: fixtureAudit(ref, "a_1") },
      ]);
      await store.claimEvent(null, fixtureTurn(ref.subjectId, "e1"));
      await store.updateEvent(null, "e1", { status: "done", proposal: { ops: [{ op: "noop", rationale: "r" }] }, result: { accepted: 0, rejected: [] } });
      const serialised = store.snapshot();
      expect(serialised.format).toBe(MEMORY_STORE_FORMAT);
      expect(JSON.parse(JSON.stringify(serialised))).toEqual(serialised);

      const copy = new MemoryStore({ clock });
      copy.load(JSON.parse(JSON.stringify(serialised)));
      expect(copy.snapshot()).toEqual(serialised);
      await expect(copy.loadSnapshot(ref)).resolves.toEqual(await store.loadSnapshot(ref));
      await expect(copy.getEvent(null, "e1")).resolves.toEqual(await store.getEvent(null, "e1"));
      await expect(copy.listAudit(ref, 10)).resolves.toEqual(await store.listAudit(ref, 10));
      await expect(copy.applyBatch(ref, [], { expectVersion: 1 })).resolves.toEqual({ version: 2 });
    });

    it("round-trips the advisor fixture", () => {
      const { store } = advisorFixture();
      const serialised = store.snapshot();
      const copy = new MemoryStore();
      copy.load(serialised);
      expect(copy.snapshot()).toEqual(serialised);
    });

    it("returns a copy from snapshot(): mutating it does not touch the store", () => {
      const { store } = advisorFixture();
      const first = store.snapshot();
      first.subjects[0]?.hints.splice(0);
      first.events.splice(0);
      expect(store.snapshot().subjects[0]?.hints.length).toBeGreaterThan(0);
      expect(store.snapshot().events).toHaveLength(1);
    });

    it("replaces the previous contents entirely and clears a pending failNext", async () => {
      const { store } = advisorFixture();
      store.failNext(new Error("stale"));
      store.load({ format: MEMORY_STORE_FORMAT, subjects: [], events: [], audit: [] });
      expect(store.snapshot()).toEqual({ format: MEMORY_STORE_FORMAT, subjects: [], events: [], audit: [] });
      await expect(store.loadSnapshot({ tenantId: null, subjectId: "rm_42" })).resolves.toBeNull();
    });

    it("rejects an invalid snapshot with a TypeError that points at the field", () => {
      const store = new MemoryStore();
      const valid: MemoryStoreSnapshot = advisorFixture().store.snapshot();
      expect(() => store.load(null)).toThrow(TypeError);
      expect(() => store.load({ ...valid, format: "something-else" })).toThrow(/\/format/);
      const badHint = structuredClone(valid);
      const hint = badHint.subjects[0]?.hints[0];
      if (hint) hint.confidence = 7;
      expect(() => store.load(badHint)).toThrow(/\/subjects\/0\/hints\/0\/confidence/);
      const badNode = structuredClone(valid);
      const node = badNode.subjects[0]?.nodes[1];
      if (node) node.level = 3;
      expect(() => store.load(badNode)).toThrow(/\/subjects\/0\/nodes\/1\/level/);
      const badEvent = structuredClone(valid);
      const event = badEvent.events[0];
      if (event) event.status = "weird" as never;
      expect(() => store.load(badEvent)).toThrow(/\/events\/0\/status/);
      const badAudit = structuredClone(valid);
      const entry = badAudit.audit[0];
      if (entry) entry.at = "yesterday";
      expect(() => store.load(badAudit)).toThrow(/\/audit\/0\/at/);
      // A rejected load leaves the store as it was.
      expect(store.snapshot()).toEqual({ format: MEMORY_STORE_FORMAT, subjects: [], events: [], audit: [] });
    });

    it("rejects a snapshot that breaks the slot invariant", () => {
      const store = new MemoryStore();
      const valid = advisorFixture().store.snapshot();
      const subject = valid.subjects[0];
      const active = subject?.hints.find((h) => h.status === "active");
      if (!subject || !active) throw new Error("fixture has no active hint");
      subject.hints.push({ ...active, id: "h_dup" });
      expect(() => store.load(valid)).toThrow(/\/subjects\/0\/hints\/\d+\/slot: slot conflict/);
    });

    it("rejects a snapshot that breaks the other invariants applyBatch enforces, pointing at the row", () => {
      const store = new MemoryStore();
      const valid: MemoryStoreSnapshot = advisorFixture().store.snapshot();
      const subject = valid.subjects[0];
      const root = subject?.nodes.find((n) => n.path === "/");
      if (!subject || !root) throw new Error("fixture has no root node");

      const twoNodesOnePath = structuredClone(valid);
      twoNodesOnePath.subjects[0]?.nodes.push({ ...root, id: "n_other" });
      expect(() => store.load(twoNodesOnePath)).toThrow(/\/subjects\/0\/nodes\/\d+\/path: path \/ already belongs to node/);

      const sameNodeTwice = structuredClone(valid);
      sameNodeTwice.subjects[0]?.nodes.push(structuredClone(root));
      expect(() => store.load(sameNodeTwice)).toThrow(/\/subjects\/0\/nodes\/\d+\/id: node .* appears twice/);

      const misfiledHint = structuredClone(valid);
      const hint = misfiledHint.subjects[0]?.hints[0];
      if (hint) hint.subjectId = "rm_99";
      expect(() => store.load(misfiledHint)).toThrow(/\/subjects\/0\/hints\/0: hint .* belongs to \(no tenant\)\/rm_99, not \(no tenant\)\/rm_42/);

      const misfiledNode = structuredClone(valid);
      const node = misfiledNode.subjects[0]?.nodes[0];
      if (node) node.tenantId = "acme";
      expect(() => store.load(misfiledNode)).toThrow(/\/subjects\/0\/nodes\/0: node .* belongs to acme\/rm_42, not \(no tenant\)\/rm_42/);

      const subjectTwice = structuredClone(valid);
      subjectTwice.subjects.push({ ...structuredClone(subject), version: 5 });
      expect(() => store.load(subjectTwice)).toThrow(new RegExp(`/subjects/${valid.subjects.length}: \\(no tenant\\)/rm_42 appears twice`));

      const eventTwice = structuredClone(valid);
      const event = eventTwice.events[0];
      if (event) eventTwice.events.push(structuredClone(event));
      expect(() => store.load(eventTwice)).toThrow(/\/events\/1: event .* appears twice/);

      // Every rejection leaves the store as it was.
      expect(store.snapshot()).toEqual({ format: MEMORY_STORE_FORMAT, subjects: [], events: [], audit: [] });
    });
  });
});
