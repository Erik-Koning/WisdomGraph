/**
 * langgraph/messages.ts — LangChain messages as the neutral shape recall
 * understands.
 *
 * Must-have 1 forbids a LangChain import, so this file never sees a
 * `BaseMessage`. It reads the few structural fields every LangChain message
 * class carries — `_getType()`, `content`, `name`, `tool_calls` — and the
 * plain `{ role, content }` shape a consumer's own code or a deep-agents
 * `messages` reducer holds, and produces `NeutralMessage`s, the only message
 * vocabulary anything under `core/` speaks. Reading fields rather than
 * checking classes is what lets one converter serve every LangChain major
 * the consumer might be on, and a serialised message (`type: "human"`)
 * exactly as well as a live one.
 *
 * The conversion is lossy on purpose. Recall reads user text, tool names
 * and the last two user turns (spec §4.2 step 1); everything else — image
 * parts, tool-call ids, response metadata — is payload the hot path never
 * looks at, so it is dropped here rather than carried into a value that is
 * logged and cached. An unknown kind of message converts to `null` and is
 * skipped by the list helpers: a message the adapter cannot place must not
 * become a `user` turn by accident, because that would feed the classifier
 * text the user never wrote.
 *
 * Nothing here throws on a malformed message. The converters run at the
 * request boundary, before the recall promise exists, and a consumer's
 * message array is untyped at runtime; a hole or a stray object yields
 * `null`, `[]` or `""`, never an exception in the request path.
 */

import type { NeutralMessage } from "../core/types";

/** Spec §2.9: the structural fields the adapter reads from a LangChain message or a plain role/content object. */
export interface MessageLike {
  _getType?(): string;
  type?: string;
  role?: string;
  name?: string;
  content: string | { type: string; text?: string }[];
  tool_calls?: { name: string; args: unknown }[];
}

/**
 * Spec §8.1's mapping: LangChain's own kinds and the plain-object roles.
 * A `Map`, not an object, so `constructor` and friends are not roles.
 */
const ROLES: ReadonlyMap<string, NeutralMessage["role"]> = new Map([
  ["human", "user"],
  ["user", "user"],
  ["ai", "assistant"],
  ["assistant", "assistant"],
  ["tool", "tool"],
  ["system", "system"],
]);

/** The first discriminator present decides: `_getType()`, then `type`, then `role` (spec §8.1). */
function discriminator(m: MessageLike): unknown {
  const kind = typeof m._getType === "function" ? m._getType() : undefined;
  return kind ?? m.type ?? m.role;
}

/** A content part that carries text. Reads through a record view because the array's members are untyped at runtime. */
function textPartOf(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const record = part as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string" ? record.text : null;
}

/** String content verbatim; a parts array flattened to its text parts joined by newlines; anything else is empty. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    const text = textPartOf(part);
    if (text !== null) texts.push(text);
  }
  return texts.join("\n");
}

/** `tool_calls` as `toolCalls`: name and args only, entries without a name dropped, absent when there are none. */
function toolCallsOf(calls: unknown): NeutralMessage["toolCalls"] | undefined {
  if (!Array.isArray(calls)) return undefined;
  const out: { name: string; args: unknown }[] = [];
  for (const call of calls) {
    if (typeof call !== "object" || call === null) continue;
    const record = call as Record<string, unknown>;
    if (typeof record.name === "string") out.push({ name: record.name, args: record.args });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Spec §8.1. One message as a `NeutralMessage`, or `null` for a kind recall
 * has no role for (`function`, `generic`, a missing discriminator, a hole in
 * the array).
 */
export function toNeutralMessage(m: MessageLike): NeutralMessage | null {
  if (typeof m !== "object" || m === null) return null;
  const kind = discriminator(m);
  const role = typeof kind === "string" ? ROLES.get(kind) : undefined;
  if (role === undefined) return null;
  const out: NeutralMessage = { role, content: textOf(m.content) };
  if (typeof m.name === "string") out.name = m.name;
  const toolCalls = toolCallsOf(m.tool_calls);
  if (toolCalls !== undefined) out.toolCalls = toolCalls;
  return out;
}

/**
 * Spec §8.1. Every convertible message in order, then the last `last` of
 * them when a limit is given — the limit counts converted messages, so an
 * unknown kind in the window does not cost a turn. A limit of zero or less
 * keeps nothing.
 */
export function toNeutralMessages(ms: readonly MessageLike[], opts: { last?: number } = {}): NeutralMessage[] {
  if (!Array.isArray(ms)) return [];
  const out: NeutralMessage[] = [];
  for (const m of ms) {
    const neutral = toNeutralMessage(m);
    if (neutral !== null) out.push(neutral);
  }
  const limit = opts.last;
  if (limit === undefined || !Number.isFinite(limit)) return out;
  const keep = Math.max(0, Math.floor(limit));
  return keep === 0 ? [] : out.slice(-keep);
}

/** Spec §8.1. The content of the last `user` message, or `""` when there is none. */
export function lastUserText(ms: readonly MessageLike[]): string {
  if (!Array.isArray(ms)) return "";
  for (let i = ms.length - 1; i >= 0; i -= 1) {
    const m = ms[i];
    if (m === undefined) continue;
    const neutral = toNeutralMessage(m);
    if (neutral !== null && neutral.role === "user") return neutral.content;
  }
  return "";
}
