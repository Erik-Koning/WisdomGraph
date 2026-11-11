/**
 * The scheduler's three rules — one job per subject at a time, a global
 * running cap, and timers that hold no lane — plus the bound, the
 * outcomes, and what close() does and does not stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_DEFAULTS, SubjectQueue, type AttemptResult } from "./queue";

/** A hand-controlled attempt: `release()` lets it finish with `result`. */
function gate(result: AttemptResult = { kind: "done" }): { attempt: () => Promise<AttemptResult>; release: () => void; started: () => boolean } {
  let started = false;
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    attempt: async () => {
      started = true;
      await opened;
      return result;
    },
    release,
    started: () => started,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("SubjectQueue — lanes and concurrency", () => {
  it("runs jobs of one subject one after another, in arrival order", async () => {
    const queue = new SubjectQueue({ concurrency: 4 });
    const a = gate();
    const b = gate();
    const first = queue.enqueue("s1", a.attempt);
    const second = queue.enqueue("s1", b.attempt);
    expect(first.accepted && second.accepted).toBe(true);
    await tick();
    expect(a.started()).toBe(true);
    expect(b.started()).toBe(false);
    expect(queue.running).toBe(1);
    a.release();
    await tick();
    expect(b.started()).toBe(true);
    b.release();
    await queue.idle();
    expect(queue.depth).toBe(0);
  });

  it("runs different subjects in parallel up to `concurrency`, then queues the rest", async () => {
    const queue = new SubjectQueue({ concurrency: 2 });
    const gates = ["s1", "s2", "s3", "s4"].map((key) => ({ key, g: gate() }));
    for (const { key, g } of gates) queue.enqueue(key, g.attempt);
    await tick();
    expect(gates.map(({ g }) => g.started())).toEqual([true, true, false, false]);
    expect(queue.running).toBe(2);
    expect(queue.depth).toBe(4);
    gates[0]?.g.release();
    await tick();
    expect(gates[2]?.g.started()).toBe(true);
    expect(gates[3]?.g.started()).toBe(false);
    for (const { g } of gates) g.release();
    await queue.idle();
    expect(queue.running).toBe(0);
  });

  it("refuses beyond maxPending with `overflow`; a finished job frees the slot", async () => {
    const queue = new SubjectQueue({ maxPending: 1 });
    const a = gate();
    expect(queue.enqueue("s1", a.attempt).accepted).toBe(true);
    expect(queue.enqueue("s2", gate().attempt)).toEqual({ accepted: false, reason: "overflow" });
    expect(queue.depth).toBe(1);
    a.release();
    await queue.idle();
    expect(queue.enqueue("s2", gate().attempt).accepted).toBe(true);
  });

  it("falls back to the defaults for nonsense options", () => {
    const queue = new SubjectQueue({ concurrency: 0, maxPending: -1 });
    expect(queue.concurrency).toBe(QUEUE_DEFAULTS.concurrency);
    expect(queue.maxPending).toBe(QUEUE_DEFAULTS.maxPending);
    expect(new SubjectQueue({ concurrency: 2.9, maxPending: 0 })).toMatchObject({ concurrency: 2, maxPending: 0 });
  });
});

describe("SubjectQueue — outcomes", () => {
  it("resolves the outcome with the attempt's word, and `failed` for an attempt that throws", async () => {
    const queue = new SubjectQueue();
    const done = queue.enqueue("s1", async () => ({ kind: "done" }));
    const skipped = queue.enqueue("s2", async () => ({ kind: "skipped" }));
    const failed = queue.enqueue("s3", async () => ({ kind: "failed" }));
    const threw = queue.enqueue("s4", async () => {
      throw new Error("boom");
    });
    const notDue = queue.enqueue("s5", async () => ({ kind: "not-due" }));
    const outcomes = await Promise.all([done, skipped, failed, threw, notDue].map((e) => (e.accepted ? e.outcome : Promise.resolve("refused"))));
    expect(outcomes).toEqual(["done", "skipped", "failed", "failed", "not-due"]);
    expect(queue.depth).toBe(0);
  });

  it("idle() resolves at once when nothing is held and never rejects", async () => {
    const queue = new SubjectQueue();
    await expect(queue.idle()).resolves.toBeUndefined();
  });
});

describe("SubjectQueue — retry timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-runs a job after its delay and settles the outcome with the final attempt", async () => {
    const queue = new SubjectQueue();
    const results: AttemptResult[] = [{ kind: "retry", delayMs: 100, reason: "backoff" }, { kind: "retry", delayMs: 400, reason: "backoff" }, { kind: "done" }];
    let calls = 0;
    const enqueued = queue.enqueue("s1", async () => results[calls++] ?? { kind: "failed" });
    if (!enqueued.accepted) throw new Error("refused");
    let settled: string | undefined;
    void enqueued.outcome.then((o) => {
      settled = o;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(queue.scheduled).toBe(1);
    expect(queue.depth).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toBe(3);
    expect(settled).toBe("done");
    expect(queue.depth).toBe(0);
  });

  it("a job waiting on a timer holds no lane: a later job for the same subject runs in the meantime", async () => {
    const queue = new SubjectQueue();
    const order: string[] = [];
    let first = 0;
    queue.enqueue("s1", async () => {
      first += 1;
      order.push(`a${first}`);
      return first === 1 ? { kind: "retry", delayMs: 1_000, reason: "deferred" } : { kind: "done" };
    });
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue("s1", async () => {
      order.push("b");
      return { kind: "done" };
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a1", "b"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["a1", "b", "a2"]);
    await queue.idle();
  });

  it("a retry with a non-positive or non-finite delay runs on the next timer turn", async () => {
    const queue = new SubjectQueue();
    let calls = 0;
    queue.enqueue("s1", async () => {
      calls += 1;
      return calls === 1 ? { kind: "retry", delayMs: Number.NaN, reason: "backoff" } : { kind: "done" };
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
  });

  it("close() cancels pending timers and waiting jobs (outcome `cancelled`), refuses new jobs, and lets only the job in flight finish", async () => {
    const queue = new SubjectQueue({ concurrency: 1 });
    const retrying = queue.enqueue("s1", async () => ({ kind: "retry", delayMs: 5_000, reason: "backoff" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.scheduled).toBe(1);
    const blocker = gate();
    const running = queue.enqueue("s2", blocker.attempt);
    let ran = false;
    const queued = queue.enqueue("s3", async () => {
      ran = true;
      return { kind: "done" };
    });
    // A second job in the running lane: dropped too, and the lane survives for the job in flight.
    const sameLane = queue.enqueue("s2", async () => {
      ran = true;
      return { kind: "done" };
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toBe(false);
    expect(queue.depth).toBe(4);

    queue.close();
    expect(queue.isClosed).toBe(true);
    expect(queue.scheduled).toBe(0);
    expect(queue.running).toBe(1);
    expect(queue.depth).toBe(1);
    expect(queue.enqueue("s4", gate().attempt)).toEqual({ accepted: false, reason: "closed" });
    if (!retrying.accepted || !queued.accepted || !sameLane.accepted || !running.accepted) throw new Error("refused");
    await expect(retrying.outcome).resolves.toBe("cancelled");
    await expect(queued.outcome).resolves.toBe("cancelled");
    await expect(sameLane.outcome).resolves.toBe("cancelled");
    expect(ran).toBe(false);

    blocker.release();
    await queue.idle();
    await expect(running.outcome).resolves.toBe("done");
    expect(ran).toBe(false);
    expect(queue.depth).toBe(0);
  });

  it("a job that asks to retry after close() ends `cancelled` instead of scheduling", async () => {
    const queue = new SubjectQueue();
    const blocker = gate({ kind: "retry", delayMs: 1_000, reason: "backoff" });
    const enqueued = queue.enqueue("s1", blocker.attempt);
    await vi.advanceTimersByTimeAsync(0);
    queue.close();
    blocker.release();
    if (!enqueued.accepted) throw new Error("refused");
    await expect(enqueued.outcome).resolves.toBe("cancelled");
    expect(queue.scheduled).toBe(0);
    expect(queue.depth).toBe(0);
  });
});
