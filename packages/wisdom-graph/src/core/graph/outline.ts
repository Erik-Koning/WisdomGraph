/**
 * graph/outline.ts — the subject's graph as the extractor is allowed to
 * see it.
 *
 * The extraction prompt (spec §5.5) has to let a model decide *where* a
 * preference belongs — update an existing hint, add one to the most
 * specific node, or create a sub-node — without handing it the whole
 * graph, which for a mature advisor is hundreds of nodes and would cost
 * more tokens per turn than the hint it produces. So the outline is a
 * fixed set of views, not a dump: the root's global hints, every level-1
 * category as one line, the classified path expanded (description,
 * properties, every active hint with its id), the leaf's siblings as one
 * line each so a near-duplicate node is visible before it is proposed,
 * and the hints the anchor turn actually applied. Everything else is
 * absent on purpose — a node the outline does not show is one the model
 * has no business editing, and gate 2 of the organiser refuses paths it
 * hallucinates.
 *
 * The budget is ~1 500 tokens and it is enforced here, not hoped for,
 * because a prompt that grows with the graph is a cost that grows with
 * the customer. When the views overflow, nodes are elided deepest-first:
 * the leaf's siblings, then the secondary paths' leaves, then the
 * ancestors of the primary path from its parent upward — the secondary
 * path before the primary at equal depth — and the global hints last of
 * the optional views. The classified leaf itself is never elided: it
 * keeps its description and properties, and only when nothing else is
 * left does it lose hint lines, with a marker saying how many. Level-1
 * lines and the known slots are never elided either: they are the
 * vocabulary that keeps proposals converging on the same paths and keys.
 *
 * Every hint is rendered in one fixed form — `id [lane,scope,agent?,
 * source,confidence] slot=value :: text` — so the model reads placement
 * and value at a glance and the tests can pin the format.
 */

import type { PolicyConfig } from "../policy";
import type { HintRecord, JsonValue } from "../types";
import { estimateTokens, type Tokenizer } from "../text/tokens";
import { ROOT_PATH, SLUG_PATTERN, ancestors, depth, parentPath } from "./paths";
import type { SnapshotNode, SubjectSnapshot } from "./snapshot";

/** The outline's default token budget (§5.5: "≤ ~1 500 tokens"). */
export const OUTLINE_MAX_TOKENS = 1500;
/** A node's properties bag is shown as JSON cut at this many characters (§5.5). */
export const PROPERTIES_MAX_CHARS = 300;
/** The known-slots line shows at most this many slots; the seeded ones come first. */
export const MAX_SLOTS_SHOWN = 40;

export interface OutlineOptions {
  /** Default `OUTLINE_MAX_TOKENS`. */
  maxTokens?: number;
  tokenizer?: Tokenizer;
  /** Hint ids the anchor turn applied; rendered in full in their own section. */
  appliedHintIds?: readonly string[];
}

/** One known slot with the value a stored hint gives it, when any does. */
export interface KnownSlot {
  slot: string;
  example?: string;
}

/** Shown in place of an agent name that is not a slug (§9.1). */
export const WITHHELD_NAME = "(name withheld)";

/**
 * An agent name as a prompt may show it: verbatim when it is a slug, as
 * every configured name is; withheld otherwise. Lives here rather than in
 * `ingest/prompts.ts` because a stored hint's `agent` is rendered by
 * `hintLine` below, and a row written before agent names were filtered to
 * slugs must go through the same rule as a name from `agentsUsed`.
 */
export function promptName(name: string): string {
  return SLUG_PATTERN.test(name) ? name : WITHHELD_NAME;
}

/** `id [lane,scope,agent?,source,confidence] slot=value :: text` — the one form every hint takes in a prompt. */
export function hintLine(record: HintRecord): string {
  const tags: string[] = [record.lane, record.scope];
  if (record.agent !== undefined) tags.push(promptName(record.agent));
  tags.push(record.source, record.confidence.toFixed(2));
  return `${record.id} [${tags.join(",")}] ${record.slot}=${record.value} :: ${record.text}`;
}

/** `path | title | description` — the one-line form of a node. */
export function nodeLine(node: Pick<SnapshotNode, "path" | "title" | "description">): string {
  return `${node.path} | ${node.title} | ${node.description}`;
}

/** The properties bag as JSON, cut at `PROPERTIES_MAX_CHARS` with an ellipsis; "" for an empty bag. */
export function propertiesLine(properties: Readonly<Record<string, JsonValue>>): string {
  if (Object.keys(properties).length === 0) return "";
  const json = JSON.stringify(properties);
  return json.length > PROPERTIES_MAX_CHARS ? `${json.slice(0, PROPERTIES_MAX_CHARS - 1)}…` : json;
}

/** Active records per node path, in store order. */
export function activeHintsByPath(snapshot: SubjectSnapshot): Map<string, HintRecord[]> {
  const out = new Map<string, HintRecord[]>();
  for (const record of snapshot.records) {
    if (record.status !== "active") continue;
    const list = out.get(record.nodePath);
    if (list) list.push(record);
    else out.set(record.nodePath, [record]);
  }
  return out;
}

/**
 * The slot vocabulary (§5.5 item 2): the policy's seeded slots first, then
 * every slot an active hint of the subject uses, each with the first stored
 * value as its example so the model coins the same key for the same
 * dimension. Aliases are already folded: the snapshot canonicalised them.
 */
export function knownSlots(snapshot: SubjectSnapshot, policy: PolicyConfig): KnownSlot[] {
  const examples = new Map<string, string>();
  for (const record of snapshot.records) {
    if (record.status === "active" && !examples.has(record.slot)) examples.set(record.slot, record.value);
  }
  const seen = new Set<string>();
  const out: KnownSlot[] = [];
  const add = (slot: string): void => {
    if (seen.has(slot) || out.length >= MAX_SLOTS_SHOWN) return;
    seen.add(slot);
    const example = examples.get(slot);
    out.push(example === undefined ? { slot } : { slot, example });
  };
  for (const slot of policy.slots) add(slot);
  for (const slot of [...examples.keys()].sort()) add(slot);
  return out;
}

export function knownSlotsLine(slots: readonly KnownSlot[]): string {
  if (slots.length === 0) return "Known slots: (none yet)";
  return `Known slots: ${slots.map((s) => (s.example === undefined ? s.slot : `${s.slot} (e.g. ${s.example})`)).join(", ")}`;
}

// ── Blocks ───────────────────────────────────────────────────────────────────

type BlockKind = "header" | "global" | "categories" | "focus" | "node" | "sibling" | "applied" | "slots";

/**
 * One elidable unit of the outline. `head` survives trimming; `hints` are
 * cut from the end one at a time. `depth` orders elision (deepest first),
 * `rank` breaks ties between kinds at one depth, `secondary` marks a block
 * of a non-primary path (elided before the primary's at equal depth), and
 * `required` marks what is never elided as a whole: the vocabulary and the
 * classified leaf.
 */
interface Block {
  kind: BlockKind;
  depth: number;
  required: boolean;
  secondary: boolean;
  head: string[];
  hints: string[];
  /** Set while trimming: how many hint lines were cut. */
  trimmed: number;
}

function block(kind: BlockKind, depth: number, required: boolean, head: string[], hints: string[] = [], secondary = false): Block {
  return { kind, depth, required, secondary, head, hints, trimmed: 0 };
}

function blank(b: Block): void {
  b.head = [];
  b.hints = [];
  b.trimmed = 0;
}

function isEmpty(b: Block): boolean {
  return b.head.length === 0 && b.hints.length === 0 && b.trimmed === 0;
}

function render(b: Block): string[] {
  if (isEmpty(b)) return [];
  const lines = [...b.head, ...b.hints];
  if (b.trimmed > 0) lines.push(`${b.hints.length > 0 ? "      " : "  "}… (+${b.trimmed} more hints not shown)`);
  return lines;
}

function renderAll(blocks: readonly Block[]): string {
  return blocks.flatMap(render).join("\n");
}

/** The focus paths that name active nodes, in order, each once. */
function activeFocus(snapshot: SubjectSnapshot, focusPaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of focusPaths) {
    const node = snapshot.nodesByPath.get(path);
    if (node === undefined || node.status !== "active" || path === ROOT_PATH || out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

/** The expanded view of one node: its line, its properties, and every active hint. */
function nodeBlock(node: SnapshotNode, hints: readonly HintRecord[], required: boolean, secondary: boolean, indent: string): Block {
  const head = [`${indent}${nodeLine(node)}`];
  const properties = propertiesLine(node.properties);
  if (properties.length > 0) head.push(`${indent}  properties: ${properties}`);
  head.push(`${indent}  hints:${hints.length === 0 ? " (none)" : ""}`);
  return block("node", node.level, required, head, hints.map((h) => `${indent}    ${hintLine(h)}`), secondary);
}

/**
 * Spec §5.5 item 3. `focusPaths` are the classified paths for the anchor
 * text, best first; the first is the primary path and is kept whole for as
 * long as the budget allows. An empty list — a "direct" classification —
 * yields the global hints, the categories and the slots alone.
 */
export function buildOutline(snapshot: SubjectSnapshot, focusPaths: readonly string[], policy: PolicyConfig, opts: OutlineOptions = {}): string {
  const tokenizer = opts.tokenizer ?? estimateTokens;
  const maxTokens = opts.maxTokens ?? OUTLINE_MAX_TOKENS;
  const byPath = activeHintsByPath(snapshot);
  const blocks: Block[] = [];

  blocks.push(block("header", 0, true, ["GRAPH OUTLINE (this advisor's preference graph; hint ids are the ids you may reference)"]));

  const global = byPath.get(ROOT_PATH) ?? [];
  blocks.push(block("global", 0, false, [`Global hints on / (scope global):${global.length === 0 ? " (none)" : ""}`], global.map((h) => `  ${hintLine(h)}`)));

  const categories = snapshot.nodes
    .filter((n) => n.level === 1 && n.status === "active")
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  blocks.push(
    block(
      "categories",
      1,
      true,
      ["Categories (level 1; path | title | description):", ...categories.map((n) => `  ${nodeLine(n)}`)],
    ),
  );

  const focus = activeFocus(snapshot, focusPaths);
  const shown = new Set<string>();
  focus.forEach((path, i) => {
    const primary = i === 0;
    const chain = [...ancestors(path).filter((p) => p !== ROOT_PATH), path];
    const fresh = chain.filter((p) => !shown.has(p));
    if (fresh.length === 0) return;
    blocks.push(block("focus", 1, primary, [primary ? `Classified path for this evidence: ${path}` : `Also relevant: ${path}`], [], !primary));
    for (const p of fresh) {
      const node = snapshot.nodesByPath.get(p);
      if (node === undefined || node.status !== "active") continue;
      shown.add(p);
      // Only the classified leaf is protected; its ancestors are context and elide deepest-first like any node.
      blocks.push(nodeBlock(node, byPath.get(p) ?? [], primary && p === path, !primary, "  "));
    }
    if (!primary) return;
    const parent = parentPath(path);
    const siblings = snapshot.nodes
      .filter((n) => n.status === "active" && n.parentPath === parent && n.path !== path && n.path !== ROOT_PATH)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (siblings.length > 0) {
      blocks.push(block("focus", depth(path), false, [`Siblings of ${path} (add to one of these rather than creating a near-duplicate):`], [], true));
      for (const s of siblings) blocks.push(block("sibling", s.level, false, [`  ${nodeLine(s)}`], [], true));
    }
  });

  const applied: HintRecord[] = [];
  for (const id of opts.appliedHintIds ?? []) {
    const record = snapshot.recordsById.get(id);
    if (record !== undefined && record.status === "active" && !applied.includes(record)) applied.push(record);
  }
  if (applied.length > 0) {
    blocks.push(block("applied", 0, false, ["Hints applied in the anchor turn (the ones feedback is about):"], applied.map((h) => `  ${hintLine(h)}`)));
  }

  blocks.push(block("slots", 0, true, [knownSlotsLine(knownSlots(snapshot, policy))]));

  return fitToBudget(blocks, maxTokens, tokenizer);
}

/** Elision order among blocks that may go: deepest first, then the kind that costs the model least to lose, then secondary before primary. */
const ELIDE_RANK: Readonly<Record<BlockKind, number>> = Object.freeze({
  sibling: 0,
  node: 1,
  focus: 2,
  applied: 3,
  global: 4,
  header: 9,
  categories: 9,
  slots: 9,
});

function byElisionOrder(a: Block, b: Block): number {
  return b.depth - a.depth || ELIDE_RANK[a.kind] - ELIDE_RANK[b.kind] || Number(b.secondary) - Number(a.secondary);
}

/** A "Classified path" / "Also relevant" / "Siblings" heading with nothing left under it is noise. */
function dropOrphanHeadings(blocks: Block[]): void {
  blocks.forEach((b, i) => {
    if (b.kind !== "focus" || isEmpty(b)) return;
    let j = i + 1;
    let content = false;
    while (j < blocks.length && (blocks[j]?.kind === "node" || blocks[j]?.kind === "sibling")) {
      if (!isEmpty(blocks[j] as Block)) content = true;
      j += 1;
    }
    if (!content) blank(b);
  });
}

/**
 * Elide until the rendered outline fits: optional blocks whole, deepest
 * first; then the classified leaf's hint lines; and as a last resort a
 * hard cut, which the caps on hints per node and depth make unreachable
 * in practice.
 */
function fitToBudget(blocks: Block[], maxTokens: number, tokenizer: Tokenizer): string {
  const fits = (): string | undefined => {
    dropOrphanHeadings(blocks);
    const text = renderAll(blocks);
    return tokenizer(text) <= maxTokens ? text : undefined;
  };
  let text = fits();
  if (text !== undefined) return text;

  for (const b of blocks.filter((x) => !x.required).sort(byElisionOrder)) {
    blank(b);
    text = fits();
    if (text !== undefined) return text;
  }

  for (const b of blocks.filter((x) => x.required && x.kind === "node")) {
    while (b.hints.length > 0) {
      b.hints.pop();
      b.trimmed += 1;
      text = fits();
      if (text !== undefined) return text;
    }
  }

  // Nothing left to elide but the vocabulary itself: cut, so a prompt never
  // grows without bound, and say so.
  const marker = "\n… (outline truncated)";
  const whole = renderAll(blocks);
  let cut = whole.length;
  while (cut > 0 && tokenizer(whole.slice(0, cut) + marker) > maxTokens) cut = Math.floor(cut * 0.9);
  return whole.slice(0, cut) + marker;
}
