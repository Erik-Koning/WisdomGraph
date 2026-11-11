/**
 * models.ts — the LangChain chat model the graph nodes call.
 *
 *   online   `new ChatAnthropic({ model: cfg.model })` — the real thing.
 *   offline  `HintReportingChatModel`, a deterministic `BaseChatModel` whose
 *            reply reports how many `<<wisdom-hints …>>` blocks and bullet
 *            lines it found in its own system prompt. That number is what a
 *            tester watches change after `/remember`: it proves the hints
 *            reached the prompt of the node that produced the answer.
 *
 * The harness's `h.chat` is deliberately not used here — this app exists to
 * show the library's langgraph adapter working against real LangChain
 * message objects and a real `BaseChatModel`, so the models are LangChain's.
 *
 * `FakeListChatModel` from `@langchain/core/utils/testing` ignores its input
 * entirely (its `_generate` takes `_messages`), so it cannot report what was
 * injected; the fake here is a minimal `BaseChatModel` subclass instead. It
 * sleeps a little so the fan-out path visibly overlaps in `/route`.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { hintLinesIn, type Harness } from "@wisdom-graph/harness";

export interface DemoModels {
  kind: "anthropic" | "fake";
  /** One model serves router, specialists and synthesizer; the prompts differ, not the weights. */
  model: BaseChatModel;
  /** For the start-up banner. */
  describe: string;
}

/** Count `<<wisdom-hints` openings in a prompt: one per rendered lane. */
export function hintBlocksIn(prompt: string): number {
  return (prompt.match(/<<wisdom-hints\b/g) ?? []).length;
}

/**
 * A deterministic chat model for offline runs. Reads the system message(s)
 * it is given, counts the wisdom-hints blocks and bullets, and echoes the
 * last human message so the transcript shows what each node was asked.
 */
export class HintReportingChatModel extends BaseChatModel {
  private readonly sleepMs: number;

  constructor(opts: { sleepMs?: number } = {}) {
    super({});
    this.sleepMs = opts.sleepMs ?? 120;
  }

  _llmType(): string {
    return "wisdom-hint-reporting-fake";
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const system = messages.filter((m) => m._getType() === "system").map((m) => m.text).join("\n");
    const blocks = hintBlocksIn(system);
    const hints = hintLinesIn(system);
    const lastHuman = [...messages].reverse().find((m) => m._getType() === "human")?.text ?? "";
    if (this.sleepMs > 0) await new Promise((r) => setTimeout(r, this.sleepMs));
    const lines = [
      `(fake model) my system prompt carries ${blocks} <<wisdom-hints>> block${blocks === 1 ? "" : "s"} and ${hints.length} hint line${hints.length === 1 ? "" : "s"}.`,
      ...hints.map((h) => `  • ${h}`),
      `You asked: ${lastHuman.replace(/\s+/g, " ").slice(0, 160)}`,
    ];
    const text = lines.join("\n");
    return { generations: [{ text, message: new AIMessage(text) }] };
  }
}

export function createModels(h: Harness): DemoModels {
  if (h.cfg.offline) {
    return {
      kind: "fake",
      model: new HintReportingChatModel(),
      describe: "fake (HintReportingChatModel — replies count the <<wisdom-hints>> blocks in their system prompt; set ANTHROPIC_API_KEY or run `ant auth login` for ChatAnthropic)",
    };
  }
  return {
    kind: "anthropic",
    model: new ChatAnthropic({ model: h.cfg.model }),
    describe: `ChatAnthropic ${h.cfg.model}`,
  };
}
