/**
 * core/ — the portable half.
 *
 * Zero dependencies: no Node built-ins, no storage driver, no LLM client, no
 * DOM. The graph schema and its validation, the per-query charter assembly,
 * and the system-prompt compiler belong here, so they can be copied into any
 * runtime the agent lives in and run as-is.
 *
 * `core/isolation.test.ts` enforces the rule by walking the import graph;
 * this comment only explains it.
 *
 * Exports are curated: every runtime name here is a deliberate semver
 * commitment, pinned by `src/api-surface.test.ts`, and follows spec §2. The
 * validator combinators, id helpers and path algebra stay package-internal —
 * other halves import them by relative path — so the public surface is the
 * vocabulary, the ports, the policy, the boundary validators and the
 * reference store, not the toolkit that built them.
 */

// ── Vocabulary (§2, §7.1, §10.3) ─────────────────────────────────────────────
export type {
  JsonValue,
  NeutralMessage,
  HintScope,
  HintLane,
  HintKind,
  HintSource,
  HintStatus,
  HintMaturity,
  Approval,
  Surface,
  FeedbackSignal,
  FeedbackTarget,
  HintProvenanceSummary,
  Hint,
  RetiredReason,
  HintProvenance,
  HintRecord,
  NodeStatus,
  TopicNode,
  TurnEvent,
  FeedbackEvent,
  IngestEvent,
  RecallRequest,
  ClassifyMethod,
  Topic,
  ConflictRule,
  DropReason,
  Charter,
  RecallStatus,
  RecallReason,
  Recall,
  CompiledArtifact,
  CompileOptions,
  CategorySpec,
  WisdomGraphOptions,
  IngestReceipt,
  MaintenanceReport,
  ConsolidationReport,
  EngineStats,
  WisdomGraph,
  EventStatus,
  AuditEntry,
  Explanation,
  ExplainNode,
  HintExplanation,
  RecallTrace,
} from "./types";

// ── Ports (§2.6, §7.1) ───────────────────────────────────────────────────────
export { noopLogger, noopTracer, systemClock, VersionConflictError } from "./ports";
export type {
  LlmPort,
  EmbeddingPort,
  LoggerPort,
  SpanLike,
  TracerPort,
  ClockPort,
  SubjectRef,
  ConsolidateEvent,
  StoredEventBody,
  StoredEvent,
  StoredEventPatch,
  GraphSnapshotData,
  NodePatch,
  HintPatch,
  StoreOp,
  LeaseQuery,
  StorePort,
} from "./ports";

// ── Policy (§2.7) ────────────────────────────────────────────────────────────
export { defaultPolicy } from "./policy";
export type { PolicyConfig, DeepPartial } from "./policy";

// ── Validation (§2.8, §3.5) ──────────────────────────────────────────────────
import type { Validator } from "./schema/validate";
import type { Hint, HintRecord, IngestEvent, RecallRequest, TopicNode } from "./types";
import { validateHint, validateHintRecord } from "./schema/hint";
import { validateNode } from "./schema/node";
import { validateIngestEvent } from "./schema/event";
import { validateRecallRequest } from "./schema/request";
import { validateProposalShape, type Proposal } from "./schema/proposal";

/**
 * One structural validator per trust boundary (spec §2.8). `proposal` is the
 * extraction gate (§5.6 gate 1: 8 ops, no consolidation ops); the
 * consolidation pass and the organiser build theirs from `proposalValidator`
 * with the purpose, cap and agent vocabulary only an engine knows.
 */
export const validators: {
  hint: Validator<Hint>;
  hintRecord: Validator<HintRecord>;
  node: Validator<TopicNode>;
  event: Validator<IngestEvent>;
  recallRequest: Validator<RecallRequest>;
  proposal: Validator<Proposal>;
} = Object.freeze({
  hint: validateHint,
  hintRecord: validateHintRecord,
  node: validateNode,
  event: validateIngestEvent,
  recallRequest: validateRecallRequest,
  proposal: validateProposalShape,
});

export type { Validator, Validation, Issue } from "./schema/validate";
export type {
  Proposal,
  Operation,
  OperationKind,
  AddHintBody,
  AddHintOp,
  UpdateHintOp,
  ReinforceHintOp,
  RetireHintOp,
  CreateNodeOp,
  UpdateNodeOp,
  SetPropertyOp,
  NoopOp,
  MergeHintsOp,
  MoveHintOp,
  SplitNodeChild,
  SplitNodeOp,
  MergeNodesOp,
  AliasSlotOp,
} from "./schema/proposal";

// ── Extraction protocol (§2.8, §5.5) ─────────────────────────────────────────
export { PROMPT_VERSION } from "./ingest/prompts";
// `RejectReason` is the vocabulary of `op.rejected` audit rows; the organiser's own
// input/output shapes stay internal until `validateProposal` is public.
export type { RejectReason } from "./ingest/organiser";

// ── Text (§2.8, §9.1) ────────────────────────────────────────────────────────
export { estimateTokens } from "./text/tokens";
export type { Tokenizer } from "./text/tokens";
export { sanitizeStatement } from "./text/sanitize";
export type { SanitizeResult, SanitizeReason, SanitizeOptions } from "./text/sanitize";
export type { InjectionFamily } from "./text/patterns";

// ── Charter policy and compilation (§2.8, §6, §8.3) ─────────────────────────
export { resolveConflicts } from "./policy/conflict";
export type { ConflictContext, Verdict } from "./policy/conflict";
export { scoreHint } from "./policy/decay";
export { compileCharter, compilePreRoute, compileAgentPreamble, compileResponseStyle } from "./recall/compile";
export type { LaneCompileOptions, LaneCaps } from "./recall/compile";

// ── Recall helpers (§2.8, §4.1) ──────────────────────────────────────────────
export { emptyRecall } from "./recall/recall";
export { settleWithin, linkSignals } from "./recall/deadline";

// ── Reference store (§2.8, §7.2) ─────────────────────────────────────────────
export { MemoryStore } from "./store/memory";
export type { MemoryStoreOptions, MemoryStoreSnapshot, MemoryStoreSubject } from "./store/memory";
