/**
 * The store-testing toolkit, tested: the shared contract suite must accept a
 * transparent `FaultyStore` (proof the wrapper changes nothing it was not
 * asked to) and must drive its factory one store at a time, and
 * `FaultyStore` itself must fail, hang and corrupt exactly as its mode says
 * — those are the instruments the never-reject tests read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../core/store/memory";
import { validators } from "../core";
import type { StorePort, SubjectRef } from "../core/ports";
import { FakeClock, FaultyStore } from "./fakes";
import { fixtureNode, fixtureTurn, advisorFixture } from "./fixtures";
import { storeContractTests } from "./store-contract";

/** What the suite promises its factory: a fresh store per test, closed before the next one is made. */
const lifecycle = { made: 0, closed: 0, overlapping: 0 };
let open = 0;

storeContractTests("FaultyStore(memory) without faults", async () => {
  if (open > 0) lifecycle.overlapping += 1;
  open += 1;
  lifecycle.made += 1;
  return {
    store: new FaultyStore(new MemoryStore({ clock: new FakeClock() })),
    close: async () => {
      open -= 1;
      lifecycle.closed += 1;
    },
  };
});

describe("storeContractTests", () => {
  // Registered after the suite above, so it runs once every contract test has finished.
  it("makes a fresh store for every test and awaits close() before the next one opens", () => {
    expect(lifecycle.made).toBeGreaterThan(20);
    expect(lifecycle.closed).toBe(lifecycle.made);
    expect(lifecycle.overlapping).toBe(0);
  });
});

describe("FaultyStore", () => {
  const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };

  describe("throwOn", () => {
    it("rejects the named methods before the inner store sees them, and forwards the rest", async () => {
      const inner = new MemoryStore();
      const store = new FaultyStore(inner, { throwOn: ["applyBatch", "getHint"] });
      await expect(store.applyBatch(ref, [{ op: "upsertNode", node: fixtureNode(ref, "/") }])).rejects.toThrow("FaultyStore: applyBatch failed");
      await expect(store.getHint(ref, "h")).rejects.toThrow("FaultyStore: getHint failed");
      await expect(inner.loadSnapshot(ref)).resolves.toBeNull();
      await expect(store.claimEvent(null, fixtureTurn(ref.subjectId, "e1"))).resolves.toBe("claimed");
      await expect(inner.getEvent(null, "e1")).resolves.not.toBeNull();
    });

    it("rejects with the configured error when one is given", async () => {
      const error = new Error("connection refused");
      const store = new FaultyStore(new MemoryStore(), { throwOn: ["loadSnapshot"], error });
      await expect(store.loadSnapshot(ref)).rejects.toBe(error);
    });
  });

  describe("hangOn", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("never settles until the call's signal aborts, then rejects with the reason", async () => {
      const store = new FaultyStore(new MemoryStore(), { hangOn: ["loadSnapshot"] });
      const controller = new AbortController();
      let outcome: unknown = "pending";
      const p = store.loadSnapshot(ref, { signal: controller.signal }).then(
        (r) => {
          outcome = r;
        },
        (e: unknown) => {
          outcome = e;
        },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(outcome).toBe("pending");
      const reason = new Error("deadline");
      controller.abort(reason);
      await p;
      expect(outcome).toBe(reason);
    });

    it("rejects immediately on an already-aborted signal", async () => {
      const store = new FaultyStore(new MemoryStore(), { hangOn: ["applyBatch"] });
      const controller = new AbortController();
      controller.abort();
      await expect(store.applyBatch(ref, [], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    });

    it("hangs for good on a method that carries no signal", async () => {
      const store = new FaultyStore(new MemoryStore(), { hangOn: ["getHint"] });
      let settled = false;
      void store.getHint(ref, "h").then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(600_000);
      expect(settled).toBe(false);
    });
  });

  describe("corruptRows", () => {
    it("returns hint rows the validators reject — a missing slot on even rows, a bad confidence on odd rows", async () => {
      const { store: inner, subjectId } = advisorFixture();
      const store = new FaultyStore(inner, { corruptRows: true });
      const subject: SubjectRef = { tenantId: null, subjectId };
      const clean = await inner.loadSnapshot(subject);
      const snapshot = await store.loadSnapshot(subject);
      expect(snapshot?.hints).toHaveLength(clean?.hints.length ?? -1);
      expect(snapshot?.nodes).toEqual(clean?.nodes);
      snapshot?.hints.forEach((hint, index) => {
        const result = validators.hintRecord(hint);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const paths = result.issues.map((i) => i.path);
        expect(paths).toEqual([index % 2 === 0 ? "/slot" : "/confidence"]);
      });
      // Every row that was valid before is invalid after.
      for (const hint of clean?.hints ?? []) expect(validators.hintRecord(hint).ok).toBe(true);
    });

    it("passes null through for an unknown subject", async () => {
      const store = new FaultyStore(new MemoryStore(), { corruptRows: true });
      await expect(store.loadSnapshot(ref)).resolves.toBeNull();
    });
  });

  describe("calls", () => {
    it("records every method call with its arguments, in order", async () => {
      const store = new FaultyStore(new MemoryStore(), { throwOn: ["getHint"] });
      await store.loadSnapshot(ref);
      await store.getHint(ref, "h").catch(() => undefined);
      await store.listAudit(ref, 5);
      expect(store.calls).toEqual([
        { method: "loadSnapshot", args: [ref, undefined] },
        { method: "getHint", args: [ref, "h"] },
        { method: "listAudit", args: [ref, 5] },
      ]);
    });
  });

  describe("searchNodesByEmbedding", () => {
    it("is present and forwarded only when the inner store implements it", async () => {
      const inner = new MemoryStore();
      await inner.applyBatch(ref, [{ op: "upsertNode", node: fixtureNode(ref, "/", { embedding: [1, 0] }) }]);
      const withVectors = new FaultyStore(inner);
      expect(withVectors.searchNodesByEmbedding).toBeDefined();
      await expect(withVectors.searchNodesByEmbedding?.(ref, [1, 0], 5)).resolves.toEqual([{ nodeId: fixtureNode(ref, "/").id, score: 1 }]);
      expect(withVectors.calls.at(-1)?.method).toBe("searchNodesByEmbedding");

      // A port with the optional method absent: explicit delegation, since spreading an instance copies no prototype methods.
      const withoutSearch: StorePort = {
        loadSnapshot: inner.loadSnapshot.bind(inner),
        applyBatch: inner.applyBatch.bind(inner),
        getHint: inner.getHint.bind(inner),
        deleteHint: inner.deleteHint.bind(inner),
        deleteSubject: inner.deleteSubject.bind(inner),
        claimEvent: inner.claimEvent.bind(inner),
        leaseEvents: inner.leaseEvents.bind(inner),
        updateEvent: inner.updateEvent.bind(inner),
        getEvent: inner.getEvent.bind(inner),
        getTurn: inner.getTurn.bind(inner),
        listEvents: inner.listEvents.bind(inner),
        scrubEvents: inner.scrubEvents.bind(inner),
        listAudit: inner.listAudit.bind(inner),
        purge: inner.purge.bind(inner),
      };
      const withoutVectors = new FaultyStore(withoutSearch);
      expect(withoutVectors.searchNodesByEmbedding).toBeUndefined();
    });
  });
});
