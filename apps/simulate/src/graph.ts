/**
 * graph.ts — a flat view of `explain()` and the diff between two of them.
 *
 * The timeline needs to say what each step *changed*, and `explain()` is the
 * only read that sees every row (active, pending, superseded and retired) —
 * recall snapshots drop the last two. So after every step the runner takes an
 * explanation with `includeRetired: true`, flattens it into maps keyed by
 * hint id and node path, and diffs it against the previous one. Rows that
 * appear, vanish, or change status / maturity / confidence / counters become
 * the `+hint`, `-hint`, `~hint` and `+node` lines of the timeline.
 */
import type { ExplainNode, Explanation, HintExplanation, HintRecord, TopicNode } from "@mosphere/wisdom-graph";

export interface GraphView {
  hints: Map<string, HintExplanation>;
  nodes: Map<string, TopicNode>;
  stats: Explanation["stats"];
}

function walk(n: ExplainNode, view: GraphView): void {
  view.nodes.set(n.node.path, n.node);
  for (const h of n.hints) view.hints.set(h.hint.id, h);
  for (const c of n.children) walk(c, view);
}

/** Every hint and node in one explanation, by id and by path. */
export function flatten(e: Explanation): GraphView {
  const view: GraphView = { hints: new Map(), nodes: new Map(), stats: e.stats };
  for (const n of e.tree) walk(n, view);
  for (const h of e.pendingApproval) view.hints.set(h.hint.id, h);
  for (const h of e.retired) view.hints.set(h.hint.id, h);
  return view;
}

export const emptyView = (): GraphView => ({ hints: new Map(), nodes: new Map(), stats: { nodes: 0, activeHints: 0, pending: 0, retired: 0, slots: [] } });

export interface HintChange {
  id: string;
  text: string;
  /** field → [before, after] */
  fields: Record<string, [string, string]>;
}

export interface GraphDiff {
  addedHints: HintRecord[];
  removedHints: HintRecord[];
  changedHints: HintChange[];
  addedNodes: TopicNode[];
  removedNodes: TopicNode[];
  changedNodes: { path: string; fields: Record<string, [string, string]> }[];
}

/** The fields of a hint whose change is worth a timeline line. */
const WATCHED: readonly (keyof HintRecord)[] = ["status", "maturity", "confidence", "approval", "needsReview", "reinforcements", "contradictions", "applied", "source", "text", "value", "nodePath", "retiredReason"];

function show(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

export function diff(before: GraphView, after: GraphView): GraphDiff {
  const out: GraphDiff = { addedHints: [], removedHints: [], changedHints: [], addedNodes: [], removedNodes: [], changedNodes: [] };
  for (const [id, h] of after.hints) {
    const prev = before.hints.get(id);
    if (prev === undefined) {
      out.addedHints.push(h.hint);
      continue;
    }
    const fields: Record<string, [string, string]> = {};
    for (const f of WATCHED) {
      const a = show(prev.hint[f]);
      const b = show(h.hint[f]);
      if (a !== b) fields[f] = [a, b];
    }
    if (Object.keys(fields).length > 0) out.changedHints.push({ id, text: h.hint.text, fields });
  }
  for (const [id, h] of before.hints) if (!after.hints.has(id)) out.removedHints.push(h.hint);
  for (const [path, n] of after.nodes) {
    const prev = before.nodes.get(path);
    if (prev === undefined) {
      out.addedNodes.push(n);
      continue;
    }
    const fields: Record<string, [string, string]> = {};
    if (prev.status !== n.status) fields["status"] = [prev.status, n.status];
    const pp = JSON.stringify(prev.properties);
    const np = JSON.stringify(n.properties);
    if (pp !== np) fields["properties"] = [pp, np];
    const pa = prev.agents.join(",");
    const na = n.agents.join(",");
    if (pa !== na) fields["agents"] = [pa || "—", na || "—"];
    if (Object.keys(fields).length > 0) out.changedNodes.push({ path, fields });
  }
  for (const [path, n] of before.nodes) if (!after.nodes.has(path)) out.removedNodes.push(n);
  out.addedHints.sort((a, b) => a.id.localeCompare(b.id));
  out.changedHints.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** The compact one-line-per-change rendering used by the text timeline. */
export function renderDiff(d: GraphDiff): string[] {
  const lines: string[] = [];
  for (const n of d.addedNodes) lines.push(`+node ${n.path} "${n.title}"`);
  for (const h of d.addedHints) {
    const where = [h.lane, h.scope + (h.agent ? `:${h.agent}` : ""), h.source].join("/");
    lines.push(`+hint "${h.text}" (${h.slot}=${h.value}, ${where}, ${h.status}${h.needsReview ? ", needs-review" : ""}) @${h.nodePath} id=${h.id}`);
  }
  for (const c of d.changedHints) {
    const changes = Object.entries(c.fields).map(([f, [a, b]]) => `${f} ${a}→${b}`).join(" / ");
    lines.push(`~hint ${c.id} "${c.text}": ${changes}`);
  }
  for (const h of d.removedHints) lines.push(`-hint ${h.id} "${h.text}"`);
  for (const c of d.changedNodes) lines.push(`~node ${c.path}: ${Object.entries(c.fields).map(([f, [a, b]]) => `${f} ${a}→${b}`).join(" / ")}`);
  for (const n of d.removedNodes) lines.push(`-node ${n.path}`);
  return lines;
}

/** Hints whose text contains `needle` (case-insensitive), or the one hint with that exact id. */
export function findHints(view: GraphView, ref: { hintText?: string | undefined; hintId?: string | undefined }): HintExplanation[] {
  if (ref.hintId !== undefined) {
    const h = view.hints.get(ref.hintId);
    return h ? [h] : [];
  }
  const needle = (ref.hintText ?? "").toLowerCase();
  if (needle.length === 0) return [];
  return [...view.hints.values()].filter((h) => h.hint.text.toLowerCase().includes(needle));
}

/** For approve/forget: the one hint a reference means — live rows first, then the oldest. */
export function pickHint(view: GraphView, ref: { hintText?: string | undefined; hintId?: string | undefined }): HintExplanation | undefined {
  const rank = (s: HintRecord["status"]): number => (s === "active" ? 0 : s === "pending" ? 1 : 2);
  return findHints(view, ref).sort((a, b) => rank(a.hint.status) - rank(b.hint.status) || a.hint.createdAt.localeCompare(b.hint.createdAt) || a.hint.id.localeCompare(b.hint.id))[0];
}
