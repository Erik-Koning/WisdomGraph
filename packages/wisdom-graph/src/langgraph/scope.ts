/**
 * langgraph/scope.ts — two lanes, one request.
 *
 * The consumer's integration plan (requirements.md) starts one recall per
 * turn before `graph.invoke`, races it at 150 ms for the router prompt and
 * again with the remaining budget deep inside the graph, where the consult
 * nodes and the synthesizer build their prompts. Those sites are ordinary
 * functions with no handle on the request, so the recall promise travels
 * the way the consumer already moves identity and model choice through a
 * LangGraph run: an `AsyncLocalStorage`. A node that is added to the graph
 * instead would sit behind the superstep barrier and a slow store would
 * block the whole turn; a promise in ALS blocks nothing until a site awaits
 * it, and each site awaits with its own budget and its own fallback.
 *
 * The handle carries two promises, not a `Recall` with a promise inside it
 * (decision 3): a `Recall` is a frozen, serialisable value that fan-out nodes
 * read concurrently, so the "maybe better later" result lives beside it as
 * `refined`, produced by `graph.refine` once the base has landed. Both
 * promises are guarded here so that neither can reject — the graph promises
 * as much for `recall`, but the consumer may hand in any object that looks
 * like a graph, and a prompt site must never see a throw.
 *
 * `laneA` is `settleWithin(base, 150 ms, empty)`. `laneB` waits on
 * `refined ?? base` for the budget that is left, and when the refinement is
 * late but the base is in, takes the base: a plain recall now beats a
 * re-ranked one the prompt cannot wait for. Outside any scope both lanes
 * resolve to an empty recall, which is what makes every site safe to call
 * unconditionally — behind a feature flag, in a test, in a path that never
 * started a turn.
 *
 * Identity always arrives in the request (must-have 5). The scope stores a
 * handle the consumer built from an explicit `subjectId`; it never reads
 * the subject id from ALS or anywhere else, and it never writes.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { noopLogger, systemClock, type ClockPort, type LoggerPort } from "../core/ports";
import type { Recall, RecallRequest, WisdomGraph } from "../core/types";
import { clampBudget, raceSignal, settleWithin } from "../core/recall/deadline";
import { emptyRecall } from "../core/recall/recall";

/** Spec §8.2: the Lane A race the router prompt waits for. */
export const LANE_A_DEFAULT_MS = 150;

/** Spec §2.9: what one turn's recall looks like from inside the graph. Plain, so a consumer can build one by hand. */
export interface RecallHandle {
  request: RecallRequest;
  base: Promise<Recall>;
  refined?: Promise<Recall>;
  startedAt: number;
}

export interface StartTurnRecallOptions {
  /** Chain `graph.refine` after the base recall; `laneB` prefers its result when it lands in time. */
  refine?: boolean;
  logger?: LoggerPort;
  /** Stamps `startedAt`; give the scope the same clock so `laneB`'s remaining budget is measured on it. */
  clock?: ClockPort;
}

export interface RecallScope {
  run<T>(handle: RecallHandle, fn: () => T): T;
  current(): RecallHandle | undefined;
  /** Default 150 ms: the base promise raced; `emptyRecall` on timeout or outside a scope. */
  laneA(ms?: number): Promise<Recall>;
  /** Default `budgetMs − elapsed`: `refined ?? base` raced; the settled base when the refinement is late; `emptyRecall` otherwise. */
  laneB(ms?: number): Promise<Recall>;
}

export interface RecallScopeOptions {
  /** The clock `laneB` measures elapsed time on; defaults to the system clock, which is also `startTurnRecall`'s default. */
  clock?: ClockPort;
}

function describeError(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Structurally a `Recall`: the fields every injection helper reads. A graph
 * that resolves to anything else is treated as having failed, so the
 * promises on the handle only ever carry values the helpers can render.
 */
function isRecall(value: unknown): value is Recall {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.preRoute) &&
    Array.isArray(r.responseStyle) &&
    Array.isArray(r.provenance) &&
    typeof r.agentHints === "object" &&
    r.agentHints !== null &&
    typeof r.charter === "object" &&
    r.charter !== null &&
    typeof r.meta === "object" &&
    r.meta !== null &&
    typeof r.topic === "object" &&
    r.topic !== null
  );
}

/**
 * `fn()` as a promise that cannot reject and only resolves to a `Recall`: a
 * synchronous throw, a rejection and a malformed value all settle to what
 * `onFailure` returns for them.
 */
function guarded(fn: () => Promise<Recall>, onFailure: (e: unknown) => Recall): Promise<Recall> {
  try {
    return Promise.resolve(fn()).then(
      (value) => (isRecall(value) ? value : onFailure(new TypeError("graph resolved to something that is not a Recall"))),
      (e: unknown) => onFailure(e),
    );
  } catch (e) {
    return Promise.resolve(onFailure(e));
  }
}

/**
 * Spec §8.2. Starts `graph.recall(req)` now and, with `refine`, chains
 * `graph.refine` on its result. `refine` is chained whenever asked for: the
 * graph itself is the authority on whether it can improve a recall, and it
 * returns the input unchanged — at once — when it has no embeddings, so the
 * adapter does not reach into the engine to find out. Failures at either
 * stage are logged and settle to the best value available (an empty recall,
 * then the base); neither promise ever rejects.
 */
export function startTurnRecall(graph: WisdomGraph, req: RecallRequest, opts: StartTurnRecallOptions = {}): RecallHandle {
  const logger = opts.logger ?? noopLogger;
  const clock = opts.clock ?? systemClock;
  const startedAt = clock.now();
  const failed = (stage: "recall" | "refine", e: unknown, value: Recall): Recall => {
    logger.warn({ subjectId: req?.subjectId, requestId: req?.requestId, stage, error: describeError(e) }, `langgraph.${stage}.failed`);
    return value;
  };
  const base = guarded(
    () => graph.recall(req),
    (e) => failed("recall", e, emptyRecall(req, "error")),
  );
  const handle: RecallHandle = { request: req, base, startedAt };
  if (opts.refine === true) {
    const signal = req?.signal;
    handle.refined = base.then((r) =>
      guarded(
        () => graph.refine(r, req, signal !== undefined ? { signal } : {}),
        (e) => failed("refine", e, r),
      ),
    );
  }
  return handle;
}

/** What is left of the request's budget, measured on `clock` from the handle's `startedAt`; never negative, 0 when unmeasurable. */
function remainingBudget(handle: RecallHandle, clock: ClockPort): number {
  const budget = clampBudget(handle.request?.budgetMs);
  return clampBudget(budget - (clock.now() - handle.startedAt));
}

/** Spec §2.9. One `AsyncLocalStorage<RecallHandle>` and the two lanes over it. */
export function createRecallScope(opts: RecallScopeOptions = {}): RecallScope {
  const clock = opts.clock ?? systemClock;
  const storage = new AsyncLocalStorage<RecallHandle>();

  const laneA = async (ms: number = LANE_A_DEFAULT_MS): Promise<Recall> => {
    const handle = storage.getStore();
    if (handle === undefined) return emptyRecall();
    return settleWithin(handle.base, ms, emptyRecall(handle.request, "budget"));
  };

  const laneB = async (ms?: number): Promise<Recall> => {
    const handle = storage.getStore();
    if (handle === undefined) return emptyRecall();
    const outcome = await raceSignal(handle.refined ?? handle.base, { ms: ms ?? remainingBudget(handle, clock) });
    if (outcome.status === "fulfilled") return outcome.value;
    // The refinement was late or failed: the base if it has settled (one microtask turn), else empty.
    return settleWithin(handle.base, 0, emptyRecall(handle.request, "budget"));
  };

  return {
    run: (handle, fn) => storage.run(handle, fn),
    current: () => storage.getStore(),
    laneA,
    laneB,
  };
}
