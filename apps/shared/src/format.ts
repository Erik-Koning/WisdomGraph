/**
 * format.ts — plain-text renderings of the library's data for terminals,
 * MCP tool results and log lines. No colours, no tables wider than a pane.
 */
import type { Explanation, ExplainNode, HintExplanation, IngestReceipt, Recall } from "@mosphere/wisdom-graph";

function hintLine(h: HintExplanation, indent: string): string {
  const r = h.hint;
  const flags = [r.status, r.approval === "approved" ? "approved" : null, r.needsReview ? "needs-review" : null, r.maturity].filter(Boolean).join(",");
  const where = [r.lane, r.scope, r.agent ? `agent=${r.agent}` : null, r.clientId ? `client=${r.clientId}` : null].filter(Boolean).join("/");
  const sup = h.suppressedBy ? ` ⟵ suppressed by ${h.suppressedBy.hintId} (${h.suppressedBy.rule})` : "";
  return `${indent}• ${r.text}\n${indent}    [${where}] slot=${r.slot}=${JSON.stringify(r.value)} ${r.source} conf=${r.confidence.toFixed(2)} eff=${h.effectiveScore.toFixed(2)} ${flags} id=${r.id}${sup}`;
}

function nodeLines(n: ExplainNode, depth: number, out: string[], opts: { hints: boolean }): void {
  const indent = "  ".repeat(depth);
  const props = Object.keys(n.node.properties).length ? ` props=${JSON.stringify(n.node.properties)}` : "";
  out.push(`${indent}${n.node.path === "/" ? "/ (global)" : n.node.path} — ${n.node.title} · ${n.hints.length} hint${n.hints.length === 1 ? "" : "s"}${n.node.agents.length ? ` agents=${n.node.agents.join(",")}` : ""}${props}`);
  if (opts.hints) for (const h of n.hints) out.push(hintLine(h, indent + "  "));
  for (const c of n.children) nodeLines(c, depth + 1, out, opts);
}

export function formatExplanation(e: Explanation, opts: { hints?: boolean; audit?: number; events?: number } = {}): string {
  const out: string[] = [];
  out.push(`subject ${e.subjectId}${e.tenantId ? ` tenant ${e.tenantId}` : ""} · ${e.stats.nodes} nodes · ${e.stats.activeHints} active · ${e.stats.pending} pending · ${e.stats.retired} retired · slots: ${e.stats.slots.join(", ") || "—"}`);
  for (const n of e.tree) nodeLines(n, 0, out, { hints: opts.hints ?? true });
  if (e.pendingApproval.length) {
    out.push(`pending approval (${e.pendingApproval.length}):`);
    for (const h of e.pendingApproval) out.push(hintLine(h, "  "));
  }
  if (e.retired.length) {
    out.push(`retired (${e.retired.length}):`);
    for (const h of e.retired) out.push(`  • ${h.hint.text} [${h.hint.status === "superseded" ? `superseded by ${h.hint.supersededBy ?? "?"}` : (h.hint.retiredReason ?? h.hint.status)}] id=${h.hint.id}`);
  }
  const events = e.recentEvents.slice(0, opts.events ?? 5);
  if (events.length) {
    out.push(`recent events:`);
    for (const ev of events) out.push(`  ${ev.at} ${ev.kind.padEnd(8)} ${ev.status.padEnd(10)} ${ev.id}${ev.accepted !== undefined ? ` accepted=${ev.accepted}` : ""}${ev.rejected !== undefined ? ` rejected=${ev.rejected}` : ""}`);
  }
  const audit = e.audit.slice(0, opts.audit ?? 5);
  if (audit.length) {
    out.push(`audit:`);
    for (const a of audit) out.push(`  ${a.at} ${a.action.padEnd(16)} ${a.actor}${a.hintId ? ` hint=${a.hintId}` : ""}${a.nodePath ? ` node=${a.nodePath}` : ""}`);
  }
  if (e.trace) {
    out.push(`dry-run recall: topic=${e.trace.topic.category} (${e.trace.topic.confidence.toFixed(2)}, ${e.trace.topic.method}) paths=${e.trace.topic.nodePaths.join(",") || "—"}`);
    for (const c of e.trace.candidates) out.push(`  ${c.outcome.padEnd(10)} ${c.hintId} rel=${c.relevance.toFixed(2)} eff=${c.effective.toFixed(2)}${c.rule ? ` ${c.rule}` : ""}${c.reason ? ` ${c.reason}` : ""}`);
  }
  return out.join("\n");
}

export function formatRecall(r: Recall): string {
  const lanes = [
    `preRoute ${r.preRoute.length}`,
    `agent ${Object.entries(r.agentHints).map(([a, hs]) => `${a}:${hs.length}`).join(" ") || "—"}`,
    `responseStyle ${r.responseStyle.length}`,
  ].join(" · ");
  return `recall ${r.meta.status}${r.meta.reason ? `/${r.meta.reason}` : ""} · topic=${r.topic.category} (${r.topic.confidence.toFixed(2)}, ${r.topic.method}) agents=[${r.topic.agents.join(",")}] · ${lanes} · ${r.charter.tokenEstimate} tok · ${r.meta.cache} ${r.meta.elapsedMs}ms · suppressed=${r.charter.suppressed.length} dropped=${r.charter.dropped.length}`;
}

export function formatReceipt(r: IngestReceipt): string {
  return `ingest ${r.eventId}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`;
}
