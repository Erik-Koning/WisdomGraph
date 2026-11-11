/**
 * langgraph/ — the subpath `@mosphere/wisdom-graph/langgraph`.
 *
 * The adapter for a LangChain / LangGraph / deep-agents host, built without
 * importing any of them (must-have 1): messages are read structurally, the
 * per-turn recall rides an `AsyncLocalStorage` through the graph, and the
 * three injection sites get one string helper each. `node:async_hooks` is
 * the only thing this subpath needs beyond `core/`, which is why it is a
 * subpath of its own rather than part of the portable root.
 *
 * Exports are curated to spec §2.9 and `surface.test.ts` pins them.
 * `settleWithin` and `emptyRecall` are re-exported so a consumer wiring the
 * two lanes by hand has the same primitives the scope uses without a second
 * import path. `LANE_A_DEFAULT_MS` and the lane renderer stay internal.
 */

// ── Messages (§8.1) ──────────────────────────────────────────────────────────
export { toNeutralMessage, toNeutralMessages, lastUserText } from "./messages";
export type { MessageLike } from "./messages";

// ── Scope and lanes (§8.2) ───────────────────────────────────────────────────
export { createRecallScope, startTurnRecall } from "./scope";
export type { RecallHandle, RecallScope, RecallScopeOptions, StartTurnRecallOptions } from "./scope";

// ── Injection helpers (§8.3) ─────────────────────────────────────────────────
export { systemPromptPrefix, nodePreamble, synthesizeSuffix, charterMessages, createPromptDecorator } from "./inject";
export type { CharterMessage } from "./inject";

// ── Core primitives the lanes are built on (§2.9) ────────────────────────────
export { settleWithin, emptyRecall } from "../core";
export type { NeutralMessage, Recall, RecallRequest, HintLane, CompileOptions, WisdomGraph, LoggerPort, ClockPort } from "../core";
