/**
 * @wisdom-graph/harness — shared wiring for the test apps.
 *
 *   const h = await createHarness();       // config + logger + store + engine + chat
 *   const recall = await h.graph.recall({ subjectId: h.cfg.subjectId, text, budgetMs: 2500 });
 *   const reply = await h.chat({ system: BASE + synthesizeSuffix(recall), messages });
 *   await h.graph.ingest({ type: "turn", ... });
 *   await h.close();
 */
export { createHarness } from "./engine";
export type { Harness, HarnessOptions } from "./engine";
export { loadConfig, hasAnthropicCredentials, REPO_ROOT, DEFAULT_CONFIG_PATH } from "./config";
export type { HarnessConfig, LogLevel, Effort } from "./config";
export { createLogger } from "./logger";
export { createStore } from "./store";
export type { HarnessStore } from "./store";
export { createLlmPort, createChat, heuristicProposal, evidenceOf, hintLinesIn } from "./llm";
export type { ChatFn, ChatArgs, OfflineProposalOp } from "./llm";
export { formatExplanation, formatRecall, formatReceipt } from "./format";
