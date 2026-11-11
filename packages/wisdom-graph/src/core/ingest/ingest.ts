/**
 * ingest/ingest.ts — the event lifecycle: admit, process, drain.
 *
 * Spec §5. `ingest()` is the consumer's fire-and-forget call (must-have 4),
 * so the guarantees here are the mirror image of recall's: it never
 * rejects, it is idempotent on the event id across processes, and it
 * resolves after one store round-trip. Everything that makes those true is
 * one of three habits:
 *
 *   - **The row is the truth; the process is a worker.** `claimEvent` is
 *     the idempotency check and the durability, both in one insert. After
 *     it the queue merely schedules an *attempt*; every attempt leases the
 *     row first (`leaseEvents`), so two engines on one store — or this
 *     engine and a `drain()` on another — never process the same event,
 *     and a crash between apply and `done` is replayed rather than lost.
 *     A lease is only a guarantee for its term, so the term is sized to
 *     the attempt (`leaseMsFor`: the model step's worst case plus slack),
 *     renewed right before the model is called — the one place an attempt
 *     waits for something slower than the store — and, in `drain()`, held
 *     per row rather than per batch: a row that waited behind slow
 *     neighbours is renewed while it is still ours and taken again when
 *     it lapsed, and processed only if that succeeds (`holdLease`).
 *     Attempts are counted on the row, not in memory, so a crash loop is
 *     bounded by `maxAttempts` however many times the process restarts.
 *   - **Every write made while processing an event converges on replay.**
 *     Audit rows derive from `(event, seq)`, hint and node ids from the
 *     spec's `deterministicId` recipe (decision 12), so a replayed event
 *     lands on the same rows instead of doubling them; and every counter
 *     patch (`applied`, `reinforcements`, `contradictions`) appends the
 *     event id to the hint's provenance and is skipped for a hint that
 *     already carries it. That is what lets a failed `updateEvent(done)`
 *     be retried by simply running the event again. The one write that
 *     does not converge is the subject's `consolidationCounter`: it has no
 *     event identity, so a replay counts the event twice toward the next
 *     consolidation — harmless, and noted where it is pushed.
 *   - **A failure is a scheduled retry, never a lost event.** An attempt
 *     that throws leaves the row `failed` with `retry_at` on the backoff
 *     schedule and asks the queue to run again — `maxAttempts` retries
 *     after the first attempt, one per step of `backoffMs`, so the spec's
 *     defaults (3 and 1 s / 4 s / 16 s) use every step; the last one
 *     leaves it `failed` with the error, an `event.failed` audit row and
 *     an error log, and `drain()` — startup, cron — gives it another
 *     attempt. A feedback event whose turn has not arrived is the same
 *     mechanism with `pending` and the anchor delay (§5.4, decision 25),
 *     and those deferrals are not failures: they count on the row, as
 *     §5.4 asks, but not against the error budget.
 *
 * Extraction (§5.5–5.6) is not in this module: the LLM step is reached
 * through `IngestContext.extractor`, a seam `ingest/extract.ts` fills and
 * the engine wires. Without it — or without an `LlmPort` — the gate still
 * runs and its decision is logged, so the rule-based paths (applications,
 * routing learning, feedback arithmetic) behave identically with and
 * without a model, which is spec §2.7's "absent → no extraction; feedback
 * still adjusts weights".
 *
 * Consolidation (§5.7) reaches the ledger the same way, through
 * `IngestContext.consolidation`, for two reasons. A `kind: "consolidate"`
 * row is processed by the very code path a turn is — lease, plan, apply,
 * mark done, backoff — so the long-term pass inherits replay, leasing and
 * crash idempotency for free (decision 30); the seam supplies only the
 * planner. And the short-term pass is *triggered* here, right after the
 * event that made it due (the subject's counter reaching the period, or a
 * node the organiser reported over cap), inside the subject's lane, so it
 * never races the event it follows. It runs after the row is `done`: a
 * pass that fails is logged, never a failed event.
 */

import {
  VersionConflictError,
  type ConsolidateEvent,
  type LlmPort,
  type NodePatch,
  type SpanLike,
  type StoreOp,
  type StoredEvent,
  type StoredEventBody,
  type SubjectRef,
} from "../ports";
import type { PolicyConfig } from "../policy";
import type { FeedbackEvent, HintRecord, HintSource, IngestEvent, IngestReceipt, TopicNode, TurnEvent, WisdomGraphOptions } from "../types";
import type { Proposal } from "../schema/proposal";
import { validateIngestEvent } from "../schema/event";
import { KEYWORD_PATTERN, MAX_KEYWORDS } from "../schema/node";
import { stemLite, tokenize } from "../text/normalize";
import { ROOT_PATH, SLUG_PATTERN, categoryOf, join } from "../graph/paths";
import { DIRECT_CATEGORY } from "../graph/seed";
import type { SubjectSnapshot } from "../graph/snapshot";
import { classify } from "../classify/index";
import { cacheKey, describeError } from "../recall/cache";
import { snapshotLoader, type RecallContext } from "../recall/recall";
import { QUEUE_DEFAULTS, SubjectQueue, type AttemptResult, type JobOutcome } from "./queue";
import { shouldExtract, type ExtractOverride, type Sampler, type TriageDecision } from "./triage";
import { alreadyApplied, appliedHints, applyFeedback, eventAudit, targetedHints } from "./feedback";

// ── Constants (§5.1, §5.2) ───────────────────────────────────────────────────

export const USER_TEXT_MAX_CHARS = 8_000;
export const ASSISTANT_TEXT_MAX_CHARS = 16_000;
export const FEEDBACK_TEXT_MAX_CHARS = 2_000;
/**
 * Slack on a lease beyond the model step's worst case: snapshot load, planning,
 * apply and the store's own latency. A crashed worker's row is leasable again
 * once its lease (`leaseMsFor`) lapses.
 */
export const LEASE_MS = 60_000;
/** Model calls one extraction may make — the call and its retry (`extract.ts`); a lease must outlast both at `llmTimeoutMs`. */
export const MODEL_CALLS_PER_STEP = 2;

/** How long one attempt owns a row: the model step's worst case at the policy's timeout, plus `LEASE_MS` of slack. */
export function leaseMsFor(policy: PolicyConfig): number {
  return LEASE_MS + MODEL_CALLS_PER_STEP * policy.ingest.llmTimeoutMs;
}
/** Rows one `drain()` leases when the caller gives no limit. */
export const DRAIN_LIMIT = 100;
/** New keywords a turn may add to its best node (§5.3 step 2). */
export const KEYWORD_REFRESH_MAX = 3;
/** The actor on audit rows the ledger itself writes. */
export const INGEST_ACTOR = "system:ingest";

// ── Context ──────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Retries after the first attempt; retry `n` waits `backoffMs[n - 1]` (the last step repeats past the end). */
  maxAttempts: number;
  backoffMs: readonly number[];
  inline: boolean;
}

/** `WisdomGraphOptions.queue` resolved against the §2.7 defaults; nonsense values fall back rather than disable retries. */
export function resolveRetryPolicy(queue: WisdomGraphOptions["queue"]): RetryPolicy {
  const maxAttempts = queue?.maxAttempts;
  const backoffMs = queue?.backoffMs;
  return {
    maxAttempts: maxAttempts !== undefined && Number.isFinite(maxAttempts) && maxAttempts >= 0 ? Math.floor(maxAttempts) : QUEUE_DEFAULTS.maxAttempts,
    backoffMs: Array.isArray(backoffMs) ? backoffMs.filter((ms) => Number.isFinite(ms) && ms >= 0) : QUEUE_DEFAULTS.backoffMs,
    inline: queue?.inline === true,
  };
}

/** What the write path reads from the engine: the recall context plus the ledger's own ports and settings. */
export interface IngestContext extends RecallContext {
  llm?: LlmPort;
  queue: SubjectQueue;
  retry: RetryPolicy;
  /** The triage die (§5.3); `Math.random` unless a test scripts it. */
  sampler: Sampler;
  /** Aborted by `close()` once its grace period is over; handed to every model call so a shutdown interrupts extraction. */
  signal: AbortSignal;
  /** The extraction step (§5.5–5.6), when the organiser is wired; absent → gate decisions are logged and nothing is extracted. */
  extractor?: Extractor;
  /** The consolidation passes (§5.7), when wired; absent → `consolidate` rows fail as unsupported and nothing is triggered. */
  consolidation?: ConsolidationHooks;
  /** Node paths the organiser reported over `caps.maxActiveHintsPerNode`, per subject key, until the LLM pass has seen them. */
  flagged: Map<string, Set<string>>;
  /** Subjects this engine has written for since it started: what `maintain()` sweeps when no subject is named (the port cannot enumerate subjects). */
  subjects: Set<string>;
  /** Per subject key, the hash of the text each node was last embedded from, so `maintain()` re-embeds only what changed since. */
  embedded: Map<string, Map<string, string>>;
  requireApproval?: WisdomGraphOptions["requireApproval"];
}

// ── The extraction seam (§5.5–5.6) ───────────────────────────────────────────

export interface ExtractionInput {
  ref: SubjectRef;
  event: TurnEvent | FeedbackEvent;
  /** The turn the event anchors to: the turn itself, or feedback's run turn (`null` once the anchor retries are spent). */
  anchor: TurnEvent | null;
  snapshot: SubjectSnapshot;
  /** Set by the ledger from the event kind, never by the model: `inferred` for turns, `explicit` for feedback. */
  source: HintSource;
  /**
   * The applied hints feedback targets (§5.4 step 2); empty for a turn. For a
   * `down` with text their `× downFactor` / `contradictions + 1` patch is
   * already in this event's batch (§5.4 step 4 runs with or without a model,
   * §2.7), so an `update_hint` on one of them must change its text or value
   * only and leave confidence and contradictions alone.
   */
  targeted: readonly HintRecord[];
  /** A proposal persisted on the row by an earlier attempt; reuse it instead of calling the model (§5.2). */
  storedProposal: Proposal | null;
  signal: AbortSignal;
}

export interface ExtractionResult {
  /** Accepted ops as store ops, ids already deterministic. */
  ops: StoreOp[];
  accepted: number;
  rejected: { op: string; reason: string }[];
  /**
   * The model's proposal, persisted on the row before apply; `null` when the
   * model was not called. When no attempt produced one, the extractor's
   * `unparseableProposal()` marker, so a replay repeats the verdict without a call.
   */
  proposal: Proposal | null;
  usedLlm: boolean;
  /** Model calls made (the call and its retry count separately); default 1 when `usedLlm`, else 0. */
  llmCalls?: number;
  /** Node paths whose active hints now exceed `caps.maxActiveHintsPerNode` (§5.6); the consolidation pass reads them. */
  needsConsolidation?: string[];
}

export type Extractor = (ctx: IngestContext, input: ExtractionInput) => Promise<ExtractionResult>;

// ── The consolidation seam (§5.7) ────────────────────────────────────────────

export interface ConsolidationInput {
  ref: SubjectRef;
  event: ConsolidateEvent;
  snapshot: SubjectSnapshot;
  /** A proposal persisted on the row by an earlier attempt; reuse it instead of calling the model (§5.2). */
  storedProposal: Proposal | null;
  signal: AbortSignal;
}

/** The `consolidate` row's planner — prompt, model, organiser — the long-term pass's counterpart of `Extractor`. */
export type ConsolidationPlanner = (ctx: IngestContext, input: ConsolidationInput) => Promise<ExtractionResult>;

/** Why the short-term pass is due after an event: the subject's counter (this event included) and the nodes that overflowed. */
export interface ConsolidationDue {
  counter: number;
  overflow: string[];
}

export interface ConsolidationHooks {
  plan: ConsolidationPlanner;
  /**
   * The short-term pass (§5.7), run in the subject's lane right after the
   * event that made it due. It runs inside a queue job for that lane, so it
   * must never wait on another job of the same subject — the LLM pass, which
   * goes through the queue, is `maintain()`'s and never this hook's.
   */
  due: (ctx: IngestContext, ref: SubjectRef, reason: ConsolidationDue) => Promise<unknown>;
}

/** Remember paths the organiser found over cap, for the LLM pass (§5.7 "was flagged"). */
export function flagOverflow(ctx: IngestContext, ref: SubjectRef, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const key = cacheKey(ref);
  const set = ctx.flagged.get(key) ?? new Set<string>();
  for (const path of paths) set.add(path);
  ctx.flagged.set(key, set);
}

/** The subject's flagged paths, cleared: the pass that takes them is the one that acts on them. */
export function takeFlagged(ctx: IngestContext, ref: SubjectRef): string[] {
  const key = cacheKey(ref);
  const set = ctx.flagged.get(key);
  if (set === undefined) return [];
  ctx.flagged.delete(key);
  return [...set];
}

// ── Small helpers ────────────────────────────────────────────────────────────

const NOOP_SPAN: SpanLike = Object.freeze({ setAttribute: () => undefined, addEvent: () => undefined, recordException: () => undefined, end: () => undefined });

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function baseLog(ctx: IngestContext, subjectId: string): Record<string, unknown> {
  return { lib: "wisdom-graph", op: "ingest", tenantId: ctx.tenantId, subjectId };
}

/** Observability must never turn an ingest into a rejection. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // A logger or tracer that throws is not the ledger's failure to report.
  }
}

function startSpan(ctx: IngestContext, name: string, attributes: Record<string, string | number | boolean>): SpanLike {
  try {
    return ctx.tracer.startSpan(name, { attributes });
  } catch {
    return NOOP_SPAN;
  }
}

function debug(ctx: IngestContext, obj: object, msg: string): void {
  safe(() => (ctx.logger.debug ?? ctx.logger.info).call(ctx.logger, obj, msg));
}

/** A store call whose failure must not fail the attempt around it (the error path's own writes). */
async function tryStore(ctx: IngestContext, subjectId: string, method: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (e) {
    safe(() => ctx.logger.error({ ...baseLog(ctx, subjectId), method, error: describeError(e) }, "store.error"));
  }
}

/** Control characters other than tab, newline and return are dropped; the cap never splits a surrogate pair. */
export function capText(text: string, maxChars: number): string {
  const clean = text.replace(/(?![\t\n\r])\p{Cc}/gu, "");
  if (clean.length <= maxChars) return clean;
  const last = maxChars > 0 ? clean.charCodeAt(maxChars - 1) : 0;
  const endsOnHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return clean.slice(0, endsOnHighSurrogate ? maxChars - 1 : maxChars);
}

function extractOverride(value: unknown): ExtractOverride {
  return value === "force" || value === "skip" ? value : "auto";
}

/** Ops that change graph rows — what `result.accepted` and `stats.opsAccepted` count; audit and counters are bookkeeping. */
function countGraphOps(ops: readonly StoreOp[]): number {
  return ops.filter((op) => op.op !== "audit" && op.op !== "consolidationCounter").length;
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

// ── Admission (§5.1) ─────────────────────────────────────────────────────────

export interface IngestOptions {
  waitFor?: "recorded" | "processed";
  extract?: "auto" | "force" | "skip";
}

/** Spec §5.1 step 2: text capped and cleaned, `at` filled from the clock. Runs on a validated event. */
export function normaliseEvent(ev: IngestEvent, now: number): IngestEvent {
  const at = ev.at ?? iso(now);
  if (ev.type === "turn") {
    return { ...ev, userText: capText(ev.userText, USER_TEXT_MAX_CHARS), assistantText: capText(ev.assistantText, ASSISTANT_TEXT_MAX_CHARS), at };
  }
  return { ...ev, ...(ev.text !== undefined ? { text: capText(ev.text, FEEDBACK_TEXT_MAX_CHARS) } : {}), at };
}

/**
 * Spec §10.1: the event's raw text goes into a log line only at `debug` and
 * only when `retention.logRawText` is on — the one place it ever appears.
 */
function rawTextFields(ctx: IngestContext, ev: IngestEvent): Record<string, string> {
  if (!ctx.policy.retention.logRawText) return {};
  if (ev.type === "turn") return { userText: ev.userText, assistantText: ev.assistantText };
  return ev.text !== undefined ? { text: ev.text } : {};
}

function outcomeReceipt(eventId: string, outcome: JobOutcome): IngestReceipt {
  switch (outcome) {
    case "done":
      return { eventId, status: "processed" };
    case "failed":
      return { eventId, status: "failed", reason: "processing failed after every attempt" };
    case "skipped":
      return { eventId, status: "recorded", reason: "leased elsewhere" };
    case "not-due":
      return { eventId, status: "recorded", reason: "not due yet; left for drain()" };
    case "cancelled":
      return { eventId, status: "recorded", reason: "closed before processing; left for drain()" };
  }
}

/** `inline` mode is one attempt: a retry the queue would have scheduled is left to `drain()` (§5.1 step 4, serverless). */
function inlineReceipt(eventId: string, result: AttemptResult): IngestReceipt {
  switch (result.kind) {
    case "done":
      return { eventId, status: "processed" };
    case "failed":
      return { eventId, status: "failed", reason: "processing failed after every attempt" };
    case "skipped":
      return { eventId, status: "recorded", reason: "leased elsewhere" };
    case "not-due":
      return { eventId, status: "recorded", reason: "not due yet; left for drain()" };
    case "retry":
      return result.reason === "deferred"
        ? { eventId, status: "recorded", reason: "deferred until its turn arrives; left for drain()" }
        : { eventId, status: "failed", reason: "attempt failed; retry left for drain()" };
  }
}

async function admission(ctx: IngestContext, raw: IngestEvent, opts: IngestOptions, eventId: string, kind: string): Promise<IngestReceipt> {
  const validated = validateIngestEvent(raw);
  if (!validated.ok) {
    const reason = validated.issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; ");
    safe(() => ctx.logger.warn({ ...baseLog(ctx, stringOr(raw?.subjectId, "")), eventId, kind, reason, issues: validated.issues }, "ingest.rejected"));
    return { eventId, status: "rejected", reason };
  }
  const ev = normaliseEvent(validated.value, ctx.clock.now());
  const ref: SubjectRef = { tenantId: ctx.tenantId, subjectId: ev.subjectId };
  const log = { ...baseLog(ctx, ev.subjectId), eventId: ev.id, kind: ev.type };

  let claim: "claimed" | "duplicate";
  try {
    claim = await ctx.store.claimEvent(ctx.tenantId, ev);
  } catch (e) {
    safe(() => ctx.logger.error({ ...log, method: "claimEvent", error: describeError(e) }, "store.error"));
    ctx.stats.failed += 1;
    return { eventId: ev.id, status: "failed", reason: describeError(e) };
  }
  if (claim === "duplicate") {
    ctx.stats.duplicates += 1;
    debug(ctx, log, "ingest.duplicate");
    return { eventId: ev.id, status: "duplicate" };
  }
  ctx.stats.ingested += 1;
  ctx.subjects.add(ev.subjectId);

  const extract = extractOverride(opts.extract);
  // This job's own count of attempts that were not deferrals, the fallback
  // budget when an attempt cannot even lease the row (see `failAttempt`).
  let local = 0;
  const attempt = async (): Promise<AttemptResult> => {
    const result = await processEvent(ctx, { eventId: ev.id, subjectId: ev.subjectId, extract, local: local + 1 });
    if (result.kind !== "retry" || result.reason !== "deferred") local += 1;
    return result;
  };
  const unscheduled = (reason: "overflow" | "closed"): IngestReceipt => {
    safe(() => ctx.logger.warn({ ...log, reason, queueDepth: ctx.queue.depth }, "ingest.unscheduled"));
    return { eventId: ev.id, status: "recorded", reason: `${reason}; left pending for drain()` };
  };
  const recorded = { ...log, ...rawTextFields(ctx, ev) };
  if (ctx.retry.inline) {
    // Inline mode skips the queue, not its lifetime: after `close()` the model
    // signal aborts, so the row is left for `drain()` as a queued one is.
    if (ctx.queue.isClosed) return unscheduled("closed");
    debug(ctx, recorded, "ingest.recorded");
    return inlineReceipt(ev.id, await attempt());
  }

  const enqueued = ctx.queue.enqueue(cacheKey(ref), attempt);
  if (!enqueued.accepted) return unscheduled(enqueued.reason);
  debug(ctx, recorded, "ingest.recorded");
  if (opts.waitFor !== "processed") return { eventId: ev.id, status: "recorded" };
  return outcomeReceipt(ev.id, await enqueued.outcome);
}

/**
 * Spec §5.1 and §2.7: never rejects. Validates, caps, claims the row,
 * schedules the attempt (or runs it inline) and answers with a receipt
 * whose status says exactly how far the event got.
 */
export async function admit(ctx: IngestContext, raw: IngestEvent, opts: IngestOptions = {}): Promise<IngestReceipt> {
  const eventId = stringOr(raw?.id, "");
  const kind = stringOr(raw?.type, "?");
  const span = startSpan(ctx, "wisdom.ingest.admit", { "wisdom.event_id": eventId, "wisdom.kind": kind });
  let receipt: IngestReceipt;
  try {
    receipt = await admission(ctx, raw, opts ?? {}, eventId, kind);
  } catch (e) {
    safe(() => ctx.logger.error({ ...baseLog(ctx, stringOr(raw?.subjectId, "")), eventId, error: describeError(e) }, "ingest.error"));
    safe(() => span.recordException(e));
    receipt = { eventId, status: "failed", reason: describeError(e) };
  }
  safe(() => {
    span.setAttribute("wisdom.result", receipt.status);
    span.end();
  });
  return receipt;
}

// ── Turn handling (§5.3) ─────────────────────────────────────────────────────

/** Fields a turn may change on a node. */
export interface NodeEdit {
  agents?: string[];
  keywords?: string[];
}

/**
 * The first write of a subject materialises its virtual nodes (§3.1), and
 * every write carries the turn's node edits: merged into the row for a
 * node that does not exist yet, a `patchNode` for one that does. Only
 * virtual nodes are upserted — an existing category row has learned
 * agents and keywords the seed does not know.
 */
export function materialise(snapshot: SubjectSnapshot, edits: ReadonlyMap<string, NodeEdit>, at: string): StoreOp[] {
  const ops: StoreOp[] = [];
  for (const node of snapshot.nodes) {
    const edit = edits.get(node.path);
    if (node.virtual) {
      const { virtual, ...row } = node;
      void virtual;
      const touched: Partial<TopicNode> = edit === undefined ? {} : { ...edit, stats: { ...row.stats, lastIngestAt: at }, updatedAt: at };
      ops.push({ op: "upsertNode", node: { ...row, ...touched } });
    } else if (edit !== undefined) {
      const patch: NodePatch = { ...edit, stats: { ...node.stats, lastIngestAt: at } };
      ops.push({ op: "patchNode", nodeId: node.id, patch });
    }
  }
  return ops;
}

/**
 * Spec §5.3 step 2, keywords: up to three words of `userText` the node
 * does not know, rarest in the graph first (document frequency over the
 * classifier index; a word no node carries ranks highest). The stored form
 * is the word as typed, lower-cased, so an outline reads "withdrawals"
 * rather than its stem; comparisons run on stems so "withdrawal" already
 * covers it. Over the cap, the oldest keyword that is neither a seed of a
 * category node nor one of this turn's additions goes first; when nothing
 * can go, the additions are trimmed instead.
 */
export function refreshKeywords(node: TopicNode, userText: string, snapshot: SubjectSnapshot): { keywords: string[]; added: string[] } {
  const seed = new Set(node.level === 1 ? (snapshot.categories.find((c) => c.path === node.path)?.keywords ?? []) : []);
  const known = new Set<string>();
  for (const keyword of node.keywords) for (const token of tokenize(keyword)) known.add(token);
  const seen = new Set<string>();
  const candidates: { word: string; df: number }[] = [];
  for (const word of tokenize(userText, { stem: false })) {
    if (seen.has(word)) continue;
    seen.add(word);
    if (word.length < 3 || /^\d+$/.test(word) || !KEYWORD_PATTERN.test(word)) continue;
    const stem = stemLite(word);
    if (known.has(stem)) continue;
    known.add(stem);
    candidates.push({ word, df: snapshot.index.documentFrequency(stem) });
  }
  candidates.sort((a, b) => a.df - b.df);
  let added = candidates.slice(0, KEYWORD_REFRESH_MAX).map((c) => c.word);
  const keywords = [...node.keywords, ...added];
  while (keywords.length > MAX_KEYWORDS) {
    const index = keywords.findIndex((k) => !seed.has(k) && !added.includes(k));
    if (index === -1) break;
    keywords.splice(index, 1);
  }
  if (keywords.length > MAX_KEYWORDS) {
    const over = keywords.length - MAX_KEYWORDS;
    keywords.splice(keywords.length - over, over);
    added = added.slice(0, added.length - over);
  }
  return { keywords, added };
}

export interface TurnHandlerContext {
  policy: PolicyConfig;
  sampler: Sampler;
  extract: ExtractOverride;
  /** ISO-8601 instant the turn's writes are stamped with (the event's `at`). */
  at: string;
  /** A gate decision already taken for this turn: a re-plan after a version conflict reuses it rather than rolling the die again. */
  decision?: TriageDecision;
}

export interface TurnPlan {
  /** Materialisation, node edits and application counters, in that order. */
  ops: StoreOp[];
  /** The applied ids that exist in the snapshot and do not carry this turn yet, each once — the hints whose counters move. */
  applied: string[];
  learned: { path: string; agents: string[] }[];
  /** `agentsUsed` entries that are not slugs and were therefore not learned (§9.1). */
  ignoredAgents: number;
  keywords: { path: string; added: string[] } | null;
  gate: TriageDecision;
  /** Where the turn classified, or `null` for "direct". */
  topicPath: string | null;
}

/** Every site but an agent's own preamble renders for any turn; that one renders only when the agent ran. */
function renderedFor(turn: TurnEvent, hint: HintRecord): boolean {
  if (hint.lane !== "agent" || hint.scope !== "agent" || hint.agent === undefined) return true;
  return (turn.agentsUsed ?? []).includes(hint.agent);
}

/**
 * Spec §5.3 steps 1–3, without I/O: application counters for the applied
 * hints, `agentsUsed` learned onto the best node, its category and the
 * router's category, a keyword refresh on the best node, and the triage
 * decision. The extraction step (4) is the caller's, because it is the
 * one that needs a port.
 */
export function handleTurn(turn: TurnEvent, snapshot: SubjectSnapshot, ctx: TurnHandlerContext): TurnPlan {
  const at = ctx.at;
  // The turn goes into each applied hint's provenance (§3.3 lists turn ids
  // there), which is also how a replay knows the counter has already moved.
  // `Recall.provenance` is the candidate set across every agent bucket; an
  // agent's own agent-lane hints render only in that agent's preamble, so
  // they count as applied only when the agent ran (§5.3 step 1).
  const applied = appliedHints(turn, snapshot)
    .filter((h) => renderedFor(turn, h) && !alreadyApplied(h, turn.id))
    .map((h) => h.id);
  const provenance = { appendEventId: turn.id, appendRunId: turn.runId };
  const hintOps: StoreOp[] = applied.map((hintId) => ({ op: "patchHint", hintId, patch: { applied: { add: 1 }, lastAppliedAt: at, provenance } }));

  // The text alone decides where it classifies; the router's category is a
  // second target, not a hint — otherwise every turn would learn onto the
  // router's choice and a sub-node the text is plainly about would never see
  // the agents that answered it.
  const configured = turn.category !== undefined && snapshot.categoryNames.has(turn.category) ? join(ROOT_PATH, turn.category) : undefined;
  const { topic } = classify(snapshot, turn.userText, { policy: ctx.policy });
  const best = topic.category === DIRECT_CATEGORY ? undefined : topic.nodePaths[0];
  const targets: string[] = [];
  const target = (path: string | undefined): void => {
    if (path !== undefined && !targets.includes(path)) targets.push(path);
  };
  if (best !== undefined) {
    target(best);
    const category = categoryOf(best);
    if (category !== null) target(join(ROOT_PATH, category));
  }
  target(configured);

  // Only slugs are learned (§9.1): a configured name is one, and a name
  // that is not — anything a consumer's `agentsUsed` can carry, newlines
  // included — would otherwise become vocabulary the organiser accepts for
  // an agent-scoped hint and text the outline renders into every later
  // prompt, which is exactly what the prompt's withholding rule refuses.
  const agentsUsed = turn.agentsUsed ?? [];
  const agents = unique(agentsUsed.filter((a) => a !== DIRECT_CATEGORY && SLUG_PATTERN.test(a)));
  const ignoredAgents = unique(agentsUsed.filter((a) => a !== DIRECT_CATEGORY && !SLUG_PATTERN.test(a))).length;
  const edits = new Map<string, NodeEdit>();
  const learned: TurnPlan["learned"] = [];
  for (const path of targets) {
    const node = snapshot.nodesByPath.get(path);
    if (node === undefined || node.status !== "active") continue;
    const added = agents.filter((a) => !node.agents.includes(a));
    if (added.length === 0) continue;
    edits.set(path, { agents: [...node.agents, ...added] });
    learned.push({ path, agents: added });
  }

  // Keywords are classifier input, so only text the classifier could place
  // teaches them (§5.3 step 2, "the best node"). A direct turn routed by the
  // consumer to a category is learned as agents there, never as keywords:
  // its words are by definition the ones no node recognised. A node already
  // stamped with this turn's instant was refreshed by this turn before a
  // crash (§5.2): the refresh is capped per turn, so running it again would
  // learn the next three words rather than the same three.
  let keywords: TurnPlan["keywords"] = null;
  const keywordNode = best === undefined ? undefined : snapshot.nodesByPath.get(best);
  if (best !== undefined && keywordNode !== undefined && keywordNode.status === "active" && keywordNode.stats.lastIngestAt !== at) {
    const refreshed = refreshKeywords(keywordNode, turn.userText, snapshot);
    if (refreshed.added.length > 0) {
      edits.set(best, { ...edits.get(best), keywords: refreshed.keywords });
      keywords = { path: best, added: refreshed.added };
    }
  }

  return {
    ops: [...materialise(snapshot, edits, at), ...hintOps],
    applied,
    learned,
    ignoredAgents,
    keywords,
    gate: ctx.decision ?? shouldExtract(turn, ctx.policy, ctx.sampler, ctx.extract),
    topicPath: best ?? null,
  };
}

// ── Processing (§5.2) ────────────────────────────────────────────────────────

interface EventPlan {
  ops: StoreOp[];
  accepted: number;
  rejected: { op: string; reason: string }[];
  extracted: boolean;
  llmMs: number;
  /** The proposal in play — stored on the row, or produced now — so a re-plan after a version conflict reuses it. */
  proposal: Proposal | null;
  /** A turn's gate decision, so a re-plan after a version conflict extracts exactly when the first plan did. */
  gate?: TriageDecision;
  /** Set instead of ops when the event must wait (feedback before its turn). */
  deferMs?: number;
  /** Node paths the organiser left over `caps.maxActiveHintsPerNode` (§5.6): the overflow trigger of the short-term pass. */
  overflow: string[];
}

/** The snapshot an attempt plans against: the cache's fresh entry, or a (deduped) load. */
async function ingestSnapshot(ctx: IngestContext, ref: SubjectRef): Promise<SubjectSnapshot> {
  const lookup = ctx.cache.lookup(ref);
  if (lookup.state === "hit") return lookup.snapshot;
  return ctx.cache.load(ref, snapshotLoader(ctx, ref));
}

/**
 * One model-backed step under its span: the extraction seam or the
 * consolidation seam. Counts the calls, persists the proposal on the row
 * before the caller applies (§5.2) — only when the row had none, so a replay
 * never overwrites what the first attempt stored — and times the step.
 */
async function modelStep(
  ctx: IngestContext,
  eventId: string,
  spanName: string,
  storedProposal: Proposal | null,
  step: () => Promise<ExtractionResult>,
): Promise<ExtractionResult & { llmMs: number }> {
  const span = startSpan(ctx, spanName, { "wisdom.event_id": eventId });
  const started = ctx.clock.now();
  try {
    // The lease was taken before the snapshot load and the plan; the model
    // step is the long wait, so it starts on a fresh term sized for it.
    await ctx.store.updateEvent(ctx.tenantId, eventId, { leaseUntil: iso(started + leaseMsFor(ctx.policy)) });
    const result = await step();
    ctx.stats.llmCalls += result.llmCalls ?? (result.usedLlm ? 1 : 0);
    if (result.proposal !== null && storedProposal === null) {
      await ctx.store.updateEvent(ctx.tenantId, eventId, { proposal: result.proposal });
    }
    const llmMs = ctx.clock.now() - started;
    safe(() => {
      span.setAttribute("wisdom.ops_accepted", result.accepted);
      span.setAttribute("wisdom.ops_rejected", result.rejected.length);
      span.setAttribute("wisdom.llm_ms", llmMs);
    });
    return { ...result, llmMs };
  } catch (e) {
    safe(() => span.recordException(e));
    throw e;
  } finally {
    safe(() => span.end());
  }
}

/** The extraction step through the seam; `null` when there is nothing to call. */
async function extractFor(
  ctx: IngestContext,
  row: StoredEvent,
  input: Omit<ExtractionInput, "signal">,
): Promise<(ExtractionResult & { llmMs: number }) | null> {
  const log = { ...baseLog(ctx, input.ref.subjectId), eventId: row.event.id };
  const extractor = ctx.extractor;
  if (ctx.llm === undefined || extractor === undefined) {
    debug(ctx, { ...log, reason: ctx.llm === undefined ? "no-llm" : "no-extractor" }, "ingest.extraction-skipped");
    return null;
  }
  return modelStep(ctx, row.event.id, "wisdom.ingest.extract", input.storedProposal, () => extractor(ctx, { ...input, signal: ctx.signal }));
}

async function planTurn(
  ctx: IngestContext,
  ref: SubjectRef,
  row: StoredEvent,
  turn: TurnEvent,
  snapshot: SubjectSnapshot,
  extract: ExtractOverride,
  storedProposal: Proposal | null,
  decision: TriageDecision | undefined,
): Promise<EventPlan> {
  const at = turn.at ?? iso(ctx.clock.now());
  const span = startSpan(ctx, "wisdom.ingest.triage", { "wisdom.event_id": turn.id });
  let plan: TurnPlan;
  try {
    plan = handleTurn(turn, snapshot, { policy: ctx.policy, sampler: ctx.sampler, extract, at, ...(decision !== undefined ? { decision } : {}) });
  } finally {
    safe(() => span.end());
  }
  safe(() => span.setAttribute("wisdom.extracted", plan.gate.extract));
  debug(
    ctx,
    { ...baseLog(ctx, ref.subjectId), eventId: turn.id, gate: plan.gate.reason, extract: plan.gate.extract, applied: plan.applied.length, topicPath: plan.topicPath },
    "ingest.triage",
  );
  if (plan.ignoredAgents > 0) debug(ctx, { ...baseLog(ctx, ref.subjectId), eventId: turn.id, ignored: plan.ignoredAgents }, "ingest.agents-ignored");

  const ops = [...plan.ops];
  let accepted = countGraphOps(ops);
  let rejected: EventPlan["rejected"] = [];
  let extracted = false;
  let llmMs = 0;
  let proposal = storedProposal;
  let overflow: string[] = [];
  if (plan.gate.extract) {
    const result = await extractFor(ctx, row, { ref, event: turn, anchor: turn, snapshot, source: "inferred", targeted: [], storedProposal });
    if (result !== null) {
      ops.push(...result.ops);
      accepted += result.accepted;
      rejected = result.rejected;
      extracted = true;
      llmMs = result.llmMs;
      proposal = result.proposal;
      overflow = result.needsConsolidation ?? [];
    }
  }
  plan.learned.forEach((l, i) => {
    ops.push(eventAudit(ref, { eventId: turn.id, seq: `agents:${i}`, at, actor: INGEST_ACTOR, action: "node.agents", nodePath: l.path, detail: { added: l.agents } }));
  });
  // Not idempotent on replay: the counter carries no event identity (see the header).
  ops.push({ op: "consolidationCounter", action: "increment" });
  return { ops, accepted, rejected, extracted, llmMs, proposal, gate: plan.gate, overflow };
}

async function planFeedback(
  ctx: IngestContext,
  ref: SubjectRef,
  row: StoredEvent,
  fb: FeedbackEvent,
  attempt: number,
  snapshot: SubjectSnapshot,
  storedProposal: Proposal | null,
): Promise<EventPlan> {
  const at = fb.at ?? iso(ctx.clock.now());
  const log = { ...baseLog(ctx, ref.subjectId), eventId: fb.id };
  const anchor = await ctx.store.getTurn(ref, fb.runId);
  if (anchor === null && attempt <= ctx.policy.ingest.feedbackAnchorRetries) {
    return { ops: [], accepted: 0, rejected: [], extracted: false, llmMs: 0, proposal: storedProposal, deferMs: ctx.policy.ingest.feedbackAnchorDelayMs, overflow: [] };
  }
  if (anchor === null) debug(ctx, { ...log, runId: fb.runId, attempts: attempt }, "ingest.unanchored");
  if (fb.target?.startsWith("tool:")) debug(ctx, { ...log, target: fb.target }, "ingest.tool-target");

  const ops = [...materialise(snapshot, new Map(), at), ...applyFeedback(fb, anchor, snapshot, ctx.policy)];
  let accepted = countGraphOps(ops);
  let rejected: EventPlan["rejected"] = [];
  let extracted = false;
  let llmMs = 0;
  let proposal = storedProposal;
  let overflow: string[] = [];
  const text = fb.text?.trim() ?? "";
  const wantsExtraction = text.length > 0 && (fb.signal === "comment" || fb.signal === "correction" || fb.signal === "down");
  if (wantsExtraction) {
    const targeted = targetedHints(fb, anchor, snapshot);
    const result = await extractFor(ctx, row, { ref, event: fb, anchor, snapshot, source: "explicit", targeted, storedProposal });
    if (result !== null) {
      ops.push(...result.ops);
      accepted += result.accepted;
      rejected = result.rejected;
      extracted = true;
      llmMs = result.llmMs;
      proposal = result.proposal;
      overflow = result.needsConsolidation ?? [];
    }
  }
  // Not idempotent on replay: the counter carries no event identity (see the header).
  ops.push({ op: "consolidationCounter", action: "increment" });
  return { ops, accepted, rejected, extracted, llmMs, proposal, overflow };
}

/**
 * A `consolidate` row (§5.7): the seam builds the prompt for the node, calls
 * the model unless the row already carries a proposal, and gates the reply
 * through the organiser. No counter increment — the pass is not an event
 * the subject learns from, and it must never make itself due again.
 */
async function planConsolidate(
  ctx: IngestContext,
  ref: SubjectRef,
  hooks: ConsolidationHooks,
  ev: ConsolidateEvent,
  snapshot: SubjectSnapshot,
  storedProposal: Proposal | null,
): Promise<EventPlan> {
  const result = await modelStep(ctx, ev.id, "wisdom.ingest.consolidate", storedProposal, () =>
    hooks.plan(ctx, { ref, event: ev, snapshot, storedProposal, signal: ctx.signal }),
  );
  return {
    ops: result.ops,
    accepted: result.accepted,
    rejected: result.rejected,
    extracted: result.usedLlm,
    llmMs: result.llmMs,
    proposal: result.proposal,
    overflow: result.needsConsolidation ?? [],
  };
}

function planEvent(
  ctx: IngestContext,
  ref: SubjectRef,
  row: StoredEvent,
  body: StoredEventBody,
  hooks: ConsolidationHooks | undefined,
  attempt: number,
  snapshot: SubjectSnapshot,
  extract: ExtractOverride,
  storedProposal: Proposal | null,
  decision?: TriageDecision,
): Promise<EventPlan> {
  if (body.type === "turn") return planTurn(ctx, ref, row, body, snapshot, extract, storedProposal, decision);
  if (body.type === "feedback") return planFeedback(ctx, ref, row, body, attempt, snapshot, storedProposal);
  if (hooks === undefined) return Promise.reject(new Error("consolidate events need the consolidation pass wired"));
  return planConsolidate(ctx, ref, hooks, body, snapshot, storedProposal);
}

/**
 * Spec §5.7's short-term triggers, checked once the row is `done`: the
 * subject's counter — this event's increment included — reaching
 * `consolidateEveryEvents`, or a node the organiser left over cap. The
 * counter is exact because the batch applied under `expectVersion` against
 * this very snapshot. Overflow is remembered for the LLM pass whether or
 * not the short-term pass runs now. A non-positive period disables the
 * counter trigger rather than firing on every event.
 */
async function consolidateIfDue(ctx: IngestContext, ref: SubjectRef, eventId: string, snapshot: SubjectSnapshot, overflow: readonly string[]): Promise<void> {
  flagOverflow(ctx, ref, overflow);
  const counter = snapshot.eventsSinceConsolidation + 1;
  const period = ctx.policy.ingest.consolidateEveryEvents;
  const due = (period > 0 && counter >= period) || overflow.length > 0;
  if (!due) return;
  const log = { ...baseLog(ctx, ref.subjectId), eventId, counter, overflow: [...overflow] };
  const hooks = ctx.consolidation;
  if (hooks === undefined) {
    debug(ctx, log, "consolidate.unwired");
    return;
  }
  debug(ctx, log, "consolidate.due");
  try {
    await hooks.due(ctx, ref, { counter, overflow: [...overflow] });
  } catch (e) {
    safe(() => ctx.logger.error({ ...log, error: describeError(e) }, "consolidate.error"));
  }
}

async function apply(ctx: IngestContext, ref: SubjectRef, plan: EventPlan, expectVersion: number, eventId: string): Promise<void> {
  const span = startSpan(ctx, "wisdom.ingest.apply", { "wisdom.event_id": eventId, "wisdom.ops_accepted": plan.accepted, "wisdom.ops_rejected": plan.rejected.length });
  try {
    await ctx.store.applyBatch(ref, plan.ops, { expectVersion });
  } catch (e) {
    safe(() => span.recordException(e));
    throw e;
  } finally {
    safe(() => span.end());
  }
}

async function defer(ctx: IngestContext, ref: SubjectRef, eventId: string, attempt: number, delayMs: number): Promise<AttemptResult> {
  const retryAt = iso(ctx.clock.now() + delayMs);
  await ctx.store.updateEvent(ctx.tenantId, eventId, { status: "pending", retryAt });
  debug(ctx, { ...baseLog(ctx, ref.subjectId), eventId, attempts: attempt, retryAt }, "ingest.deferred");
  return { kind: "retry", delayMs, reason: "deferred" };
}

/** The leased row, planned and applied once; a version conflict re-plans against a fresh snapshot and applies once more (§5.2). */
async function processRow(ctx: IngestContext, ref: SubjectRef, row: StoredEvent, attempt: number, extract: ExtractOverride, span: SpanLike, started: number): Promise<AttemptResult> {
  const body = row.event;
  const eventId = body.id;
  const log = { ...baseLog(ctx, ref.subjectId), eventId, kind: body.type };
  const hooks = ctx.consolidation;
  if (body.type === "consolidate" && hooks === undefined) {
    await ctx.store.updateEvent(ctx.tenantId, eventId, { status: "failed", error: "consolidate events are not handled by this engine", attempts: attempt });
    safe(() => ctx.logger.warn(log, "ingest.unsupported"));
    ctx.stats.failed += 1;
    return { kind: "failed" };
  }

  let snapshot = await ingestSnapshot(ctx, ref);
  let plan = await planEvent(ctx, ref, row, body, hooks, attempt, snapshot, extract, row.proposal ?? null);
  if (plan.deferMs !== undefined) return defer(ctx, ref, eventId, attempt, plan.deferMs);
  try {
    await apply(ctx, ref, plan, snapshot.version, eventId);
  } catch (e) {
    if (!(e instanceof VersionConflictError)) throw e;
    debug(ctx, { ...log, expected: e.expected, actual: e.actual }, "ingest.version-conflict");
    ctx.cache.invalidate(ref);
    snapshot = await ingestSnapshot(ctx, ref);
    // The first plan's proposal and gate decision carry over: a conflict changes what the ops apply to, never whether the event extracts.
    plan = await planEvent(ctx, ref, row, body, hooks, attempt, snapshot, extract, plan.proposal, plan.gate);
    if (plan.deferMs !== undefined) return defer(ctx, ref, eventId, attempt, plan.deferMs);
    await apply(ctx, ref, plan, snapshot.version, eventId);
  }
  await ctx.store.updateEvent(ctx.tenantId, eventId, { status: "done", result: { accepted: plan.accepted, rejected: plan.rejected } });
  ctx.cache.invalidate(ref);
  ctx.stats.processed += 1;
  ctx.stats.opsAccepted += plan.accepted;
  ctx.stats.opsRejected += plan.rejected.length;
  const elapsedMs = ctx.clock.now() - started;
  safe(() =>
    ctx.logger.info(
      { ...log, extracted: plan.extracted, opsAccepted: plan.accepted, opsRejected: plan.rejected.length, elapsedMs, attempts: attempt },
      "ingest.processed",
    ),
  );
  safe(() => {
    span.setAttribute("wisdom.extracted", plan.extracted);
    span.setAttribute("wisdom.ops_accepted", plan.accepted);
    span.setAttribute("wisdom.ops_rejected", plan.rejected.length);
    span.setAttribute("wisdom.llm_ms", plan.llmMs);
  });
  // A consolidate row only ever remembers its overflow: the pass it belongs to is already running.
  if (body.type === "consolidate") flagOverflow(ctx, ref, plan.overflow);
  else await consolidateIfDue(ctx, ref, eventId, snapshot, plan.overflow);
  return { kind: "done" };
}

/**
 * How many of a row's attempts were feedback-anchor deferrals rather than
 * failures. The row counts both (§5.4 reads `attempts` for the deferral
 * cap), but only failures may spend the retry budget — otherwise a thumb
 * that waited its three turns for a run would be one transient store error
 * from terminal. Deferrals are taken to come first, which is the order
 * the anchor rule produces; a failure that precedes one is counted once
 * too generously and the bound stays finite.
 */
function deferralsOf(ctx: IngestContext, row: StoredEvent | undefined, attempts: number): number {
  if (row?.event.type !== "feedback") return 0;
  return Math.max(0, Math.min(attempts - 1, ctx.policy.ingest.feedbackAnchorRetries));
}

/**
 * The error path of one attempt: the next backoff step while retries
 * remain, the terminal `failed` otherwise. `attempts` is the row's count
 * when the row was leased, the job's own count when the lease itself
 * failed — so a store that is down is retried on the same schedule and
 * still gives up. The terminal audit row has one id per event, so a
 * poison-pill row that every `drain()` retries converges on a single
 * `event.failed` entry instead of growing the audit by one per cron tick.
 */
async function failAttempt(ctx: IngestContext, ref: SubjectRef, row: StoredEvent | undefined, attempts: number, error: unknown): Promise<AttemptResult> {
  const message = describeError(error);
  const eventId = row?.event.id;
  const log = { ...baseLog(ctx, ref.subjectId), eventId, attempts, error: message };
  const { maxAttempts, backoffMs } = ctx.retry;
  const failures = attempts - deferralsOf(ctx, row, attempts);
  if (failures <= maxAttempts) {
    const delayMs = backoffMs[failures - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
    const retryAt = iso(ctx.clock.now() + delayMs);
    if (eventId !== undefined) {
      await tryStore(ctx, ref.subjectId, "updateEvent", () => ctx.store.updateEvent(ctx.tenantId, eventId, { status: "failed", error: message, retryAt }));
    }
    safe(() => ctx.logger.warn({ ...log, retryAt }, "ingest.retry"));
    return { kind: "retry", delayMs, reason: "backoff" };
  }
  if (eventId !== undefined) {
    await tryStore(ctx, ref.subjectId, "updateEvent", () => ctx.store.updateEvent(ctx.tenantId, eventId, { status: "failed", error: message }));
    const audit = eventAudit(ref, {
      eventId,
      seq: "failed",
      at: iso(ctx.clock.now()),
      actor: INGEST_ACTOR,
      action: "event.failed",
      detail: { error: message, attempts },
    });
    await tryStore(ctx, ref.subjectId, "applyBatch", () => ctx.store.applyBatch(ref, [audit]));
  }
  safe(() => ctx.logger.error(log, "ingest.failed"));
  ctx.stats.failed += 1;
  return { kind: "failed" };
}

export interface ProcessTarget {
  eventId: string;
  subjectId: string;
  extract: ExtractOverride;
  /** A row `drain()` already leased; otherwise the attempt leases it. */
  leased?: StoredEvent;
  /** This job's own count of attempts that were not deferrals, for the case where the row could not be leased at all. */
  local: number;
}

/**
 * Why a row this attempt could not lease: already `done` (a `drain()` on
 * this engine or another finished it), `not-due` (its `retry_at` is still
 * ahead on the injected clock — the queue's wall-clock timer ran early, or
 * a test's clock did not move), or `skipped` (leased by another worker, or
 * gone). A store error reads as `skipped`: the row is left where it is.
 */
async function unleasable(ctx: IngestContext, eventId: string, now: number): Promise<{ kind: "done" | "not-due" | "skipped"; retryAt?: string }> {
  try {
    const row = await ctx.store.getEvent(ctx.tenantId, eventId);
    if (row === null) return { kind: "skipped" };
    if (row.status === "done") return { kind: "done" };
    if (row.status !== "processing" && row.retryAt !== undefined && Date.parse(row.retryAt) > now) return { kind: "not-due", retryAt: row.retryAt };
    return { kind: "skipped" };
  } catch {
    return { kind: "skipped" };
  }
}

/**
 * One attempt at one event (§5.2): lease, count, plan, apply, mark done —
 * or hand the failure to the backoff. Never rejects; the result tells the
 * queue (or `drain()`) what happened. Spec §1 calls this `process`; the
 * name is not used because `core/` may never mention the Node global of
 * that name (the isolation test greps for it) and a function that shadows
 * it invites exactly that confusion.
 */
export async function processEvent(ctx: IngestContext, target: ProcessTarget): Promise<AttemptResult> {
  const ref: SubjectRef = { tenantId: ctx.tenantId, subjectId: target.subjectId };
  const started = ctx.clock.now();
  const span = startSpan(ctx, "wisdom.ingest.process", { "wisdom.event_id": target.eventId });
  let row = target.leased;
  let attempt = 0;
  try {
    if (row === undefined) {
      const now = ctx.clock.now();
      const rows = await ctx.store.leaseEvents({ tenantId: ctx.tenantId, ids: [target.eventId], limit: 1, leaseMs: leaseMsFor(ctx.policy), now });
      row = rows[0];
      if (row === undefined) {
        // A `drain()` may have taken the row first; when it has finished it, the receipt should say so.
        const state = await unleasable(ctx, target.eventId, now);
        const msg = state.kind === "done" ? "ingest.already-done" : state.kind === "not-due" ? "ingest.not-due" : "ingest.skipped";
        debug(ctx, { ...baseLog(ctx, ref.subjectId), eventId: target.eventId, ...(state.retryAt !== undefined ? { retryAt: state.retryAt } : {}) }, msg);
        safe(() => span.setAttribute("wisdom.result", state.kind));
        return { kind: state.kind };
      }
    }
    attempt = row.attempts + 1;
    safe(() => span.setAttribute("wisdom.attempt", attempt));
    await ctx.store.updateEvent(ctx.tenantId, target.eventId, { attempts: attempt });
    const result = await processRow(ctx, ref, row, attempt, target.extract, span, started);
    safe(() => span.setAttribute("wisdom.result", result.kind));
    return result;
  } catch (e) {
    safe(() => span.recordException(e));
    const result = await failAttempt(ctx, ref, row, attempt > 0 ? attempt : target.local, e);
    safe(() => span.setAttribute("wisdom.result", result.kind));
    return result;
  } finally {
    safe(() => span.end());
  }
}

// ── drain() (§5.2, §2.7) ─────────────────────────────────────────────────────

/**
 * Lease every unfinished row whose lease and `retry_at` have passed —
 * `pending`, `failed`, and a `processing` row whose worker died holding
 * it — oldest first, and run each through `processEvent`. The store's
 * default statuses are exactly that set; asking for `pending`/`failed`
 * alone would leave a crashed worker's row stranded, which is the one
 * case §5.2's replay guarantee exists for. A row whose attempt fails keeps
 * its backoff `retry_at` for the next drain rather than a timer here:
 * drain is the cron's and the startup's tool, and its report is complete
 * when it returns. Rows left unprocessed by an abort are released back to
 * `pending`.
 *
 * The batch is leased in one call so the rows are taken oldest-first and
 * exactly once across concurrent drains, but the rows are processed one
 * after another, and a lease taken for the batch is a guarantee only for
 * its term: the tenth row's lease may lapse while the first nine run their
 * model calls, after which another drain would take it and both would
 * process it. So each row is held afresh before it runs (`holdLease`), and
 * one whose lease was lost to another worker in the meantime is left to
 * that worker.
 */
export async function drain(ctx: IngestContext, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<{ processed: number; failed: number }> {
  const limit = opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit >= 0 ? Math.floor(opts.limit) : DRAIN_LIMIT;
  const leaseMs = leaseMsFor(ctx.policy);
  const rows = await ctx.store.leaseEvents({ tenantId: ctx.tenantId, limit, leaseMs, now: ctx.clock.now() });
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    if (opts.signal?.aborted) {
      for (const rest of rows.slice(i)) {
        await tryStore(ctx, rest.event.subjectId, "updateEvent", () => ctx.store.updateEvent(ctx.tenantId, rest.event.id, { status: "pending" }));
      }
      break;
    }
    const held = await holdLease(ctx, row, leaseMs);
    if (held === null) {
      debug(ctx, { ...baseLog(ctx, row.event.subjectId), eventId: row.event.id }, "ingest.lease-lost");
      continue;
    }
    ctx.subjects.add(row.event.subjectId);
    const result = await processEvent(ctx, { eventId: row.event.id, subjectId: row.event.subjectId, extract: "auto", leased: held, local: 0 });
    if (result.kind === "done") processed += 1;
    else if (result.kind === "failed" || (result.kind === "retry" && result.reason === "backoff")) failed += 1;
  }
  return { processed, failed };
}

/**
 * A batch-leased row, made safe to run now: still ours with at least half
 * its term left → as is; still ours but running low → renewed for a full
 * term (nobody else can hold a live lease, so the renewal races nothing);
 * lapsed → leased again through the store, which hands it back only if no
 * other worker took it, or `null`. A store that did not report the lease
 * it granted is read as "still ours" and renewed, never as lapsed: a row
 * this drain holds must not be skipped on a missing timestamp.
 */
async function holdLease(ctx: IngestContext, row: StoredEvent, leaseMs: number): Promise<StoredEvent | null> {
  const now = ctx.clock.now();
  const until = row.leaseUntil === undefined ? Number.NaN : Date.parse(row.leaseUntil);
  if (until <= now) {
    const [again] = await ctx.store.leaseEvents({ tenantId: ctx.tenantId, ids: [row.event.id], limit: 1, leaseMs, now });
    return again ?? null;
  }
  if (until - now >= leaseMs / 2) return row;
  const leaseUntil = iso(now + leaseMs);
  await ctx.store.updateEvent(ctx.tenantId, row.event.id, { leaseUntil });
  return { ...row, leaseUntil };
}
