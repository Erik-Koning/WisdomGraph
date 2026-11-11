/**
 * langgraph/inject.ts — the three injection sites, and two shapes for
 * frameworks that own the prompt.
 *
 * The host app has three string-concatenation sites and no prompt abstraction
 * (requirements.md): the router prompt at START, the specialist preamble in
 * the MIDDLE, the synthesizer prompt at the END. Each helper here is the one
 * expression that site adds — `ROUTER_PROMPT + systemPromptPrefix(recall)` —
 * and returns `""` when its lane is empty, so the site needs no guard and a
 * turn without hints renders the prompt it always did.
 *
 * They render through the compiler in `core/recall/compile.ts`, on the lanes
 * the assembler built (`recall.preRoute`, `recall.agentHints[agent]`,
 * `recall.responseStyle`) rather than by re-deriving a lane from the charter:
 * the buckets already honour the engine's own caps, and the agent bucket
 * carries the mirrored `responseStyle` hints that keep a single-consult turn
 * — the one that skips `synthesize` — in the advisor's voice (§4.2 step 6,
 * decision 5). `nodePreamble` for an agent with no bucket serves
 * `recall.agentDefaults` for the same reason: the router, not the
 * classifier, decided which specialist runs. Either way the output is
 * byte-for-byte what `graph.compile(recall.charter, lane, { agent })`
 * renders, so a consumer may wire any site through either path.
 *
 * `charterMessages` and `createPromptDecorator` are the same renderers in
 * the shapes deep-agents middleware and a `messages` reducer want: plain
 * `{ role: "system", content }` objects with no class behind them, and an
 * async `(systemPrompt) => systemPrompt + block` that awaits Lane B itself.
 * An empty lane gives `[]` and the prompt unchanged, respectively.
 *
 * None of these touch the user's `HumanMessage`: the consumer replays the
 * thread from checkpoints every turn, so a rewritten query would be
 * replayed forever. Hints augment prompts; they never edit history.
 */

import type { CompileOptions, HintLane, Recall } from "../core/types";
import { compileAgentPreamble, compileCharter, compilePreRoute, compileResponseStyle } from "../core/recall/compile";
import type { RecallScope } from "./scope";

/** START (`router.ts`): the `preRoute` lane — query-shaping rules — or `""`. */
export function systemPromptPrefix(recall: Recall, opts: CompileOptions = {}): string {
  return compilePreRoute(recall, opts);
}

/** MIDDLE (`invocation.ts`): `agentHints[agent]`, or `agentDefaults` when the agent has no bucket, or `""`. */
export function nodePreamble(recall: Recall, agent: string, opts: CompileOptions = {}): string {
  return compileAgentPreamble(recall, agent, opts);
}

/** END (`synthesize.ts`): the `responseStyle` lane — the final voice — or `""`. */
export function synthesizeSuffix(recall: Recall, opts: CompileOptions = {}): string {
  return compileResponseStyle(recall, opts);
}

/**
 * One lane as text. The agent lane without an agent name is the charter's
 * whole agent lane — every agent-lane entry, whoever it is addressed to —
 * which is what a middleware that does not know its specialist's name can
 * sensibly render.
 */
function renderLane(recall: Recall, lane: HintLane, agent: string | undefined, opts: CompileOptions): string {
  switch (lane) {
    case "preRoute":
      return systemPromptPrefix(recall, opts);
    case "responseStyle":
      return synthesizeSuffix(recall, opts);
    case "agent":
      return agent === undefined ? compileCharter(recall.charter, "agent", opts).text : nodePreamble(recall, agent, opts);
  }
}

/** A system message as any `messages` reducer accepts it: a plain object, no class. */
export type CharterMessage = { role: "system"; content: string };

/** Spec §8.3: the lane as `[{ role: "system", content }]`, or `[]` when it is empty. */
export function charterMessages(recall: Recall, lane: HintLane, agent?: string, opts: CompileOptions = {}): CharterMessage[] {
  const content = renderLane(recall, lane, agent, opts);
  return content === "" ? [] : [{ role: "system", content }];
}

/**
 * Spec §8.3: a decorator that awaits `scope.laneB(opts.ms)` and appends the
 * lane's block to the prompt, separated by a blank line so the block's
 * opening tag starts its own line. Outside a scope, or with an empty lane,
 * the prompt comes back unchanged.
 */
export function createPromptDecorator(
  scope: RecallScope,
  lane: HintLane,
  agent?: string,
  opts: CompileOptions & { ms?: number } = {},
): (systemPrompt: string) => Promise<string> {
  const { ms, ...compile } = opts;
  return async (systemPrompt: string): Promise<string> => {
    const recall = await scope.laneB(ms);
    const block = renderLane(recall, lane, agent, compile);
    if (block === "") return systemPrompt;
    return systemPrompt === "" ? block : `${systemPrompt}\n\n${block}`;
  };
}
