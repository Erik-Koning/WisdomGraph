/**
 * recall/deadline.ts — the time-and-cancellation primitives behind "never
 * rejects, always honours the budget".
 *
 * Must-have 2 makes recall a promise the consumer can race at 150 ms and
 * again at 2.5 s and never has to guard with a `catch`. Everything that
 * makes that true is one of four small helpers here, and they are hand-
 * rolled rather than built on `AbortSignal.any` / `AbortSignal.timeout`
 * (decision 20): core/ is meant to be copied into any runtime, the composite
 * is twenty lines, and owning it means the abort *reason* is ours — which is
 * how a caller tells "the user hung up" from "the store was slow".
 *
 *   - `linkSignals` is the composite: one signal that aborts when any input
 *     does, with the first input's reason, and `dispose()` so a long-lived
 *     parent signal does not accumulate a listener per request.
 *   - `Deadline` is a budget as a signal. It aborts on the parent or when the
 *     budget elapses, and reports which; `remaining()` reads the injected
 *     clock so the pipeline's "is there time left for the shared subject /
 *     the embedding step" decisions are reproducible under a `FakeClock`,
 *     while the abort itself rides a real timer so a hung port is actually
 *     interrupted.
 *   - `raceSignal` turns a promise into a *tagged outcome* — fulfilled,
 *     rejected, aborted, or timed out — and never rejects. The tag, not the
 *     order two callbacks happened to run in, is what the pipeline maps to
 *     `meta.reason`, so the same race gives the same answer every time.
 *   - `settleWithin` is the public, simplest form (spec §2.8): the value or
 *     a fallback, whether the promise was slow or failed.
 *
 * None of them cancel the underlying promise. A store cannot cancel a running
 * statement (§7.3), so a race is what "honouring the budget" means; the
 * promise that lost is left to finish and, in the cache's case, to warm the
 * next request.
 */

import type { ClockPort } from "../ports";

/** The reason a `Deadline` aborts with when its budget elapses; `name` is what a caller should test. */
export function timeoutError(budgetMs: number): Error {
  const error = new Error(`deadline of ${budgetMs} ms exceeded`);
  error.name = "TimeoutError";
  return error;
}

/** The reason an aborted signal carries, or a generic AbortError when the runtime gave it none. */
export function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * One signal that aborts when any of `signals` does (an input that is
 * already aborted aborts it at once, with that input's reason). `dispose()`
 * detaches from every input; call it when the composite is no longer needed
 * so a request-scoped composite does not outlive the request on a
 * long-lived parent.
 */
export function linkSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const attached: { signal: AbortSignal; onAbort: () => void }[] = [];
  const dispose = (): void => {
    for (const { signal, onAbort } of attached) signal.removeEventListener("abort", onAbort);
    attached.length = 0;
  };
  for (const signal of signals) {
    if (signal === undefined) continue;
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      break;
    }
    const onAbort = (): void => {
      controller.abort(abortReason(signal));
      dispose();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    attached.push({ signal, onAbort });
  }
  if (controller.signal.aborted) dispose();
  return { signal: controller.signal, dispose };
}

/** Non-finite or negative budgets read as 0: a budget that cannot be honoured is no budget. */
export function clampBudget(budgetMs: number): number {
  return Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
}

/**
 * A budget as an `AbortSignal`. Aborts when `parent` aborts (with its
 * reason) or when `budgetMs` elapses on a real timer (with a
 * `TimeoutError`); `timedOut` says which. `remaining()` is measured on the
 * injected clock and drops to 0 the moment the signal aborts for any reason.
 */
export class Deadline {
  readonly signal: AbortSignal;
  readonly budgetMs: number;
  private readonly clock: ClockPort;
  private readonly endsAt: number;
  private readonly controller: AbortController;
  private readonly link: { signal: AbortSignal; dispose(): void };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private elapsed = false;

  constructor(budgetMs: number, clock: ClockPort, parent?: AbortSignal) {
    this.budgetMs = clampBudget(budgetMs);
    this.clock = clock;
    this.endsAt = clock.now() + this.budgetMs;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.link = linkSignals(parent);
    const linked = this.link.signal;
    if (linked.aborted) {
      this.controller.abort(abortReason(linked));
    } else {
      linked.addEventListener(
        "abort",
        () => {
          this.clearTimer();
          this.controller.abort(abortReason(linked));
        },
        { once: true },
      );
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.signal.aborted) return;
        this.elapsed = true;
        this.controller.abort(timeoutError(this.budgetMs));
      }, this.budgetMs);
    }
  }

  /** Milliseconds left on the clock, never negative; 0 once aborted. */
  remaining(): number {
    if (this.signal.aborted) return 0;
    return Math.max(0, this.endsAt - this.clock.now());
  }

  /** True once the signal has aborted or the clock has passed the budget. */
  expired(): boolean {
    return this.signal.aborted || this.clock.now() >= this.endsAt;
  }

  /** True when the abort came from the budget's own timer, not the parent. */
  timedOut(): boolean {
    return this.elapsed;
  }

  /** Stop the timer and detach from the parent. The signal stays as it is. */
  dispose(): void {
    this.clearTimer();
    this.link.dispose();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** What became of a promise raced against a signal and/or a timer. */
export type Outcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "aborted"; reason: unknown }
  | { status: "timeout" };

/**
 * Race `p` against `opts.signal` and/or a timer of `opts.ms`; resolve with a
 * tagged outcome and never reject. An already-aborted signal settles at once.
 * A non-positive `ms` gives `p` one microtask turn — a promise that has
 * already settled still wins, which is what lets a zero budget serve a
 * cache hit — and `ms` undefined or non-finite means no timer. Listeners
 * and the timer are released on settle.
 */
export function raceSignal<T>(p: Promise<T>, opts: { signal?: AbortSignal; ms?: number } = {}): Promise<Outcome<T>> {
  return new Promise<Outcome<T>>((resolve) => {
    const { signal } = opts;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const onAbort = (): void => settle({ status: "aborted", reason: signal === undefined ? undefined : abortReason(signal) });
    const settle = (outcome: Outcome<T>): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    // The promise is observed before any early exit so a rejection is never unhandled.
    p.then(
      (value) => settle({ status: "fulfilled", value }),
      (reason: unknown) => settle({ status: "rejected", reason }),
    );
    if (signal?.aborted) {
      settle({ status: "aborted", reason: abortReason(signal) });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.ms !== undefined && Number.isFinite(opts.ms)) {
      if (opts.ms <= 0) void Promise.resolve().then(() => settle({ status: "timeout" }));
      else timer = setTimeout(() => settle({ status: "timeout" }), opts.ms);
    }
  });
}

/**
 * Spec §2.8: the value of `p`, or `fallback` when `p` rejects or has not
 * settled after `ms`. Never rejects. A non-finite `ms` waits for `p` alone.
 */
export async function settleWithin<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  const outcome = await raceSignal(p, { ms: Number.isFinite(ms) ? Math.max(0, ms) : undefined });
  return outcome.status === "fulfilled" ? outcome.value : fallback;
}
