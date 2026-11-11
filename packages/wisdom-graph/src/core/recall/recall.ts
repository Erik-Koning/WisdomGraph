/**
 * recall/recall.ts — the hot path, end to end.
 *
 * Spec §4. `recall()` is the one call the consumer makes on every turn and
 * races at 150 ms, so its contract is stricter than any other function in
 * the package: it never rejects, never calls a model, never writes, issues
 * at most one store round-trip, and returns a deep-frozen `Recall` whatever
 * the store, the ports or the caller did. The steps are the spec's, in the
 * spec's order — validate, snapshot, classify, collect, assemble — and
 * everything that makes the contract hold is one of three habits:
 *
 *   - **Race, never cancel.** The budget is a `Deadline`; the store load and
 *     the embedding call are raced against it with `raceSignal` and left to
 *     finish. A load that lost is the cache's to keep (Lane B gets it); the
 *     recall itself returns `empty` with the tagged reason.
 *   - **Classify outcomes by state, not by luck.** Whether a lost race
 *     reports `aborted` or `store-timeout` is read from the caller's signal
 *     and the deadline, not from which callback happened to run first, so
 *     the same situation always names the same reason.
 *   - **Two nets.** The pipeline catches its own errors and returns
 *     `empty/error`; `settleWithin` around it turns a slow or (impossibly)
 *     rejecting pipeline into `empty/budget`; a `try` around that catches
 *     what setting up the span or the deadline could throw. The `+5 ms`
 *     grace on the outer net is deliberate: a pipeline that finished inside
 *     the budget with a `partial` result must return it, not lose to the
 *     net by a scheduling tick.
 *
 * Steps 3–7 are exposed as `assembleRecall` and `buildRecall` because
 * `refine()` re-runs them on the cached snapshot and `explain()` runs them
 * as a dry run whose result must equal a real recall's — one function, one
 * answer.
 *
 * `emptyRecall` lives here too (spec §2.8): the value every failure path
 * degrades to, and the value the langgraph scope hands out when Lane A
 * times out, so it is exported for the consumer as well.
 */

import type { ClockPort, EmbeddingPort, LoggerPort, SpanLike, StorePort, SubjectRef, TracerPort } from "../ports";
import type { PolicyConfig } from "../policy";
import type {
  CategorySpec,
  EngineStats,
  HintStatus,
  NeutralMessage,
  Recall,
  RecallReason,
  RecallRequest,
  Surface,
  Topic,
} from "../types";
import { fnv1a32Hex, newId } from "../ids";
import { validateRecallRequest } from "../schema/request";
import type { Tokenizer } from "../text/tokens";
import { ROOT_PATH } from "../graph/paths";
import { compileSnapshot, type SubjectSnapshot } from "../graph/snapshot";
import { classify, type Classification } from "../classify/index";
import { rerankByEmbedding } from "../classify/embedding";
import { collectCandidates } from "./select";
import { assembleCharter, type Assembly } from "./charter";
import { Deadline, clampBudget, raceSignal, settleWithin } from "./deadline";
import { LruMap, SnapshotCache, describeError, type SnapshotLoader } from "./cache";

/** `text` is cut here before anything reads it (§2.5). */
export const MAX_QUERY_CHARS = 2000;
/** The user messages of `recentTurns` that are kept (§4.2 step 1). */
export const RECENT_USER_TURNS = 2;
/** The longest a miss on the shared subject may hold the primary (§4.2 step 2). */
export const SHARED_SUBJECT_WAIT_MS = 50;
/** The shared subject's entry stays fresh this many times longer (§4.2 step 2). */
export const SHARED_TTL_FACTOR = 4;
/** The outer net's grace over the budget (§4.1). */
export const GRACE_MS = 5;
/** Query vectors remembered for the embedding re-rank (§4.2 step 3). */
export const QUERY_VECTOR_CACHE = 256;

/** What the pipeline reads from the engine; built once by `createWisdomGraph`. */
export interface RecallContext {
  store: StorePort;
  policy: PolicyConfig;
  categories: readonly CategorySpec[];
  tenantId: string | null;
  sharedSubjectId: string | null;
  cache: SnapshotCache;
  clock: ClockPort;
  logger: LoggerPort;
  tracer: TracerPort;
  embeddings?: EmbeddingPort;
  tokenizer?: Tokenizer;
  /** `WisdomGraphOptions.surfaceCategories`: the category hint a request's `surface` carries. */
  surfaceCategories?: Readonly<Partial<Record<Surface, string>>>;
  /** Query text hash → vector, so a re-rank of a repeated question costs no embedding call. */
  queryVectors: LruMap<number[]>;
  /** Mutable counters behind `stats()`. */
  stats: EngineStats;
}

/** A validated request with the step-1 normalisation applied. */
export interface NormalisedRequest {
  subjectId: string;
  clientId: string | null;
  text: string;
  recentTurns: NeutralMessage[];
  surface?: RecallRequest["surface"];
  approvedOnly: boolean;
  refine: boolean;
  requestId: string;
  budgetMs: number;
  signal?: AbortSignal;
}

// ── The empty value ──────────────────────────────────────────────────────────

/** A frozen empty list under the mutable type `Topic` declares; the whole `Recall` is frozen anyway (§2.5). */
function noStrings(): string[] {
  const list: string[] = [];
  return Object.freeze(list) as string[];
}

const EMPTY_TOPIC: Topic = Object.freeze({
  category: "direct",
  agents: noStrings(),
  confidence: 0,
  nodePaths: noStrings(),
  method: "none",
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

interface EmptyFields {
  subjectId: string;
  clientId: string | null;
  requestId: string;
  reason: RecallReason | undefined;
  elapsedMs: number;
  now: number;
  cache: Recall["meta"]["cache"];
}

function buildEmpty(f: EmptyFields): Recall {
  const meta: Recall["meta"] = {
    requestId: f.requestId,
    status: "empty",
    ...(f.reason !== undefined ? { reason: f.reason } : {}),
    elapsedMs: f.elapsedMs,
    cache: f.cache,
    classifier: "none",
    refined: false,
  };
  return deepFreeze({
    topic: EMPTY_TOPIC,
    preRoute: [],
    agentHints: {},
    agentDefaults: [],
    responseStyle: [],
    provenance: [],
    charter: {
      subjectId: f.subjectId,
      clientId: f.clientId,
      generatedAt: new Date(f.now).toISOString(),
      topicPath: ROOT_PATH,
      entries: [],
      suppressed: [],
      dropped: [],
      approvalMix: "none",
      tokenEstimate: 0,
    },
    meta,
  });
}

/**
 * Spec §2.8: a frozen `Recall` with no hints for `req` — status `empty`,
 * the reason when given, a fresh request id when the request carries none.
 * Total on its input: anything that is not a request reads as an empty one.
 */
export function emptyRecall(req?: Pick<RecallRequest, "subjectId" | "clientId" | "requestId">, reason?: RecallReason): Recall {
  const clientId = req?.clientId;
  return buildEmpty({
    subjectId: stringOr(req?.subjectId, ""),
    clientId: typeof clientId === "string" ? clientId : null,
    requestId: stringOr(req?.requestId, "") || newId(),
    reason,
    elapsedMs: 0,
    now: Date.now(),
    cache: "none",
  });
}

// ── Step 1: validate and normalise ───────────────────────────────────────────

/**
 * The last `RECENT_USER_TURNS` user messages, plus every message that names
 * a tool (a `tool` reply or an assistant's tool calls), in their original
 * order. User text feeds the classifier's previous-turn tokens; tool names
 * feed its category hint (§4.2 step 3). Everything else is payload the hot
 * path never reads.
 */
export function trimTurns(turns: readonly NeutralMessage[] | undefined): NeutralMessage[] {
  if (turns === undefined) return [];
  const keep = new Set<number>();
  let users = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) continue;
    if (turn.role === "user") {
      if (users < RECENT_USER_TURNS) {
        keep.add(i);
        users += 1;
      }
    } else if (turn.role === "tool" || (turn.toolCalls?.length ?? 0) > 0) keep.add(i);
  }
  return turns.filter((_, i) => keep.has(i));
}

/**
 * The request's signal when it is structurally an `AbortSignal` — what the
 * validator accepts, but checked here because the deadline is built before
 * the validator runs and the request may be anything. The casts only name
 * the two properties the check reads; nothing else about the value is
 * trusted.
 */
function signalOf(value: unknown): AbortSignal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const signal: unknown = (value as { signal?: unknown }).signal;
  if (typeof signal !== "object" || signal === null) return undefined;
  const shaped = signal as { aborted?: unknown; addEventListener?: unknown };
  return typeof shaped.aborted === "boolean" && typeof shaped.addEventListener === "function" ? (signal as AbortSignal) : undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** Step 1 on a validated request. */
export function normaliseRequest(req: RecallRequest, requestId: string): NormalisedRequest {
  return {
    subjectId: req.subjectId,
    clientId: req.clientId ?? null,
    text: req.text.slice(0, MAX_QUERY_CHARS),
    recentTurns: trimTurns(req.recentTurns),
    ...(req.surface !== undefined ? { surface: req.surface } : {}),
    approvedOnly: req.approvedOnly === true,
    refine: req.refine === true,
    requestId,
    budgetMs: clampBudget(req.budgetMs),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  };
}

// ── Step 2 helpers: loaders and the shared subject ───────────────────────────

/** A cache loader: one `loadSnapshot` for `ref`, compiled with the engine's categories and policy. */
export function snapshotLoader(ctx: RecallContext, ref: SubjectRef, statuses?: HintStatus[]): SnapshotLoader {
  return async (signal) => {
    const data = await ctx.store.loadSnapshot(ref, statuses === undefined ? { signal } : { signal, statuses });
    return compileSnapshot(data, ctx.policy, ctx.logger, { ref, categories: ctx.categories, clock: ctx.clock });
  };
}

export function sharedRef(ctx: RecallContext, subjectId: string): SubjectRef | null {
  if (ctx.sharedSubjectId === null || ctx.sharedSubjectId === subjectId) return null;
  return { tenantId: ctx.tenantId, subjectId: ctx.sharedSubjectId };
}

/**
 * The shared subject's snapshot, if one is configured and it can be had in
 * time: a hit or a stale entry at once (stale refreshed in the background),
 * a miss raced for at most `SHARED_SUBJECT_WAIT_MS` of what the deadline
 * has left. When it cannot, the recall proceeds without it and reports
 * `partial` with the reason.
 */
export async function sharedSnapshot(
  ctx: RecallContext,
  subjectId: string,
  deadline: Deadline,
): Promise<{ shared: SubjectSnapshot | null; partial?: RecallReason }> {
  const ref = sharedRef(ctx, subjectId);
  if (ref === null) return { shared: null };
  const ttlMs = ctx.cache.ttlMs * SHARED_TTL_FACTOR;
  const loader = snapshotLoader(ctx, ref);
  const lookup = ctx.cache.lookup(ref);
  if (lookup.state === "hit") return { shared: lookup.snapshot };
  if (lookup.state === "stale") {
    ctx.cache.refresh(ref, loader, { ttlMs });
    return { shared: lookup.snapshot };
  }
  const outcome = await raceSignal(ctx.cache.load(ref, loader, { ttlMs }), {
    signal: deadline.signal,
    ms: Math.min(deadline.remaining(), SHARED_SUBJECT_WAIT_MS),
  });
  if (outcome.status === "fulfilled") return { shared: outcome.value };
  return { shared: null, partial: outcome.status === "rejected" ? "store-error" : "budget" };
}

// ── Step 3 helpers: classification and the embedding re-rank ─────────────────

/** The keyword classification of a normalised request against a snapshot, with the subject's continuity ring. */
export function classifyRequest(ctx: RecallContext, snapshot: SubjectSnapshot, req: NormalisedRequest, ref: SubjectRef): Classification {
  return classify(snapshot, req.text, {
    policy: ctx.policy,
    recentTurns: req.recentTurns,
    recentPaths: ctx.cache.recentPaths(ref),
    ...(req.surface !== undefined ? { surface: req.surface } : {}),
    ...(ctx.surfaceCategories !== undefined ? { surfaceCategories: ctx.surfaceCategories } : {}),
  });
}

/**
 * The query's vector from the port, remembered by text hash. `null` when
 * there is no port, the call failed, was aborted, or returned nothing
 * usable — every one of which means "keep the keyword result".
 */
export async function embedQuery(ctx: RecallContext, text: string, signal: AbortSignal): Promise<number[] | null> {
  const port = ctx.embeddings;
  if (port === undefined) return null;
  const key = fnv1a32Hex(text);
  const cached = ctx.queryVectors.get(key);
  if (cached !== undefined) return cached;
  let call: Promise<number[][]>;
  try {
    call = port.embed([text], { signal });
  } catch (e) {
    call = Promise.reject(e);
  }
  const outcome = await raceSignal(call, { signal });
  if (outcome.status === "rejected") {
    ctx.logger.warn({ lib: "wisdom-graph", op: "recall", tenantId: ctx.tenantId, error: describeError(outcome.reason) }, "embedding.error");
  }
  if (outcome.status !== "fulfilled") return null;
  const vector = Array.isArray(outcome.value) ? outcome.value[0] : undefined;
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  ctx.queryVectors.set(key, vector);
  return vector;
}

// ── Steps 4–7: candidates, charter, the Recall value ─────────────────────────

export interface AssembleRecallInput {
  snapshot: SubjectSnapshot;
  shared: SubjectSnapshot | null;
  req: NormalisedRequest;
  topic: Topic;
  /** Epoch ms: decay is measured against it and `generatedAt` derives from it. */
  now: number;
}

/** Steps 4–6 for one query: the lanes, the charter and the per-candidate trace. */
export function assembleRecall(ctx: RecallContext, input: AssembleRecallInput): Assembly {
  const { snapshot, shared, req, topic } = input;
  const candidates = collectCandidates(snapshot, shared, topic, req, ctx.policy);
  const invalidRowIds = snapshot.dropped.filter((d) => d.table === "hint" && d.id !== "?").map((d) => d.id);
  return assembleCharter(candidates, {
    policy: ctx.policy,
    now: input.now,
    topic,
    subjectId: req.subjectId,
    clientId: req.clientId,
    ...(ctx.tokenizer !== undefined ? { tokenizer: ctx.tokenizer } : {}),
    invalidRowIds,
  });
}

/** Step 7: the frozen `Recall` of an assembly. */
export function buildRecall(assembly: Assembly, topic: Topic, meta: Recall["meta"]): Recall {
  return deepFreeze({
    topic,
    preRoute: assembly.preRoute,
    agentHints: assembly.agentHints,
    agentDefaults: assembly.agentDefaults,
    responseStyle: assembly.responseStyle,
    provenance: assembly.charter.entries.map((h) => h.id),
    charter: assembly.charter,
    meta,
  });
}

// ── Observability ────────────────────────────────────────────────────────────

/** Run an observability call that must never turn a recall into a rejection (§4.1). */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // A logger or tracer that throws is the operator's problem, not the caller's.
  }
}

function baseLog(ctx: RecallContext, subjectId: string): Record<string, unknown> {
  return { lib: "wisdom-graph", op: "recall", tenantId: ctx.tenantId, subjectId };
}

/** The `recall.done` line (§10.1): debug for a plain cache hit, info otherwise. */
function logDone(ctx: RecallContext, subjectId: string, recall: Recall): void {
  const { meta, topic, charter } = recall;
  const line = {
    ...baseLog(ctx, subjectId),
    requestId: meta.requestId,
    status: meta.status,
    ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
    cache: meta.cache,
    classifier: meta.classifier,
    category: topic.category,
    agents: [...topic.agents],
    hintIds: [...recall.provenance],
    suppressed: charter.suppressed.length,
    dropped: charter.dropped.length,
    elapsedMs: meta.elapsedMs,
  };
  if (meta.status === "ok" && meta.cache === "hit") (ctx.logger.debug ?? ctx.logger.info).call(ctx.logger, line, "recall.done");
  else ctx.logger.info(line, "recall.done");
}

/** The `wisdom.recall` span's result attributes (§10.2). */
function annotate(span: SpanLike, recall: Recall): void {
  span.setAttribute("wisdom.status", recall.meta.status);
  span.setAttribute("wisdom.cache", recall.meta.cache);
  span.setAttribute("wisdom.classifier", recall.meta.classifier);
  span.setAttribute("wisdom.category", recall.topic.category);
  span.setAttribute("wisdom.hint_count", recall.provenance.length);
  span.setAttribute("wisdom.elapsed_ms", recall.meta.elapsedMs);
  span.setAttribute("wisdom.partial", recall.meta.status === "partial");
}

interface StepSpans {
  /** Open the next child span; the previous one must already be done. */
  start(name: string): void;
  /** End the open span with its result attributes. */
  done(attrs: Record<string, string | number | boolean>): void;
  /** Record `e` on the open span, if any, and end it. */
  fail(e: unknown): void;
}

/**
 * The child spans of one pipeline run (`wisdom.recall.snapshot` /
 * `.classify` / `.assemble`, §10.2). The steps run one after another, so
 * at most one is open at a time and the pipeline's single catch can end
 * whichever step threw with the exception recorded on it — a span ended
 * only on the success path would stay open whenever a tokenizer, a tracer
 * attribute or a corrupt snapshot threw mid-step.
 */
function stepSpans(ctx: RecallContext, deadline: Deadline): StepSpans {
  let open: { span: SpanLike; startedAt: number } | undefined;
  const close = (attrs: Record<string, string | number | boolean>, error?: { e: unknown }): void => {
    if (open === undefined) return;
    const { span, startedAt } = open;
    open = undefined;
    span.setAttribute("wisdom.elapsed_ms", ctx.clock.now() - startedAt);
    for (const [key, value] of Object.entries(attrs)) span.setAttribute(key, value);
    if (error !== undefined) span.recordException(error.e);
    span.end();
  };
  return {
    start: (name) => {
      const startedAt = ctx.clock.now();
      open = { span: ctx.tracer.startSpan(name, { attributes: { "wisdom.budget_ms": deadline.budgetMs } }), startedAt };
    },
    done: (attrs) => close(attrs),
    fail: (e) => close({}, { e }),
  };
}

// ── recall() ─────────────────────────────────────────────────────────────────

interface PipelineArgs {
  raw: RecallRequest;
  requestId: string;
  started: number;
  deadline: Deadline;
  /** The `wisdom.recall` span, so an exception inside a step is recorded on it too. */
  span: SpanLike;
}

/** Steps 1–7. Returns its own `empty` on every failure it can see; never throws for a reason it understands. */
async function pipeline(ctx: RecallContext, args: PipelineArgs): Promise<Recall> {
  const { raw, requestId, started, deadline, span } = args;
  const elapsed = (): number => ctx.clock.now() - started;
  const empty = (reason: RecallReason, cache: Recall["meta"]["cache"], subjectId: string, clientId: string | null): Recall =>
    buildEmpty({ subjectId, clientId, requestId, reason, elapsedMs: elapsed(), now: ctx.clock.now(), cache });

  // 1. Validate + normalise
  const validated = validateRecallRequest(raw);
  if (!validated.ok) {
    ctx.logger.warn({ ...baseLog(ctx, stringOr(raw?.subjectId, "")), requestId, issues: validated.issues }, "recall.invalid");
    const clientId = raw?.clientId;
    return empty("invalid-request", "none", stringOr(raw?.subjectId, ""), typeof clientId === "string" ? clientId : null);
  }
  const req = normaliseRequest(validated.value, requestId);
  if (req.signal?.aborted) return empty("aborted", "none", req.subjectId, req.clientId);
  const ref: SubjectRef = { tenantId: ctx.tenantId, subjectId: req.subjectId };

  // `cache` outlives the try: an error after the snapshot step still reports where the snapshot came from.
  let cache: Recall["meta"]["cache"] = "none";
  const steps = stepSpans(ctx, deadline);
  try {
    // 2. Snapshot
    steps.start("wisdom.recall.snapshot");
    let snapshot: SubjectSnapshot;
    let partial: RecallReason | undefined;
    const lookup = ctx.cache.lookup(ref);
    if (lookup.state === "hit" || lookup.state === "stale") {
      ctx.stats.cacheHits += 1;
      snapshot = lookup.snapshot;
      cache = lookup.state;
      if (lookup.state === "stale") ctx.cache.refresh(ref, snapshotLoader(ctx, ref));
    } else {
      ctx.stats.cacheMisses += 1;
      cache = "miss";
      // `ms` is what the clock says is left, so a zero budget gives the load
      // one microtask turn: "cache hit or nothing" (§2.5), even against a
      // store that would have answered a moment later. The load runs on.
      const outcome = await raceSignal(ctx.cache.load(ref, snapshotLoader(ctx, ref)), { signal: deadline.signal, ms: deadline.remaining() });
      if (outcome.status !== "fulfilled") {
        const reason: RecallReason = req.signal?.aborted ? "aborted" : outcome.status === "rejected" ? "store-error" : "store-timeout";
        steps.done({ "wisdom.cache": cache, "wisdom.partial": false, "wisdom.node_count": 0 });
        return empty(reason, cache, req.subjectId, req.clientId);
      }
      snapshot = outcome.value;
    }
    const shared = await sharedSnapshot(ctx, req.subjectId, deadline);
    partial = shared.partial;
    steps.done({ "wisdom.cache": cache, "wisdom.partial": partial !== undefined, "wisdom.node_count": snapshot.nodes.length });

    // 3. Classify (+ optional embedding re-rank)
    steps.start("wisdom.recall.classify");
    let classification = classifyRequest(ctx, snapshot, req, ref);
    let refined = false;
    if (req.refine && ctx.embeddings !== undefined && snapshot.hasEmbeddings) {
      if (deadline.remaining() > ctx.policy.classify.embedMinBudgetMs) {
        const vector = await embedQuery(ctx, req.text, deadline.signal);
        const reranked = vector === null ? classification : rerankByEmbedding(classification, vector, snapshot, ctx.policy);
        if (reranked !== classification) {
          classification = reranked;
          refined = true;
        }
      } else partial ??= "budget";
    }
    const { topic } = classification;
    steps.done({ "wisdom.cache": cache, "wisdom.partial": partial !== undefined, "wisdom.node_count": snapshot.nodes.length });

    // 4–7. Collect, assemble, freeze
    steps.start("wisdom.recall.assemble");
    const now = ctx.clock.now();
    const assembly = assembleRecall(ctx, { snapshot, shared: shared.shared, req, topic, now });
    steps.done({ "wisdom.cache": cache, "wisdom.partial": partial !== undefined, "wisdom.candidate_count": assembly.trace.length });
    ctx.cache.remember(ref, topic.nodePaths);
    return buildRecall(assembly, topic, {
      requestId,
      status: partial === undefined ? "ok" : "partial",
      ...(partial !== undefined ? { reason: partial } : {}),
      elapsedMs: elapsed(),
      cache,
      classifier: topic.method,
      refined,
    });
  } catch (e) {
    ctx.logger.error({ ...baseLog(ctx, req.subjectId), requestId, error: describeError(e) }, "recall.error");
    try {
      steps.fail(e);
      span.recordException(e);
    } catch {
      // The tracer may be what threw; it must not turn the fallback into a rejection.
    }
    return empty("error", cache, req.subjectId, req.clientId);
  }
}

/**
 * Spec §4.1. Never rejects, never writes, never calls a model. Resolves
 * within `budgetMs + GRACE_MS` with the pipeline's result, or `empty` with
 * the reason that stopped it.
 */
export async function recall(ctx: RecallContext, req: RecallRequest): Promise<Recall> {
  const started = ctx.clock.now();
  const subjectId = stringOr(req?.subjectId, "");
  const clientIdRaw: unknown = req?.clientId;
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw : null;
  const requestId = stringOr(req?.requestId, "") || newId();
  const budgetMs = clampBudget(numberOf(req?.budgetMs));
  let span: SpanLike | undefined;
  let deadline: Deadline | undefined;
  let result: Recall | undefined;
  try {
    span = ctx.tracer.startSpan("wisdom.recall", {
      attributes: { "wisdom.request_id": requestId, "wisdom.subject_hash": fnv1a32Hex(subjectId), "wisdom.budget_ms": budgetMs },
    });
    deadline = new Deadline(budgetMs, ctx.clock, signalOf(req));
    const settled = await settleWithin<Recall | null>(pipeline(ctx, { raw: req, requestId, started, deadline, span }), budgetMs + GRACE_MS, null);
    result =
      settled ??
      buildEmpty({ subjectId, clientId, requestId, reason: "budget", elapsedMs: ctx.clock.now() - started, now: ctx.clock.now(), cache: "none" });
  } catch (e) {
    // The tracer or the deadline threw; the logger may be just as broken, and must-have 2 still holds.
    safely(() => ctx.logger.error({ ...baseLog(ctx, subjectId), requestId, error: describeError(e) }, "recall.error"));
    safely(() => span?.recordException(e));
    result = buildEmpty({ subjectId, clientId, requestId, reason: "error", elapsedMs: ctx.clock.now() - started, now: ctx.clock.now(), cache: "none" });
  } finally {
    deadline?.dispose();
    ctx.stats.recalls += 1;
  }
  if (result.meta.status === "empty") ctx.stats.recallEmpty += 1;
  if (result.meta.status === "partial") ctx.stats.recallPartial += 1;
  try {
    if (span !== undefined) {
      annotate(span, result);
      span.end();
    }
    logDone(ctx, subjectId, result);
  } catch {
    // A logger or tracer that throws must not turn a recall into a rejection.
  }
  return result;
}

// ── refine() ─────────────────────────────────────────────────────────────────

async function refinePipeline(ctx: RecallContext, base: Recall, raw: RecallRequest, deadline: Deadline, started: number): Promise<Recall | null> {
  if (ctx.embeddings === undefined) return null;
  const validated = validateRecallRequest(raw);
  if (!validated.ok) return null;
  const req = normaliseRequest(validated.value, base.meta.requestId);
  if (req.signal?.aborted || deadline.signal.aborted) return null;
  const ref: SubjectRef = { tenantId: ctx.tenantId, subjectId: req.subjectId };

  const lookup = ctx.cache.lookup(ref);
  if (lookup.state === "miss") return null;
  const { snapshot } = lookup;
  if (lookup.state === "stale") ctx.cache.refresh(ref, snapshotLoader(ctx, ref));
  if (!snapshot.hasEmbeddings) return null;
  if (deadline.remaining() <= ctx.policy.classify.embedMinBudgetMs) return null;

  const vector = await embedQuery(ctx, req.text, deadline.signal);
  if (vector === null) return null;
  const keyword = classifyRequest(ctx, snapshot, req, ref);
  const reranked = rerankByEmbedding(keyword, vector, snapshot, ctx.policy);
  if (reranked === keyword) return null;

  const shared = await sharedSnapshot(ctx, req.subjectId, deadline);
  const { topic } = reranked;
  const assembly = assembleRecall(ctx, { snapshot, shared: shared.shared, req, topic, now: ctx.clock.now() });
  ctx.cache.remember(ref, topic.nodePaths);
  return buildRecall(assembly, topic, {
    requestId: base.meta.requestId,
    status: shared.partial === undefined ? "ok" : "partial",
    ...(shared.partial !== undefined ? { reason: shared.partial } : {}),
    elapsedMs: ctx.clock.now() - started,
    cache: lookup.state,
    classifier: topic.method,
    refined: true,
  });
}

/**
 * Spec §4.2 step 3, as a call of its own: the embedding re-rank over the
 * cached snapshot, then steps 4–7 again. Returns `recall` itself — the
 * same object — whenever it cannot improve on it: no port, no cached
 * snapshot, no node embeddings, no budget, a failed or slow embedding, a
 * re-rank that changed nothing, or any error. Never rejects.
 */
export async function refine(ctx: RecallContext, recall: Recall, req: RecallRequest, opts: { signal?: AbortSignal; budgetMs?: number } = {}): Promise<Recall> {
  const started = ctx.clock.now();
  let deadline: Deadline | undefined;
  try {
    const budgetMs = clampBudget(numberOf(opts.budgetMs ?? req?.budgetMs));
    deadline = new Deadline(budgetMs, ctx.clock, opts.signal ?? signalOf(req));
    const refined = await settleWithin<Recall | null>(refinePipeline(ctx, recall, req, deadline, started), budgetMs + GRACE_MS, null);
    return refined ?? recall;
  } catch (e) {
    safely(() => ctx.logger.error({ ...baseLog(ctx, stringOr(req?.subjectId, "")), requestId: recall?.meta?.requestId, error: describeError(e) }, "refine.error"));
    return recall;
  } finally {
    deadline?.dispose();
  }
}
