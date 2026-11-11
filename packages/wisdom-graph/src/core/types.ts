/**
 * types.ts — the vocabulary every other module speaks.
 *
 * Nothing here runs; this file is the shared noun list from spec §2 (the
 * public API), §7.1 (the ledger and audit rows a store holds) and §10.3 (what
 * `explain()` shows a human). It is kept as one file so that the recall side,
 * the ingest side and the stores cannot drift into three dialects of "hint".
 *
 * Two shapes deserve a word on why they are separate:
 *
 *   - `Hint` is what a recall hands to the consumer: contract fields, placement
 *     and a compact provenance summary. It is plain, JSON-serialisable and
 *     frozen, so a host can spread it into prompts, logs and SSE frames without
 *     a copy and without leaking store internals.
 *   - `HintRecord` is what a store holds: the same statement plus lifecycle
 *     (status / approval / maturity are deliberately orthogonal — visibility,
 *     governance and timescale are three different questions), counters, and
 *     full provenance. The projection `HintRecord → Hint` happens once, at
 *     snapshot compile time.
 *
 * Every interface is structural. Nothing is a class the consumer must extend.
 */

import type { ClockPort, EmbeddingPort, LlmPort, LoggerPort, StorePort, TracerPort } from "./ports";
import type { DeepPartial, PolicyConfig } from "./policy";

// ── 2.1 Vocabulary ───────────────────────────────────────────────────────────

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type NeutralMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  name?: string;
  toolCalls?: { name: string; args: unknown }[];
};

export type HintScope = "global" | "category" | "agent" | "client";
export type HintLane = "preRoute" | "agent" | "responseStyle";
export type HintKind = "preference" | "style" | "routing" | "fact" | "constraint";
export type HintSource = "explicit" | "inferred";
export type HintStatus = "pending" | "active" | "superseded" | "retired";
export type HintMaturity = "captured" | "consolidated" | "established";
export type Approval = "auto" | "approved" | "rejected";
export type Surface = "standalone" | "client_sheet" | "dashboard" | "portfolio";
export type FeedbackSignal = "up" | "down" | "comment" | "correction";
export type FeedbackTarget = "response" | `agent:${string}` | `tool:${string}`;

// ── 2.2 Hints ────────────────────────────────────────────────────────────────

export interface HintProvenanceSummary {
  /** Event that created the hint. */
  originEventId: string;
  /** Run of that event, when known. */
  runId?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  lastReinforcedAt: string;
  extractor: "llm" | "rule" | "human";
}

export interface Hint {
  // contract fields (requirements.md "Contract")
  id: string;
  /** Canonical statement, sanitised, ≤ 200 chars. */
  text: string;
  /** 0..100 */
  priority: number;
  scope: HintScope;
  source: HintSource;
  /** 0..1 */
  confidence: number;
  // placement
  lane: HintLane;
  kind: HintKind;
  /** Conflict key, required, `^[a-z0-9_.]{2,60}$`. */
  slot: string;
  /** "/consult_advice/retirement" */
  nodePath: string;
  /** Required when `scope === "agent"`. */
  agent?: string;
  /** Required when `scope === "client"`. */
  clientId?: string;
  /** Rejected hints never reach a Recall. */
  approval: "auto" | "approved";
  provenance: HintProvenanceSummary;
}

export type RetiredReason =
  | "decayed"
  | "contradicted"
  | "withdrawn"
  | "obsolete"
  | "merged"
  | "rejected"
  | "feedback";

export interface HintProvenance {
  originEventId: string;
  /** Every event that created/reinforced/updated it, newest last, capped at 50. */
  eventIds: string[];
  /** Capped at 50. */
  runIds: string[];
  extractor: { kind: "llm" | "rule" | "human"; promptVersion?: string; model?: string };
  approval?: { by: string; at: string; note?: string };
  supersedes?: string;
}

export interface HintRecord extends Omit<Hint, "approval" | "provenance"> {
  tenantId: string | null;
  subjectId: string;
  nodeId: string;
  /** Normalised slot value, ≤ 80 chars, lower-case; decides reinforce-vs-conflict. */
  value: string;
  status: HintStatus;
  approval: Approval;
  maturity: HintMaturity;
  /** Flagged for a human; still active unless `status` says otherwise. */
  needsReview: boolean;
  supersedes?: string;
  supersededBy?: string;
  retiredReason?: RetiredReason;
  reinforcements: number;
  contradictions: number;
  /** Bumped from `TurnEvent.appliedHintIds`, never on recall. */
  applied: number;
  lastAppliedAt?: string;
  provenance: HintProvenance;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt: string;
}

// ── 2.3 Topic nodes ──────────────────────────────────────────────────────────

export type NodeStatus = "active" | "merged" | "retired";

export interface TopicNode {
  id: string;
  tenantId: string | null;
  subjectId: string;
  /** Materialised path: "/" (root), "/consult_advice", "/consult_advice/retirement". */
  path: string;
  /** null only for "/". */
  parentPath: string | null;
  /** Last path segment; "" for root. */
  slug: string;
  /** ≤ 80 chars. */
  title: string;
  /** One line, "what belongs here", ≤ 200 chars. */
  description: string;
  /** Classifier vocabulary, ≤ 40 entries, maintained by ingest. */
  keywords: string[];
  /** Seed-only regex sources from CategorySpec; the LLM cannot write these. */
  patterns: string[];
  /** Handoff names learned from TurnEvent.agentsUsed (+ seed). */
  agents: string[];
  /** LLM-maintained structured knowledge, ≤ 32 keys, ≤ 4 KB serialised. Never rendered. */
  properties: Record<string, JsonValue>;
  /** 0 root, 1 category, 2..4 sub-topics. */
  level: number;
  /** True for root and level-1 nodes: slug/path immutable, cannot be retired. */
  locked: boolean;
  status: NodeStatus;
  /** Path. */
  mergedInto?: string;
  stats: { activeHints: number; lastIngestAt?: string };
  /** Optional, populated by maintain() when an EmbeddingPort exists. */
  embedding?: number[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ── 2.4 Events ───────────────────────────────────────────────────────────────

export interface TurnEvent {
  type: "turn";
  /** Idempotency key. */
  id: string;
  runId: string;
  subjectId: string;
  clientId?: string | null;
  /** Stored for explain(); NEVER a key. */
  threadId?: string | null;
  /** Router's decision, if the consumer knows it. */
  category?: string;
  /** The specialists that ran. Omit it (or pass `[]`) when the host has no agents: no agent-lane hint is then counted as applied. */
  agentsUsed?: string[];
  toolsUsed?: string[];
  dataSources?: string[];
  /** Capped to 8 000 chars at admission. */
  userText: string;
  /** Capped to 16 000 chars at admission. */
  assistantText: string;
  model?: string;
  appliedHintIds?: string[];
  surface?: Surface;
  /** ISO-8601; defaults to clock.now(). */
  at?: string;
}

export interface FeedbackEvent {
  type: "feedback";
  id: string;
  runId: string;
  subjectId: string;
  clientId?: string | null;
  signal: FeedbackSignal;
  /** Capped to 2 000 chars. */
  text?: string;
  target?: FeedbackTarget;
  at?: string;
}

export type IngestEvent = TurnEvent | FeedbackEvent;

// ── 2.5 Recall request, Recall, Charter, CompiledArtifact ────────────────────

export interface RecallRequest {
  /** The ONLY identity key (for example an advisor id). */
  subjectId: string;
  clientId?: string | null;
  /** Truncated to 2 000 chars internally. */
  text: string;
  /** Last 2 user messages are used. */
  recentTurns?: NeutralMessage[];
  surface?: Surface;
  /** ≥ 0; 0 means "cache hit or nothing". */
  budgetMs: number;
  /** Contract has it required; optional here is a superset. */
  signal?: AbortSignal;
  /** Strictly human-approved charter for this query. */
  approvedOnly?: boolean;
  /** Run embedding re-rank inside the budget (default false). */
  refine?: boolean;
  /** Echoed into meta/logs; generated if absent. */
  requestId?: string;
}

export type ClassifyMethod = "keyword" | "embedding" | "continuity" | "category-hint" | "none";

export interface Topic {
  /** Level-1 slug of the best node, or "direct". */
  category: string;
  /** Predicted handoff names (may be empty). */
  agents: string[];
  /** 0..1 */
  confidence: number;
  /** Matched nodes, best first (≤ 3). */
  nodePaths: string[];
  method: ClassifyMethod;
}

export type ConflictRule = "approval" | "scope" | "source" | "recency" | "score" | "shared-subject";
export type DropReason = "budget" | "duplicate" | "policy" | "stale" | "invalid-row";

export interface Charter {
  subjectId: string;
  clientId: string | null;
  generatedAt: string;
  /** Best node path or "/". */
  topicPath: string;
  /** Every hint that survived; superset of the three lanes. */
  entries: Hint[];
  suppressed: { hintId: string; by: string; rule: ConflictRule }[];
  dropped: { hintId: string; reason: DropReason }[];
  approvalMix: "approved-only" | "mixed" | "none";
  tokenEstimate: number;
}

export type RecallStatus = "ok" | "partial" | "empty";
export type RecallReason =
  | "budget"
  | "aborted"
  | "store-timeout"
  | "store-error"
  | "invalid-request"
  | "no-subject"
  | "error";

export interface Recall {
  topic: Topic;
  preRoute: Hint[];
  /** One bucket per predicted or addressed agent, keyed by handoff name. */
  agentHints: Record<string, Hint[]>;
  /**
   * The agent-lane bucket of any agent without one — every agent-lane entry
   * addressed to everyone plus the mirrored voice hints — so the specialist
   * the router picks on a misclassified or `direct` turn still gets them.
   */
  agentDefaults: Hint[];
  responseStyle: Hint[];
  /**
   * Ids of charter.entries: everything that could render this turn, across
   * every site and every candidate agent. Pass it as `TurnEvent.appliedHintIds`;
   * ingest counts an agent's own hints as applied only when that agent is in
   * `agentsUsed`, since its preamble is the one place they render.
   */
  provenance: string[];
  charter: Charter;
  meta: {
    requestId: string;
    status: RecallStatus;
    reason?: RecallReason;
    elapsedMs: number;
    cache: "hit" | "miss" | "stale" | "none";
    classifier: Topic["method"];
    refined: boolean;
  };
}

export interface CompiledArtifact {
  /** "" when no hints. */
  text: string;
  hintIds: string[];
  tokenEstimate: number;
  /** fnv1a of text, for cache keys / debugging. */
  hash: string;
}

export interface CompileOptions {
  /** Default advisory header (§9). */
  header?: string;
  /** Default `<<wisdom-hints lane="…">> … <</wisdom-hints>>`. */
  delimiter?: { open: string; close: string };
  /** Extra cap at render time. */
  maxTokens?: number;
  tokenizer?: (s: string) => number;
  /** Default false; true appends " [h_…]" per bullet for debugging. */
  includeIds?: boolean;
}

// ── 2.7 Engine-facing shapes ─────────────────────────────────────────────────

export interface CategorySpec {
  /** Handoff name: "consult_advice"; becomes level-1 path "/consult_advice". */
  name: string;
  /** Default: name with underscores → spaces, "consult " stripped, title-cased. */
  title?: string;
  description?: string;
  keywords: string[];
  /** Regex sources, validated at construction (see §9 safe regex rules). */
  patterns?: string[];
  /** Default all. */
  lanes?: HintLane[];
}

export interface WisdomGraphOptions {
  store: StorePort;
  /** Required; "direct" is implicit and never a node. */
  categories: CategorySpec[];
  /** Absent → no extraction; feedback still adjusts weights. */
  llm?: LlmPort;
  embeddings?: EmbeddingPort;
  logger?: LoggerPort;
  tracer?: TracerPort;
  clock?: ClockPort;
  /** Engine is bound to one tenant; null ↔ '' in the store. */
  tenantId?: string | null;
  /** Default null (off). When set, its approved hints join every recall. */
  sharedSubjectId?: string | null;
  /** The category a `RecallRequest.surface` implies, per surface; the classifier's category hint (§4.2 step 3). Default none. */
  surfaceCategories?: Partial<Record<Surface, string>>;
  policy?: DeepPartial<PolicyConfig>;
  /** 30 000, 300 000, 10 000, 256 */
  cache?: { ttlMs?: number; staleTtlMs?: number; negativeTtlMs?: number; maxSubjects?: number };
  /** 4, 3, [1000, 4000, 16000], 1000, false */
  queue?: {
    concurrency?: number;
    maxAttempts?: number;
    backoffMs?: number[];
    maxPending?: number;
    inline?: boolean;
  };
  requireApproval?: (hint: HintRecord, ctx: { shared: boolean; event: IngestEvent | null }) => boolean;
  tokenizer?: (s: string) => number;
}

export interface IngestReceipt {
  eventId: string;
  status: "recorded" | "duplicate" | "rejected" | "processed" | "failed";
  reason?: string;
}

export interface MaintenanceReport {
  subjectId?: string;
  examined: number;
  promoted: number;
  retired: number;
  merged: number;
  nodesRetired: number;
  reembedded: number;
  purgedEvents: number;
  purgedAudit: number;
  elapsedMs: number;
}

export interface ConsolidationReport {
  subjectId: string;
  merged: number;
  promoted: number;
  retired: number;
  opsAccepted: number;
  opsRejected: number;
  usedLlm: boolean;
}

export interface EngineStats {
  recalls: number;
  recallEmpty: number;
  recallPartial: number;
  cacheHits: number;
  cacheMisses: number;
  ingested: number;
  duplicates: number;
  processed: number;
  failed: number;
  llmCalls: number;
  opsAccepted: number;
  opsRejected: number;
  queueDepth: number;
}

export interface WisdomGraph {
  /** Never rejects. */
  recall(req: RecallRequest): Promise<Recall>;
  /** Never rejects; returns the input on failure. */
  refine(recall: Recall, req: RecallRequest, opts?: { signal?: AbortSignal; budgetMs?: number }): Promise<Recall>;
  /** Never rejects. */
  ingest(
    ev: IngestEvent,
    opts?: { waitFor?: "recorded" | "processed"; extract?: "auto" | "force" | "skip" },
  ): Promise<IngestReceipt>;
  explain(
    subjectId: string,
    opts?: { clientId?: string | null; text?: string; includeRetired?: boolean; topicPath?: string },
  ): Promise<Explanation>;
  forget(subjectId: string, hintId?: string, opts?: { actor?: string; reason?: string }): Promise<void>;
  approve(
    subjectId: string,
    hintId: string,
    decision: { status: "approved" | "rejected"; by: string; note?: string },
  ): Promise<void>;
  /** Pure. */
  compile(charter: Charter, lane: HintLane, opts?: CompileOptions & { agent?: string }): CompiledArtifact;
  invalidate(subjectId?: string): void;
  maintenance: {
    drain(opts?: { limit?: number; signal?: AbortSignal }): Promise<{ processed: number; failed: number }>;
    consolidate(subjectId: string, opts?: { signal?: AbortSignal; llm?: boolean }): Promise<ConsolidationReport>;
    maintain(opts?: { subjectId?: string; signal?: AbortSignal }): Promise<MaintenanceReport>;
    warm(subjectId: string): Promise<void>;
  };
  /** Wait for the in-process queue to empty (tests/shutdown). */
  flush(): Promise<void>;
  /**
   * Stop accepting work, drop jobs not yet started (their rows stay in the
   * ledger for `maintenance.drain()`), let jobs in flight finish for up to
   * `graceMs` (default `policy.ingest.llmTimeoutMs`; `0` interrupts at once),
   * then abort every model call still running and wait for those attempts to
   * settle their rows. Idempotent; never rejects.
   */
  close(opts?: { graceMs?: number }): Promise<void>;
  stats(): EngineStats;
}

// ── 7.1 Ledger and audit vocabulary shared by ports and explain() ────────────

export type EventStatus = "pending" | "processing" | "done" | "failed";

export interface AuditEntry {
  id: string;
  tenantId: string | null;
  subjectId: string;
  at: string;
  /** "llm:extract@1" | "system:decay" | "system:feedback" | "human:<id>" | "system:forget" */
  actor: string;
  /** "hint.created" | "hint.reinforced" | "hint.superseded" | "hint.retired" | "hint.approved" | … */
  action: string;
  hintId?: string;
  nodePath?: string;
  eventId?: string;
  detail: Record<string, JsonValue>;
}

// ── 10.3 explain() ───────────────────────────────────────────────────────────

export interface Explanation {
  subjectId: string;
  tenantId: string | null;
  generatedAt: string;
  /** Nested from "/". */
  tree: ExplainNode[];
  pendingApproval: HintExplanation[];
  /** When includeRetired. */
  retired: HintExplanation[];
  /** Last 20. */
  recentEvents: {
    id: string;
    kind: string;
    runId?: string;
    at: string;
    status: EventStatus;
    accepted?: number;
    rejected?: number;
    /** When retention has blanked the event's text (§10.4); the row itself is kept. */
    scrubbedAt?: string;
  }[];
  /** Last 50. */
  audit: AuditEntry[];
  /** When opts.text is given: dry-run recall. */
  trace?: RecallTrace;
  stats: { nodes: number; activeHints: number; pending: number; retired: number; slots: string[] };
}

export interface ExplainNode {
  node: TopicNode;
  hints: HintExplanation[];
  children: ExplainNode[];
}

export interface HintExplanation {
  hint: HintRecord;
  effectiveScore: number;
  decayWeight: number;
  suppressedBy: { hintId: string; rule: ConflictRule } | null;
  /** "explicit · agent-scoped (consult_advice) · approved by rm_42 on 2026-09-02 · reinforced 3× · …" */
  why: string;
}

export interface RecallTrace {
  topic: Topic;
  candidates: {
    hintId: string;
    relevance: number;
    decayWeight: number;
    effective: number;
    outcome: "kept" | "suppressed" | "dropped";
    rule?: ConflictRule;
    reason?: string;
  }[];
  recall: Recall;
}
