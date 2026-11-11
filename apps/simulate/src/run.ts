/**
 * run.ts — plays a scenario against a real engine on a fake clock.
 *
 * The engine is the shared harness (`createHarness`) with two ports swapped:
 *
 *   clock — a `FakeClock` that starts at the scenario's `startAt`, ticks one
 *           minute per step so rows get distinct timestamps, and jumps when a
 *           step says `advanceDays` / `advanceMs`. Decay, retirement and
 *           promotion are pure functions of this clock, so a 400-day story
 *           plays in milliseconds.
 *   llm   — a scripted port: when the current step carries a `proposal`, the
 *           next `extract` call returns it verbatim; otherwise the call falls
 *           through to whatever the harness would have used (the offline
 *           heuristic, or the real model when credentials are present and
 *           WISDOM_OFFLINE is off). Consolidation calls always fall through.
 *
 * Every step yields a `TimelineEntry`: what ran, what the clock said, the
 * diff of the graph against the previous step, receipts and any expectation
 * results. The CLI renders those as text or JSON lines.
 */
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileAgentPreamble,
  compilePreRoute,
  compileResponseStyle,
  type HintExplanation,
  type IngestReceipt,
  type LlmPort,
  type Proposal,
  type Recall,
} from "@mosphere/wisdom-graph";
import { FakeClock } from "@mosphere/wisdom-graph/testing";
import { createHarness, createLlmPort, createLogger, formatRecall, formatReceipt, loadConfig, REPO_ROOT, type Harness } from "@wisdom-graph/harness";
import { diff, emptyView, findHints, flatten, pickHint, renderDiff, type GraphDiff, type GraphView } from "./graph";
import { DEFAULT_START_AT, stepKind, type GraphExpect, type RecallExpect, type Scenario, type Step, type StepKind } from "./scenario";

// ── Scripted extraction port ────────────────────────────────────────────────

/**
 * Returns the queued proposal on the next `extract` call, else defers to the
 * fallback port. One proposal is queued per step, so a proposal that is never
 * consumed (the triage gate said no, or the ingest was rejected) is reported
 * on the step rather than leaking into a later one.
 */
class ScriptedLlm implements LlmPort {
  private queued: Proposal | null = null;
  /** Calls made since `arm()` — the runner reports `extract` calls per step. */
  calls: { purpose: string; scripted: boolean }[] = [];

  constructor(private readonly fallback: LlmPort) {}

  arm(proposal: Proposal | undefined): void {
    this.queued = proposal ?? null;
    this.calls = [];
  }

  /** The proposal left unconsumed by the step, if any. */
  disarm(): Proposal | null {
    const left = this.queued;
    this.queued = null;
    return left;
  }

  async complete(prompt: string, opts: Parameters<LlmPort["complete"]>[1]): Promise<string> {
    const purpose = opts.purpose ?? "extract";
    if (purpose === "extract" && this.queued !== null) {
      const reply = this.queued;
      this.queued = null;
      this.calls.push({ purpose, scripted: true });
      return JSON.stringify(reply);
    }
    this.calls.push({ purpose, scripted: false });
    return this.fallback.complete(prompt, opts);
  }
}

// ── Timeline ────────────────────────────────────────────────────────────────

export interface ExpectationResult {
  ok: boolean;
  what: string;
  expected: string;
  actual: string;
}

export interface TimelineEntry {
  step: number;
  kind: StepKind;
  /** ISO clock reading after the step. */
  at: string;
  /** One-line summary of what the step did (receipt, report, recall line, note). */
  summary: string[];
  /** Extra lines shown only with --verbose (rendered artifacts, reports). */
  detail: string[];
  diff: GraphDiff;
  diffLines: string[];
  expectations: ExpectationResult[];
  warnings: string[];
}

export interface RunOptions {
  scenario: Scenario;
  storeFile?: string;
  verbose?: boolean;
  onEntry?: (entry: TimelineEntry) => void;
}

export interface RunResult {
  entries: TimelineEntry[];
  failures: { step: number; kind: StepKind; result: ExpectationResult }[];
  harness: Harness;
  subjectId: string;
  clientId: string | null;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const RECALL_BUDGET_MS = 2_500;

function fmtDays(n: number): string {
  return Number.isInteger(n) ? `${n} d` : `${n.toFixed(2)} d`;
}

/** Why candidates fell out of the charter — appended to the recall line when anything did. */
function charterLosses(recall: Recall): string {
  const parts: string[] = [];
  if (recall.charter.suppressed.length) parts.push(`suppressed: ${recall.charter.suppressed.map((s) => `${s.hintId} by ${s.by} (${s.rule})`).join(", ")}`);
  if (recall.charter.dropped.length) parts.push(`dropped: ${recall.charter.dropped.map((d) => `${d.hintId} (${d.reason})`).join(", ")}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** The three lanes as a prompt would see them, for `includes` / `excludes` checks. */
function renderArtifacts(recall: Recall, agent: string | undefined): { text: string; agents: string[] } {
  const agents = new Set<string>();
  if (agent !== undefined) agents.add(agent);
  for (const a of recall.topic.agents) agents.add(a);
  for (const a of Object.keys(recall.agentHints)) agents.add(a);
  if (agents.size === 0 && recall.topic.category !== "direct") agents.add(recall.topic.category);
  if (agents.size === 0) agents.add("default");
  const parts = [compilePreRoute(recall)];
  for (const a of agents) parts.push(compileAgentPreamble(recall, a));
  parts.push(compileResponseStyle(recall));
  return { text: parts.filter((p) => p.length > 0).join("\n"), agents: [...agents] };
}

// ── Expectations ────────────────────────────────────────────────────────────

function checkRecall(recall: Recall, rendered: string, expect: RecallExpect): ExpectationResult[] {
  const out: ExpectationResult[] = [];
  if (expect.category !== undefined) {
    out.push({ ok: recall.topic.category === expect.category, what: "recall.category", expected: expect.category, actual: recall.topic.category });
  }
  const lower = rendered.toLowerCase();
  for (const s of expect.includes ?? []) {
    out.push({ ok: lower.includes(s.toLowerCase()), what: "recall.includes", expected: `"${s}" in rendered artifacts`, actual: lower.includes(s.toLowerCase()) ? "present" : `absent from:\n${rendered || "(empty)"}` });
  }
  for (const s of expect.excludes ?? []) {
    out.push({ ok: !lower.includes(s.toLowerCase()), what: "recall.excludes", expected: `"${s}" not in rendered artifacts`, actual: lower.includes(s.toLowerCase()) ? `present in:\n${rendered}` : "absent" });
  }
  const n = recall.charter.entries.length;
  if (expect.minHints !== undefined) out.push({ ok: n >= expect.minHints, what: "recall.minHints", expected: `≥ ${expect.minHints}`, actual: String(n) });
  if (expect.maxHints !== undefined) out.push({ ok: n <= expect.maxHints, what: "recall.maxHints", expected: `≤ ${expect.maxHints}`, actual: String(n) });
  return out;
}

function describeMatches(view: GraphView, needle: string, field: (h: HintExplanation) => string): string {
  const matches = findHints(view, { hintText: needle });
  if (matches.length === 0) return "no hint matches";
  return matches.map((h) => `"${h.hint.text}" → ${field(h)} (id=${h.hint.id})`).join("; ");
}

function checkGraph(view: GraphView, expect: GraphExpect): ExpectationResult[] {
  const out: ExpectationResult[] = [];
  const count = (what: keyof Pick<GraphExpect, "activeHints" | "retired" | "pending" | "nodes">, actual: number): void => {
    const e = expect[what];
    if (e !== undefined) out.push({ ok: actual === e, what: `expect.${what}`, expected: String(e), actual: String(actual) });
  };
  count("activeHints", view.stats.activeHints);
  count("retired", view.stats.retired);
  count("pending", view.stats.pending);
  count("nodes", view.stats.nodes);
  for (const [needle, status] of Object.entries(expect.hintStatus ?? {})) {
    const matches = findHints(view, { hintText: needle });
    const ok = status === "absent" ? matches.length === 0 : matches.some((h) => h.hint.status === status);
    out.push({ ok, what: `expect.hintStatus["${needle}"]`, expected: status, actual: describeMatches(view, needle, (h) => h.hint.status) });
  }
  for (const [needle, maturity] of Object.entries(expect.maturity ?? {})) {
    const matches = findHints(view, { hintText: needle }).filter((h) => h.hint.status === "active" || h.hint.status === "pending");
    out.push({ ok: matches.some((h) => h.hint.maturity === maturity), what: `expect.maturity["${needle}"]`, expected: maturity, actual: describeMatches(view, needle, (h) => `${h.hint.maturity} (${h.hint.status})`) });
  }
  for (const [needle, flag] of Object.entries(expect.needsReview ?? {})) {
    const matches = findHints(view, { hintText: needle }).filter((h) => h.hint.status === "active" || h.hint.status === "pending");
    out.push({ ok: matches.length > 0 && matches.some((h) => h.hint.needsReview === flag), what: `expect.needsReview["${needle}"]`, expected: String(flag), actual: describeMatches(view, needle, (h) => `needsReview=${h.hint.needsReview} (${h.hint.status})`) });
  }
  for (const [needle, min] of Object.entries(expect.reinforcements ?? {})) {
    const matches = findHints(view, { hintText: needle });
    out.push({ ok: matches.some((h) => h.hint.reinforcements >= min), what: `expect.reinforcements["${needle}"]`, expected: `≥ ${min}`, actual: describeMatches(view, needle, (h) => `${h.hint.reinforcements} (${h.hint.status})`) });
  }
  for (const [needle, bounds] of Object.entries(expect.decay ?? {})) {
    const matches = findHints(view, { hintText: needle }).filter((h) => h.hint.status === "active");
    const within = (w: number): boolean => (bounds.below === undefined || w < bounds.below) && (bounds.above === undefined || w > bounds.above);
    const expected = [bounds.above !== undefined ? `> ${bounds.above}` : null, bounds.below !== undefined ? `< ${bounds.below}` : null].filter(Boolean).join(" and ");
    out.push({ ok: matches.some((h) => within(h.decayWeight)), what: `expect.decay["${needle}"]`, expected, actual: describeMatches(view, needle, (h) => `decay=${h.decayWeight.toFixed(3)} (${h.hint.status})`) });
  }
  if (expect.nodeExists !== undefined) {
    const node = view.nodes.get(expect.nodeExists);
    out.push({ ok: node !== undefined && node.status === "active", what: "expect.nodeExists", expected: `${expect.nodeExists} active`, actual: node === undefined ? `absent (nodes: ${[...view.nodes.keys()].join(", ")})` : node.status });
  }
  for (const [path, props] of Object.entries(expect.properties ?? {})) {
    const node = view.nodes.get(path);
    for (const [key, value] of Object.entries(props)) {
      const actual = node?.properties[key];
      out.push({ ok: node !== undefined && JSON.stringify(actual) === JSON.stringify(value), what: `expect.properties["${path}"]["${key}"]`, expected: JSON.stringify(value), actual: node === undefined ? "node absent" : actual === undefined ? `key absent (properties: ${JSON.stringify(node.properties)})` : JSON.stringify(actual) });
    }
  }
  return out;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const { scenario } = opts;
  const startMs = Date.parse(scenario.startAt ?? DEFAULT_START_AT);
  const clock = new FakeClock(startMs);

  const storeFile = resolve(REPO_ROOT, opts.storeFile ?? `.wisdom/sim-${scenario.name}.json`);
  if (existsSync(storeFile)) unlinkSync(storeFile);

  const cfg = loadConfig({
    storeFile,
    ...(scenario.subjectId !== undefined ? { subjectId: scenario.subjectId } : {}),
    ...(scenario.clientId !== undefined ? { clientId: scenario.clientId } : {}),
  });
  const logger = createLogger(cfg.logLevel);
  const llm = new ScriptedLlm(createLlmPort(cfg, logger));
  const harness = await createHarness({ config: cfg, clock, llm, inline: true });
  const { graph } = harness;
  const subjectId = cfg.subjectId;
  const clientId = cfg.clientId;
  process.stderr.write(`${harness.banner()} · clock=${clock.iso()} · extractor=${cfg.offline ? "scripted → offline heuristic" : `scripted → ${cfg.model}`}\n`);

  const entries: TimelineEntry[] = [];
  const failures: RunResult["failures"] = [];
  let previous = emptyView();
  let lastRunId: string | null = null;
  let lastTurnAgents: string[] = [];

  const explainAll = async (): Promise<GraphView> => flatten(await graph.explain(subjectId, { clientId, includeRetired: true }));

  const receiptLine = (r: IngestReceipt, expl: { accepted?: number; rejected?: number } | undefined): string => {
    const counts = expl ? ` accepted=${expl.accepted ?? 0} rejected=${expl.rejected ?? 0}` : "";
    return `${formatReceipt(r)}${counts}`;
  };

  for (let i = 0; i < scenario.steps.length; i += 1) {
    const step = scenario.steps[i] as Step;
    const kind = stepKind(step);
    const n = i + 1;
    if (i > 0) clock.tick(MINUTE_MS);
    const entry: TimelineEntry = { step: n, kind, at: clock.iso(), summary: [], detail: [], diff: diff(previous, previous), diffLines: [], expectations: [], warnings: [] };

    switch (kind) {
      case "note": {
        entry.summary.push((step as { note: string }).note);
        break;
      }
      case "advanceDays": {
        const days = (step as { advanceDays: number }).advanceDays;
        clock.tick(days * DAY_MS);
        entry.summary.push(`clock +${fmtDays(days)} → ${clock.iso()}`);
        break;
      }
      case "advanceMs": {
        const ms = (step as { advanceMs: number }).advanceMs;
        clock.tick(ms);
        entry.summary.push(`clock +${ms} ms → ${clock.iso()}`);
        break;
      }
      case "turn": {
        const t = (step as Extract<Step, { turn: unknown }>).turn;
        const runId = `run_${n}`;
        let applied: string[] = [];
        let agentsUsed = t.agentsUsed ?? [];
        if (t.recall) {
          const recall = await graph.recall({ subjectId, clientId, text: t.user, budgetMs: RECALL_BUDGET_MS });
          applied = [...recall.provenance];
          if (agentsUsed.length === 0) agentsUsed = [...recall.topic.agents];
          entry.summary.push(`${formatRecall(recall)}${charterLosses(recall)} · applied=[${applied.join(",")}]`);
          if (opts.verbose) entry.detail.push(renderArtifacts(recall, agentsUsed[0]).text || "(no artifacts rendered)");
        }
        llm.arm(t.proposal);
        const extract = t.extract ?? (t.proposal !== undefined ? "force" : "auto");
        const receipt = await graph.ingest(
          {
            type: "turn",
            id: `turn_${n}`,
            runId,
            subjectId,
            clientId,
            agentsUsed,
            userText: t.user,
            assistantText: t.assistant ?? "(scripted assistant reply)",
            appliedHintIds: applied,
          },
          { waitFor: "processed", extract },
        );
        const left = llm.disarm();
        lastRunId = runId;
        lastTurnAgents = agentsUsed;
        const ev = (await graph.explain(subjectId, { clientId })).recentEvents.find((e) => e.id === `turn_${n}`);
        entry.summary.push(`${receiptLine(receipt, ev)} · extract=${extract} · llm=${llm.calls.map((c) => `${c.purpose}${c.scripted ? "(scripted)" : "(fallback)"}`).join(",") || "none"}`);
        if (left !== null) entry.warnings.push("scripted proposal was not consumed: the extractor was never called for this turn (triage gate said no, or the event was rejected)");
        break;
      }
      case "feedback": {
        const f = (step as Extract<Step, { feedback: unknown }>).feedback;
        if (lastRunId === null) {
          entry.warnings.push("feedback before any turn: ingested unanchored (no runId to attach to)");
        }
        const runId = lastRunId ?? `run_unanchored_${n}`;
        llm.arm(f.proposal);
        const receipt = await graph.ingest(
          {
            type: "feedback",
            id: `fb_${n}`,
            runId,
            subjectId,
            clientId,
            signal: f.signal,
            ...(f.text !== undefined ? { text: f.text } : {}),
            ...(f.target !== undefined ? { target: f.target } : {}),
          },
          { waitFor: "processed" },
        );
        const left = llm.disarm();
        const ev = (await graph.explain(subjectId, { clientId })).recentEvents.find((e) => e.id === `fb_${n}`);
        entry.summary.push(`${receiptLine(receipt, ev)} · signal=${f.signal}${f.target ? ` target=${f.target}` : ""} run=${runId} · llm=${llm.calls.map((c) => `${c.purpose}${c.scripted ? "(scripted)" : "(fallback)"}`).join(",") || "none"}`);
        if (left !== null) entry.warnings.push("scripted proposal was not consumed: the extractor was never called for this feedback");
        break;
      }
      case "consolidate": {
        const r = await graph.maintenance.consolidate(subjectId);
        entry.summary.push(`consolidate: merged=${r.merged} promoted=${r.promoted} retired=${r.retired} ops=${r.opsAccepted}/${r.opsAccepted + r.opsRejected} llm=${r.usedLlm}`);
        break;
      }
      case "maintain": {
        const r = await graph.maintenance.maintain({ subjectId });
        entry.summary.push(`maintain: examined=${r.examined} promoted=${r.promoted} retired=${r.retired} merged=${r.merged} nodesRetired=${r.nodesRetired} purgedEvents=${r.purgedEvents}`);
        break;
      }
      case "drain": {
        const r = await graph.maintenance.drain();
        entry.summary.push(`drain: processed=${r.processed} failed=${r.failed}`);
        break;
      }
      case "approve": {
        const a = (step as Extract<Step, { approve: unknown }>).approve;
        const target = pickHint(previous, a);
        if (target === undefined) {
          entry.expectations.push({ ok: false, what: "approve", expected: `a hint matching ${JSON.stringify(a.hintText ?? a.hintId)}`, actual: "no such hint" });
          break;
        }
        const status = a.status ?? "approved";
        await graph.approve(subjectId, target.hint.id, { status, by: "simulate", note: `scenario ${scenario.name} step ${n}` });
        entry.summary.push(`${status}: "${target.hint.text}" (${target.hint.id})`);
        break;
      }
      case "forget": {
        const f = (step as Extract<Step, { forget: unknown }>).forget;
        if ("subject" in f && f.subject === true) {
          await graph.forget(subjectId, undefined, { actor: "simulate" });
          entry.summary.push(`forgot subject ${subjectId}`);
          break;
        }
        const target = pickHint(previous, f);
        if (target === undefined) {
          entry.expectations.push({ ok: false, what: "forget", expected: `a hint matching ${JSON.stringify(f.hintText ?? f.hintId)}`, actual: "no such hint" });
          break;
        }
        await graph.forget(subjectId, target.hint.id, { actor: "simulate", reason: `scenario ${scenario.name} step ${n}` });
        entry.summary.push(`forgot "${target.hint.text}" (${target.hint.id})`);
        break;
      }
      case "recall": {
        const r = (step as Extract<Step, { recall: unknown }>).recall;
        const recall = await graph.recall({ subjectId, clientId, text: r.text, budgetMs: RECALL_BUDGET_MS, ...(r.approvedOnly !== undefined ? { approvedOnly: r.approvedOnly } : {}) });
        const { text, agents } = renderArtifacts(recall, r.agent ?? lastTurnAgents[0]);
        entry.summary.push(`${formatRecall(recall)}${r.approvedOnly ? " · approvedOnly" : ""}${charterLosses(recall)} · rendered for agents=[${agents.join(",")}]`);
        entry.detail.push(text || "(no artifacts rendered)");
        if (r.expect) entry.expectations.push(...checkRecall(recall, text, r.expect));
        break;
      }
      case "expect": {
        entry.expectations.push(...checkGraph(await explainAll(), (step as Extract<Step, { expect: unknown }>).expect));
        break;
      }
    }

    const view = await explainAll();
    entry.at = clock.iso();
    entry.diff = diff(previous, view);
    entry.diffLines = renderDiff(entry.diff);
    previous = view;
    for (const r of entry.expectations) if (!r.ok) failures.push({ step: n, kind, result: r });
    entries.push(entry);
    opts.onEntry?.(entry);
  }

  return { entries, failures, harness, subjectId, clientId };
}
