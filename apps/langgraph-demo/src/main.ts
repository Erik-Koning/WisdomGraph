/**
 * main.ts — REPL and script runner around the supervisor-shaped graph.
 *
 * Per turn, exactly what the host app's chat.ts does (spec §8.2, §8.4):
 *
 *   1. build a RecallRequest from the LangChain history via toNeutralMessages
 *   2. handle = startTurnRecall(h.graph, req)          — recall starts now, nothing awaits it
 *   3. await scope.run(handle, () => app.invoke(...))   — the graph reads Lane A/B inside
 *   4. print the answer
 *   5. ingest a TurnEvent: agentsUsed = the specialists that ran,
 *      appliedHintIds = (await handle.base).provenance   — never awaited by the answer path in the host app;
 *                                                          awaited here so the receipt is visible
 *
 *   npm run start -w @wisdom-graph/langgraph-demo                 REPL
 *   npm run smoke -w @wisdom-graph/langgraph-demo                 offline script (scripts/smoke.txt)
 *   tsx src/main.ts --script <file>                               lines are input; `#` comments; exit 0/1
 *
 * Commands: /up  /down [text]  /comment <text>  /correct <text>  (feedback on the last run)
 *           /remember <text>   /explain [query]   /hints   /route   /quit
 *           /expect <substring> (script mode: assert on the last printed block; a miss fails the run)
 *
 * stdout carries the conversation; every log line goes to stderr.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { FeedbackSignal, Recall, RecallRequest } from "@mosphere/wisdom-graph";
import { startTurnRecall, toNeutralMessages } from "@mosphere/wisdom-graph/langgraph";
import { createHarness, formatExplanation, formatReceipt, formatRecall } from "@wisdom-graph/harness";
import { buildGraph, DIRECT, type NodeTrace } from "./graph";
import { createModels } from "./models";
import { scope } from "./scope";

interface LastRun {
  runId: string;
  text: string;
  answer: string;
  route: string[];
  trace: NodeTrace[];
  agentsUsed: string[];
  recall: Recall;
}

const args = process.argv.slice(2);
const scriptIdx = args.indexOf("--script");
const scriptPath = scriptIdx >= 0 ? args[scriptIdx + 1] : undefined;
if (scriptIdx >= 0 && scriptPath === undefined) {
  process.stderr.write("usage: tsx src/main.ts [--script <file>]\n");
  process.exit(2);
}

const h = await createHarness();
const models = createModels(h);
const app = buildGraph(h, models);
const { subjectId, clientId } = h.cfg;
const modelName = models.kind === "anthropic" ? h.cfg.model : "fake";

let history: BaseMessage[] = [];
let lastRun: LastRun | null = null;
let lastOutput = "";
let seq = 0;
let failed = false;

function out(text: string): void {
  lastOutput = text;
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

// ── One turn through the graph ───────────────────────────────────────────────

async function turn(text: string): Promise<void> {
  const runId = nextId("run");
  const req: RecallRequest = {
    subjectId,
    clientId,
    text,
    recentTurns: toNeutralMessages(history, { last: 6 }), // live HumanMessage/AIMessage objects in, neutral turns out
    budgetMs: 2500,
    requestId: runId,
  };
  const handle = startTurnRecall(h.graph, req, { logger: h.logger });
  const result = await scope.run(handle, () => app.invoke({ messages: [...history, new HumanMessage(text)] }));
  history = result.messages;
  out(result.answer);

  const recall = await handle.base;
  const agentsUsed = result.route.filter((r) => r !== DIRECT);
  const receipt = await h.graph.ingest({
    type: "turn",
    id: `turn_${runId}`,
    runId,
    subjectId,
    clientId,
    category: result.route[0] ?? DIRECT,
    agentsUsed,
    userText: text,
    assistantText: result.answer,
    model: modelName,
    appliedHintIds: recall.provenance,
  });
  process.stderr.write(`[ingest] ${formatReceipt(receipt)} agentsUsed=${agentsUsed.join(",") || "—"} appliedHintIds=${recall.provenance.length}\n`);
  lastRun = { runId, text, answer: result.answer, route: result.route, trace: result.trace, agentsUsed, recall };
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function feedback(signal: FeedbackSignal, text: string): Promise<void> {
  if (lastRun === null) return out("no run to give feedback on yet — ask something first");
  const receipt = await h.graph.ingest({
    type: "feedback",
    id: nextId("fb"),
    runId: lastRun.runId,
    subjectId,
    clientId,
    signal,
    ...(text ? { text } : {}),
    target: "response",
  });
  out(`${formatReceipt(receipt)} · ${signal} on ${lastRun.runId}`);
}

/** A standalone preference: anchored to a synthetic turn so the feedback is processed now rather than deferred waiting for one. */
async function remember(text: string): Promise<void> {
  if (!text) return out("usage: /remember <preference>");
  const runId = nextId("run_remember");
  await h.graph.ingest(
    { type: "turn", id: `turn_${runId}`, runId, subjectId, clientId, category: DIRECT, agentsUsed: [], userText: text, assistantText: "Noted.", model: modelName },
    { extract: "skip" },
  );
  const receipt = await h.graph.ingest({ type: "feedback", id: `fb_${runId}`, runId, subjectId, clientId, signal: "comment", text });
  out(formatReceipt(receipt));
}

async function explain(query: string): Promise<void> {
  const e = await h.graph.explain(subjectId, { clientId, ...(query ? { text: query } : {}) });
  out(formatExplanation(e, { hints: true, audit: 3, events: 3 }));
}

function hints(): void {
  if (lastRun === null) return out("no run yet");
  const lines = [formatRecall(lastRun.recall)];
  for (const t of lastRun.trace) {
    lines.push(`[${t.node}] lane=${t.lane} recall=${t.recall} blocks=${t.blocks} hints=${t.hints.length} ${t.endedAt - t.startedAt}ms`);
    for (const hint of t.hints) lines.push(`    • ${hint}`);
  }
  out(lines.join("\n"));
}

function route(): void {
  if (lastRun === null) return out("no run yet");
  const { route: r, trace } = lastRun;
  const mode = r[0] === DIRECT ? "direct" : r.length === 1 ? "single" : "fanout";
  const synth = trace.some((t) => t.node === "synthesize") ? "ran" : "skipped";
  const specialists = trace.filter((t) => r.includes(t.node));
  let parallel = "n/a";
  if (specialists.length >= 2) {
    const overlap = Math.min(...specialists.map((t) => t.endedAt)) - Math.max(...specialists.map((t) => t.startedAt));
    parallel = overlap > 0 ? `yes overlap=${overlap}ms` : `no gap=${-overlap}ms`;
  }
  out(`route=${r.join(",")} mode=${mode} synthesize=${synth} parallel=${parallel} nodes=${trace.map((t) => t.node).join(">")}`);
}

/** True when the line asked to quit. */
async function handle(line: string): Promise<boolean> {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return false;
  if (!trimmed.startsWith("/")) {
    await turn(trimmed);
    return false;
  }
  const space = trimmed.indexOf(" ");
  const cmd = space < 0 ? trimmed : trimmed.slice(0, space);
  const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();
  switch (cmd) {
    case "/up": await feedback("up", rest); break;
    case "/down": await feedback("down", rest); break;
    case "/comment": await feedback("comment", rest); break;
    case "/correct": await feedback("correction", rest); break;
    case "/remember": await remember(rest); break;
    case "/explain": await explain(rest); break;
    case "/hints": hints(); break;
    case "/route": route(); break;
    case "/expect": {
      const ok = lastOutput.includes(rest);
      if (!ok) failed = true;
      process.stdout.write(`${ok ? "expect ok" : "EXPECT FAILED"}: ${JSON.stringify(rest)}\n`);
      break;
    }
    case "/quit": case "/exit": return true;
    default: out(`unknown command ${cmd} — /up /down [text] /comment <text> /correct <text> /remember <text> /explain [query] /hints /route /quit`);
  }
  return false;
}

// ── Entry ────────────────────────────────────────────────────────────────────

process.stdout.write(`${h.banner()}\nmodels: ${models.describe}\n`);

if (scriptPath !== undefined) {
  try {
    for (const line of readFileSync(scriptPath, "utf8").split("\n")) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      process.stdout.write(`> ${line.trim()}\n`);
      if (await handle(line)) break;
    }
  } catch (e) {
    failed = true;
    process.stderr.write(`script failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  }
  await h.close();
  process.stdout.write(failed ? "SMOKE FAILED\n" : "SMOKE OK\n");
  process.exit(failed ? 1 : 0);
}

// Readline emits buffered lines at once (a paste, a pipe), so lines are handled strictly in order
// through one promise chain, and `close` drains that chain before the store is flushed.
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
let queue: Promise<void> = Promise.resolve();
rl.prompt();
rl.on("line", (line) => {
  queue = queue
    .then(() => handle(line))
    .then((quit) => {
      if (quit) rl.close();
      else rl.prompt();
    })
    .catch((e: unknown) => {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      rl.prompt();
    });
});
rl.on("close", () => {
  void queue.then(() => h.close()).then(() => process.exit(0));
});
