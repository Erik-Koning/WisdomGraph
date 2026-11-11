/**
 * server.ts — the WisdomGraph MCP server ("wisdom-graph") over stdio.
 *
 * Exposes the library loop to any MCP client (Claude Code, Claude Desktop,
 * the Inspector) as tools, so a host model can recall the compiled charter
 * before it answers, hand the turn back for extraction afterwards, and let a
 * human inspect / approve / forget what the graph learned:
 *
 *   wisdom_recall        → the three compiled blocks + provenance ids
 *   wisdom_ingest_turn   → capture a finished turn (idempotent on runId)
 *   wisdom_feedback      → up / down / comment / correction on a run
 *   wisdom_remember      → "remember that …" in one call (turn + comment)
 *   wisdom_explain       → what the graph knows (optionally a dry-run trace)
 *   wisdom_approve / wisdom_forget / wisdom_maintenance / wisdom_stats
 *
 * Resources: `wisdom://config`, `wisdom://subject/{subjectId}/explain`.
 * Prompt:    `charter` — the responseStyle + agent blocks as one message.
 *
 * STDOUT IS THE JSON-RPC CHANNEL. Nothing here writes to it: the banner and
 * every log line go to stderr (the harness logger already does), and
 * `console.log` is redirected to stderr as a belt-and-braces guard against a
 * dependency printing something. Shutdown on SIGINT/SIGTERM or when the client
 * closes the pipe flushes the store via `h.close()`.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Explanation, ExplainNode, HintExplanation, HintRecord, Recall } from "@mosphere/wisdom-graph";
import { nodePreamble, synthesizeSuffix, systemPromptPrefix } from "@mosphere/wisdom-graph/langgraph";
import { createHarness, formatExplanation, formatRecall, formatReceipt, type Harness } from "@wisdom-graph/harness";

// ── Stdout guard ────────────────────────────────────────────────────────────
// Anything a dependency prints with console.log would corrupt the protocol.
console.log = (...args: unknown[]): void => { console.error(...args); };
console.info = (...args: unknown[]): void => { console.error(...args); };

const h: Harness = await createHarness();
process.stderr.write(`${h.banner()}\n`);

const RECALL_BUDGET_MS = 2500;

// ── Helpers ─────────────────────────────────────────────────────────────────

function text(s: string): CallToolResult {
  return { content: [{ type: "text", text: s }] };
}

function failure(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  h.logger.error({ err: message }, "mcp.tool.failed");
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

/** Wrap a handler so a thrown error becomes an `isError` result instead of a protocol failure. */
function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return failure(err);
    }
  };
}

function subjectOf(subjectId: string | undefined): string {
  return subjectId ?? h.cfg.subjectId;
}

function clientOf(clientId: string | undefined): string | null {
  return clientId === undefined ? h.cfg.clientId : clientId;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** A short id that is unique per process, for synthetic runs and feedback events. */
let seq = 0;
function fresh(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** Every hint that is active (not pending, not retired) anywhere in the explanation tree. */
function activeHints(e: Explanation): HintRecord[] {
  const out: HintRecord[] = [];
  const walk = (n: ExplainNode): void => {
    for (const hx of n.hints) if (hx.hint.status === "active") out.push(hx.hint);
    for (const c of n.children) walk(c);
  };
  for (const n of e.tree) walk(n);
  return out;
}

function shortHintList(hints: readonly HintRecord[]): string {
  if (hints.length === 0) return "(no active hints)";
  return hints.map((r) => `• ${r.text}  [${r.lane}/${r.slot}${r.agent ? ` agent=${r.agent}` : ""}] id=${r.id}`).join("\n");
}

function pendingHintList(hints: readonly HintExplanation[]): string {
  return hints.map((hx) => `• ${hx.hint.text}  id=${hx.hint.id}`).join("\n");
}

/** The three compiled artifacts for a recall, each "" when its lane is empty. */
function compiled(recall: Recall, agent: string): { preRoute: string; agent: string; responseStyle: string } {
  return {
    preRoute: systemPromptPrefix(recall),
    agent: nodePreamble(recall, agent),
    responseStyle: synthesizeSuffix(recall),
  };
}

function renderRecall(recall: Recall, agent: string): string {
  const blocks = compiled(recall, agent);
  const section = (title: string, body: string): string => `## ${title}\n${body.trim() === "" ? "(empty)" : body.trim()}`;
  return [
    formatRecall(recall),
    "",
    section("preRoute (prepend to the router / first system prompt)", blocks.preRoute),
    "",
    section(`agent "${agent}" (prepend to the specialist prompt)`, blocks.agent),
    "",
    section("responseStyle (append to the final answer prompt)", blocks.responseStyle),
    "",
    `## provenance (pass back as appliedHintIds in wisdom_ingest_turn)\n${json(recall.provenance)}`,
  ].join("\n");
}

async function explanationText(subjectId: string, opts: { query?: string; includeRetired?: boolean } = {}): Promise<string> {
  const e = await h.graph.explain(subjectId, {
    clientId: h.cfg.clientId,
    ...(opts.query !== undefined ? { text: opts.query } : {}),
    ...(opts.includeRetired !== undefined ? { includeRetired: opts.includeRetired } : {}),
  });
  return formatExplanation(e);
}

// ── Server ──────────────────────────────────────────────────────────────────

const mcp = new McpServer(
  { name: "wisdom-graph", version: "0.0.0" },
  {
    instructions: [
      "wisdom-graph keeps a per-subject memory of preferences, style rules and facts learned from conversations and feedback.",
      "Before answering a substantive question call wisdom_recall with the user's text and follow the returned blocks.",
      "After answering call wisdom_ingest_turn with the same runId, both texts and the provenance ids you were given.",
      "When the user states a preference ('keep answers short', 'call me Erik') call wisdom_remember with their words.",
      "wisdom_explain shows what is stored; wisdom_approve and wisdom_forget are the human controls.",
    ].join(" "),
  },
);

const subjectArg = z.string().min(1).optional().describe("Subject (user/advisor) id the graph belongs to. Default: the server's configured subject.");
const clientArg = z.string().optional().describe("Optional client sub-scope under the subject. Default: the server's configured client (may be none).");

mcp.registerTool(
  "wisdom_recall",
  {
    title: "Recall the compiled charter for a query",
    description: [
      "Look up what the subject's wisdom graph knows that is relevant to `text` and return it compiled into three prompt blocks:",
      "preRoute (query-shaping rules for the router), agent (the specialist's preamble, for `agent` or the predicted topic category),",
      "and responseStyle (voice and format rules for the final answer). Each block is a fenced `<<wisdom-hints …>>` section that",
      "can be pasted verbatim into a system prompt; an empty block means nothing applies. Also returns a one-line summary and the",
      "`provenance` hint ids — pass them back as `appliedHintIds` to wisdom_ingest_turn so the graph can count what was used.",
      "Never fails: on timeout or store trouble it returns an empty recall.",
    ].join(" "),
    inputSchema: {
      text: z.string().min(1).describe("The user's message (or question) to recall for."),
      subjectId: subjectArg,
      clientId: clientArg,
      agent: z.string().optional().describe("Which agent bucket to compile for (a category name such as assist_code). Default: the predicted topic category."),
      approvedOnly: z.boolean().optional().describe("true → only human-approved hints are used (a strictly governed charter)."),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  guarded(async ({ text: q, subjectId, clientId, agent, approvedOnly }) => {
    const recall = await h.graph.recall({
      subjectId: subjectOf(subjectId),
      clientId: clientOf(clientId),
      text: q,
      budgetMs: RECALL_BUDGET_MS,
      ...(approvedOnly !== undefined ? { approvedOnly } : {}),
    });
    return text(renderRecall(recall, agent ?? recall.topic.category));
  }),
);

mcp.registerTool(
  "wisdom_ingest_turn",
  {
    title: "Capture a finished conversation turn",
    description: [
      "Record one completed exchange so the graph can learn from it (extraction runs only when the user text looks like a",
      "preference or when the run later receives feedback). Idempotent on `runId`: sending the same run twice returns `duplicate`.",
      "Pass the `provenance` ids from the wisdom_recall you used as `appliedHintIds` and the agent/category you answered as in",
      "`agentsUsed`, so the graph can count which hints were actually rendered.",
    ].join(" "),
    inputSchema: {
      runId: z.string().min(1).describe("Your id for this exchange; reuse it in wisdom_feedback."),
      userText: z.string().describe("What the user said."),
      assistantText: z.string().describe("What you answered."),
      agentsUsed: z.array(z.string()).optional().describe("Category / agent names that handled the turn, e.g. [\"assist_code\"]. Default: none."),
      appliedHintIds: z.array(z.string()).optional().describe("The provenance ids returned by wisdom_recall for this turn."),
      subjectId: subjectArg,
      clientId: clientArg,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  guarded(async ({ runId, userText, assistantText, agentsUsed, appliedHintIds, subjectId, clientId }) => {
    const receipt = await h.graph.ingest(
      {
        type: "turn",
        id: `turn_${runId}`,
        runId,
        subjectId: subjectOf(subjectId),
        clientId: clientOf(clientId),
        agentsUsed: agentsUsed ?? [],
        userText,
        assistantText,
        ...(appliedHintIds ? { appliedHintIds } : {}),
      },
      { waitFor: "processed" },
    );
    await h.persist();
    return text(formatReceipt(receipt));
  }),
);

mcp.registerTool(
  "wisdom_feedback",
  {
    title: "Give feedback on a run",
    description: [
      "Attach a feedback signal to an earlier run (by `runId`). `up` reinforces the hints applied in that run, `down` weakens them,",
      "`comment` and `correction` carry free text that is mined for new preferences (\"shorter answers\", \"no disclaimers\",",
      "\"call me Erik\", \"prefer python\"). `target` narrows a signal to the response or one agent/tool.",
    ].join(" "),
    inputSchema: {
      runId: z.string().min(1).describe("The runId given to wisdom_ingest_turn."),
      signal: z.enum(["up", "down", "comment", "correction"]).describe("Kind of feedback."),
      text: z.string().optional().describe("The user's words, for comment / correction (also welcome with up / down)."),
      target: z.string().optional().describe("\"response\", \"agent:<name>\" or \"tool:<name>\". Default: the whole run."),
      subjectId: subjectArg,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  guarded(async ({ runId, signal, text: body, target, subjectId }) => {
    const receipt = await h.graph.ingest(
      {
        type: "feedback",
        id: fresh(`fb_${runId}`),
        runId,
        subjectId: subjectOf(subjectId),
        clientId: h.cfg.clientId,
        signal,
        ...(body !== undefined ? { text: body } : {}),
        ...(target !== undefined ? { target: target as `agent:${string}` } : {}),
      },
      { waitFor: "processed" },
    );
    await h.persist();
    return text(formatReceipt(receipt));
  }),
);

mcp.registerTool(
  "wisdom_remember",
  {
    title: "Remember a stated preference",
    description: [
      "Convenience for \"remember that …\": records a synthetic turn plus a comment carrying `text`, so the extractor turns the",
      "user's words into canonical hints in one call. Returns the ingest receipts and the short list of hints now active for the",
      "subject. Use the user's own phrasing (\"keep answers short and use bullet points\", \"call me Erik\").",
    ].join(" "),
    inputSchema: {
      text: z.string().min(1).describe("The preference in the user's words."),
      subjectId: subjectArg,
      clientId: clientArg,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  guarded(async ({ text: body, subjectId, clientId }) => {
    const subject = subjectOf(subjectId);
    const client = clientOf(clientId);
    const runId = fresh("remember");
    const turn = await h.graph.ingest(
      { type: "turn", id: `turn_${runId}`, runId, subjectId: subject, clientId: client, agentsUsed: [], userText: body, assistantText: "Noted — I will remember that." },
      { waitFor: "processed" },
    );
    const feedback = await h.graph.ingest(
      { type: "feedback", id: `fb_${runId}`, runId, subjectId: subject, clientId: client, signal: "comment", text: body },
      { waitFor: "processed" },
    );
    await h.persist();
    const e = await h.graph.explain(subject, { clientId: client });
    const lines = [formatReceipt(turn), formatReceipt(feedback), "", `active hints for ${subject}:`, shortHintList(activeHints(e))];
    if (e.pendingApproval.length) lines.push("", `pending approval (${e.pendingApproval.length}):`, pendingHintList(e.pendingApproval));
    return text(lines.join("\n"));
  }),
);

mcp.registerTool(
  "wisdom_explain",
  {
    title: "Explain what the graph knows",
    description: [
      "The subject's whole graph as text: the topic tree with every hint (status, lane, slot, score, id), hints pending approval,",
      "retired hints (with `includeRetired`), recent events and the audit trail. With `query` it also runs a dry-run recall and",
      "lists each candidate hint with its relevance and whether it was kept, suppressed or dropped — use that to answer",
      "\"why did / didn't hint X apply to this question?\". Read-only; never calls a model.",
    ].join(" "),
    inputSchema: {
      subjectId: subjectArg,
      query: z.string().optional().describe("A user message to trace a dry-run recall for."),
      includeRetired: z.boolean().optional().describe("Also list retired hints."),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  guarded(async ({ subjectId, query, includeRetired }) =>
    text(await explanationText(subjectOf(subjectId), {
      ...(query !== undefined ? { query } : {}),
      ...(includeRetired !== undefined ? { includeRetired } : {}),
    }))),
);

mcp.registerTool(
  "wisdom_approve",
  {
    title: "Approve or reject a hint",
    description: [
      "Human governance: `approved` makes the hint part of the approved charter (it never decays, wins slot conflicts, and is",
      "the only kind used by `approvedOnly` recalls); `rejected` retires it. Hint ids come from wisdom_explain or wisdom_remember.",
    ].join(" "),
    inputSchema: {
      hintId: z.string().min(1).describe("The hint id (h_…)."),
      status: z.enum(["approved", "rejected"]).describe("The decision."),
      by: z.string().optional().describe("Who decided; recorded in the audit trail. Default: \"mcp\"."),
      subjectId: subjectArg,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  guarded(async ({ hintId, status, by, subjectId }) => {
    await h.graph.approve(subjectOf(subjectId), hintId, { status, by: by ?? "mcp" });
    await h.persist();
    return text(`hint ${hintId} ${status} by ${by ?? "mcp"}`);
  }),
);

mcp.registerTool(
  "wisdom_forget",
  {
    title: "Forget a hint or the whole subject",
    description: [
      "With `hintId`: hard-delete that hint (tombstoned so a replayed event cannot bring it back). Without `hintId`: delete the",
      "subject's entire graph — nodes, hints, events and audit — which requires `confirm: true`. Both are idempotent.",
    ].join(" "),
    inputSchema: {
      hintId: z.string().optional().describe("The hint to forget. Omit to forget the whole subject."),
      subjectId: subjectArg,
      confirm: z.boolean().optional().describe("Must be true to forget a whole subject."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  guarded(async ({ hintId, subjectId, confirm }) => {
    const subject = subjectOf(subjectId);
    if (hintId === undefined && confirm !== true) {
      return { content: [{ type: "text", text: `refusing to forget the whole subject "${subject}" without confirm: true` }], isError: true };
    }
    await h.graph.forget(subject, hintId, { actor: "mcp" });
    await h.persist();
    return text(hintId === undefined ? `forgot subject ${subject}` : `forgot hint ${hintId} for ${subject}`);
  }),
);

mcp.registerTool(
  "wisdom_maintenance",
  {
    title: "Run a maintenance pass",
    description: [
      "`consolidate` merges and promotes the subject's hints (the slow-timescale pass); `maintain` applies decay, retirement,",
      "node garbage-collection and retention for the subject (or all subjects when none is given); `drain` processes any",
      "ingest events still queued in the ledger. Returns the report as JSON.",
    ].join(" "),
    inputSchema: {
      action: z.enum(["consolidate", "maintain", "drain"]).describe("Which pass to run."),
      subjectId: subjectArg,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  guarded(async ({ action, subjectId }) => {
    const subject = subjectOf(subjectId);
    const report =
      action === "consolidate" ? await h.graph.maintenance.consolidate(subject)
      : action === "maintain" ? await h.graph.maintenance.maintain({ subjectId: subject })
      : await h.graph.maintenance.drain();
    await h.persist();
    return text(json({ action, ...report }));
  }),
);

mcp.registerTool(
  "wisdom_stats",
  {
    title: "Engine counters",
    description: "Process-lifetime counters for this server: recalls, cache hits, ingests, extraction calls, accepted/rejected ops, queue depth. JSON.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  guarded(async () => text(json(h.graph.stats()))),
);

// ── Resources ───────────────────────────────────────────────────────────────

mcp.registerResource(
  "config",
  "wisdom://config",
  { title: "Server configuration", description: "Subject, client, categories, store and model mode this server runs with.", mimeType: "application/json" },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: json({
        subjectId: h.cfg.subjectId,
        clientId: h.cfg.clientId,
        tenantId: h.cfg.tenantId,
        sharedSubjectId: h.cfg.sharedSubjectId,
        categories: h.cfg.categories.map((c) => ({ name: c.name, title: c.title ?? null, description: c.description ?? null })),
        store: h.storeDescription,
        offline: h.cfg.offline,
        model: h.cfg.offline ? null : h.cfg.model,
      }),
    }],
  }),
);

mcp.registerResource(
  "explain",
  new ResourceTemplate("wisdom://subject/{subjectId}/explain", {
    list: async () => ({
      resources: [{ uri: `wisdom://subject/${h.cfg.subjectId}/explain`, name: `explain ${h.cfg.subjectId}`, mimeType: "text/plain" }],
    }),
    complete: { subjectId: async () => [h.cfg.subjectId] },
  }),
  { title: "Subject explanation", description: "Everything the graph knows about a subject, as text (same as wisdom_explain).", mimeType: "text/plain" },
  async (uri, variables) => {
    const raw = variables["subjectId"];
    const subjectId = Array.isArray(raw) ? raw[0] : raw;
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: await explanationText(subjectOf(subjectId)) }] };
  },
);

// ── Prompt ──────────────────────────────────────────────────────────────────

mcp.registerPrompt(
  "charter",
  {
    title: "Charter for a query",
    description: "The compiled responseStyle and agent blocks for `text`, as one system-style message a client can pull into its own prompt.",
    argsSchema: {
      text: z.string().min(1).describe("The user's message to compile the charter for."),
      subjectId: z.string().optional().describe("Subject id. Default: the server's configured subject."),
    },
  },
  async ({ text: q, subjectId }) => {
    const recall = await h.graph.recall({ subjectId: subjectOf(subjectId), clientId: h.cfg.clientId, text: q, budgetMs: RECALL_BUDGET_MS });
    const blocks = compiled(recall, recall.topic.category);
    const body = [blocks.agent, blocks.responseStyle].filter((b) => b.trim() !== "").join("\n");
    const content = body === ""
      ? "System: the wisdom graph holds no preferences relevant to this query."
      : `System: apply the following advisory preferences when answering.\n${body}`;
    return {
      description: `charter for ${subjectOf(subjectId)} · topic=${recall.topic.category} · ${recall.charter.tokenEstimate} tok`,
      messages: [{ role: "user", content: { type: "text", text: content } }],
    };
  },
);

// ── Lifecycle ───────────────────────────────────────────────────────────────

let closing = false;
async function shutdown(reason: string, code: number): Promise<void> {
  if (closing) return;
  closing = true;
  h.logger.info({ reason }, "mcp.shutdown");
  try {
    await h.close();
    await mcp.close();
  } catch (err) {
    h.logger.error({ err: err instanceof Error ? err.message : String(err) }, "mcp.shutdown.failed");
  }
  process.exit(code);
}

process.on("SIGINT", () => { void shutdown("SIGINT", 0); });
process.on("SIGTERM", () => { void shutdown("SIGTERM", 0); });
mcp.server.onclose = () => { void shutdown("transport-closed", 0); };
mcp.server.onerror = (err) => { h.logger.error({ err: err.message }, "mcp.transport.error"); };

const transport = new StdioServerTransport();
await mcp.connect(transport);
h.logger.info({ tools: 9, resources: 2, prompts: 1 }, "mcp.ready");
