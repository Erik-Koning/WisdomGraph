/**
 * ingest/queue.ts — the in-process scheduler behind `ingest()`.
 *
 * Spec §5: the event row is the durability, the queue is only the
 * scheduler. That one sentence decides everything about this class. It
 * holds no event, only a closure that will *attempt* one; it never persists
 * anything; and losing it (a crash, a `close()`) loses no work, because the
 * rows it was going to run are still `pending` or `failed` in the store for
 * `drain()` to pick up. So it can afford to be simple, and it is: one FIFO
 * lane per subject, a global running count, and a set of timers.
 *
 * Three rules are load-bearing:
 *
 *   - **One job per subject at a time.** Two events for the same advisor
 *     both read a snapshot, plan against it and write with `expectVersion`;
 *     run concurrently, the second would always conflict and retry. Serial
 *     per subject makes the common case conflict-free, while different
 *     subjects still run in parallel up to `concurrency`.
 *   - **A job waiting on a timer holds nothing.** An attempt may ask to run
 *     again later — a backoff after a failure, or a feedback event whose
 *     turn has not arrived (§5.4). While it waits it is out of its subject's
 *     lane, so the turn it is waiting for can be processed in the meantime;
 *     when the timer fires it re-joins the back of the lane. A waiting job
 *     that held the lane would wait for the very event it blocks.
 *   - **`close()` stops everything that has not started.** Retry timers
 *     are cancelled and jobs waiting for a slot are dropped, both answered
 *     `cancelled` — their rows are still `pending` or `failed` with a
 *     `retry_at` in the store, so `drain()` on the next start finds them —
 *     and no new job is accepted. Only jobs already in flight run to their
 *     result (a job that then asks to retry is `cancelled` too), so the
 *     cost of a shutdown is bounded by `concurrency` running attempts, not
 *     by the backlog. Timers are `unref`'d where the runtime allows so a
 *     queue with a retry pending never keeps a process alive on its own.
 *
 * `maxPending` bounds what this process will hold, not what it will accept:
 * an overflowing `enqueue` is refused and the caller leaves the row
 * `pending` for `drain()` (§5.1 step 4). Nothing is dropped.
 */

/**
 * Defaults for `WisdomGraphOptions.queue` (spec §2.7). `maxAttempts` counts
 * retries after the first attempt, one per step of `backoffMs`: the spec
 * pairs 3 with a three-step schedule, and this is the reading under which
 * every step is used and a row fails after 1 s, 4 s and 16 s (§5.2).
 */
export const QUEUE_DEFAULTS = Object.freeze({
  concurrency: 4,
  maxAttempts: 3,
  backoffMs: Object.freeze([1_000, 4_000, 16_000]) as readonly number[],
  maxPending: 1_000,
  inline: false,
});

export interface SubjectQueueOptions {
  /** Jobs running at once across all subjects; default 4. */
  concurrency?: number;
  /** Jobs held (waiting, running or on a timer) before `enqueue` refuses; default 1 000. */
  maxPending?: number;
}

/**
 * What one attempt reports back. `retry` asks to run again after `delayMs`;
 * `reason` says why, for the caller's counters. `skipped` is a row another
 * worker holds; `not-due` a row whose `retry_at` has not passed on the
 * caller's clock — the timers here are wall-clock (`setTimeout`), the
 * ledger's `retry_at` is compared on the injected clock, and when the two
 * disagree the row is left for `drain()` rather than misreported.
 */
export type AttemptResult =
  | { kind: "done" }
  | { kind: "failed" }
  | { kind: "skipped" }
  | { kind: "not-due" }
  | { kind: "retry"; delayMs: number; reason: "backoff" | "deferred" };

/** How a job ended: the last attempt's word, or `cancelled` when `close()` dropped it before it ran (or ran again). */
export type JobOutcome = "done" | "failed" | "skipped" | "not-due" | "cancelled";

export type Attempt = () => Promise<AttemptResult>;

export type Enqueued = { accepted: true; outcome: Promise<JobOutcome> } | { accepted: false; reason: "overflow" | "closed" };

interface Job {
  key: string;
  attempt: Attempt;
  settle: (outcome: JobOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Lane {
  /** A job of this lane is running. */
  active: boolean;
  /** The lane is in `ready`, waiting for a running slot. */
  queued: boolean;
  waiting: Job[];
}

/** A positive integer or the default: a caller cannot configure the queue away by mistake. */
function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Let a timer not hold the process open where the runtime supports it; a no-op elsewhere. */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle: unknown = timer;
  if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") handle.unref();
}

export class SubjectQueue {
  readonly concurrency: number;
  readonly maxPending: number;
  private readonly lanes = new Map<string, Lane>();
  /** Subject keys with a waiting job and no running one, in arrival order. */
  private readonly ready: string[] = [];
  private readonly timers = new Set<Job>();
  private readonly idlers: (() => void)[] = [];
  private active = 0;
  private tracked = 0;
  private closed = false;

  constructor(opts: SubjectQueueOptions = {}) {
    this.concurrency = positiveInt(opts.concurrency, QUEUE_DEFAULTS.concurrency);
    this.maxPending = nonNegativeInt(opts.maxPending, QUEUE_DEFAULTS.maxPending);
  }

  /** Jobs held: waiting, running, or on a timer. */
  get depth(): number {
    return this.tracked;
  }

  /** Jobs running right now. */
  get running(): number {
    return this.active;
  }

  /** Jobs waiting on a retry timer. */
  get scheduled(): number {
    return this.timers.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Hold `attempt` for `key`'s lane. Refused after `close()` or when
   * `maxPending` jobs are already held; accepted otherwise, with a promise
   * of how the job ends. The promise never rejects: an attempt that throws
   * counts as `failed`.
   */
  enqueue(key: string, attempt: Attempt): Enqueued {
    if (this.closed) return { accepted: false, reason: "closed" };
    if (this.tracked >= this.maxPending) return { accepted: false, reason: "overflow" };
    let settle: (outcome: JobOutcome) => void = () => undefined;
    const outcome = new Promise<JobOutcome>((resolve) => {
      settle = resolve;
    });
    this.tracked += 1;
    this.admit({ key, attempt, settle });
    return { accepted: true, outcome };
  }

  /** Resolves once no job is held — waiting, running or on a timer. Never rejects. */
  idle(): Promise<void> {
    if (this.tracked === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idlers.push(resolve);
    });
  }

  /**
   * Refuse new jobs, stop every retry timer and drop every job still
   * waiting for a slot — all of those end `cancelled`, with their rows left
   * in the store for `drain()`. Only jobs in flight keep running; `close()`
   * on the engine awaits `idle()` afterwards, which is what "flush" means
   * once nothing else can start.
   */
  close(): void {
    this.closed = true;
    for (const job of this.timers) {
      if (job.timer !== undefined) clearTimeout(job.timer);
      job.timer = undefined;
      this.finish(job, "cancelled");
    }
    this.timers.clear();
    this.ready.length = 0;
    for (const [key, lane] of this.lanes) {
      lane.queued = false;
      const waiting = lane.waiting.splice(0);
      for (const job of waiting) this.finish(job, "cancelled");
      if (!lane.active) this.lanes.delete(key);
    }
  }

  private admit(job: Job): void {
    let lane = this.lanes.get(job.key);
    if (lane === undefined) {
      lane = { active: false, queued: false, waiting: [] };
      this.lanes.set(job.key, lane);
    }
    lane.waiting.push(job);
    if (!lane.active && !lane.queued) {
      lane.queued = true;
      this.ready.push(job.key);
    }
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const key = this.ready.shift();
      if (key === undefined) return;
      const lane = this.lanes.get(key);
      if (lane === undefined) continue;
      lane.queued = false;
      const job = lane.waiting.shift();
      if (job === undefined) continue;
      lane.active = true;
      this.active += 1;
      void this.run(lane, job);
    }
  }

  private async run(lane: Lane, job: Job): Promise<void> {
    let result: AttemptResult;
    try {
      result = await job.attempt();
    } catch {
      result = { kind: "failed" };
    }
    this.active -= 1;
    lane.active = false;
    if (lane.waiting.length > 0) {
      lane.queued = true;
      this.ready.push(job.key);
    } else if (this.lanes.get(job.key) === lane) this.lanes.delete(job.key);

    if (result.kind === "retry") {
      if (this.closed) this.finish(job, "cancelled");
      else this.schedule(job, result.delayMs);
    } else this.finish(job, result.kind);
    this.pump();
  }

  private schedule(job: Job, delayMs: number): void {
    const timer = setTimeout(
      () => {
        this.timers.delete(job);
        job.timer = undefined;
        this.admit(job);
      },
      Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0,
    );
    unrefTimer(timer);
    job.timer = timer;
    this.timers.add(job);
  }

  private finish(job: Job, outcome: JobOutcome): void {
    this.tracked -= 1;
    job.settle(outcome);
    if (this.tracked === 0) {
      const idlers = this.idlers.splice(0);
      for (const resolve of idlers) resolve();
    }
  }
}
