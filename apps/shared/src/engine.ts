/**
 * engine.ts — one call that gives a test app everything: config, logger,
 * store, the WisdomGraph engine, and the chat model.
 *
 * Every app (REPL, web, MCP, LangGraph demo, simulator) starts with
 * `createHarness()`, so they all agree on identity, store file and model, and
 * a graph grown in one is visible in the others. `close()` flushes the store
 * and stops the engine's queue; call it on exit or the last ingest may be lost.
 */
import { createWisdomGraph, type ClockPort, type LlmPort, type LoggerPort, type StorePort, type WisdomGraph } from "@mosphere/wisdom-graph";
import { loadConfig, type HarnessConfig } from "./config";
import { createLogger } from "./logger";
import { createStore } from "./store";
import { createChat, createLlmPort, type ChatFn } from "./llm";

export interface Harness {
  cfg: HarnessConfig;
  logger: LoggerPort;
  store: StorePort;
  storeDescription: string;
  graph: WisdomGraph;
  chat: ChatFn;
  /** The extraction port the engine uses (Anthropic, offline heuristic, or the one passed in). */
  llm: LlmPort;
  /** Flush pending store writes (memory mode). */
  persist(): Promise<void>;
  /** Wait for queued ingests, flush, and stop timers. */
  close(): Promise<void>;
  /** One-line banner for app start-up. */
  banner(): string;
}

export interface HarnessOptions {
  config?: Partial<HarnessConfig>;
  /** Process ingests inline (serverless-style) so a receipt means "done". Default true: test apps want determinism. */
  inline?: boolean;
  /** Injected clock (the simulator advances days); default: the system clock. */
  clock?: ClockPort;
  /** Replace the extraction model (the simulator scripts proposals); default: Anthropic or the offline heuristic per config. */
  llm?: LlmPort;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const cfg = loadConfig(opts.config);
  const logger = createLogger(cfg.logLevel);
  const hs = await createStore(cfg, logger, opts.clock);
  const llm = opts.llm ?? createLlmPort(cfg, logger);
  const graph = createWisdomGraph({
    store: hs.store,
    categories: cfg.categories,
    llm,
    logger,
    ...(opts.clock ? { clock: opts.clock } : {}),
    tenantId: cfg.tenantId,
    sharedSubjectId: cfg.sharedSubjectId,
    policy: cfg.policy,
    queue: { inline: opts.inline ?? true },
  });
  const chat = createChat(cfg);
  return {
    cfg,
    logger,
    llm,
    store: hs.store,
    storeDescription: hs.describe,
    graph,
    chat,
    persist: () => hs.persist(),
    close: async () => {
      await graph.close();
      await hs.close();
    },
    banner: () =>
      `wisdom-graph harness · subject=${cfg.subjectId}${cfg.clientId ? ` client=${cfg.clientId}` : ""} · store=${hs.describe} · model=${cfg.offline ? "offline" : `${cfg.model} (${cfg.effort})`} · categories=${cfg.categories.map((c) => c.name).join(",")}`,
  };
}
