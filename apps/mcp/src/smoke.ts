/**
 * smoke.ts — end-to-end check of the MCP server through a real MCP client.
 *
 * Spawns `npx tsx src/server.ts` over stdio (exactly how Claude Code / Claude
 * Desktop run it), connects an SDK `Client`, and walks the library loop:
 * list tools → read config → recall (empty) → remember a preference → recall
 * again (the responseStyle block now carries it) → ingest a turn + thumbs-up →
 * explain → consolidate → stats. Every step asserts on the returned text, so a
 * regression in the server, the harness or the library fails the run.
 *
 * Runs offline: `npm run smoke -w @wisdom-graph/mcp` sets WISDOM_OFFLINE=1 and
 * a private store file, which this script deletes first for a clean graph.
 * Exit code 0 on success, 1 on any failed assertion or protocol error.
 */
import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_DIR, "..", "..");

const EXPECTED_TOOLS = [
  "wisdom_recall", "wisdom_ingest_turn", "wisdom_feedback", "wisdom_remember", "wisdom_explain",
  "wisdom_approve", "wisdom_forget", "wisdom_maintenance", "wisdom_stats",
];

let failures = 0;
function check(cond: boolean, what: string, detail?: string): void {
  if (cond) {
    console.log(`ok   ${what}`);
  } else {
    failures += 1;
    console.log(`FAIL ${what}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}`);
  }
}

/** The concatenated text content of a tool result (plus a flag when the server marked it an error). */
function textOf(result: unknown): { text: string; isError: boolean } {
  const r = typeof result === "object" && result !== null ? (result as { content?: unknown; isError?: unknown }) : {};
  const parts = Array.isArray(r.content) ? r.content : [];
  const text = parts
    .map((p) => (typeof p === "object" && p !== null && "type" in p && p.type === "text" && "text" in p ? String(p.text) : ""))
    .join("\n");
  return { text, isError: r.isError === true };
}

// Start from an empty graph so the assertions below are deterministic.
const storeFile = process.env["WISDOM_STORE_FILE"];
if (storeFile) {
  const abs = resolve(REPO_ROOT, storeFile);
  if (existsSync(abs)) unlinkSync(abs);
}

const env: Record<string, string> = { ...getDefaultEnvironment() };
for (const k of ["WISDOM_OFFLINE", "WISDOM_STORE_FILE", "WISDOM_STORE", "WISDOM_LOG", "WISDOM_SUBJECT", "WISDOM_CLIENT", "WISDOM_CONFIG"]) {
  const v = process.env[k];
  if (v !== undefined) env[k] = v;
}
if (env["WISDOM_OFFLINE"] === undefined) env["WISDOM_OFFLINE"] = "1";

const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/server.ts"], cwd: APP_DIR, env, stderr: "inherit" });
const client = new Client({ name: "wisdom-graph-smoke", version: "0.0.0" });

const runId = `smoke_${Date.now().toString(36)}`;
const question = "how do I fix this typescript compile error in my function?";

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  check(info?.name === "wisdom-graph", "connected to server 'wisdom-graph'", JSON.stringify(info));

  // tools/list
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  check(missing.length === 0, `tools/list exposes ${EXPECTED_TOOLS.length} wisdom_* tools`, `missing: ${missing.join(", ")} · got: ${names.join(", ")}`);
  check(tools.tools.every((t) => (t.description ?? "").length > 40), "every tool has a description");

  // resources
  const cfg = await client.readResource({ uri: "wisdom://config" });
  const cfgText = cfg.contents[0] && "text" in cfg.contents[0] ? cfg.contents[0].text : "";
  const cfgJson = JSON.parse(cfgText) as { subjectId?: string; offline?: boolean; categories?: unknown[] };
  check(typeof cfgJson.subjectId === "string" && Array.isArray(cfgJson.categories), "wisdom://config is JSON with subjectId and categories", cfgText);
  check(cfgJson.offline === true, "server runs offline in the smoke", cfgText);
  const templates = await client.listResourceTemplates();
  check(templates.resourceTemplates.some((t) => t.uriTemplate === "wisdom://subject/{subjectId}/explain"), "resource template wisdom://subject/{subjectId}/explain is listed");

  // recall on an empty graph
  const r0 = textOf(await client.callTool({ name: "wisdom_recall", arguments: { text: question } }));
  check(!r0.isError && r0.text.startsWith("recall "), "wisdom_recall returns a summary line", r0.text);
  check(r0.text.includes("## provenance"), "wisdom_recall returns a provenance section", r0.text);
  check(!r0.text.includes("bullet"), "empty graph: responseStyle carries no bullet-point hint yet", r0.text);

  // remember a preference
  const rem = textOf(await client.callTool({ name: "wisdom_remember", arguments: { text: "keep answers short and use bullet points" } }));
  check(!rem.isError && rem.text.includes("processed"), "wisdom_remember processed the synthetic turn and comment", rem.text);
  check(/bullet/i.test(rem.text), "wisdom_remember lists the bullet-point hint as active", rem.text);

  // recall again: the responseStyle block carries it
  const r1 = textOf(await client.callTool({ name: "wisdom_recall", arguments: { text: question } }));
  const styleBlock = r1.text.split("## responseStyle")[1] ?? "";
  check(styleBlock.includes("<<wisdom-hints") && /bullet/i.test(styleBlock), "wisdom_recall responseStyle block now contains 'bullet'", r1.text);
  const provenance = JSON.parse((r1.text.split("## provenance (pass back as appliedHintIds in wisdom_ingest_turn)")[1] ?? "[]").trim()) as string[];
  check(Array.isArray(provenance) && provenance.length > 0, "provenance ids are returned", JSON.stringify(provenance));

  // prompt
  const prompt = await client.getPrompt({ name: "charter", arguments: { text: question } });
  const promptText = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
  check(/bullet/i.test(promptText) && promptText.includes("<<wisdom-hints"), "charter prompt carries the compiled blocks", promptText);

  // ingest a turn and thumbs-up
  const turn = textOf(await client.callTool({
    name: "wisdom_ingest_turn",
    arguments: { runId, userText: question, assistantText: "- Add the missing type annotation.\n- Re-run tsc.", agentsUsed: ["assist_code"], appliedHintIds: provenance },
  }));
  check(!turn.isError && /recorded|processed/.test(turn.text), "wisdom_ingest_turn returns a receipt", turn.text);
  const dup = textOf(await client.callTool({ name: "wisdom_ingest_turn", arguments: { runId, userText: question, assistantText: "again" } }));
  check(dup.text.includes("duplicate"), "wisdom_ingest_turn is idempotent on runId", dup.text);
  const fb = textOf(await client.callTool({ name: "wisdom_feedback", arguments: { runId, signal: "up" } }));
  check(!fb.isError && /recorded|processed/.test(fb.text), "wisdom_feedback up returns a receipt", fb.text);

  // explain
  const ex = textOf(await client.callTool({ name: "wisdom_explain", arguments: { query: question } }));
  check(ex.text.startsWith("subject ") && /^\s*• .*bullet/im.test(ex.text), "wisdom_explain shows a hint line for the bullet-point preference", ex.text);
  check(ex.text.includes("dry-run recall"), "wisdom_explain with query includes the dry-run trace", ex.text);
  const res = await client.readResource({ uri: `wisdom://subject/${cfgJson.subjectId ?? "erik"}/explain` });
  const resText = res.contents[0] && "text" in res.contents[0] ? res.contents[0].text : "";
  check(resText.startsWith("subject "), "wisdom://subject/{subjectId}/explain reads the explanation", resText);

  // approve the first hint we can find, then forget-without-confirm is refused
  const hintId = /id=(h_[A-Za-z0-9_-]+)/.exec(ex.text)?.[1];
  check(hintId !== undefined, "explain exposes a hint id", ex.text);
  if (hintId) {
    const ap = textOf(await client.callTool({ name: "wisdom_approve", arguments: { hintId, status: "approved", by: "smoke" } }));
    check(!ap.isError && ap.text.includes("approved"), "wisdom_approve approves a hint", ap.text);
  }
  const refuse = textOf(await client.callTool({ name: "wisdom_forget", arguments: {} }));
  check(refuse.isError && refuse.text.includes("confirm"), "wisdom_forget without hintId requires confirm: true", refuse.text);

  // maintenance + stats
  const cons = textOf(await client.callTool({ name: "wisdom_maintenance", arguments: { action: "consolidate" } }));
  const consJson = JSON.parse(cons.text) as { action?: string; subjectId?: string };
  check(consJson.action === "consolidate" && typeof consJson.subjectId === "string", "wisdom_maintenance consolidate returns a report", cons.text);
  const stats = textOf(await client.callTool({ name: "wisdom_stats", arguments: {} }));
  const statsJson = JSON.parse(stats.text) as { recalls?: number; ingested?: number };
  check((statsJson.recalls ?? 0) >= 3 && (statsJson.ingested ?? 0) >= 4, "wisdom_stats counts the recalls and ingests", stats.text);
} catch (err) {
  failures += 1;
  console.log(`FAIL protocol error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
} finally {
  await client.close().catch(() => undefined);
}

console.log(failures === 0 ? "smoke: all checks passed" : `smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
