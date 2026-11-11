/**
 * session.ts — the chat loop and every slash command, independent of where
 * the lines come from (a terminal or a --script file).
 *
 * One `Session` owns the identity in play (subject + client), a rolling
 * history of NeutralMessage, and what the last turn looked like from the
 * graph's side: the Recall, the three compiled artifacts injected into the
 * prompt, the full system prompt, and the runId feedback should aim at.
 *
 * `ask(text)` is the whole read path per turn (recall → prefix / preamble /
 * suffix → stream → ingest turn); `command(line)` dispatches a `/…` line.
 * Both throw on a hard error so the runner can decide whether to keep going
 * (interactive) or fail the script (--script).
 */
import type { CompiledArtifact, HintLane, NeutralMessage, Recall, WisdomGraph } from "@mosphere/wisdom-graph";
import { nodePreamble, synthesizeSuffix, systemPromptPrefix } from "@mosphere/wisdom-graph/langgraph";
import { formatExplanation, formatRecall, formatReceipt, type Harness } from "@wisdom-graph/harness";

const BASE_PERSONA = "You are a concise, friendly assistant. Answer directly; ask when the question is ambiguous.";
const HISTORY_LIMIT = 20;
const RECENT_TURNS = 6;
const RECALL_BUDGET_MS = 2500;

/** What the last turn injected, one artifact per lane (§8.3). */
interface Injected {
  agent: string | null;
  artifacts: { lane: HintLane; artifact: CompiledArtifact }[];
}

export interface SessionIo {
  /** Conversation and command output. */
  out(text: string): void;
  /** Ask the human a yes/no question; the runner returns `false` when it cannot prompt. */
  confirm(question: string): Promise<boolean>;
}

export const HELP = `commands
  /help                       this list
  /up | /down [text]          thumbs on the last answer (optional text is stored with it)
  /comment <text>             free-form feedback on the last answer — preferences are extracted from it
  /correct <text>             a correction of the last answer
  /remember <text>            store a preference without a conversation (synthetic turn + comment)
  /explain [query]            what the graph knows about the subject; with a query, a dry-run recall trace
  /hints                      the three compiled artifacts injected on the last turn
  /prompt                     the full system prompt of the last turn
  /approve <hintId>           mark a hint human-approved (never decays, wins conflicts)
  /reject <hintId>            reject a hint (retired, never recalled)
  /forget <hintId> | all      hard-delete one hint, or the whole subject (asks y/N)
  /consolidate                run the consolidation pass for the subject
  /maintain                   run the maintenance pass (decay, promotion, retention)
  /drain                      process any queued ingest events
  /subject <id>               switch subject (clears history)
  /client <id> | none         set or clear the client sub-scope
  /stats                      engine counters
  /quit                       exit`;

export class Session {
  private history: NeutralMessage[] = [];
  private lastRunId: string | null = null;
  private lastRecall: Recall | null = null;
  private lastSystem: string | null = null;
  private lastInjected: Injected | null = null;
  private turn = 0;
  subjectId: string;
  clientId: string | null;

  constructor(private readonly h: Harness, private readonly io: SessionIo, ids: { subjectId: string; clientId: string | null }) {
    this.subjectId = ids.subjectId;
    this.clientId = ids.clientId;
  }

  private get graph(): WisdomGraph {
    return this.h.graph;
  }

  /** A free-text line: one full turn against the graph and the model. */
  async ask(text: string): Promise<void> {
    const runId = `run_${Date.now()}_${++this.turn}`;
    const recall = await this.graph.recall({
      subjectId: this.subjectId,
      clientId: this.clientId,
      text,
      recentTurns: this.history.slice(-RECENT_TURNS),
      budgetMs: RECALL_BUDGET_MS,
      requestId: runId,
    });
    const agent = recall.topic.category === "direct" ? null : recall.topic.category;
    const system = [
      BASE_PERSONA,
      systemPromptPrefix(recall),
      agent ? nodePreamble(recall, agent) : "",
      synthesizeSuffix(recall),
    ].filter((s) => s.length > 0).join("\n\n");
    this.io.out(`· ${formatRecall(recall)}`);

    this.history.push({ role: "user", content: text });
    let streamed = false;
    const reply = await this.h.chat({
      system,
      messages: this.history,
      onDelta: (delta) => {
        streamed = true;
        process.stdout.write(delta);
      },
    });
    if (!streamed) process.stdout.write(reply);
    process.stdout.write("\n");
    this.history.push({ role: "assistant", content: reply });
    this.history = this.history.slice(-HISTORY_LIMIT);

    const receipt = await this.graph.ingest({
      type: "turn",
      id: `turn_${runId}`,
      runId,
      subjectId: this.subjectId,
      clientId: this.clientId,
      agentsUsed: agent ? [agent] : [],
      userText: text,
      assistantText: reply,
      appliedHintIds: recall.provenance,
    });
    this.h.logger.info({ runId, receipt }, "chat.turn");

    this.lastRunId = runId;
    this.lastRecall = recall;
    this.lastSystem = system;
    this.lastInjected = {
      agent,
      artifacts: (["preRoute", "agent", "responseStyle"] as const).map((lane) => ({
        lane,
        artifact: this.graph.compile(recall.charter, lane, agent ? { agent } : {}),
      })),
    };
  }

  /** A `/…` line. Returns false when the session should end. */
  async command(line: string): Promise<boolean> {
    const m = line.match(/^\/(\S+)\s*([\s\S]*)$/);
    const name = m?.[1]?.toLowerCase() ?? "";
    const rest = m?.[2]?.trim() ?? "";
    switch (name) {
      case "help":
        this.io.out(HELP);
        return true;
      case "quit":
      case "exit":
        return false;
      case "up":
      case "down":
        await this.feedback(name, rest || undefined);
        return true;
      case "comment":
        await this.feedback("comment", this.required(rest, "/comment <text>"));
        return true;
      case "correct":
        await this.feedback("correction", this.required(rest, "/correct <text>"));
        return true;
      case "remember":
        await this.remember(this.required(rest, "/remember <text>"));
        return true;
      case "explain": {
        const e = await this.graph.explain(this.subjectId, { clientId: this.clientId, includeRetired: true, ...(rest ? { text: rest } : {}) });
        this.io.out(formatExplanation(e));
        return true;
      }
      case "hints":
        this.io.out(this.hints());
        return true;
      case "prompt":
        this.io.out(this.lastSystem ?? "none (no turn yet)");
        return true;
      case "approve":
      case "reject": {
        const id = this.required(rest, `/${name} <hintId>`);
        await this.graph.approve(this.subjectId, id, { status: name === "approve" ? "approved" : "rejected", by: `chat:${this.subjectId}` });
        this.io.out(`${name === "approve" ? "approved" : "rejected"} ${id}`);
        return true;
      }
      case "forget":
        await this.forget(this.required(rest, "/forget <hintId> | all"));
        return true;
      case "consolidate":
        this.io.out(`consolidate ${JSON.stringify(await this.graph.maintenance.consolidate(this.subjectId))}`);
        return true;
      case "maintain":
        this.io.out(`maintain ${JSON.stringify(await this.graph.maintenance.maintain({ subjectId: this.subjectId }))}`);
        return true;
      case "drain":
        this.io.out(`drain ${JSON.stringify(await this.graph.maintenance.drain())}`);
        return true;
      case "subject":
        this.subjectId = this.required(rest, "/subject <id>");
        this.reset();
        this.io.out(`subject=${this.subjectId} (history cleared)`);
        return true;
      case "client": {
        const id = this.required(rest, "/client <id> | none");
        this.clientId = id.toLowerCase() === "none" ? null : id;
        this.io.out(`client=${this.clientId ?? "none"}`);
        return true;
      }
      case "stats":
        this.io.out(JSON.stringify(this.graph.stats()));
        return true;
      default:
        throw new Error(`unknown command /${name} — try /help`);
    }
  }

  private required(value: string, usage: string): string {
    if (!value) throw new Error(`usage: ${usage}`);
    return value;
  }

  private reset(): void {
    this.history = [];
    this.lastRunId = null;
    this.lastRecall = null;
    this.lastSystem = null;
    this.lastInjected = null;
  }

  private async feedback(signal: "up" | "down" | "comment" | "correction", text?: string): Promise<void> {
    if (!this.lastRunId) throw new Error("no answer to give feedback on yet — ask something first");
    const receipt = await this.graph.ingest({
      type: "feedback",
      id: `fb_${this.lastRunId}_${signal}_${Date.now()}`,
      runId: this.lastRunId,
      subjectId: this.subjectId,
      clientId: this.clientId,
      signal,
      ...(text ? { text } : {}),
    });
    this.io.out(formatReceipt(receipt));
  }

  /**
   * A preference with no conversation behind it: a synthetic turn anchors a
   * runId (no extraction — the text is not a question) and a comment on that
   * run carries the preference through the normal feedback path.
   */
  private async remember(text: string): Promise<void> {
    const runId = `remember_${Date.now()}`;
    const turn = await this.graph.ingest(
      { type: "turn", id: `turn_${runId}`, runId, subjectId: this.subjectId, clientId: this.clientId, agentsUsed: [], userText: text, assistantText: "(noted)" },
      { extract: "skip" },
    );
    const fb = await this.graph.ingest({ type: "feedback", id: `fb_${runId}`, runId, subjectId: this.subjectId, clientId: this.clientId, signal: "comment", text });
    this.io.out(`${formatReceipt(turn)} · ${formatReceipt(fb)}`);
  }

  private async forget(target: string): Promise<void> {
    if (target.toLowerCase() === "all") {
      const ok = await this.io.confirm(`forget everything about subject ${this.subjectId}? [y/N] `);
      if (!ok) {
        this.io.out("kept");
        return;
      }
      await this.graph.forget(this.subjectId, undefined, { actor: `chat:${this.subjectId}`, reason: "chat /forget all" });
      this.reset();
      this.io.out(`forgot subject ${this.subjectId}`);
      return;
    }
    await this.graph.forget(this.subjectId, target, { actor: `chat:${this.subjectId}`, reason: "chat /forget" });
    this.io.out(`forgot ${target}`);
  }

  private hints(): string {
    const inj = this.lastInjected;
    if (!inj || !this.lastRecall) return "none (no turn yet)";
    const out: string[] = [];
    for (const { lane, artifact } of inj.artifacts) {
      const site = lane === "preRoute" ? "systemPromptPrefix" : lane === "agent" ? `nodePreamble(${inj.agent ?? "skipped: topic=direct"})` : "synthesizeSuffix";
      out.push(`── ${lane} · ${site} · ${artifact.hintIds.length} hint${artifact.hintIds.length === 1 ? "" : "s"} · ~${artifact.tokenEstimate} tok · hash=${artifact.hash}`);
      if (lane === "agent" && !inj.agent) out.push("(not injected — the topic was direct)");
      else out.push(artifact.text || "(empty)");
    }
    const c = this.lastRecall.charter;
    out.push(`── charter · ${c.entries.length} entries · approvalMix=${c.approvalMix} · suppressed=${c.suppressed.length} dropped=${c.dropped.length}`);
    return out.join("\n");
  }
}
