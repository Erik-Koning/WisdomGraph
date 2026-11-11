/**
 * The fakes are the instruments every later suite measures with, so their
 * behaviour is pinned here: which script step answers, when a hang releases,
 * that embeddings are pure functions, that the clock only moves when told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapturingTracer, CollectingLogger, FakeClock, FakeEmbedding, FakeLlm } from "./index";
import { EMPTY_PROPOSAL, FAKE_CLOCK_EPOCH, hashedBagOfWords } from "./fakes";

describe("FakeLlm", () => {
  it("replies with an empty proposal and records the call when nothing matches", async () => {
    const llm = new FakeLlm();
    await expect(llm.complete("anything", { purpose: "extract" })).resolves.toBe(EMPTY_PROPOSAL);
    expect(llm.calls).toEqual([{ prompt: "anything", opts: { purpose: "extract" } }]);
    expect(JSON.parse(EMPTY_PROPOSAL)).toEqual({ ops: [] });
  });

  it("matches by purpose", async () => {
    const llm = new FakeLlm([
      { purpose: "consolidate", reply: "C" },
      { purpose: "extract", reply: "E" },
    ]);
    await expect(llm.complete("p", { purpose: "extract" })).resolves.toBe("E");
    await expect(llm.complete("p", { purpose: "consolidate" })).resolves.toBe("C");
  });

  it("matches by regex on the prompt", async () => {
    const llm = new FakeLlm([
      { match: /disclaimer/, reply: "D" },
      { match: /bullet/, reply: "B" },
    ]);
    await expect(llm.complete("prefers bullet points", {})).resolves.toBe("B");
    await expect(llm.complete("about disclaimers", {})).resolves.toBe("D");
  });

  it("matches a /g or /y regex the same way on every call", async () => {
    // RegExp.prototype.test would carry `lastIndex` across calls and alternate hit/miss.
    const llm = new FakeLlm([{ match: /bullet/g, reply: "B", sticky: true }]);
    for (let i = 0; i < 3; i += 1) await expect(llm.complete("prefers bullet points", {})).resolves.toBe("B");
    const sticky = new FakeLlm([{ match: /prefers/y, reply: "P", sticky: true }]);
    for (let i = 0; i < 3; i += 1) await expect(sticky.complete("prefers bullet points", {})).resolves.toBe("P");
  });

  it("requires both purpose and regex when both are given", async () => {
    const llm = new FakeLlm([{ match: /x/, purpose: "extract", reply: "both" }]);
    await expect(llm.complete("x", { purpose: "consolidate" })).resolves.toBe(EMPTY_PROPOSAL);
    await expect(llm.complete("y", { purpose: "extract" })).resolves.toBe(EMPTY_PROPOSAL);
    await expect(llm.complete("x", { purpose: "extract" })).resolves.toBe("both");
  });

  it("consumes steps in order so a retry script plays out", async () => {
    const llm = new FakeLlm([{ reply: "garbage" }, { reply: { ops: [] } }]);
    expect(llm.pending).toBe(2);
    await expect(llm.complete("p", {})).resolves.toBe("garbage");
    await expect(llm.complete("p", {})).resolves.toBe('{"ops":[]}');
    await expect(llm.complete("p", {})).resolves.toBe(EMPTY_PROPOSAL);
    expect(llm.pending).toBe(0);
    expect(llm.calls).toHaveLength(3);
  });

  it("keeps sticky steps and lets push() extend the script", async () => {
    const llm = new FakeLlm([{ reply: "always", sticky: true }]);
    await expect(llm.complete("p", {})).resolves.toBe("always");
    await expect(llm.complete("p", {})).resolves.toBe("always");
    llm.push({ match: /special/, reply: "once" });
    await expect(llm.complete("special", {})).resolves.toBe("always");
    const llm2 = new FakeLlm();
    llm2.push({ reply: "pushed" });
    await expect(llm2.complete("p", {})).resolves.toBe("pushed");
  });

  it("stringifies object replies", async () => {
    const llm = new FakeLlm([{ reply: { ops: [{ op: "noop", rationale: "r" }] } }]);
    await expect(llm.complete("p", {})).resolves.toBe('{"ops":[{"op":"noop","rationale":"r"}]}');
  });

  it("rejects with `throws`", async () => {
    const error = new Error("model down");
    const llm = new FakeLlm([{ reply: "", throws: error }]);
    await expect(llm.complete("p", {})).rejects.toBe(error);
    expect(llm.calls).toHaveLength(1);
  });

  describe("timing", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("delays the reply by delayMs", async () => {
      const llm = new FakeLlm([{ reply: "late", delayMs: 500 }]);
      let settled: string | undefined;
      const p = llm.complete("p", {}).then((r) => {
        settled = r;
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toBe("late");
    });

    it("throws after the delay when both are set", async () => {
      const llm = new FakeLlm([{ reply: "", delayMs: 100, throws: new Error("late failure") }]);
      const p = llm.complete("p", {});
      const outcome = p.then(
        () => "resolved",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(100);
      await expect(outcome).resolves.toBe("late failure");
    });

    it("hangs until the signal aborts, then rejects with the reason", async () => {
      const llm = new FakeLlm([{ reply: "never", hang: true }]);
      const controller = new AbortController();
      let outcome: unknown = "pending";
      const p = llm.complete("p", { signal: controller.signal }).then(
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

    it("rejects immediately on an already-aborted signal, even for a delayed step", async () => {
      const llm = new FakeLlm([{ reply: "x", delayMs: 1000 }]);
      const controller = new AbortController();
      controller.abort();
      await expect(llm.complete("p", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    });

    it("abort during a delay cancels the timer", async () => {
      const llm = new FakeLlm([{ reply: "x", delayMs: 1000 }]);
      const controller = new AbortController();
      const p = llm.complete("p", { signal: controller.signal });
      const outcome = p.then(
        () => "resolved",
        () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await expect(outcome).resolves.toBe("rejected");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("FakeEmbedding", () => {
  function cosine(a: number[], b: number[]): number {
    return a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
  }

  it("is deterministic and records calls", async () => {
    const a = new FakeEmbedding();
    const b = new FakeEmbedding();
    const [va] = await a.embed(["Retirement planning and RRSP withdrawals"]);
    const [vb] = await b.embed(["Retirement planning and RRSP withdrawals"]);
    expect(va).toEqual(vb);
    expect(a.calls).toEqual([["Retirement planning and RRSP withdrawals"]]);
    expect(a.dimensions).toBe(64);
    expect(va).toHaveLength(64);
  });

  it("L2-normalises every non-empty vector and zeroes the empty text", async () => {
    const e = new FakeEmbedding(16);
    const [x, y, empty] = await e.embed(["one two three", "market news today", ""]);
    for (const v of [x, y]) {
      const norm = Math.sqrt((v ?? []).reduce((s, n) => s + n * n, 0));
      expect(norm).toBeCloseTo(1, 9);
      expect(v).toHaveLength(16);
    }
    expect(empty).toEqual(new Array<number>(16).fill(0));
  });

  it("puts texts that share words closer than texts that do not", async () => {
    const e = new FakeEmbedding(128);
    const [a, b, c] = await e.embed(["rrsp retirement withdrawals", "retirement rrsp planning", "quarterly market analysis"]);
    expect(cosine(a ?? [], b ?? [])).toBeGreaterThan(cosine(a ?? [], c ?? []));
    expect(cosine(a ?? [], a ?? [])).toBeCloseTo(1, 9);
  });

  it("is case-insensitive and tokenises on letters and digits", () => {
    expect(hashedBagOfWords("RRSP, rrif!", 32)).toEqual(hashedBagOfWords("rrsp rrif", 32));
    expect(hashedBagOfWords("a", 8)).not.toEqual(hashedBagOfWords("b", 8));
  });

  it("honours throws and an aborted signal", async () => {
    const error = new Error("embed down");
    await expect(new FakeEmbedding(8, { throws: error }).embed(["x"])).rejects.toBe(error);
    const controller = new AbortController();
    controller.abort();
    await expect(new FakeEmbedding(8).embed(["x"], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("delays with delayMs under fake timers", async () => {
    vi.useFakeTimers();
    try {
      const e = new FakeEmbedding(8, { delayMs: 200 });
      let done = false;
      const p = e.embed(["x"]).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(199);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FakeClock", () => {
  it("starts at the fixed epoch and only moves when told", () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(FAKE_CLOCK_EPOCH);
    expect(clock.iso()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe(FAKE_CLOCK_EPOCH);
  });

  it("tick adds milliseconds and advanceDays adds whole days", () => {
    const clock = new FakeClock(1_000);
    clock.tick(500);
    expect(clock.now()).toBe(1_500);
    clock.advanceDays(2);
    expect(clock.now()).toBe(1_500 + 2 * 86_400_000);
    clock.advanceDays(0.5);
    expect(clock.now()).toBe(1_500 + 2.5 * 86_400_000);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});

describe("CollectingLogger", () => {
  it("records level, object and message for every call", () => {
    const logger = new CollectingLogger();
    logger.debug({ a: 1 }, "recall.done");
    logger.info({ b: 2 }, "ingest.processed");
    logger.warn({ c: 3 });
    logger.error({ d: 4 }, "store.error");
    expect(logger.entries).toEqual([
      { level: "debug", obj: { a: 1 }, msg: "recall.done" },
      { level: "info", obj: { b: 2 }, msg: "ingest.processed" },
      { level: "warn", obj: { c: 3 } },
      { level: "error", obj: { d: 4 }, msg: "store.error" },
    ]);
    expect(logger.find({ level: "error" })).toHaveLength(1);
    expect(logger.find({ msg: "recall.done" })).toEqual([{ level: "debug", obj: { a: 1 }, msg: "recall.done" }]);
    expect(logger.find({ level: "info", msg: "nope" })).toEqual([]);
    logger.clear();
    expect(logger.entries).toEqual([]);
  });
});

describe("CapturingTracer", () => {
  it("captures attributes, events, exceptions and end per span", () => {
    const tracer = new CapturingTracer();
    const span = tracer.startSpan("wisdom.recall", { attributes: { "wisdom.budget_ms": 150 } });
    span.setAttribute("wisdom.status", "ok");
    span.addEvent?.("cache", { hit: true });
    span.addEvent?.("bare");
    const error = new Error("boom");
    span.recordException(error);
    expect(tracer.spans[0]?.ended).toBe(false);
    span.end();
    tracer.startSpan("wisdom.recall.classify");
    expect(tracer.spans).toEqual([
      {
        name: "wisdom.recall",
        attrs: { "wisdom.budget_ms": 150, "wisdom.status": "ok" },
        events: [{ name: "cache", attrs: { hit: true } }, { name: "bare" }],
        exceptions: [error],
        ended: true,
      },
      { name: "wisdom.recall.classify", attrs: {}, events: [], exceptions: [], ended: false },
    ]);
    expect(tracer.named("wisdom.recall")).toHaveLength(1);
  });
});
