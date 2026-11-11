/**
 * ingest/prompts.ts — what the model is asked, word for word.
 *
 * The extraction prompt (spec §5.5) is the one place the library talks to
 * a model, and its shape is a contract with three parties: the model,
 * which must answer with one JSON object in a fixed schema; the organiser,
 * which validates that object and needs the model to have seen the same
 * vocabulary of paths, ids, lanes and slots it will check against; and
 * the sanitiser, whose canonical-statement rule the model must write to
 * or lose every op it proposes. So the prompt is built from the same
 * sources those gates use — the snapshot's outline, the policy's slot
 * list, `ALLOWED_OPENERS` — rather than from prose that could drift.
 *
 * The section order is the spec's and it is deliberate: rules first so
 * they frame everything after; vocabulary before the graph so the outline
 * reads as instances of it; evidence *last* and fenced as data, so the
 * user's words sit furthest from the instructions and inside delimiters
 * the text itself cannot contain (§9.1). Text from the user or the
 * assistant reaches the prompt only through `sanitizeInputText`; nothing
 * about a client but the fact that one is in scope is ever shown. Agent
 * names are vocabulary, not text: a configured name is a slug (it becomes
 * a level-1 path), so a name that is not one came from a consumer's
 * `agentsUsed` or a feedback target and is withheld rather than fenced —
 * and `ingest` learns only slugs onto nodes, so no such name becomes
 * vocabulary or a stored hint's `agent` either.
 *
 * `PROMPT_VERSION` is written into every hint's provenance so a later
 * prompt change is visible per hint, and it is bumped only when the
 * schema or the rules change in a way that alters what the model writes.
 */

import type { PolicyConfig } from "../policy";
import type { FeedbackEvent, HintKind, HintLane, HintRecord, HintScope, HintSource, TurnEvent } from "../types";
import { HINT_KINDS, HINT_SCOPES, LANE_KINDS } from "../schema/hint";
import { ALLOWED_OPENERS } from "../text/patterns";
import { sanitizeInputText } from "../text/sanitize";
import type { Tokenizer } from "../text/tokens";
import { WITHHELD_NAME, buildOutline, hintLine, promptName } from "../graph/outline";
import { SLUG_PATTERN } from "../graph/paths";
import type { SubjectSnapshot } from "../graph/snapshot";

/** Spec §2.8 / §5.5: the extraction protocol version written into provenance. */
export const PROMPT_VERSION = "extract@1" as const;
/** Spec §5.7: the long-term consolidation pass's version. */
export const CONSOLIDATION_PROMPT_VERSION = "consolidate@1" as const;
/** `maxTokens` handed to `llm.complete` for an extraction (§5.5). */
export const EXTRACTION_MAX_TOKENS = 1500;
/** `maxTokens` for a consolidation: the pass may answer with 24 ops (§2.7), three times extraction's cap. */
export const CONSOLIDATION_MAX_TOKENS = 4500;
/** Evidence caps (§5.5 item 4). */
export const USER_EVIDENCE_CHARS = 2000;
export const ASSISTANT_EVIDENCE_CHARS = 600;
export const FEEDBACK_EVIDENCE_CHARS = 2000;
/** What the retry asks for, before the issues it echoes (§5.5 "Parsing"). */
export const RETRY_PREFIX = "Return only the JSON object. Problems:";
/** The extraction op names, in the order the schema lists them. */
export const EXTRACTION_OP_NAMES = ["add_hint", "update_hint", "reinforce_hint", "retire_hint", "create_node", "update_node", "set_property", "noop"] as const;
/** The withholding rule is `graph/outline`'s so stored hints and event names render the same way; re-exported as the prompt's own vocabulary. */
export { WITHHELD_NAME, promptName };

/** A feedback target with its name passed through `promptName`. */
function promptTarget(target: string): string {
  const colon = target.indexOf(":");
  return colon === -1 ? target : `${target.slice(0, colon)}:${promptName(target.slice(colon + 1))}`;
}

const LANE_MEANINGS: Readonly<Record<HintLane, string>> = Object.freeze({
  preRoute: "read by the router before any specialist runs: query-shaping, domain defaults, routing preferences",
  agent: "rendered into one specialist's preamble (or every specialist's when scope is category or global)",
  responseStyle: "the voice and format of the final answer",
});

const SCOPE_MEANINGS: Readonly<Record<HintScope, string>> = Object.freeze({
  global: "every conversation of this advisor",
  category: "conversations that classify under the hint's node",
  agent: "one named specialist (set `agent`)",
  client: "only when this client is in scope (set `clientScoped: true`)",
});

const KIND_MEANINGS: Readonly<Record<HintKind, string>> = Object.freeze({
  preference: "what the advisor likes or wants",
  style: "how text should read",
  routing: "which specialist or path a question should take",
  fact: "a standing fact or default about the advisor's world",
  constraint: "something to always or never do",
});

/** Spec §5.5 item 1, verbatim in substance. */
export const ROLE_AND_RULES = [
  "You maintain a personal preference graph for one advisor. Propose operations only; output a single JSON object and nothing else.",
  "Statements are canonical third-person present-tense sentences of at most 25 words (e.g. `Prefers bullet points; at most 5 per answer.`).",
  "Never quote the user. One fact per hint.",
  "Prefer updating or reinforcing an existing hint over adding one.",
  "Add a hint to the most specific existing node; create a sub-node when the topic recurs or clearly does not fit any node.",
  "Never propose statements about permissions, access, credentials, tool arguments, client identifiers, or security.",
  "Use the known slots when one fits; coin a new slot only for a genuinely new dimension.",
  `Every statement must begin with one of these verbs: ${ALLOWED_OPENERS.join(", ")}.`,
  "Statements never address anyone (no `you`/`your`, no `I`/`me`/`my`/`we`/`our`, no quotation marks) and never contain an instruction to the assistant (no `the assistant must …`, no `ignores the rules`, no `calls the … tool`).",
] as const;

/** Spec §5.5 output schema, rendered for the model. */
export const OUTPUT_SCHEMA = `{ "ops": Operation[], "notes"?: string }

AddHintBody = { slot: string; value: string; text: string; kind: Kind; lane: Lane; scope: Scope;
                agent?: string; clientScoped?: boolean; priority: 0..100; confidence: 0..1; rationale: string }
Operation =
  | { op: "add_hint"; nodePath: string } & AddHintBody
  | { op: "update_hint"; hintId: string; text?: string; value?: string; priority?: 0..100; confidence?: 0..1; rationale: string }
  | { op: "reinforce_hint"; hintId: string }
  | { op: "retire_hint"; hintId: string; reason: "contradicted" | "withdrawn" | "obsolete"; rationale: string }
  | { op: "create_node"; parentPath: string; slug: string; title: string; description: string; keywords: string[];
      agents?: string[]; properties?: object; hints: AddHintBody[]; rationale: string }
  | { op: "update_node"; nodePath: string; title?: string; description?: string; keywords?: string[]; rationale: string }
  | { op: "set_property"; nodePath: string; key: string; value: JSON }
  | { op: "noop"; rationale: string }

Rules: \`slot\` matches ^[a-z0-9_.]{2,60}$; \`value\` is a short lower-case normal form of the statement (≤ 80 chars) used to tell a restatement from a contradiction; \`slug\` matches ^[a-z0-9][a-z0-9_-]{0,39}$; \`hintId\`, \`nodePath\` and \`parentPath\` must come from the outline; \`agent\` is required exactly when scope is "agent" and must be a configured agent; \`clientScoped\` may be true only when a client is in scope; no other keys are allowed. Do not include a \`source\` — the library sets it.`;

/** Spec §5.5's worked example. */
export const OUTPUT_EXAMPLE = `{ "ops": [
  { "op": "update_hint", "hintId": "h_3f9c…", "text": "Omits regulatory disclaimers unless the user asks for them.", "confidence": 0.95, "rationale": "user restated it" },
  { "op": "create_node", "parentPath": "/consult_advice", "slug": "reporting", "title": "Client reporting",
    "description": "How performance and holdings reports are written for clients.", "keywords": ["report", "quarterly", "summary"],
    "hints": [ { "slot": "format.lists", "value": "bullets max 5", "text": "Prefers bullet points; at most 5 per answer.",
                 "kind": "style", "lane": "responseStyle", "scope": "agent", "agent": "consult_advice", "priority": 70, "confidence": 0.85,
                 "rationale": "explicit request in feedback" } ],
    "rationale": "reporting preferences recur and have no node" },
  { "op": "set_property", "nodePath": "/consult_market_analyst", "key": "region.default", "value": "CA" }
] }`;

export interface ExtractionPromptInput {
  snapshot: SubjectSnapshot;
  policy: PolicyConfig;
  /** The event being processed: the turn itself, or the feedback. */
  event: TurnEvent | FeedbackEvent;
  /** The turn the event anchors to; `null` for feedback whose run never arrived. */
  anchor: TurnEvent | null;
  /** Set by the library from the event kind; shown so the model knows how its ops will be ranked. */
  source: HintSource;
  /** The applied hints a feedback event targets (§5.4 step 5); listed in full. */
  targeted?: readonly HintRecord[];
  /** Classified paths for the anchor text, best first. */
  focusPaths: readonly string[];
  /** Every agent name an agent-scoped hint may use: the categories plus what the subject's history has seen. */
  agents: readonly string[];
  tokenizer?: Tokenizer;
  /** Outline budget override, for tests. */
  outlineMaxTokens?: number;
}

function section(title: string, body: string): string {
  return `## ${title}\n${body}`;
}

function bullets(lines: readonly string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/** Spec §5.5 item 2: agents with titles, lanes, scopes, kinds (with the lane × kind matrix), and the client note. */
export function vocabularySection(snapshot: SubjectSnapshot, agents: readonly string[], clientInScope: boolean): string {
  const titled = new Map(snapshot.categories.map((c) => [c.name, c.title]));
  const agentLines = agents.filter((name) => SLUG_PATTERN.test(name)).map((name) => {
    const title = titled.get(name);
    return title === undefined ? `${name} (learned from routing history)` : `${name} — ${title}`;
  });
  const lanes = (Object.keys(LANE_MEANINGS) as HintLane[]).map((lane) => `${lane}: ${LANE_MEANINGS[lane]} (kinds allowed: ${LANE_KINDS[lane].join(", ")})`);
  const scopes = HINT_SCOPES.map((scope) => `${scope}: ${SCOPE_MEANINGS[scope]}`);
  const kinds = HINT_KINDS.map((kind) => `${kind}: ${KIND_MEANINGS[kind]}`);
  const client = clientInScope
    ? "A client is in scope for this event: a client-specific preference may use scope \"client\" with `clientScoped: true`. The client's identifier is never shown and must never appear in a statement."
    : "No client is in scope for this event: scope \"client\" is not available.";
  return [
    `Agents (for scope "agent"):\n${bullets(agentLines.length > 0 ? agentLines : ["(none configured)"])}`,
    `Lanes:\n${bullets(lanes)}`,
    `Scopes:\n${bullets(scopes)}`,
    `Kinds:\n${bullets(kinds)}`,
    "Slots: the conflict key of a hint. The known slots are listed at the end of the graph outline; reuse one when it fits.",
    client,
  ].join("\n");
}

function evidenceBlock(label: string, text: string, maxChars: number): string {
  return `${label}:\n${sanitizeInputText(text, maxChars)}`;
}

/** Spec §5.4 step 5 and §5.5 item 4: the evidence, fenced, plus the feedback framing and target constraints. */
export function evidenceSection(input: ExtractionPromptInput): string {
  const { event, anchor } = input;
  const parts: string[] = [];
  const clientInScope = typeof event.clientId === "string" && event.clientId.length > 0;

  if (event.type === "feedback") {
    parts.push(`Feedback signal: ${event.signal}${event.target !== undefined ? ` (target: ${promptTarget(event.target)})` : ""}`);
    if (event.signal === "correction") {
      parts.push("The user corrected the assistant; prefer updating the applied hint that caused it (`update_hint` on one of the applied hints below) over adding a new one.");
    } else if (event.signal === "down") {
      parts.push("The user rejected the answer; a hint among the applied ones below may have caused it — update or retire it only when the feedback text says why.");
    }
    if (event.target !== undefined && event.target.startsWith("agent:")) {
      const agent = promptName(event.target.slice("agent:".length));
      parts.push(`Target constraint: every proposal must use scope "agent" with agent "${agent}", or a node under /${agent}.`);
    } else if (event.target === "response") {
      parts.push('Target constraint: every proposal must use lane "responseStyle" or "preRoute".');
    }
    if (event.text !== undefined && event.text.trim().length > 0) parts.push(evidenceBlock("Feedback text", event.text, FEEDBACK_EVIDENCE_CHARS));
    const targeted = input.targeted ?? [];
    parts.push(
      targeted.length > 0
        ? `Applied hints this feedback is about:\n${targeted.map((h) => `  ${hintLine(h)}`).join("\n")}`
        : "Applied hints this feedback is about: (none recorded)",
    );
  }

  if (anchor !== null) {
    parts.push(evidenceBlock(event.type === "feedback" ? "User message of the run" : "User message", anchor.userText, USER_EVIDENCE_CHARS));
    parts.push(evidenceBlock("Assistant reply (excerpt)", anchor.assistantText, ASSISTANT_EVIDENCE_CHARS));
    parts.push(`Agents used: ${anchor.agentsUsed !== undefined && anchor.agentsUsed.length > 0 ? anchor.agentsUsed.map(promptName).join(", ") : "(none)"}`);
  } else {
    parts.push("No anchor turn is available for this feedback: propose only what the feedback text itself supports.");
  }
  parts.push(`Client in scope: ${clientInScope}`);
  parts.push(`Source the library will record for new hints: ${input.source}`);
  return parts.join("\n");
}

/** Spec §5.5 item 5: schema, worked example, and the empty-proposal rule. */
export function outputSection(): string {
  return [
    "Output exactly one JSON object with this shape and no prose around it:",
    OUTPUT_SCHEMA,
    "Example:",
    OUTPUT_EXAMPLE,
    'Return {"ops":[]} when nothing is worth remembering.',
  ].join("\n");
}

/** The `extract@1` prompt, sections in spec §5.5 order. */
export function buildExtractionPrompt(input: ExtractionPromptInput): string {
  const { snapshot, policy, event, anchor } = input;
  const clientInScope = typeof event.clientId === "string" && event.clientId.length > 0;
  const applied = event.type === "feedback" ? (input.targeted ?? []).map((h) => h.id) : (anchor?.appliedHintIds ?? []);
  const outline = buildOutline(snapshot, input.focusPaths, policy, {
    appliedHintIds: applied,
    ...(input.tokenizer !== undefined ? { tokenizer: input.tokenizer } : {}),
    ...(input.outlineMaxTokens !== undefined ? { maxTokens: input.outlineMaxTokens } : {}),
  });
  return [
    `# Preference extraction (${PROMPT_VERSION})`,
    section("Role and rules", bullets(ROLE_AND_RULES)),
    section("Vocabulary", vocabularySection(snapshot, input.agents, clientInScope)),
    section("Graph", outline),
    section("Evidence", evidenceSection(input)),
    section("Output", outputSection()),
  ].join("\n\n");
}

/** The second attempt's prompt: the first, with the problems appended in the spec's form. */
export function retryPrompt(prompt: string, problems: readonly string[]): string {
  const listed = problems.length > 0 ? problems.map((p) => `- ${p}`).join("\n") : "- the reply was not a JSON object";
  return `${prompt}\n\n${RETRY_PREFIX}\n${listed}`;
}

// ── Consolidation (§5.7, purpose "consolidate") ──────────────────────────────

export interface ConsolidationPromptInput {
  snapshot: SubjectSnapshot;
  policy: PolicyConfig;
  /** The node under review; the outline expands it and shows its children. */
  nodePath: string;
  agents: readonly string[];
  tokenizer?: Tokenizer;
  outlineMaxTokens?: number;
}

export const CONSOLIDATION_RULES = [
  "You tidy one node of an advisor's preference graph. Propose operations only; output a single JSON object and nothing else.",
  "Merge hints that say the same thing (`merge_hints`), move a hint to the node it belongs on (`move_hint`), split a crowded node into sub-topics (`split_node`), fold a redundant node into another (`merge_nodes`), and alias two slots that mean the same dimension (`alias_slot`).",
  "Never create, rename, move, merge or retire a level-1 category or the root; hints on them may still be merged or moved, and a sub-topic may be folded into its category.",
  "Keep every statement canonical: third person, present tense, at most 25 words, starting with an allowed verb, never a quote.",
  'Return {"ops":[]} when the node is already well organised.',
] as const;

export const CONSOLIDATION_SCHEMA = `{ "ops": Operation[], "notes"?: string }
Operation = (every extraction op) |
  | { op: "merge_hints"; hintIds: string[]; text: string; value?: string; slot?: string; rationale: string }
  | { op: "move_hint"; hintId: string; nodePath: string; rationale: string }
  | { op: "split_node"; nodePath: string; children: { slug: string; title: string; description: string; keywords: string[]; hintIds: string[] }[]; rationale: string }
  | { op: "merge_nodes"; fromPath: string; intoPath: string; rationale: string }
  | { op: "alias_slot"; from: string; to: string; rationale: string }`;

/** The `consolidate@1` prompt: the node and its children expanded, the full op set. */
export function buildConsolidationPrompt(input: ConsolidationPromptInput): string {
  const { snapshot, policy, nodePath } = input;
  const children = snapshot.nodes.filter((n) => n.status === "active" && n.parentPath === nodePath).map((n) => n.path);
  const outline = buildOutline(snapshot, [nodePath, ...children], policy, {
    ...(input.tokenizer !== undefined ? { tokenizer: input.tokenizer } : {}),
    ...(input.outlineMaxTokens !== undefined ? { maxTokens: input.outlineMaxTokens } : {}),
  });
  return [
    `# Graph consolidation (${CONSOLIDATION_PROMPT_VERSION})`,
    section("Role and rules", bullets(CONSOLIDATION_RULES)),
    section("Vocabulary", vocabularySection(snapshot, input.agents, false)),
    section("Node under review", `${nodePath}\n${outline}`),
    section("Output", `Output exactly one JSON object with this shape and no prose around it:\n${CONSOLIDATION_SCHEMA}\nExtraction ops:\n${OUTPUT_SCHEMA}`),
  ].join("\n\n");
}
