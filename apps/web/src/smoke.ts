/**
 * smoke.ts — offline end-to-end check of the web app through its HTTP API.
 *
 * Starts the same server the page uses on a random port, then drives it with
 * fetch the way the page does: config → chat → remember a preference → chat
 * again (the reply and the compiled responseStyle block must now carry it) →
 * up / down feedback → explain → approve → forget → consolidate → stats, and
 * finally checks that `/` is HTML. Exit 0 when every assertion holds, 1 with
 * the failed assertion otherwise; the harness is always closed.
 *
 *   npm run smoke -w @wisdom-graph/web       (WISDOM_OFFLINE=1, own store file)
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, REPO_ROOT } from "@wisdom-graph/harness";
import { createWebApp, type ChatResult } from "./server";

const SUBJECT = "smoke_web";
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

class AssertionFailed extends Error {}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionFailed(message);
}

type Json = Record<string, unknown>;
type HintRow = { hint: { id: string; text: string; status: string; approval: string; lane: string } };
type ExplainJson = {
  stats: { nodes: number; activeHints: number; pending: number; retired: number; slots: string[] };
  tree: { node: { path: string }; hints: HintRow[]; children: unknown[] }[];
  recentEvents: unknown[];
  audit: { action: string; hintId?: string }[];
  trace?: { topic: { category: string }; candidates: { outcome: string }[] };
  text: string;
};

const storeFile = resolve(REPO_ROOT, process.env["WISDOM_STORE_FILE"] ?? ".wisdom/smoke-web.json");
rmSync(storeFile, { force: true });

const h = await createHarness({ config: { offline: true, storeFile, subjectId: SUBJECT, clientId: null } });
const app = createWebApp(h);
const port = await app.listen(0);
const base = `http://127.0.0.1:${port}`;
log(`smoke: ${base} · ${h.banner()}`);

async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(data as Json)["error"] as string}`);
  return data as T;
}
const chat = (text: string): Promise<ChatResult> => call<ChatResult>("POST", "/api/chat", { text, subjectId: SUBJECT });
const explain = (query?: string): Promise<ExplainJson> =>
  call<ExplainJson>("GET", `/api/explain?subjectId=${SUBJECT}&includeRetired=1${query ? `&query=${encodeURIComponent(query)}` : ""}`);
const activeHints = (e: ExplainJson): HintRow[] => {
  const out: HintRow[] = [];
  const walk = (nodes: ExplainJson["tree"]): void => {
    for (const n of nodes) {
      for (const hint of n.hints) if (hint.hint.status === "active") out.push(hint);
      walk(n.children as ExplainJson["tree"]);
    }
  };
  walk(e.tree);
  return out;
};

let exitCode = 0;
try {
  // 1. config
  const cfg = await call("GET", `/api/config?subjectId=${SUBJECT}`);
  assert(cfg["offline"] === true, "config.offline should be true under the smoke");
  assert(cfg["subjectId"] === SUBJECT, `config.subjectId should echo the query (${String(cfg["subjectId"])})`);
  assert(Array.isArray(cfg["categories"]) && (cfg["categories"] as unknown[]).length > 0, "config.categories should be non-empty");
  log("config ok");

  // 2. first chat: no preferences yet
  const first = await chat("how do I fix a typescript error");
  assert(first.recall.topic.category === "assist_code", `first turn should route to assist_code, got ${first.recall.topic.category}`);
  assert(first.injected.responseStyle === "", "responseStyle should be empty before any preference is stored");
  assert(first.receipt.status === "processed", `turn ingest should be processed, got ${first.receipt.status}`);
  assert(/no preferences yet/i.test(first.reply), "offline reply should say it carries no preferences yet");
  log(`chat #1 ok · ${first.recall.summary}`);

  // 3. remember
  const mem = await call("POST", "/api/remember", { text: "shorter answers, bullet points, no disclaimers", subjectId: SUBJECT });
  const memFeedback = mem["feedback"] as Json;
  assert(memFeedback["status"] === "processed", `remember feedback should be processed, got ${String(memFeedback["status"])}`);
  log("remember ok");

  // 4. second chat: the preferences must now be injected
  const second = await chat("how do I fix a typescript error");
  assert(/preferences?/i.test(second.reply), "second reply should mention the preferences in its prompt");
  assert(/bullet/i.test(second.injected.responseStyle), `injected.responseStyle should contain "bullet":\n${second.injected.responseStyle}`);
  assert(/disclaimer/i.test(second.injected.agent), `injected.agent should carry the disclaimers constraint:\n${second.injected.agent}`);
  assert(second.recall.laneCounts.responseStyle >= 2, `expected ≥ 2 responseStyle hints, got ${second.recall.laneCounts.responseStyle}`);
  assert(second.recall.provenance.length >= 3, `expected ≥ 3 provenance ids, got ${second.recall.provenance.length}`);
  assert(second.systemPrompt.includes(second.injected.responseStyle), "systemPrompt should embed the responseStyle block");
  log(`chat #2 ok · ${second.recall.summary}`);

  // 5. feedback up, then down with text
  const up = await call("POST", "/api/feedback", { runId: second.runId, signal: "up", subjectId: SUBJECT });
  assert((up["receipt"] as Json)["status"] === "processed", `up feedback should be processed, got ${JSON.stringify(up["receipt"])}`);
  const down = await call("POST", "/api/feedback", { runId: second.runId, signal: "down", text: "too long, and call me Erik", subjectId: SUBJECT });
  assert((down["receipt"] as Json)["status"] === "processed", `down feedback should be processed, got ${JSON.stringify(down["receipt"])}`);
  log("feedback ok");

  // 6. explain (with a dry-run query)
  const e1 = await explain("typescript error");
  assert(e1.stats.activeHints >= 2, `expected ≥ 2 active hints after remember, got ${e1.stats.activeHints}`);
  assert(e1.trace !== undefined && e1.trace.topic.category === "assist_code", "explain trace should classify the dry-run query as assist_code");
  assert(e1.trace.candidates.some((c) => c.outcome === "kept"), "explain trace should keep at least one candidate");
  assert(e1.recentEvents.length >= 4, `expected ≥ 4 recent events, got ${e1.recentEvents.length}`);
  assert(typeof e1.text === "string" && e1.text.startsWith(`subject ${SUBJECT}`), "explain.text should be the formatted explanation");
  const active = activeHints(e1);
  assert(active.length >= 2, `expected ≥ 2 active hints in the tree, got ${active.length}`);
  log(`explain ok · ${e1.stats.activeHints} active · slots ${e1.stats.slots.join(",")}`);

  // 7. approve one, forget another
  const [toApprove, toForget] = active;
  assert(toApprove !== undefined && toForget !== undefined, "need two active hints for approve/forget");
  const approved = await call("POST", `/api/hint/${toApprove.hint.id}/approve`, { status: "approved", by: "smoke", subjectId: SUBJECT });
  assert(approved["ok"] === true, "approve should return ok");
  const forgotten = await call("DELETE", `/api/hint/${toForget.hint.id}?subjectId=${SUBJECT}`);
  assert(forgotten["ok"] === true, "forget should return ok");
  const e2 = await explain();
  const after = activeHints(e2);
  const approvedRow = after.find((r) => r.hint.id === toApprove.hint.id);
  assert(approvedRow !== undefined && approvedRow.hint.approval === "approved", `hint ${toApprove.hint.id} should be active and approved`);
  assert(!after.some((r) => r.hint.id === toForget.hint.id), `hint ${toForget.hint.id} should be gone after forget`);
  assert(e2.audit.some((a) => a.action === "hint.approved" && a.hintId === toApprove.hint.id), "audit should record hint.approved");
  assert(e2.audit.some((a) => a.action === "hint.forgotten" && a.hintId === toForget.hint.id), "audit should record hint.forgotten");
  log(`approve/forget ok · approved ${toApprove.hint.id} · forgot ${toForget.hint.id}`);

  // 8. maintenance + stats
  const consolidate = await call("POST", "/api/maintenance/consolidate", { subjectId: SUBJECT });
  assert(consolidate["action"] === "consolidate" && typeof consolidate["report"] === "object", "consolidate should return a report");
  const maintain = await call("POST", "/api/maintenance/maintain", { subjectId: SUBJECT });
  assert(typeof (maintain["report"] as Json)["examined"] === "number", "maintain report should have examined");
  const drain = await call("POST", "/api/maintenance/drain", { subjectId: SUBJECT });
  assert(typeof (drain["report"] as Json)["processed"] === "number", "drain report should have processed");
  const stats = await call("GET", "/api/stats");
  assert(typeof stats["recalls"] === "number" && (stats["recalls"] as number) >= 2, `stats.recalls should be ≥ 2, got ${String(stats["recalls"])}`);
  assert((stats["processed"] as number) >= 5, `stats.processed should be ≥ 5, got ${String(stats["processed"])}`);
  log(`maintenance ok · ${JSON.stringify(consolidate["report"])}`);

  // 9. the page, the stream, and error handling
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert(page.status === 200 && (page.headers.get("content-type") ?? "").startsWith("text/html"), `/ should be text/html, got ${page.headers.get("content-type")}`);
  assert(/^<!doctype html>/i.test(html) && html.includes("<title>Wisdom Graph tester</title>") && html.includes("/api/chat/stream"), "/ should be the tester page");
  const sse = await fetch(`${base}/api/chat/stream?subjectId=${SUBJECT}&text=${encodeURIComponent("hi there")}`);
  const sseText = await sse.text();
  assert((sse.headers.get("content-type") ?? "").startsWith("text/event-stream"), "stream should be text/event-stream");
  assert(sseText.includes("event: delta") && sseText.includes("event: done"), "stream should carry delta then done events");
  const doneLine = sseText.split("\n").find((l, i, all) => all[i - 1] === "event: done" && l.startsWith("data: "));
  assert(doneLine !== undefined, "stream done event should carry data");
  const doneJson = JSON.parse(doneLine.slice("data: ".length)) as ChatResult;
  assert(typeof doneJson.runId === "string" && doneJson.reply.length > 0, "stream done payload should be a ChatResult");
  const bad = await fetch(`${base}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert(bad.status === 400 && typeof ((await bad.json()) as Json)["error"] === "string", "malformed JSON should yield 400 { error }");
  const missing = await fetch(`${base}/api/nope`);
  assert(missing.status === 404, "unknown route should be 404");
  const badSignal = await call("POST", "/api/feedback", { runId: "x", signal: "meh", subjectId: SUBJECT }).then(() => null, (e: Error) => e.message);
  assert(badSignal !== null && badSignal.includes("400"), "invalid signal should be rejected with 400");
  log("page / stream / errors ok");

  // 10. forget subject
  const gone = await call("DELETE", `/api/subject?subjectId=${SUBJECT}`);
  assert(gone["ok"] === true, "forget subject should return ok");
  const e3 = await explain();
  assert(e3.stats.activeHints === 0, `subject should have no active hints after forget, got ${e3.stats.activeHints}`);
  log("forget subject ok");

  log("SMOKE PASSED");
} catch (e) {
  exitCode = 1;
  const prefix = e instanceof AssertionFailed ? "ASSERTION FAILED" : "SMOKE ERROR";
  log(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await app.close();
  await h.close();
}
process.exit(exitCode);
