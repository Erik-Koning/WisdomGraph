/**
 * The scope is checked as the consumer's graph experiences it: a handle
 * started before `invoke` is visible after every kind of await inside the
 * run and to every parallel caller, Lane A gives up at 150 ms while Lane B
 * later gets the real recall, the refinement is preferred only when it
 * lands in time, nothing is visible outside a run, and no promise the
 * adapter hands out can reject — whatever the graph does. Timers are fake
 * throughout; the system clock follows them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopWisdomGraph } from "../core/engine";
import { emptyRecall } from "../core/recall/recall";
import type { Recall, RecallRequest, WisdomGraph } from "../core/types";
import { CollectingLogger, FakeClock } from "../testing/fakes";
import { LANE_A_DEFAULT_MS, createRecallScope, startTurnRecall, type RecallHandle } from "./scope";

const request = (over: Partial<RecallRequest> = {}): RecallRequest => ({
  subjectId: "rm_42",
  text: "How should we sequence RRIF withdrawals?",
  budgetMs: 2_500,
  ...over,
});

/** A frozen Recall that names who produced it, so the lanes' choices are visible. */
function recallNamed(requestId: string): Recall {
  return emptyRecall({ subjectId: "rm_42", requestId });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Whether a promise has settled, observed without awaiting it. */
function track<T>(p: Promise<T>): { settled: boolean; value?: T } {
  const state: { settled: boolean; value?: T } = { settled: false };
  void p.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

/** The noop graph with the recall side replaced. */
function graphWith(over: Partial<Pick<WisdomGraph, "recall" | "refine">>): WisdomGraph {
  return { ...createNoopWisdomGraph(), ...over };
}

describe("startTurnRecall (§8.2)", () => {
  it("calls graph.recall at once, stamps startedAt from the clock, and has no refined promise unless asked", async () => {
    const real = recallNamed("base");
    const recall = vi.fn(async (_req: RecallRequest) => real);
    const refine = vi.fn(async (r: Recall) => r);
    const clock = new FakeClock(1_000);
    const req = request();
    const handle = startTurnRecall(graphWith({ recall, refine }), req, { clock });
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith(req);
    expect(handle.request).toBe(req);
    expect(handle.startedAt).toBe(1_000);
    expect(handle.refined).toBeUndefined();
    await expect(handle.base).resolves.toBe(real);
    expect(refine).not.toHaveBeenCalled();
  });

  it("refine: true chains graph.refine(base, req, { signal }) and refined resolves to its result", async () => {
    const base = recallNamed("base");
    const better = recallNamed("refined");
    const refine = vi.fn(async (_r: Recall, _req: RecallRequest, _opts?: { signal?: AbortSignal; budgetMs?: number }) => better);
    const controller = new AbortController();
    const req = request({ signal: controller.signal });
    const handle = startTurnRecall(graphWith({ recall: async () => base, refine }), req, { refine: true });
    expect(handle.refined).toBeDefined();
    await expect(handle.refined).resolves.toBe(better);
    expect(refine).toHaveBeenCalledTimes(1);
    expect(refine).toHaveBeenCalledWith(base, req, { signal: controller.signal });
  });

  it("passes no signal to refine when the request has none", async () => {
    const refine = vi.fn(async (r: Recall, _req: RecallRequest, _opts?: { signal?: AbortSignal; budgetMs?: number }) => r);
    const handle = startTurnRecall(graphWith({ recall: async () => recallNamed("base"), refine }), request(), { refine: true });
    await handle.refined;
    expect(refine.mock.calls[0]?.[2]).toEqual({});
  });

  it("works against the noop graph: base resolves to an empty recall for the request's subject", async () => {
    const handle = startTurnRecall(createNoopWisdomGraph(), request(), { refine: true });
    const base = await handle.base;
    expect(base.meta.status).toBe("empty");
    expect(base.charter.subjectId).toBe("rm_42");
    await expect(handle.refined).resolves.toBe(base);
  });

  describe("never rejects", () => {
    it("a recall that rejects settles base to emptyRecall(req, 'error') and warns once", async () => {
      const logger = new CollectingLogger();
      const handle = startTurnRecall(graphWith({ recall: async () => Promise.reject(new Error("store down")) }), request({ requestId: "req_9" }), { logger });
      const base = await handle.base;
      expect(base.meta).toMatchObject({ status: "empty", reason: "error", requestId: "req_9" });
      expect(base.charter.subjectId).toBe("rm_42");
      expect(logger.find({ level: "warn", msg: "langgraph.recall.failed" })).toHaveLength(1);
      expect(logger.entries[0]?.obj).toMatchObject({ subjectId: "rm_42", requestId: "req_9", stage: "recall", error: "Error: store down" });
    });

    it("a recall that throws synchronously settles base the same way", async () => {
      const logger = new CollectingLogger();
      const recall = (): Promise<Recall> => {
        throw new TypeError("not a graph");
      };
      const handle = startTurnRecall(graphWith({ recall }), request(), { logger });
      await expect(handle.base).resolves.toMatchObject({ meta: { status: "empty", reason: "error" } });
      expect(logger.find({ level: "warn" })).toHaveLength(1);
    });

    it("a graph that is not a graph at all still yields a handle whose base resolves", async () => {
      // Malformed on purpose: the consumer wires this behind a feature flag and may pass nothing.
      const handle = startTurnRecall(undefined as unknown as WisdomGraph, request());
      await expect(handle.base).resolves.toMatchObject({ meta: { status: "empty", reason: "error" } });
    });

    it("a recall that resolves to something that is not a Recall is replaced by an empty one", async () => {
      const logger = new CollectingLogger();
      // Malformed on purpose.
      const handle = startTurnRecall(graphWith({ recall: async () => undefined as unknown as Recall }), request(), { logger });
      await expect(handle.base).resolves.toMatchObject({ meta: { status: "empty", reason: "error" } });
      expect(logger.entries[0]?.obj).toMatchObject({ error: expect.stringContaining("not a Recall") });
    });

    it("a refine that rejects, throws, or returns junk settles refined to the base value and warns", async () => {
      const base = recallNamed("base");
      for (const refine of [
        async (): Promise<Recall> => Promise.reject(new Error("embed down")),
        (): Promise<Recall> => {
          throw new Error("sync");
        },
        // Malformed on purpose.
        async (): Promise<Recall> => null as unknown as Recall,
      ]) {
        const logger = new CollectingLogger();
        const handle = startTurnRecall(graphWith({ recall: async () => base, refine }), request(), { refine: true, logger });
        await expect(handle.refined).resolves.toBe(base);
        await expect(handle.base).resolves.toBe(base);
        expect(logger.find({ level: "warn", msg: "langgraph.refine.failed" })).toHaveLength(1);
      }
    });
  });
});

describe("createRecallScope — propagation (§8.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const handleOf = (value: Recall = recallNamed("base")): RecallHandle => ({ request: request(), base: Promise.resolve(value), startedAt: Date.now() });

  it("run returns fn's value, current() is the handle inside and undefined outside", async () => {
    const scope = createRecallScope();
    const handle = handleOf();
    expect(scope.current()).toBeUndefined();
    expect(scope.run(handle, () => 42)).toBe(42);
    expect(scope.run(handle, () => scope.current())).toBe(handle);
    await expect(scope.run(handle, async () => scope.current())).resolves.toBe(handle);
    expect(scope.current()).toBeUndefined();
  });

  it("the handle survives microtask, timer and nested awaits, and parallel callers all see it", async () => {
    const scope = createRecallScope();
    const handle = handleOf();
    const seen: (RecallHandle | undefined)[] = [];
    const run = scope.run(handle, async () => {
      await Promise.resolve();
      seen.push(scope.current());
      await after(5, undefined);
      seen.push(scope.current());
      const branch = async (delay: number): Promise<RecallHandle | undefined> => {
        await after(delay, undefined);
        await Promise.resolve();
        return scope.current();
      };
      // Fan-out: three consult nodes in one superstep.
      seen.push(...(await Promise.all([branch(1), branch(3), branch(2)])));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      seen.push(scope.current());
    });
    await vi.advanceTimersByTimeAsync(20);
    await run;
    expect(seen).toHaveLength(6);
    for (const h of seen) expect(h).toBe(handle);
  });

  it("two concurrent runs keep their own handle", async () => {
    const scope = createRecallScope();
    const a = handleOf(recallNamed("a"));
    const b = handleOf(recallNamed("b"));
    const inA = scope.run(a, async () => {
      await after(3, undefined);
      return scope.current();
    });
    const inB = scope.run(b, async () => {
      await after(1, undefined);
      return scope.current();
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await inA).toBe(a);
    expect(await inB).toBe(b);
    expect(scope.current()).toBeUndefined();
  });

  it("outside a scope both lanes resolve emptyRecall() and never wait", async () => {
    const scope = createRecallScope();
    const a = track(scope.laneA());
    const b = track(scope.laneB());
    await vi.advanceTimersByTimeAsync(0);
    expect(a.settled && b.settled).toBe(true);
    for (const value of [a.value, b.value]) {
      expect(value?.meta.status).toBe("empty");
      expect(value?.charter.subjectId).toBe("");
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});

describe("createRecallScope — lanes (§8.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A graph whose recall lands `baseMs` after it is called and whose refine is controlled by the test. */
  function slowGraph(baseMs: number, base: Recall = recallNamed("base")) {
    const refinement = deferred<Recall>();
    const graph = graphWith({ recall: () => after(baseMs, base), refine: () => refinement.promise });
    return { graph, base, refinement };
  }

  it("laneA(150) resolves emptyRecall(req, 'budget') when the base is slower, and a later laneB() returns the real Recall", async () => {
    const scope = createRecallScope();
    const { graph, base } = slowGraph(500);
    const handle = startTurnRecall(graph, request());
    await scope.run(handle, async () => {
      const a = track(scope.laneA(150));
      await vi.advanceTimersByTimeAsync(149);
      expect(a.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(a.settled).toBe(true);
      expect(a.value?.meta).toMatchObject({ status: "empty", reason: "budget" });
      expect(a.value?.charter.subjectId).toBe("rm_42");

      const b = track(scope.laneB());
      await vi.advanceTimersByTimeAsync(349);
      expect(b.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(b.settled).toBe(true);
      expect(b.value).toBe(base);
    });
  });

  it("laneA defaults to 150 ms and returns a base that has already settled even at 0 ms", async () => {
    expect(LANE_A_DEFAULT_MS).toBe(150);
    const scope = createRecallScope();
    const { graph, base } = slowGraph(200);
    const handle = startTurnRecall(graph, request());
    await scope.run(handle, async () => {
      const a = track(scope.laneA());
      await vi.advanceTimersByTimeAsync(LANE_A_DEFAULT_MS - 1);
      expect(a.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(a.value?.meta.reason).toBe("budget");
      await vi.advanceTimersByTimeAsync(50);
      await expect(scope.laneA(0)).resolves.toBe(base);
    });
  });

  it("laneB waits budgetMs − elapsed by default, measured on the scope's clock", async () => {
    const scope = createRecallScope();
    const { graph, base } = slowGraph(900);
    const handle = startTurnRecall(graph, request({ budgetMs: 1_000 }));
    await scope.run(handle, async () => {
      await vi.advanceTimersByTimeAsync(400);
      const b = track(scope.laneB());
      await vi.advanceTimersByTimeAsync(499);
      expect(b.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(b.value).toBe(base);
    });

    const late = slowGraph(1_200);
    const lateHandle = startTurnRecall(late.graph, request({ budgetMs: 1_000 }));
    await scope.run(lateHandle, async () => {
      await vi.advanceTimersByTimeAsync(400);
      const b = track(scope.laneB());
      await vi.advanceTimersByTimeAsync(599);
      expect(b.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(b.value?.meta).toMatchObject({ status: "empty", reason: "budget" });
    });
  });

  it("laneB with the budget already spent resolves at once: the base if settled, else empty", async () => {
    const scope = createRecallScope();
    const spent = startTurnRecall(slowGraph(50).graph, request({ budgetMs: 100 }));
    await scope.run(spent, async () => {
      await vi.advanceTimersByTimeAsync(150);
      const b = track(scope.laneB());
      await vi.advanceTimersByTimeAsync(0);
      expect(b.value?.meta.status).toBe("empty");
      expect(b.value?.charter.subjectId).toBe("rm_42");
      expect(b.value?.meta.reason).toBeUndefined();
    });
    const slow = slowGraph(500);
    const pending = startTurnRecall(slow.graph, request({ budgetMs: 100 }));
    await scope.run(pending, async () => {
      await vi.advanceTimersByTimeAsync(150);
      const b = track(scope.laneB());
      await vi.advanceTimersByTimeAsync(0);
      expect(b.settled).toBe(true);
      expect(b.value?.meta.reason).toBe("budget");
    });
  });

  it("laneB honours an explicit ms over the budget", async () => {
    const scope = createRecallScope();
    const { graph, base } = slowGraph(300);
    const handle = startTurnRecall(graph, request({ budgetMs: 100 }));
    await scope.run(handle, async () => {
      const b = track(scope.laneB(400));
      await vi.advanceTimersByTimeAsync(299);
      expect(b.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(b.value).toBe(base);
    });
  });

  it("measures elapsed on the clock it is given when startTurnRecall stamped the handle with the same clock", async () => {
    const clock = new FakeClock();
    const scope = createRecallScope({ clock });
    const { graph } = slowGraph(10_000);
    const handle = startTurnRecall(graph, request({ budgetMs: 2_500 }), { clock });
    await scope.run(handle, async () => {
      clock.tick(2_400);
      const b = track(scope.laneB());
      await vi.advanceTimersByTimeAsync(99);
      expect(b.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(b.value?.meta.reason).toBe("budget");
    });
  });

  describe("refined (refine: true)", () => {
    it("laneB prefers the refined recall when it settles inside the wait", async () => {
      const scope = createRecallScope();
      const { graph, refinement } = slowGraph(100);
      const better = recallNamed("refined");
      const handle = startTurnRecall(graph, request(), { refine: true });
      await scope.run(handle, async () => {
        const b = track(scope.laneB());
        await vi.advanceTimersByTimeAsync(100);
        expect(b.settled).toBe(false);
        refinement.resolve(better);
        await vi.advanceTimersByTimeAsync(0);
        expect(b.value).toBe(better);
      });
    });

    it("laneB returns the base when the refinement is still pending at the deadline", async () => {
      const scope = createRecallScope();
      const { graph, base } = slowGraph(100);
      const handle = startTurnRecall(graph, request(), { refine: true });
      await scope.run(handle, async () => {
        const b = track(scope.laneB(400));
        await vi.advanceTimersByTimeAsync(399);
        expect(b.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(b.value).toBe(base);
      });
    });

    it("laneB returns emptyRecall(req, 'budget') when neither has settled at the deadline", async () => {
      const scope = createRecallScope();
      const { graph } = slowGraph(1_000);
      const handle = startTurnRecall(graph, request(), { refine: true });
      await scope.run(handle, async () => {
        const b = await (async () => {
          const p = scope.laneB(50);
          await vi.advanceTimersByTimeAsync(50);
          return p;
        })();
        expect(b.meta).toMatchObject({ status: "empty", reason: "budget" });
        expect(b.charter.subjectId).toBe("rm_42");
      });
    });

    it("laneA never waits for the refinement", async () => {
      const scope = createRecallScope();
      const { graph, base } = slowGraph(10);
      const handle = startTurnRecall(graph, request(), { refine: true });
      await scope.run(handle, async () => {
        const a = track(scope.laneA());
        await vi.advanceTimersByTimeAsync(10);
        expect(a.value).toBe(base);
      });
    });
  });

  describe("hand-built handles", () => {
    it("a rejecting base gives emptyRecall on both lanes; a rejecting refined falls back to the base", async () => {
      const scope = createRecallScope();
      const rejecting: RecallHandle = { request: request(), base: Promise.reject(new Error("no")), startedAt: Date.now() };
      await scope.run(rejecting, async () => {
        await expect(scope.laneA()).resolves.toMatchObject({ meta: { status: "empty", reason: "budget" } });
        await expect(scope.laneB()).resolves.toMatchObject({ meta: { status: "empty", reason: "budget" } });
      });
      const base = recallNamed("base");
      const badRefine: RecallHandle = { request: request(), base: Promise.resolve(base), refined: Promise.reject(new Error("no")), startedAt: Date.now() };
      await scope.run(badRefine, async () => {
        await expect(scope.laneB()).resolves.toBe(base);
      });
    });

    it("a handle with an unmeasurable startedAt or budget still resolves laneB at once", async () => {
      const scope = createRecallScope();
      const base = recallNamed("base");
      // Malformed on purpose.
      const odd: RecallHandle = { request: request({ budgetMs: Number.NaN }), base: Promise.resolve(base), startedAt: Number.NaN };
      await scope.run(odd, async () => {
        const b = track(scope.laneB());
        await vi.advanceTimersByTimeAsync(0);
        expect(b.value).toBe(base);
      });
    });
  });

  it("parallel callers inside one run receive the identical frozen object", async () => {
    const scope = createRecallScope();
    const { graph, base } = slowGraph(20);
    const handle = startTurnRecall(graph, request());
    await scope.run(handle, async () => {
      const all = Promise.all([scope.laneB(), scope.laneB(), scope.laneA(100)]);
      await vi.advanceTimersByTimeAsync(20);
      const [x, y, z] = await all;
      expect(x).toBe(base);
      expect(y).toBe(base);
      expect(z).toBe(base);
      expect(Object.isFrozen(x)).toBe(true);
      expect(JSON.parse(JSON.stringify(x))).toEqual(x);
    });
  });
});
