/**
 * ingest/extract.ts — one model call, one retry, one proposal.
 *
 * Spec §5.5. This is the only place the library calls an `LlmPort`, and
 * the shape of the call is what keeps the rest of the write path honest:
 * JSON mode, a `purpose`, a `maxTokens`, and always a signal — the worker's
 * shutdown signal linked to an `llmTimeoutMs` deadline — so a hung model
 * ends the attempt instead of the process. A model that throws or times
 * out is a failed *attempt*: the error propagates, the ledger puts the row
 * on its backoff schedule, and the next attempt calls again. A model whose
 * answer is not a proposal at all is different: it gets exactly one more
 * chance, with the problem echoed, and then the event is done with nothing
 * extracted. Retrying a bad answer forever would spend money on a model
 * that has already shown it will not comply; retrying a timeout is what
 * the schedule is for.
 *
 * "Not a proposal at all" is deliberately narrow: the reply did not parse,
 * or parsed to something without an `ops` array. Parsing is tolerant
 * (fences stripped, the first balanced object taken), and that envelope is
 * all this step checks. Whether each op inside it is well formed is the
 * organiser's gate 1 (spec §5.6), which judges ops one at a time with a
 * reason code — so one invented key or one consolidation-only op costs
 * that op, never the seven good ones beside it, and never a second model
 * call to fix what the gate refuses for free. "unparseable" therefore
 * means exactly what it says.
 *
 * The persisted proposal is the replay contract (§5.2): the ledger writes
 * it before applying, and hands it back on the next attempt as
 * `storedProposal`, so `extractEvent` calls the model only when there is
 * none. The row carries the ops as the model wrote them, so a replay
 * judges the same ops and mints the same ids. When no attempt produced a
 * proposal the row carries `unparseableProposal()` instead — an empty
 * proposal with a fixed note — so the replay of a crashed event makes no
 * call either and still reports the `unparseable` rejection. `source`
 * never comes from the model; the ledger sets it from the event kind and
 * the organiser writes it.
 */

import type { ClockPort, LlmPort, LoggerPort, StorePort, SubjectRef } from "../ports";
import { deterministicId } from "../ids";
import type { PolicyConfig } from "../policy";
import type { FeedbackEvent, HintRecord, HintSource, JsonValue, TurnEvent } from "../types";
import type { Operation, Proposal } from "../schema/proposal";
import { estimateTokens, type Tokenizer } from "../text/tokens";
import { ROOT_PATH, join } from "../graph/paths";
import type { SubjectSnapshot } from "../graph/snapshot";
import { classify } from "../classify/index";
import { DIRECT_CATEGORY } from "../graph/seed";
import { Deadline, abortReason, raceSignal } from "../recall/deadline";
import { describeError } from "../recall/cache";
import type { ExtractionInput, ExtractionResult, Extractor, IngestContext } from "./ingest";
import { eventAudit } from "./feedback";
import { EXTRACTION_MAX_TOKENS, PROMPT_VERSION, buildExtractionPrompt, retryPrompt } from "./prompts";
import { agentVocabulary, validateProposal, type OrganiserContext } from "./organiser";

/** Attempts per extraction: the call and its one retry (§5.5). */
export const EXTRACTION_ATTEMPTS = 2;
/** The `result.rejected` entry an event carries when no attempt produced a proposal (§5.5). */
export const UNPARSEABLE = Object.freeze({ op: "*", reason: "unparseable" });
/** The `notes` of the proposal a row stores when no attempt produced one; see `unparseableProposal`. */
export const UNPARSEABLE_NOTE = "unparseable: no attempt returned a JSON object with an ops array";

/**
 * What the row stores when both attempts were unusable: nothing to apply,
 * marked so a replay (§5.2) reports the rejection again without calling
 * the model. A fresh object each time — a stored proposal is the ledger's
 * to keep. A model could write this note itself; the outcome is the same.
 */
export function unparseableProposal(): Proposal {
  return { ops: [], notes: UNPARSEABLE_NOTE };
}

export function isUnparseableProposal(proposal: Proposal | null): boolean {
  return proposal !== null && proposal.notes === UNPARSEABLE_NOTE && Array.isArray(proposal.ops) && proposal.ops.length === 0;
}

// ── Parsing (§5.5 "Parsing") ─────────────────────────────────────────────────

export type ParsedJson = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * The first balanced `{…}` in `text`, fences removed, parsed. Strings are
 * tracked so a brace inside a statement does not end the object early, and
 * a truncated reply (no closing brace) is reported rather than guessed at.
 */
export function extractJson(text: string): ParsedJson {
  if (typeof text !== "string") return { ok: false, reason: "reply was not text" };
  const unfenced = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const start = unfenced.indexOf("{");
  if (start === -1) return { ok: false, reason: "no JSON object in the reply" };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i += 1) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = unfenced.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) as unknown };
        } catch (e) {
          return { ok: false, reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
    }
  }
  return { ok: false, reason: "unbalanced JSON object (reply truncated?)" };
}

export type Envelope = { ok: true; value: Proposal } | { ok: false; reason: string };

/**
 * What a reply must be before its ops can be judged one by one (§5.5): an
 * object whose `ops` is an array. Unknown top-level keys are dropped; the
 * ops are kept exactly as written, because gate 1 (§5.6) decides each one
 * with a reason code and a replay must judge the same ops.
 */
export function proposalEnvelope(value: unknown): Envelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "the reply is not a JSON object" };
  const { ops, notes } = value as { ops?: unknown; notes?: unknown };
  if (!Array.isArray(ops)) return { ok: false, reason: '"ops" must be an array of operations' };
  // Unchecked on purpose: the organiser's structural gate is where an op is refused, per op.
  return { ok: true, value: { ops: ops as Operation[], ...(typeof notes === "string" ? { notes } : {}) } };
}

// ── The call ─────────────────────────────────────────────────────────────────

export interface ExtractionContext {
  policy: PolicyConfig;
  clock: ClockPort;
  /** The worker's signal; the timeout deadline is linked to it. */
  signal?: AbortSignal;
  logger?: LoggerPort;
  tokenizer?: Tokenizer;
  /** The turn the event anchors to (the turn itself, or feedback's run turn). */
  anchor: TurnEvent | null;
  /** Set by the ledger from the event kind; shown to the model, never taken from it. */
  source: HintSource;
  /** The applied hints a feedback event targets (§5.4 step 5). */
  targeted?: readonly HintRecord[];
  /** Agent vocabulary; default: the snapshot's categories plus learned agents. */
  agents?: readonly string[];
  /** Logged with every line. */
  tenantId?: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function safeLog(logger: LoggerPort | undefined, level: "debug" | "warn", obj: object, msg: string): void {
  if (logger === undefined) return;
  try {
    if (level === "debug") (logger.debug ?? logger.info).call(logger, obj, msg);
    else logger.warn(obj, msg);
  } catch {
    // Observability never fails an extraction.
  }
}

/**
 * The paths the outline expands for this event: where the anchor text
 * classifies (best first), the router's category when the turn carries a
 * configured one, and the nodes of the hints feedback is about. A direct
 * classification contributes nothing; the outline then shows the
 * categories alone and the model must pick one of them.
 */
export function focusPathsFor(snapshot: SubjectSnapshot, event: TurnEvent | FeedbackEvent, anchor: TurnEvent | null, targeted: readonly HintRecord[], policy: PolicyConfig): string[] {
  const out: string[] = [];
  const add = (path: string | undefined): void => {
    if (path !== undefined && path !== ROOT_PATH && !out.includes(path) && snapshot.nodesByPath.get(path)?.status === "active") out.push(path);
  };
  const text = [anchor?.userText ?? "", event.type === "feedback" ? (event.text ?? "") : ""].join(" ").trim();
  if (text.length > 0) {
    const { topic } = classify(snapshot, text, { policy });
    if (topic.category !== DIRECT_CATEGORY) for (const path of topic.nodePaths) add(path);
  }
  if (anchor?.category !== undefined && snapshot.categoryNames.has(anchor.category)) add(join(ROOT_PATH, anchor.category));
  for (const hint of targeted) add(hint.nodePath);
  return out;
}

/** What one model call needs from the context: the deadline's inputs and the log's. Shared with the consolidation pass. */
export type CompletionContext = Pick<ExtractionContext, "policy" | "clock" | "signal" | "logger" | "tokenizer">;

/** One `llm.complete` under the timeout deadline; throws on error, abort or timeout. */
export async function complete(
  llm: LlmPort,
  prompt: string,
  ctx: CompletionContext,
  purpose: "extract" | "consolidate",
  log: Record<string, unknown>,
  maxTokens: number = EXTRACTION_MAX_TOKENS,
): Promise<string> {
  const deadline = new Deadline(ctx.policy.ingest.llmTimeoutMs, ctx.clock, ctx.signal);
  const started = ctx.clock.now();
  const tokenizer = ctx.tokenizer ?? estimateTokens;
  try {
    const call = Promise.resolve().then(() => llm.complete(prompt, { json: true, signal: deadline.signal, purpose, maxTokens }));
    const outcome = await raceSignal(call, { signal: deadline.signal });
    const elapsedMs = ctx.clock.now() - started;
    if (outcome.status === "fulfilled") {
      const text = typeof outcome.value === "string" ? outcome.value : String(outcome.value);
      safeLog(ctx.logger, "debug", { ...log, purpose, promptTokens: tokenizer(prompt), responseTokens: tokenizer(text), elapsedMs, ok: true }, "llm.call");
      return text;
    }
    const reason = outcome.status === "rejected" ? outcome.reason : outcome.status === "aborted" ? outcome.reason : abortReason(deadline.signal);
    safeLog(ctx.logger, "debug", { ...log, purpose, promptTokens: tokenizer(prompt), elapsedMs, ok: false, error: describeError(reason), timedOut: deadline.timedOut() }, "llm.call");
    throw reason;
  } finally {
    deadline.dispose();
  }
}

/**
 * Spec §5.5: build the `extract@1` prompt, call the model once under the
 * deadline, parse tolerantly and check the envelope; when the reply is not
 * a proposal, once more with the problem appended. Resolves the proposal
 * as the model wrote it — its ops are the organiser's to judge — or `null`
 * when neither answer was one. Rejects when the model itself fails (error,
 * abort, timeout) — that is the attempt's failure, not the proposal's.
 */
export async function runExtraction(llm: LlmPort, snapshot: SubjectSnapshot, event: TurnEvent | FeedbackEvent, ctx: ExtractionContext): Promise<Proposal | null> {
  const agents = ctx.agents ?? agentVocabulary(snapshot);
  const targeted = ctx.targeted ?? [];
  const prompt = buildExtractionPrompt({
    snapshot,
    policy: ctx.policy,
    event,
    anchor: ctx.anchor,
    source: ctx.source,
    targeted,
    focusPaths: focusPathsFor(snapshot, event, ctx.anchor, targeted, ctx.policy),
    agents,
    ...(ctx.tokenizer !== undefined ? { tokenizer: ctx.tokenizer } : {}),
  });
  const log = { lib: "wisdom-graph", op: "ingest", tenantId: ctx.tenantId ?? null, subjectId: event.subjectId, eventId: event.id };

  let attemptPrompt = prompt;
  for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt += 1) {
    const text = await complete(llm, attemptPrompt, ctx, "extract", log);
    const parsed = extractJson(text);
    const envelope: Envelope = parsed.ok ? proposalEnvelope(parsed.value) : parsed;
    if (envelope.ok) return envelope.value;
    safeLog(ctx.logger, "debug", { ...log, attempt, problems: [envelope.reason] }, "llm.invalid-proposal");
    // Always from the original prompt, so the second retry note never stacks on a first.
    attemptPrompt = retryPrompt(prompt, [envelope.reason]);
  }
  return null;
}

// ── The seam the ledger calls (§5.5–5.6) ─────────────────────────────────────

function emptyResult(proposal: Proposal | null, usedLlm: boolean, llmCalls: number): ExtractionResult {
  return { ops: [], accepted: 0, rejected: [], proposal, usedLlm, llmCalls };
}

/** An `LlmPort` that counts the calls it forwards, so the ledger's `llmCalls` counts calls, not extractions. */
function counting(llm: LlmPort): { llm: LlmPort; calls: () => number } {
  let calls = 0;
  return {
    llm: {
      complete: (prompt, opts) => {
        calls += 1;
        return llm.complete(prompt, opts);
      },
    },
    calls: () => calls,
  };
}

/** A field of an object-shaped value; `undefined` for anything else. */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** The string elements of `value` when it is an array; a malformed op names nothing. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Hint ids a proposal names, plus the ids its ops would mint — what a
 * replay must be able to find. The ops are read as the model wrote them
 * (gate 1 has not run yet), so every field is checked before it is used.
 */
export function referencedHintIds(proposal: Proposal, ref: SubjectRef, eventId: string): string[] {
  const ids = new Set<string>();
  const mint = (label: string | number): void => {
    ids.add(deterministicId("h", ref.tenantId, ref.subjectId, eventId, label));
  };
  const ops: readonly unknown[] = Array.isArray(proposal?.ops) ? proposal.ops : [];
  ops.forEach((op, index) => {
    const hintId = fieldOf(op, "hintId");
    switch (fieldOf(op, "op")) {
      case "add_hint":
        mint(index);
        break;
      case "merge_hints":
        mint(index);
        for (const id of stringsOf(fieldOf(op, "hintIds"))) ids.add(id);
        break;
      case "update_hint":
        if (typeof hintId === "string") ids.add(hintId);
        mint(index);
        break;
      case "reinforce_hint":
      case "retire_hint":
      case "move_hint":
        if (typeof hintId === "string") ids.add(hintId);
        break;
      case "create_node": {
        const hints = fieldOf(op, "hints");
        if (Array.isArray(hints)) hints.forEach((_, j) => mint(`${index}.${j}`));
        break;
      }
      case "split_node": {
        const children = fieldOf(op, "children");
        if (Array.isArray(children)) for (const child of children) for (const id of stringsOf(fieldOf(child, "hintIds"))) ids.add(id);
        break;
      }
      default:
        break;
    }
  });
  return [...ids];
}

/**
 * The rows a proposal refers to that the snapshot does not carry: the
 * ingest snapshot holds active hints only, so a pending challenger, or a
 * hint this very event retired before a crash, is fetched by id. One
 * `getHint` per missing id, bounded by the op cap; nothing when every id
 * is already in the snapshot, which is the common case.
 */
export async function fetchExtraRecords(store: StorePort, ref: SubjectRef, snapshot: SubjectSnapshot, ids: readonly string[]): Promise<HintRecord[]> {
  const missing = ids.filter((id) => !snapshot.recordsById.has(id));
  if (missing.length === 0) return [];
  const rows = await Promise.all(missing.map((id) => store.getHint(ref, id)));
  return rows.filter((row): row is HintRecord => row !== null);
}

/** What the organiser needs from the ledger's context and the event. */
export function organiserContext(ctx: IngestContext, input: ExtractionInput, ref: SubjectRef, at: string): OrganiserContext {
  const event = input.event;
  return {
    ref,
    policy: ctx.policy,
    purpose: "extract",
    eventId: event.id,
    runId: event.runId,
    at,
    source: input.source,
    clientId: event.clientId ?? null,
    ...(event.type === "feedback" && event.target !== undefined ? { target: event.target } : {}),
    targeted: input.targeted,
    // No `model`: `LlmPort.complete` returns text only, and the turn's `model` is the chat model, not the extractor's.
    promptVersion: PROMPT_VERSION,
    ...(ctx.requireApproval !== undefined ? { requireApproval: ctx.requireApproval } : {}),
    shared: ctx.sharedSubjectId !== null && ctx.sharedSubjectId === ref.subjectId,
    event,
  };
}

/**
 * The ledger's extraction step: reuse the row's proposal or call the
 * model, run the organiser, and answer with the store ops and the counts.
 * A reply that never was a proposal is the one rejection with `op: "*"`
 * (§5.5), audited like any other rejected op and remembered on the row so
 * a replay repeats the verdict, not the calls.
 */
export const extractEvent: Extractor = async (ctx, input) => {
  const llm = ctx.llm;
  if (llm === undefined) return emptyResult(input.storedProposal, false, 0);
  const event = input.event;
  const ref = input.ref;
  const at = event.at ?? iso(ctx.clock.now());
  const log = { lib: "wisdom-graph", op: "ingest", tenantId: ctx.tenantId, subjectId: ref.subjectId, eventId: event.id };

  let proposal = input.storedProposal;
  let usedLlm = false;
  let llmCalls = 0;
  if (proposal === null) {
    usedLlm = true;
    const counted = counting(llm);
    try {
      proposal = await runExtraction(counted.llm, input.snapshot, event, {
        policy: ctx.policy,
        clock: ctx.clock,
        signal: input.signal,
        logger: ctx.logger,
        ...(ctx.tokenizer !== undefined ? { tokenizer: ctx.tokenizer } : {}),
        anchor: input.anchor,
        source: input.source,
        targeted: input.targeted,
        tenantId: ctx.tenantId,
      });
    } catch (e) {
      // The attempt fails, but the calls it made were made: count them before the ledger sees the error.
      ctx.stats.llmCalls += counted.calls();
      throw e;
    }
    llmCalls = counted.calls();
  }

  if (proposal === null || isUnparseableProposal(proposal)) {
    safeLog(ctx.logger, "warn", { ...log, op: UNPARSEABLE.op, reason: UNPARSEABLE.reason, index: -1 }, "proposal.rejected");
    // The audit row is written with the attempt that made the calls; a replay repeats the verdict without a second row.
    const ops = usedLlm
      ? [
          eventAudit(ref, {
            eventId: event.id,
            seq: "unparseable",
            at,
            actor: `llm:${PROMPT_VERSION}`,
            action: "op.rejected",
            detail: { op: UNPARSEABLE.op, reason: UNPARSEABLE.reason, attempts: EXTRACTION_ATTEMPTS },
          }),
        ]
      : [];
    return { ops, accepted: 0, rejected: [{ ...UNPARSEABLE }], proposal: proposal ?? unparseableProposal(), usedLlm, llmCalls };
  }

  const extraRecords = await fetchExtraRecords(ctx.store, ref, input.snapshot, referencedHintIds(proposal, ref, event.id));
  const result = validateProposal(proposal, input.snapshot, { ...organiserContext(ctx, input, ref, at), extraRecords });
  for (const r of result.rejected) {
    const detail: Record<string, JsonValue> = r.detail !== undefined ? { detail: r.detail } : {};
    safeLog(ctx.logger, "warn", { ...log, op: r.op, reason: r.reason, index: r.index, ...detail }, "proposal.rejected");
  }
  for (const r of result.rewrites) {
    safeLog(ctx.logger, "debug", { ...log, index: r.index, from: r.from, to: r.to, reason: r.reason, ...(r.target !== undefined ? { target: r.target } : {}) }, r.reason === "retargeted" ? "proposal.retargeted" : "proposal.rewritten");
  }
  if (result.needsConsolidation.length > 0) {
    safeLog(ctx.logger, "debug", { ...log, nodePaths: result.needsConsolidation }, "proposal.needs-consolidation");
  }
  return {
    ops: result.accepted,
    accepted: result.acceptedCount,
    rejected: result.rejected.map((r) => ({ op: r.op, reason: r.reason })),
    proposal,
    usedLlm,
    llmCalls,
    needsConsolidation: result.needsConsolidation,
  };
};
