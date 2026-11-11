/**
 * The never-reject helpers are checked on the properties recall relies on:
 * a composite signal that aborts on any input and can be detached, a
 * deadline that tells a timeout from a parent abort and reads the injected
 * clock, and races that settle with a tag and never reject — including a
 * rejection of the raced promise, which must be observed, not leaked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../testing/fakes";
import { Deadline, abortReason, clampBudget, linkSignals, raceSignal, settleWithin, timeoutError } from "./deadline";

const never = new Promise<never>(() => undefined);

describe("linkSignals", () => {
  it("returns a live signal when given nothing, or only undefined", () => {
    expect(linkSignals().signal.aborted).toBe(false);
    expect(linkSignals(undefined, undefined).signal.aborted).toBe(false);
  });

  it("aborts at once, with its reason, when an input is already aborted", () => {
    const parent = new AbortController();
    parent.abort(new Error("hung up"));
    const { signal } = linkSignals(undefined, parent.signal);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(parent.signal.reason);
  });

  it("aborts when any input aborts later, carrying that input's reason", () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal } = linkSignals(a.signal, b.signal);
    expect(signal.aborted).toBe(false);
    b.abort("second");
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("second");
    a.abort("first");
    expect(signal.reason).toBe("second");
  });

  it("dispose() detaches from the inputs so a later abort no longer propagates", () => {
    const parent = new AbortController();
    const link = linkSignals(parent.signal);
    link.dispose();
    parent.abort();
    expect(link.signal.aborted).toBe(false);
  });

  it("gives a reason to a signal aborted without one", () => {
    const parent = new AbortController();
    parent.abort();
    const reason = abortReason(parent.signal);
    // Node attaches its own AbortError; a runtime that does not gets ours.
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).name).toBe("AbortError");
  });
});

describe("Deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts with a TimeoutError when the budget elapses and reports timedOut()", () => {
    vi.useFakeTimers();
    const deadline = new Deadline(100, new FakeClock());
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);
    vi.advanceTimersByTime(99);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as Error).name).toBe("TimeoutError");
    expect(deadline.timedOut()).toBe(true);
    deadline.dispose();
  });

  it("aborts with the parent's reason when the parent aborts first; timedOut() stays false", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = new Deadline(100, new FakeClock(), parent.signal);
    parent.abort("user left");
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("user left");
    vi.advanceTimersByTime(200);
    expect(deadline.timedOut()).toBe(false);
    deadline.dispose();
  });

  it("is aborted from the start under a pre-aborted parent and sets no timer", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    parent.abort("early");
    const deadline = new Deadline(100, new FakeClock(), parent.signal);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("early");
    expect(vi.getTimerCount()).toBe(0);
    expect(deadline.remaining()).toBe(0);
    deadline.dispose();
  });

  it("remaining() reads the injected clock and expired() follows it", () => {
    const clock = new FakeClock();
    const deadline = new Deadline(100, clock);
    expect(deadline.budgetMs).toBe(100);
    expect(deadline.remaining()).toBe(100);
    expect(deadline.expired()).toBe(false);
    clock.tick(40);
    expect(deadline.remaining()).toBe(60);
    clock.tick(60);
    expect(deadline.remaining()).toBe(0);
    expect(deadline.expired()).toBe(true);
    deadline.dispose();
  });

  it("remaining() is 0 once aborted, whatever the clock says", () => {
    const parent = new AbortController();
    const deadline = new Deadline(1_000, new FakeClock(), parent.signal);
    parent.abort();
    expect(deadline.remaining()).toBe(0);
    expect(deadline.expired()).toBe(true);
    deadline.dispose();
  });

  it("dispose() stops the timer and detaches from the parent", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = new Deadline(100, new FakeClock(), parent.signal);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(500);
    parent.abort();
    expect(deadline.signal.aborted).toBe(false);
  });

  it.each([
    [Number.NaN, 0],
    [-5, 0],
    [Number.POSITIVE_INFINITY, 0],
    [0, 0],
    [150, 150],
  ])("clamps a budget of %s to %d", (budget, expected) => {
    expect(clampBudget(budget)).toBe(expected);
    const deadline = new Deadline(budget, new FakeClock());
    expect(deadline.budgetMs).toBe(expected);
    deadline.dispose();
  });

  it("names the timeout error so a caller can test it", () => {
    const error = timeoutError(150);
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toContain("150");
  });
});

describe("raceSignal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a fulfilled promise with its value", async () => {
    await expect(raceSignal(Promise.resolve(42))).resolves.toEqual({ status: "fulfilled", value: 42 });
  });

  it("reports a rejected promise with its reason instead of rejecting", async () => {
    const reason = new Error("boom");
    await expect(raceSignal(Promise.reject(reason))).resolves.toEqual({ status: "rejected", reason });
  });

  it("reports an abort with the signal's reason and stops waiting", async () => {
    const controller = new AbortController();
    const race = raceSignal(never, { signal: controller.signal });
    controller.abort("stop");
    await expect(race).resolves.toEqual({ status: "aborted", reason: "stop" });
  });

  it("settles at once on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort("already");
    await expect(raceSignal(never, { signal: controller.signal })).resolves.toEqual({ status: "aborted", reason: "already" });
  });

  it("times out after ms", async () => {
    vi.useFakeTimers();
    const race = raceSignal(never, { ms: 50 });
    await vi.advanceTimersByTimeAsync(49);
    let settled = false;
    void race.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(race).resolves.toEqual({ status: "timeout" });
  });

  it("with ms 0 still lets an already-settled promise win, and times out a pending one", async () => {
    await expect(raceSignal(Promise.resolve("done"), { ms: 0 })).resolves.toEqual({ status: "fulfilled", value: "done" });
    await expect(raceSignal(never, { ms: 0 })).resolves.toEqual({ status: "timeout" });
  });

  it("releases the abort listener and the timer once settled", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await raceSignal(Promise.resolve(1), { signal: controller.signal, ms: 1_000 });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a promise that rejects after the race was lost is still observed", async () => {
    const controller = new AbortController();
    let reject: (e: unknown) => void = () => undefined;
    const late = new Promise<number>((_, r) => {
      reject = r;
    });
    const race = raceSignal(late, { signal: controller.signal });
    controller.abort();
    await race;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("settleWithin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the value when the promise settles in time", async () => {
    await expect(settleWithin(Promise.resolve("v"), 100, "fallback")).resolves.toBe("v");
  });

  it("resolves the fallback on timeout", async () => {
    vi.useFakeTimers();
    const settled = settleWithin(never, 20, "fallback");
    await vi.advanceTimersByTimeAsync(20);
    await expect(settled).resolves.toBe("fallback");
  });

  it("resolves the fallback on rejection and never rejects", async () => {
    await expect(settleWithin(Promise.reject(new Error("no")), 100, "fallback")).resolves.toBe("fallback");
  });

  it("waits for the promise alone when ms is not finite", async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("eventually"), 10_000));
    const settled = settleWithin(slow, Number.POSITIVE_INFINITY, "fallback");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(settled).resolves.toBe("eventually");
  });
});
