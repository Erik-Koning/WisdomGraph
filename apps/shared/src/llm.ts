/**
 * llm.ts — the two model roles the test apps need, each with an offline twin.
 *
 *   LlmPort  — what the library calls from ingest() to extract preferences
 *              (and from the consolidation pass). Anthropic-backed, or a
 *              heuristic that turns obvious phrasings ("shorter answers",
 *              "no disclaimers", "call me Erik") into canonical proposals so
 *              the whole capture → recall → render loop can be exercised with
 *              no API key at all.
 *   ChatFn   — the assistant the user talks to. Anthropic-backed with
 *              streaming, or an echo that reports how many hints it found in
 *              its own system prompt — which is exactly the thing a tester
 *              wants to see change as the graph evolves.
 *
 * The extractor prompt is the library's; we only read the fenced evidence out
 * of it (`<<user-text>> … <</user-text>>`) for the heuristic. The real model
 * sees the full prompt.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { HintKind, HintLane, LlmPort, LoggerPort, NeutralMessage } from "@mosphere/wisdom-graph";
import type { HarnessConfig } from "./config";

// ── Extraction port ─────────────────────────────────────────────────────────

export function createLlmPort(cfg: HarnessConfig, logger: LoggerPort): LlmPort {
  if (cfg.offline) return offlineLlmPort(logger);
  const client = new Anthropic();
  return {
    async complete(prompt, opts) {
      const started = Date.now();
      const res = await client.messages.create(
        {
          model: cfg.model,
          max_tokens: opts.maxTokens ?? 1500,
          output_config: { effort: cfg.effort },
          messages: [{ role: "user", content: prompt }],
        },
        opts.signal ? { signal: opts.signal } : undefined,
      );
      if (res.stop_reason === "refusal") {
        throw new Error(`model refused (${res.stop_details?.category ?? "unknown"})`);
      }
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      logger.debug?.({ purpose: opts.purpose, ms: Date.now() - started, chars: text.length }, "llm.complete");
      return text;
    },
  };
}

// ── Offline extractor ───────────────────────────────────────────────────────

interface Rule {
  test: RegExp;
  slot: string;
  value: string | ((m: RegExpMatchArray) => string);
  text: string | ((m: RegExpMatchArray) => string);
  lane: HintLane;
  kind: HintKind;
}

/** Obvious phrasings → canonical statements. Order matters: first match per slot wins. */
const RULES: Rule[] = [
  { test: /\b(shorter|briefer|brief|concise|too long|keep it short|less verbose)\b/i, slot: "format.length", value: "short", text: "Keeps answers short and to the point.", lane: "responseStyle", kind: "style" },
  { test: /\b(more detail|detailed|elaborate|in depth|longer answers)\b/i, slot: "format.length", value: "detailed", text: "Prefers detailed explanations with the reasoning shown.", lane: "responseStyle", kind: "style" },
  { test: /\bbullet/i, slot: "format.lists", value: "bullets", text: "Prefers bullet points over prose.", lane: "responseStyle", kind: "style" },
  { test: /\b(no|avoid|skip|without|stop using) (bullet|lists?)\b/i, slot: "format.lists", value: "prose", text: "Prefers prose over bullet lists.", lane: "responseStyle", kind: "style" },
  { test: /\btables?\b/i, slot: "format.tables", value: "tables", text: "Prefers tables for comparisons.", lane: "responseStyle", kind: "style" },
  { test: /\b(no|skip|omit|without|stop( adding)?|drop) (the )?(disclaimers?|caveats?|warnings?)\b/i, slot: "disclaimers", value: "omit", text: "Omits disclaimers unless asked for them.", lane: "agent", kind: "constraint" },
  { test: /\b(no|avoid|skip|without|stop using) (the )?emojis?\b/i, slot: "format.emoji", value: "none", text: "Avoids emoji.", lane: "responseStyle", kind: "style" },
  { test: /\bcanad(a|ian)\b/i, slot: "region.default", value: "ca", text: "Assumes a Canadian context by default.", lane: "preRoute", kind: "fact" },
  { test: /\b(metric|celsius|kilomet|kilogram)/i, slot: "units", value: "metric", text: "Uses metric units.", lane: "responseStyle", kind: "preference" },
  { test: /\bcall me ([a-z][a-z]+)\b/i, slot: "greeting.name", value: (m) => (m[1] ?? "").toLowerCase(), text: (m) => `Calls the user ${cap((m[1] ?? "").toLowerCase())}.`, lane: "responseStyle", kind: "preference" },
  { test: /\b(prefer|use|write|in) (typescript|python|rust|go|java|kotlin|swift)\b/i, slot: "code.language", value: (m) => (m[2] ?? "").toLowerCase(), text: (m) => `Prefers ${cap(m[2] ?? "")} for code examples.`, lane: "agent", kind: "preference" },
  { test: /\b(formal|casual|friendly|warm|professional|blunt|direct) (tone|voice|style)\b/i, slot: "tone", value: (m) => (m[1] ?? "").toLowerCase(), text: (m) => `Prefers a ${(m[1] ?? "").toLowerCase()} tone.`, lane: "responseStyle", kind: "style" },
  { test: /\b(cite|citations?|sources?|links? to sources)\b/i, slot: "citations", value: "always", text: "Includes sources for factual claims.", lane: "responseStyle", kind: "preference" },
  { test: /\b(show|include) (the )?(code|examples?)\b/i, slot: "code.examples", value: "always", text: "Includes a code example with explanations.", lane: "agent", kind: "preference" },
];

const TRIGGER = /\b(prefer|always|never|from now on|going forward|in future|please stop|don'?t|do not|stop|instead of|i (want|need|like|hate|dislike))\b/i;
const OPENERS = ["Prefers", "Avoids", "Uses", "Keeps", "Never", "Always", "Omits", "Includes", "Assumes", "Calls", "Wants", "Likes", "Dislikes", "Needs"];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The evidence blocks the library fences into the prompt, keyed by their label. */
export function evidenceOf(prompt: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^([A-Za-z ()]+):\n(?:[^\n]*\n)?<<user-text>>\n([\s\S]*?)\n<<\/user-text>>/gm;
  for (const m of prompt.matchAll(re)) out[(m[1] ?? "").trim()] = (m[2] ?? "").trim();
  return out;
}

/** A last-resort statement when no rule fired but the text looks like a preference. */
function genericStatement(text: string): string | null {
  const m = text.match(TRIGGER);
  if (!m || m.index === undefined) return null;
  let clause = text.slice(m.index + m[0].length).replace(/[\n\r]+/g, " ").trim();
  clause = clause.replace(/\b(i|me|my|mine|we|our|you|your|yourself|please|assistant)\b/gi, "").replace(/["“”'‘’`]/g, "").replace(/\s+/g, " ").trim();
  clause = clause.replace(/[.!?].*$/, "").trim();
  if (clause.length < 4) return null;
  const opener = /^(never|no |not )/i.test(m[0]) || /^(stop|don'?t|do not)/i.test(m[0]) ? "Avoids" : "Prefers";
  const statement = `${opener} ${clause.slice(0, 110)}.`;
  return OPENERS.some((o) => statement.startsWith(o)) ? statement : null;
}

export interface OfflineProposalOp {
  op: "add_hint";
  nodePath: string;
  slot: string;
  value: string;
  text: string;
  kind: HintKind;
  lane: HintLane;
  scope: "global";
  priority: number;
  confidence: number;
  rationale: string;
}

/** Pure: the proposal the offline port would return for a piece of user text. Exported for tests. */
export function heuristicProposal(text: string): { ops: OfflineProposalOp[]; notes: string } {
  const ops: OfflineProposalOp[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    const m = text.match(rule.test);
    if (!m || seen.has(rule.slot)) continue;
    seen.add(rule.slot);
    const value = typeof rule.value === "function" ? rule.value(m) : rule.value;
    const statement = typeof rule.text === "function" ? rule.text(m) : rule.text;
    ops.push({ op: "add_hint", nodePath: "/", slot: rule.slot, value, text: statement, kind: rule.kind, lane: rule.lane, scope: "global", priority: 65, confidence: 0.7, rationale: `offline rule ${rule.slot}` });
  }
  if (ops.length === 0) {
    const s = genericStatement(text);
    if (s) ops.push({ op: "add_hint", nodePath: "/", slot: `pref.${s.split(/\s+/).slice(1, 3).join("_").toLowerCase().replace(/[^a-z0-9_]/g, "") || "misc"}`, value: s.toLowerCase().slice(0, 60), text: s, kind: "preference", lane: "responseStyle", scope: "global", priority: 50, confidence: 0.5, rationale: "offline generic trigger" });
  }
  return { ops, notes: "offline heuristic extractor" };
}

function offlineLlmPort(logger: LoggerPort): LlmPort {
  return {
    async complete(prompt, opts) {
      if (opts.purpose === "consolidate") return JSON.stringify({ ops: [] });
      const ev = evidenceOf(prompt);
      const text = ev["Feedback text"] ?? ev["User message"] ?? ev["User message of the run"] ?? "";
      const proposal = heuristicProposal(text);
      logger.debug?.({ ops: proposal.ops.map((o) => o.slot) }, "llm.offline");
      return JSON.stringify(proposal);
    },
  };
}

// ── Chat ────────────────────────────────────────────────────────────────────

export interface ChatArgs {
  system: string;
  messages: NeutralMessage[];
  /** Streaming deltas; omit for a single string result. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
}
export type ChatFn = (args: ChatArgs) => Promise<string>;

/**
 * The distinct bullet lines inside every `<<wisdom-hints …>>` block of a prompt.
 * Distinct, because the library mirrors responseStyle hints into the agent
 * bucket on purpose (single-consult turns skip synthesize), so the same
 * statement legitimately appears in two blocks and should count once.
 */
export function hintLinesIn(prompt: string): string[] {
  const lines = new Set<string>();
  for (const m of prompt.matchAll(/<<wisdom-hints[^>]*>>\n([\s\S]*?)\n<<\/wisdom-hints>>/g)) {
    for (const line of (m[1] ?? "").split("\n")) if (line.startsWith("- ")) lines.add(line.slice(2));
  }
  return [...lines];
}

function toAnthropicMessages(messages: NeutralMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.role === "tool" ? `[tool ${m.name ?? ""}] ${m.content}` : m.content;
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === "string") last.content = `${last.content}\n\n${content}`;
    else out.push({ role, content });
  }
  if (out.length === 0 || out[0]?.role !== "user") out.unshift({ role: "user", content: "(start)" });
  return out;
}

export function createChat(cfg: HarnessConfig): ChatFn {
  if (cfg.offline) {
    return async ({ system, messages, onDelta }) => {
      const hints = hintLinesIn(system);
      const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const reply = [
        `(offline assistant — set ANTHROPIC_API_KEY or run \`ant auth login\` for a real model)`,
        hints.length === 0 ? "My system prompt carries no preferences yet." : `My system prompt carries ${hints.length} preference${hints.length === 1 ? "" : "s"}:`,
        ...hints.map((h) => `  • ${h}`),
        `You said: ${last.slice(0, 200)}`,
      ].join("\n");
      onDelta?.(reply);
      return reply;
    };
  }
  const client = new Anthropic();
  return async ({ system, messages, onDelta, signal, maxTokens }) => {
    const stream = client.messages.stream(
      {
        model: cfg.model,
        max_tokens: maxTokens ?? 4096,
        system,
        output_config: { effort: cfg.effort },
        messages: toAnthropicMessages(messages),
      },
      signal ? { signal } : undefined,
    );
    if (onDelta) stream.on("text", (delta) => onDelta(delta));
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") return "(the model declined to answer)";
    return final.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  };
}
