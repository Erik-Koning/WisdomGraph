/**
 * ingest/organiser.ts — the gates between a model's proposal and the
 * store, and the rewrites that keep the graph well organised.
 *
 * Spec §5.6. A proposal is untrusted input twice over: it comes from a
 * model, and the model was shown user text. So every op passes three gates
 * in order — structural (shape, enums, ranges, the op set), referential
 * (does the path or hint exist, is the parent full, is the node locked),
 * policy and safety (the sanitiser, source rank, approval, feedback
 * target) — and is accepted or rejected on its own with a reason code, so
 * one hallucinated id never costs the seven good ops beside it. The one
 * exception is `create_node` with its inline hints, which stand or fall
 * as a unit: a node with no valid hint is a node with no reason to exist.
 *
 * The rewrites are what the product brief calls "keeping it well
 * organised", and they are rewrites rather than rejections because the
 * model's *intent* was fine and only its placement was off:
 *
 *   - **update over add.** An `add_hint` whose applicability key already
 *     has an active holder becomes a reinforcement when the value is the
 *     same and a supersession when it differs — or a pending challenger
 *     when the holder is approved or outranks the new source (§6.1), since
 *     an inferred guess must never silently replace what a human said.
 *   - **add over create.** A `create_node` whose slug or title is a
 *     near-duplicate of a sibling becomes `add_hint`s on that sibling; an
 *     `add_hint` aimed at a locked category whose descendant plainly owns
 *     the topic is re-targeted there — unless the category already holds
 *     that key, which the add then reinforces or supersedes in place.
 *   - **review over loss.** An update or retirement of an approved hint —
 *     or an inferred update of a hint a human stated (§6.1) — becomes a
 *     challenger or a review flag; the holder stays live until a human
 *     decides.
 *
 * Everything the organiser emits converges on replay (§5.2). Ids are
 * `deterministicId` over `(tenant, subject, event, opIndex)` for hints and
 * over the path for nodes, audit ids over `(event, opIndex, n)`; every
 * patch appends the event id to the hint's provenance, and an op whose
 * target already carries this event — or whose deterministic row already
 * exists with it — is accepted as done and emits nothing. The rows an
 * active-only snapshot cannot show (a pending challenger, a hint this
 * event retired) arrive as `ctx.extraRecords`, fetched by id by the
 * extractor. That is what lets a crash between `applyBatch` and
 * `updateEvent(done)` be repaired by simply running the event again.
 *
 * The consolidation-only ops (§5.7) are validated here too, by the same
 * gates, so the long-term pass cannot reach the store by a softer road.
 * `merge_nodes` flattens a merged node's children into the target because
 * the store port cannot re-path a node; the spec's "moves … children"
 * is honoured for their hints, and the child rows are marked merged.
 *
 * A hint a human approved is as untouchable to those ops as it is to
 * `update_hint` and `retire_hint` (§5.6, §10.4). `merge_hints` over one
 * approved input keeps that row active and stores the merged statement as
 * its pending challenger — the other inputs fold into the challenger, and
 * a human approving it is what retires the original — and refuses to fold
 * two human decisions into one. A move, node merge or alias that would
 * retire an approved hint into another holder is refused as a slot
 * conflict before anything is emitted; a split moves onto fresh nodes and
 * cannot collide. Merging a sub-topic *into* its locked category is
 * allowed: the category is unchanged but for the hints it gains, exactly
 * as an `add_hint` on it, so §5.6's locked "targets" are read as the nodes
 * an op would create, move, merge away or retire.
 */

import { deterministicId } from "../ids";
import type { PolicyConfig } from "../policy";
import type { HintPatch, NodePatch, StoreOp, SubjectRef } from "../ports";
import type {
  FeedbackTarget,
  HintKind,
  HintLane,
  HintMaturity,
  HintProvenance,
  HintRecord,
  HintScope,
  HintSource,
  HintStatus,
  IngestEvent,
  JsonValue,
  TopicNode,
  WisdomGraphOptions,
} from "../types";
import {
  CONSOLIDATION_OPS,
  proposalValidator,
  type AddHintBody,
  type AddHintOp,
  type AliasSlotOp,
  type CreateNodeOp,
  type MergeHintsOp,
  type MergeNodesOp,
  type MoveHintOp,
  type Operation,
  type Proposal,
  type ReinforceHintOp,
  type RetireHintOp,
  type SetPropertyOp,
  type SplitNodeOp,
  type UpdateHintOp,
  type UpdateNodeOp,
} from "../schema/proposal";
import { HINT_MATURITIES, MAX_PROVENANCE_IDS, MAX_SLOT_VALUE_CHARS, normaliseSlotValue } from "../schema/hint";
import { MAX_KEYWORDS, propertiesValidator } from "../schema/node";
import type { Issue } from "../schema/validate";
import { matchLabelInjection, sanitizeStatement, type SanitizeReason } from "../text/sanitize";
import { INJECTION_FAMILY_NAMES } from "../text/patterns";
import { jaccard, tokenize } from "../text/normalize";
import { ROOT_PATH, SLUG_PATTERN, depth, isDescendant, join } from "../graph/paths";
import { canonicalSlot, type SubjectSnapshot } from "../graph/snapshot";
import { alreadyApplied, eventAudit } from "./feedback";
import { PROMPT_VERSION } from "./prompts";

// ── Constants (§5.6, §5.7) ───────────────────────────────────────────────────

/** Ops a consolidation proposal may carry (§2.7: "maxOpsPerEvent 8 (consolidation: 24)"). */
export const CONSOLIDATION_MAX_OPS = 24;
/** Edit distance a long sibling slug (≥ `SLUG_DISTANCE_MIN_LENGTH` chars) may sit within and still be the same topic (§5.6 gate 2). */
export const SLUG_DISTANCE = 2;
/** Slugs at least this long are compared at `SLUG_DISTANCE`; shorter ones (≥ `SLUG_TYPO_MIN_LENGTH`) at one edit; shorter still, exactly. */
export const SLUG_DISTANCE_MIN_LENGTH = 8;
export const SLUG_TYPO_MIN_LENGTH = 6;
/** A sibling title this similar (token Jaccard) is the same topic (§5.6 gate 2). */
export const TITLE_JACCARD = 0.6;
/** Keywords of a descendant that must match before an `add_hint` on a locked node is re-targeted (§5.6 "add over create"). */
export const RETARGET_MIN_SCORE = 2;

/** Every reason an op can be refused. */
export type RejectReason =
  | "invalid"
  | "too-many-ops"
  | "consolidation-only"
  | "unknown-node"
  | "unknown-hint"
  | "not-active"
  | "locked"
  | "max-depth"
  | "max-children"
  | "max-nodes"
  | "injection"
  | "not-canonical"
  | "off-target"
  | "source-rank"
  | "no-client"
  | "duplicate"
  | "tombstoned"
  | "properties-cap"
  | "no-valid-hints"
  | "slot-conflict"
  | "mixed-nodes"
  | "cycle"
  | "approved";

export interface RejectedOp {
  /** Position in `proposal.ops`. */
  index: number;
  op: string;
  reason: RejectReason;
  /** Why, for the audit row and the log; never the statement text. */
  detail?: string;
}

/** An op the organiser accepted under a different shape than proposed. */
export interface Rewrite {
  index: number;
  from: string;
  to: string;
  reason: "reinforce" | "supersede" | "challenger" | "retargeted" | "sibling-clash" | "needs-review" | "locked-title" | "already-applied";
  /** The node or hint the rewrite landed on. */
  target?: string;
}

export interface OrganiserContext {
  ref: SubjectRef;
  policy: PolicyConfig;
  purpose: "extract" | "consolidate";
  eventId: string;
  runId?: string;
  /** ISO-8601 instant every row and audit entry is stamped with. */
  at: string;
  /** Set by the library from the event kind (§5.5), never by the model. */
  source: HintSource;
  clientId?: string | null;
  /** Feedback target constraint (§5.4 step 5). */
  target?: FeedbackTarget;
  /** The applied hints feedback is about; exempt from the target constraint and, on a `down`, from confidence edits. */
  targeted?: readonly HintRecord[];
  /** Agent names an agent-scoped hint may use; default: the categories plus every agent the subject's nodes have learned. */
  agents?: readonly string[];
  /** Written into provenance (`extractor.model`). */
  model?: string;
  /** Default `PROMPT_VERSION`; the consolidation pass passes its own. */
  promptVersion?: string;
  /** Audit actor; default `llm:<promptVersion>`. */
  actor?: string;
  requireApproval?: WisdomGraphOptions["requireApproval"];
  /** True when `ref` is the shared subject: new hints start pending unless `requireApproval` says otherwise (§10.4). */
  shared?: boolean;
  event?: IngestEvent | null;
  /** The consumer's own deny regexes (§9.1 step 6). */
  extraDeny?: RegExp[];
  /**
   * Rows the snapshot does not hold — pending, superseded or retired hints
   * the proposal names or would create — fetched by id, so a replay sees
   * what the first run wrote and an update can reach a pending challenger.
   */
  extraRecords?: readonly HintRecord[];
}

export interface OrganiserResult {
  /** Store ops in apply order, audit rows included; ids deterministic. */
  accepted: StoreOp[];
  rejected: RejectedOp[];
  /** Proposal ops accepted, rewrites and replays included. */
  acceptedCount: number;
  rewrites: Rewrite[];
  /** Paths whose active hint count now exceeds `caps.maxActiveHintsPerNode` (§5.6 "hint counts"). */
  needsConsolidation: string[];
}

// ── Small helpers ────────────────────────────────────────────────────────────

const SOURCE_RANK: Readonly<Record<HintSource, number>> = Object.freeze({ explicit: 1, inferred: 0 });
const MATURITY_RANK: Readonly<Record<HintMaturity, number>> = Object.freeze({ captured: 0, consolidated: 1, established: 2 });
const injectionFamilies = new Set<string>(INJECTION_FAMILY_NAMES);
const consolidationOnly = new Set<string>(CONSOLIDATION_OPS);

/** Confidence stays a clean number in the row: 0.9 + 0.05 is 0.95, not 0.9500000000000001. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, Math.round(x * 1_000_000) / 1_000_000));
}

/** The applicability key of the slot-uniqueness invariant (§3.1). */
export function slotKey(h: Pick<HintRecord, "nodePath" | "slot" | "scope"> & { agent?: string; clientId?: string }): string {
  return JSON.stringify([h.nodePath, h.slot, h.scope, h.agent ?? "", h.clientId ?? ""]);
}

/** Edit distance between two short strings; the slug near-duplicate rule. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Whether two sibling slugs name the same topic (§5.6 gate 2). The rule is
 * length-aware because a fixed edit distance folds the short vocabulary a
 * domain is made of — `rrsp`/`resp`, `bonds`/`funds`, `rrsp`/`rrif` are one
 * or two edits apart and are different topics — while the typo it exists
 * to catch (`retirment`/`retirement`, `insurence`/`insurance`) lives in
 * longer words. A short slug therefore clashes only with itself or its
 * plural (`bond`/`bonds`, `etf`/`etfs`); from `SLUG_TYPO_MIN_LENGTH` one
 * edit is a typo; from `SLUG_DISTANCE_MIN_LENGTH` two are.
 */
export function slugsClash(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`) return true;
  const shortest = Math.min(a.length, b.length);
  if (shortest < SLUG_TYPO_MIN_LENGTH) return false;
  return levenshtein(a, b) <= (shortest < SLUG_DISTANCE_MIN_LENGTH ? 1 : SLUG_DISTANCE);
}

/**
 * Every agent name the vocabulary allows: configured categories plus what
 * the subject's nodes have learned (§3.5). Only slugs qualify — a
 * configured name is one, and `ingest` learns only slugs from
 * `agentsUsed` — so a name the prompt would withhold (§9.1) can never be
 * the target of an agent-scoped hint, and a stored row from before that
 * rule cannot re-admit one.
 */
export function agentVocabulary(snapshot: SubjectSnapshot): string[] {
  const out = new Set<string>(snapshot.categoryNames);
  for (const node of snapshot.nodes) for (const agent of node.agents) if (SLUG_PATTERN.test(agent)) out.add(agent);
  return [...out];
}

/** How many of `node`'s keywords appear whole in `text` (stems compared). */
export function keywordScore(node: Pick<TopicNode, "keywords">, text: string): number {
  const tokens = new Set(tokenize(text));
  let score = 0;
  for (const keyword of node.keywords) {
    const parts = tokenize(keyword);
    if (parts.length > 0 && parts.every((p) => tokens.has(p))) score += 1;
  }
  return score;
}

/** Union in order, the new ones appended; over the cap, the oldest non-seed keyword goes first. */
export function mergeKeywords(existing: readonly string[], added: readonly string[], seed: ReadonlySet<string>): string[] {
  const out = [...existing];
  for (const k of added) if (!out.includes(k)) out.push(k);
  while (out.length > MAX_KEYWORDS) {
    const index = out.findIndex((k) => !seed.has(k) && !added.includes(k));
    if (index === -1) break;
    out.splice(index, 1);
  }
  return out.slice(0, MAX_KEYWORDS);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function issueText(issues: readonly Issue[], index: number): string {
  return issues.map((i) => `${i.path.replace(/^\/ops\/0/, `/ops/${index}`) || "/"}: ${i.message}`).join("; ");
}

/** `x.y` for an inline hint of op `x`, so its deterministic id differs from the op's own. */
function hintLabel(index: number, inline?: number): string {
  return inline === undefined ? String(index) : `${index}.${inline}`;
}

// ── The working view of the graph during one proposal ────────────────────────

/** A node as the batch sees it: the snapshot row, or one created earlier in the same proposal. */
interface WorkNode {
  node: TopicNode;
  /** Set when this proposal created it; the row is finalised (stats) before the result is returned. */
  created?: TopicNode;
}

/** What a hint body becomes once every text-level gate has passed. */
interface PreparedHint {
  node: TopicNode;
  slot: string;
  value: string;
  text: string;
  kind: HintKind;
  lane: HintLane;
  scope: HintScope;
  agent?: string;
  clientId?: string;
  priority: number;
  confidence: number;
  review: boolean;
  reviewReason?: string;
  id: string;
  retargeted?: string;
}

type Outcome = { ok: true; rewrite?: Omit<Rewrite, "index" | "from"> } | { ok: false; reason: RejectReason; detail?: string };
type Prepared = { ok: true; hint: PreparedHint } | { ok: false; reason: RejectReason; detail: string };

const OK: Outcome = { ok: true };

class Organiser {
  readonly ops: StoreOp[] = [];
  readonly rejected: RejectedOp[] = [];
  readonly rewrites: Rewrite[] = [];
  acceptedCount = 0;
  private readonly nodes = new Map<string, WorkNode>();
  private readonly hints = new Map<string, HintRecord>();
  /** Slot key → the active holder, snapshot rows and this proposal's own together. */
  private readonly activeByKey = new Map<string, HintRecord>();
  /** Ids of hints this proposal created; a second value for their key is a duplicate, not a supersession. */
  private readonly planned = new Set<string>();
  /** Change in active hints per node path. */
  private readonly delta = new Map<string, number>();
  private readonly touched = new Set<string>();
  private readonly seedKeywords: ReadonlyMap<string, ReadonlySet<string>>;
  private readonly agents: ReadonlySet<string>;
  private readonly validate: ReturnType<typeof proposalValidator>;
  private readonly maxOps: number;
  private readonly promptVersion: string;
  private readonly actor: string;
  private readonly targetedIds: ReadonlySet<string>;
  private nodeCount: number;
  /** The op being gated and how many audit rows it has written: audit ids are `op:<index>:<n>`, stable across replays. */
  private opIndex = -1;
  private auditSeq = 0;

  constructor(
    private readonly snapshot: SubjectSnapshot,
    private readonly ctx: OrganiserContext,
  ) {
    for (const node of snapshot.nodes) this.nodes.set(node.path, { node });
    this.nodeCount = snapshot.nodes.filter((n) => n.status === "active").length;
    for (const record of [...snapshot.records, ...(ctx.extraRecords ?? [])]) {
      if (this.hints.has(record.id)) continue;
      this.hints.set(record.id, record);
      if (record.status === "active") this.activeByKey.set(slotKey(record), record);
    }
    this.seedKeywords = new Map(snapshot.categories.map((c) => [c.path, new Set(c.keywords)]));
    this.agents = new Set(ctx.agents ?? agentVocabulary(snapshot));
    this.maxOps = ctx.purpose === "consolidate" ? CONSOLIDATION_MAX_OPS : ctx.policy.caps.maxOpsPerEvent;
    this.validate = proposalValidator({ purpose: ctx.purpose, maxOps: this.maxOps, caps: ctx.policy.caps, agents: [...this.agents] });
    this.promptVersion = ctx.promptVersion ?? PROMPT_VERSION;
    this.actor = ctx.actor ?? `llm:${this.promptVersion}`;
    this.targetedIds = new Set((ctx.targeted ?? []).map((h) => h.id));
  }

  // ── Driver ──

  run(proposal: Proposal): OrganiserResult {
    const ops = Array.isArray(proposal?.ops) ? proposal.ops : [];
    ops.forEach((op, index) => {
      const name = typeof op?.op === "string" ? op.op : "?";
      this.opIndex = index;
      this.auditSeq = 0;
      const outcome = this.gate(op, index);
      if (outcome.ok) {
        this.acceptedCount += 1;
        if (outcome.rewrite !== undefined) this.rewrites.push({ index, from: name, ...outcome.rewrite });
      } else {
        this.reject(index, name, outcome.reason, outcome.detail);
      }
    });
    const needsConsolidation = this.finaliseStats();
    return { accepted: this.ops, rejected: this.rejected, acceptedCount: this.acceptedCount, rewrites: this.rewrites, needsConsolidation };
  }

  /** Gates 1–3 for one op, in order. */
  private gate(op: Operation, index: number): Outcome {
    if (index >= this.maxOps) return { ok: false, reason: "too-many-ops", detail: `at most ${this.maxOps} ops per proposal` };
    const name = typeof op?.op === "string" ? op.op : "?";
    if (this.ctx.purpose === "extract" && consolidationOnly.has(name)) {
      return { ok: false, reason: "consolidation-only", detail: `"${name}" is only accepted from the consolidation pass` };
    }
    const shape = this.validate({ ops: [op] });
    if (!shape.ok) return { ok: false, reason: "invalid", detail: issueText(shape.issues, index) };
    const valid = shape.value.ops[0];
    if (valid === undefined) return { ok: false, reason: "invalid" };
    switch (valid.op) {
      case "add_hint":
        return this.addHint(valid, index);
      case "update_hint":
        return this.updateHint(valid, index);
      case "reinforce_hint":
        return this.reinforceHint(valid, index);
      case "retire_hint":
        return this.retireHint(valid, index);
      case "create_node":
        return this.createNode(valid, index);
      case "update_node":
        return this.updateNode(valid, index);
      case "set_property":
        return this.setProperty(valid, index);
      case "noop":
        return OK;
      case "merge_hints":
        return this.mergeHints(valid, index);
      case "move_hint":
        return this.moveHint(valid, index);
      case "split_node":
        return this.splitNode(valid, index);
      case "merge_nodes":
        return this.mergeNodes(valid, index);
      case "alias_slot":
        return this.aliasSlot(valid, index);
    }
  }

  // ── Bookkeeping ──

  private audit(action: string, fields: { hintId?: string; nodePath?: string; detail?: Record<string, JsonValue> }): void {
    this.ops.push(
      eventAudit(this.ctx.ref, {
        eventId: this.ctx.eventId,
        seq: `op:${this.opIndex}:${this.auditSeq++}`,
        at: this.ctx.at,
        actor: this.actor,
        action,
        ...fields,
      }),
    );
  }

  private reject(index: number, op: string, reason: RejectReason, detail?: string): void {
    this.rejected.push({ index, op, reason, ...(detail !== undefined ? { detail } : {}) });
    const action = reason === "injection" ? "injection-rejected" : "op.rejected";
    this.audit(action, { detail: { op, reason, index, ...(detail !== undefined ? { detail } : {}) } });
  }

  private provenancePatch(): NonNullable<HintPatch["provenance"]> {
    return { appendEventId: this.ctx.eventId, ...(this.ctx.runId !== undefined ? { appendRunId: this.ctx.runId } : {}) };
  }

  private touch(path: string, activeDelta: number): void {
    this.touched.add(path);
    if (activeDelta !== 0) this.delta.set(path, (this.delta.get(path) ?? 0) + activeDelta);
  }

  /** Remember a row this proposal wrote, so later ops see it. */
  private remember(hint: HintRecord, fresh: boolean): void {
    const previous = this.hints.get(hint.id);
    if (previous !== undefined && previous.status === "active") this.activeByKey.delete(slotKey(previous));
    this.hints.set(hint.id, hint);
    if (hint.status === "active") this.activeByKey.set(slotKey(hint), hint);
    if (fresh) this.planned.add(hint.id);
  }

  private patch(hint: HintRecord, patch: HintPatch): HintRecord {
    this.ops.push({ op: "patchHint", hintId: hint.id, patch });
    const { reinforcements, contradictions, applied, provenance, ...scalars } = patch;
    void applied;
    const next: HintRecord = { ...hint, ...scalars, provenance: { ...hint.provenance, eventIds: [...hint.provenance.eventIds, this.ctx.eventId] } };
    if (reinforcements) next.reinforcements = hint.reinforcements + reinforcements.add;
    if (contradictions) next.contradictions = hint.contradictions + contradictions.add;
    void provenance;
    this.remember(next, false);
    return next;
  }

  // ── Lookups (gate 2) ──

  /** The active node at `path`, following a merge; undefined when there is none. */
  private activeNode(path: string): TopicNode | undefined {
    let current = this.nodes.get(path)?.node;
    for (let hop = 0; current !== undefined && current.status === "merged" && hop < 8; hop += 1) {
      current = current.mergedInto === undefined ? undefined : this.nodes.get(current.mergedInto)?.node;
    }
    return current !== undefined && current.status === "active" ? current : undefined;
  }

  private children(path: string): TopicNode[] {
    const out: TopicNode[] = [];
    for (const { node } of this.nodes.values()) if (node.status === "active" && node.parentPath === path) out.push(node);
    return out;
  }

  /**
   * The hint an op names, when it may still be acted on. A row this event
   * already moved is reported as `replayed` before its status is judged: a
   * hint this very event retired is not "not-active", it is done.
   */
  private liveHint(id: string): { ok: true; hint: HintRecord; replayed: boolean } | { ok: false; reason: RejectReason; detail: string } {
    const hint = this.hints.get(id);
    if (hint === undefined) return { ok: false, reason: "unknown-hint", detail: `hint ${id} is not in this subject's graph` };
    const replayed = alreadyApplied(hint, this.ctx.eventId);
    if (!replayed && hint.status !== "active" && hint.status !== "pending") return { ok: false, reason: "not-active", detail: `hint ${id} is ${hint.status}` };
    return { ok: true, hint, replayed };
  }

  private replayed(hint: HintRecord): Outcome {
    return { ok: true, rewrite: { to: "noop", reason: "already-applied", target: hint.id } };
  }

  // ── Gate 3 helpers ──

  /** Spec §5.4 step 5: what a feedback `target` lets a proposal touch. A hint the feedback is about is always in scope. */
  private offTarget(placement: { scope: HintScope; agent?: string; lane: HintLane; nodePath: string }, hintId?: string): string | undefined {
    const target = this.ctx.target;
    if (target === undefined || (hintId !== undefined && this.targetedIds.has(hintId))) return undefined;
    if (target.startsWith("agent:")) {
      const agent = target.slice("agent:".length);
      const under = placement.nodePath === join(ROOT_PATH, agent) || isDescendant(placement.nodePath, join(ROOT_PATH, agent));
      if ((placement.scope === "agent" && placement.agent === agent) || under) return undefined;
      return `feedback targets agent:${agent}; the proposal must use scope "agent" with that agent or a node under /${agent}`;
    }
    if (target === "response" && placement.lane !== "responseStyle" && placement.lane !== "preRoute") {
      return 'feedback targets the response; the proposal must use lane "responseStyle" or "preRoute"';
    }
    return undefined;
  }

  private sanitize(text: string): { ok: true; text: string; review: boolean; reviewReason?: string } | { ok: false; reason: RejectReason; detail: string } {
    const result = sanitizeStatement(text, { maxChars: this.ctx.policy.caps.maxHintChars, ...(this.ctx.extraDeny !== undefined ? { extraDeny: this.ctx.extraDeny } : {}) });
    if (result.ok) return result;
    const injection = result.reasons.some((r: SanitizeReason) => injectionFamilies.has(r) || r === "extra-deny");
    return { ok: false, reason: injection ? "injection" : "not-canonical", detail: result.reasons.join(", ") };
  }

  private normaliseValue(raw: string): string {
    return normaliseSlotValue(raw).slice(0, MAX_SLOT_VALUE_CHARS).trim();
  }

  /**
   * Gate 3 for a label (§9.1, `matchLabelInjection`): a title, description,
   * keyword list, slot value, or property key or value is stored and then
   * rendered into every later outline outside the user-text fence, so an
   * instruction inside one rejects the whole op as `injection`. The detail
   * names the field and the family, never the text.
   */
  private labelInjection(fields: Readonly<Record<string, JsonValue | undefined>>): { ok: false; reason: RejectReason; detail: string } | undefined {
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const reasons = matchLabelInjection(value, this.ctx.extraDeny ?? []);
      if (reasons.length > 0) return { ok: false, reason: "injection", detail: `${field}: ${reasons.join(", ")}` };
    }
    return undefined;
  }

  /** Whether a new hint starts pending (§10.4): review flag, policy, the approval hook, or the shared subject's default. */
  private startsPending(hint: HintRecord, review: boolean): boolean {
    if (review) return true;
    const approval = this.ctx.policy.approval;
    if (approval === "review-all" || (approval === "review-inferred" && hint.source === "inferred")) return true;
    const hook = this.ctx.requireApproval;
    if (hook !== undefined) return hook(hint, { shared: this.ctx.shared === true, event: this.ctx.event ?? null }) === true;
    return this.ctx.shared === true;
  }

  private provenance(supersedes?: string): HintProvenance {
    return {
      originEventId: this.ctx.eventId,
      eventIds: [this.ctx.eventId],
      runIds: this.ctx.runId !== undefined ? [this.ctx.runId] : [],
      extractor: { kind: "llm", promptVersion: this.promptVersion, ...(this.ctx.model !== undefined ? { model: this.ctx.model } : {}) },
      ...(supersedes !== undefined ? { supersedes } : {}),
    };
  }

  /** §6.1 item 2: count a contradiction against `holder` on behalf of challenger `by`; item 3 retires or flags it at the threshold. */
  private contradict(holder: HintRecord, by: string, via: string): void {
    const patch = this.contradictionPatch(holder);
    this.patch(holder, patch);
    this.touch(holder.nodePath, patch.status === "retired" ? -1 : 0);
    this.audit("hint.contradicted", { hintId: holder.id, nodePath: holder.nodePath, detail: { by, slot: holder.slot, via, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.needsReview ? { needsReview: true } : {}) } });
    if (patch.status === "retired") this.audit("hint.retired", { hintId: holder.id, nodePath: holder.nodePath, detail: { reason: "contradicted" } });
  }

  /** Spec §6.1 item 3, applied when a challenger counts a contradiction against its holder. */
  private contradictionPatch(holder: HintRecord): HintPatch {
    const patch: HintPatch = { contradictions: { add: 1 }, provenance: this.provenancePatch() };
    const contradictions = holder.contradictions + 1;
    if (contradictions >= this.ctx.policy.decay.contradictionsToRetire) {
      if (holder.source === "inferred" && holder.approval !== "approved") {
        patch.status = "retired";
        patch.retiredReason = "contradicted";
      } else {
        patch.needsReview = true;
      }
    }
    return patch;
  }

  // ── add_hint (§5.6 rewrites) ──

  /** Every text-level gate for one hint body; the placement decisions come in `commit`. */
  private prepare(body: AddHintBody, nodePath: string, label: string): Prepared {
    let node = this.activeNode(nodePath);
    if (node === undefined) return { ok: false, reason: "unknown-node", detail: `${nodePath} is not an active node of this subject` };
    const text = this.sanitize(body.text);
    if (!text.ok) return text;
    const value = this.normaliseValue(body.value);
    if (value.length === 0) return { ok: false, reason: "invalid", detail: "value is empty after normalisation" };
    const injected = this.labelInjection({ value });
    if (injected !== undefined) return injected;
    const slot = canonicalSlot(body.slot, this.snapshot.slotAliases);
    let clientId: string | undefined;
    if (body.clientScoped === true) {
      if (typeof this.ctx.clientId !== "string" || this.ctx.clientId.length === 0) {
        return { ok: false, reason: "no-client", detail: "clientScoped requires a client on the event" };
      }
      clientId = this.ctx.clientId;
    }
    const off = this.offTarget({ scope: body.scope, ...(body.agent !== undefined ? { agent: body.agent } : {}), lane: body.lane, nodePath: node.path });
    if (off !== undefined) return { ok: false, reason: "off-target", detail: off };

    // Add over create: a locked node whose descendant plainly owns the topic.
    // Update over add comes first (§5.6): a key the locked node already
    // holds is reinforced or superseded there, never re-stated on a child.
    let retargeted: string | undefined;
    const heldHere = this.activeByKey.has(slotKey({ nodePath: node.path, slot, scope: body.scope, ...(body.agent !== undefined ? { agent: body.agent } : {}), ...(clientId !== undefined ? { clientId } : {}) }));
    if (node.locked && !heldHere) {
      const parent = node.path;
      let best: { node: TopicNode; score: number } | undefined;
      for (const { node: candidate } of this.nodes.values()) {
        if (candidate.status !== "active" || !isDescendant(candidate.path, parent)) continue;
        const score = keywordScore(candidate, `${body.text} ${body.value}`);
        if (score < RETARGET_MIN_SCORE) continue;
        if (best === undefined || score > best.score || (score === best.score && candidate.level > best.node.level)) best = { node: candidate, score };
      }
      if (best !== undefined) {
        node = best.node;
        retargeted = best.node.path;
      }
    }

    const id = deterministicId("h", this.ctx.ref.tenantId, this.ctx.ref.subjectId, this.ctx.eventId, label);
    if (this.snapshot.tombstones.has(id)) return { ok: false, reason: "tombstoned", detail: `hint ${id} was forgotten and cannot be re-created` };
    return {
      ok: true,
      hint: {
        node,
        slot,
        value,
        text: text.text,
        kind: body.kind,
        lane: body.lane,
        scope: body.scope,
        ...(body.agent !== undefined ? { agent: body.agent } : {}),
        ...(clientId !== undefined ? { clientId } : {}),
        priority: body.priority,
        confidence: body.confidence,
        review: text.review,
        ...(text.reviewReason !== undefined ? { reviewReason: text.reviewReason } : {}),
        id,
        ...(retargeted !== undefined ? { retargeted } : {}),
      },
    };
  }

  private record(p: PreparedHint, supersedes?: string, challenger = false): HintRecord {
    const at = this.ctx.at;
    const base: HintRecord = {
      id: p.id,
      tenantId: this.ctx.ref.tenantId,
      subjectId: this.ctx.ref.subjectId,
      nodeId: p.node.id,
      nodePath: p.node.path,
      slot: p.slot,
      value: p.value,
      text: p.text,
      kind: p.kind,
      lane: p.lane,
      scope: p.scope,
      ...(p.agent !== undefined ? { agent: p.agent } : {}),
      ...(p.clientId !== undefined ? { clientId: p.clientId } : {}),
      source: this.ctx.source,
      priority: p.priority,
      confidence: p.confidence,
      status: "active",
      approval: "auto",
      maturity: "captured",
      needsReview: p.review,
      ...(supersedes !== undefined ? { supersedes } : {}),
      reinforcements: 0,
      contradictions: 0,
      applied: 0,
      provenance: this.provenance(supersedes),
      version: 1,
      createdAt: at,
      updatedAt: at,
      lastReinforcedAt: at,
    };
    const status: HintStatus = challenger || this.startsPending(base, p.review) ? "pending" : "active";
    return { ...base, status };
  }

  private reinforcePatch(hint: HintRecord, confidence?: number): HintPatch {
    return {
      reinforcements: { add: 1 },
      confidence: confidence ?? clamp01(hint.confidence + this.ctx.policy.feedback.upConfidenceDelta),
      lastReinforcedAt: this.ctx.at,
      provenance: this.provenancePatch(),
      ...this.promotion(hint),
    };
  }

  /**
   * A human-stated proposal (feedback text, source `explicit`) that edits or
   * restates an inferred hint in place has made it the user's own words: the
   * row is promoted to `explicit`, so it carries the explicit weight, half-
   * life and review-over-retire treatment (§6.1) rather than staying a guess
   * the user has since confirmed. Never the other way round.
   */
  private promotion(hint: HintRecord): { source?: HintSource } {
    return SOURCE_RANK[this.ctx.source] > SOURCE_RANK[hint.source] ? { source: this.ctx.source } : {};
  }

  /** Update over add (§5.6, §6.1): place a prepared hint against whatever already holds its key. */
  private commit(p: PreparedHint): Outcome {
    const existing = this.hints.get(p.id);
    if (existing !== undefined && alreadyApplied(existing, this.ctx.eventId)) {
      return { ok: true, rewrite: { to: "noop", reason: "already-applied", target: p.id } };
    }
    const key = slotKey({ nodePath: p.node.path, slot: p.slot, scope: p.scope, ...(p.agent !== undefined ? { agent: p.agent } : {}), ...(p.clientId !== undefined ? { clientId: p.clientId } : {}) });
    const holder = this.activeByKey.get(key);
    const retarget = p.retargeted !== undefined ? { target: p.retargeted } : {};

    if (holder !== undefined && holder.id !== p.id) {
      if (holder.value === p.value) {
        if (this.planned.has(holder.id) || alreadyApplied(holder, this.ctx.eventId)) return this.replayed(holder);
        this.patch(holder, this.reinforcePatch(holder));
        this.touch(holder.nodePath, 0);
        this.audit("hint.reinforced", { hintId: holder.id, nodePath: holder.nodePath, detail: { via: "add_hint", slot: holder.slot } });
        return { ok: true, rewrite: { to: "reinforce_hint", reason: "reinforce", target: holder.id } };
      }
      if (this.planned.has(holder.id)) {
        return { ok: false, reason: "duplicate", detail: `slot ${p.slot} on ${p.node.path} is already proposed with another value in this batch` };
      }
      const outranked = SOURCE_RANK[this.ctx.source] < SOURCE_RANK[holder.source];
      if (holder.approval === "approved" || outranked) {
        if (!alreadyApplied(holder, this.ctx.eventId)) this.contradict(holder, p.id, "add_hint");
        const challenger = this.record(p, holder.id, true);
        this.ops.push({ op: "upsertHint", hint: challenger });
        this.remember(challenger, true);
        this.touch(challenger.nodePath, 0);
        this.audit("hint.created", { hintId: challenger.id, nodePath: challenger.nodePath, detail: { status: "pending", challenges: holder.id, slot: challenger.slot, ...(p.review ? { review: p.reviewReason ?? "review" } : {}) } });
        return { ok: true, rewrite: { to: "add_hint", reason: "challenger", target: holder.id } };
      }
      this.patch(holder, { status: "superseded", supersededBy: p.id, provenance: this.provenancePatch() });
      this.touch(holder.nodePath, -1);
      this.audit("hint.superseded", { hintId: holder.id, nodePath: holder.nodePath, detail: { by: p.id, slot: holder.slot } });
      const replacement = this.record(p, holder.id);
      this.ops.push({ op: "upsertHint", hint: replacement });
      this.remember(replacement, true);
      this.touch(replacement.nodePath, replacement.status === "active" ? 1 : 0);
      this.audit("hint.created", { hintId: replacement.id, nodePath: replacement.nodePath, detail: { status: replacement.status, supersedes: holder.id, slot: replacement.slot } });
      return { ok: true, rewrite: { to: "add_hint", reason: "supersede", target: holder.id } };
    }

    const created = this.record(p);
    this.ops.push({ op: "upsertHint", hint: created });
    this.remember(created, true);
    this.touch(created.nodePath, created.status === "active" ? 1 : 0);
    this.audit("hint.created", { hintId: created.id, nodePath: created.nodePath, detail: { status: created.status, slot: created.slot, ...(p.review ? { review: p.reviewReason ?? "review" } : {}) } });
    return p.retargeted !== undefined ? { ok: true, rewrite: { to: "add_hint", reason: "retargeted", ...retarget } } : OK;
  }

  private addHint(op: AddHintOp, index: number): Outcome {
    const { op: _name, nodePath, ...body } = op;
    void _name;
    const prepared = this.prepare(body, nodePath, hintLabel(index));
    if (!prepared.ok) return prepared;
    return this.commit(prepared.hint);
  }

  // ── update / reinforce / retire ──

  private updateHint(op: UpdateHintOp, index: number): Outcome {
    const found = this.liveHint(op.hintId);
    if (!found.ok) return found;
    const hint = found.hint;
    if (found.replayed) return this.replayed(hint);
    const off = this.offTarget(hint, hint.id);
    if (off !== undefined) return { ok: false, reason: "off-target", detail: off };

    let review = false;
    let reviewReason: string | undefined;
    let newText: string | undefined;
    if (op.text !== undefined) {
      const clean = this.sanitize(op.text);
      if (!clean.ok) return clean;
      review = clean.review;
      reviewReason = clean.reviewReason;
      if (clean.text !== hint.text) newText = clean.text;
    }
    const normalised = op.value !== undefined ? this.normaliseValue(op.value) : undefined;
    const injectedValue = this.labelInjection({ value: normalised });
    if (injectedValue !== undefined) return injectedValue;
    const newValue = normalised !== undefined && normalised.length > 0 && normalised !== hint.value ? normalised : undefined;
    const textChanged = newText !== undefined;
    const valueChanged = newValue !== undefined;
    // A `down` already patched the targeted hint's confidence and contradictions in this batch (§5.4 step 4).
    const downTargeted = this.targetedIds.has(hint.id) && this.ctx.event?.type === "feedback" && this.ctx.event.signal === "down";
    const priority = downTargeted ? undefined : op.priority;
    const confidence = downTargeted ? undefined : op.confidence;

    // Review over loss (§5.6) and source rank (§6.1): an approved hint, or one
    // a human stated when this proposal is only inferred, is never rewritten in
    // place. A restatement still reinforces it; a change becomes a pending
    // challenger, and a new value from a source that may not replace the old
    // one also counts as a contradiction against the holder (§6.1 item 2).
    const outranked = SOURCE_RANK[this.ctx.source] < SOURCE_RANK[hint.source];
    if (hint.approval === "approved" || outranked) {
      if (!textChanged && !valueChanged) {
        this.patch(hint, this.reinforcePatch(hint, confidence));
        this.touch(hint.nodePath, 0);
        this.audit("hint.reinforced", { hintId: hint.id, nodePath: hint.nodePath, detail: { via: "update_hint" } });
        return { ok: true, rewrite: { to: "reinforce_hint", reason: "reinforce", target: hint.id } };
      }
      return this.challenge(hint, index, {
        value: newValue ?? hint.value,
        text: newText ?? hint.text,
        priority: priority ?? hint.priority,
        confidence: confidence ?? hint.confidence,
        review,
        ...(reviewReason !== undefined ? { reviewReason } : {}),
        contradiction: outranked && valueChanged,
      });
    }

    const patch: HintPatch = { provenance: this.provenancePatch(), ...this.promotion(hint) };
    if (newText !== undefined) patch.text = newText;
    if (newValue !== undefined) patch.value = newValue;
    if (priority !== undefined) patch.priority = priority;
    if (review) {
      patch.needsReview = true;
      patch.status = "pending";
    }
    if (!valueChanged) {
      // §6.2: an update that keeps the value is a restatement.
      Object.assign(patch, this.reinforcePatch(hint, confidence));
      if (downTargeted) delete patch.confidence;
    } else if (confidence !== undefined) {
      patch.confidence = confidence;
    }
    const before = hint.status;
    const next = this.patch(hint, patch);
    this.touch(hint.nodePath, before === "active" && next.status !== "active" ? -1 : 0);
    this.audit(valueChanged ? "hint.updated" : "hint.reinforced", {
      hintId: hint.id,
      nodePath: hint.nodePath,
      detail: { via: "update_hint", textChanged, valueChanged, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.source !== undefined ? { source: patch.source } : {}) },
    });
    return valueChanged ? OK : { ok: true, rewrite: { to: "reinforce_hint", reason: "reinforce", target: hint.id } };
  }

  /**
   * An `update_hint` the proposal may not make in place, as a pending
   * challenger carrying its changes: the holder stays active until a human
   * decides. Nothing is written when the challenger's id was forgotten, or
   * when a replay finds the challenger this event already wrote.
   */
  private challenge(
    hint: HintRecord,
    index: number,
    next: { value: string; text: string; priority: number; confidence: number; review: boolean; reviewReason?: string; contradiction: boolean },
  ): Outcome {
    const node = this.activeNode(hint.nodePath);
    if (node === undefined) return { ok: false, reason: "unknown-node", detail: `${hint.nodePath} is no longer active` };
    const id = deterministicId("h", this.ctx.ref.tenantId, this.ctx.ref.subjectId, this.ctx.eventId, hintLabel(index));
    if (this.snapshot.tombstones.has(id)) return { ok: false, reason: "tombstoned", detail: `hint ${id} was forgotten` };
    const existing = this.hints.get(id);
    if (existing !== undefined && alreadyApplied(existing, this.ctx.eventId)) return this.replayed(existing);
    if (next.contradiction) this.contradict(hint, id, "update_hint");
    const challenger = this.record(
      {
        node,
        slot: hint.slot,
        value: next.value,
        text: next.text,
        kind: hint.kind,
        lane: hint.lane,
        scope: hint.scope,
        ...(hint.agent !== undefined ? { agent: hint.agent } : {}),
        ...(hint.clientId !== undefined ? { clientId: hint.clientId } : {}),
        priority: next.priority,
        confidence: next.confidence,
        review: next.review,
        ...(next.reviewReason !== undefined ? { reviewReason: next.reviewReason } : {}),
        id,
      },
      hint.id,
      true,
    );
    this.ops.push({ op: "upsertHint", hint: challenger });
    this.remember(challenger, true);
    this.touch(challenger.nodePath, 0);
    this.audit("hint.created", { hintId: challenger.id, nodePath: challenger.nodePath, detail: { status: "pending", challenges: hint.id, via: "update_hint", slot: hint.slot } });
    return { ok: true, rewrite: { to: "add_hint", reason: "challenger", target: hint.id } };
  }

  private reinforceHint(op: ReinforceHintOp, _index: number): Outcome {
    void _index;
    const found = this.liveHint(op.hintId);
    if (!found.ok) return found;
    const hint = found.hint;
    if (found.replayed) return this.replayed(hint);
    const off = this.offTarget(hint, hint.id);
    if (off !== undefined) return { ok: false, reason: "off-target", detail: off };
    const downTargeted = this.targetedIds.has(hint.id) && this.ctx.event?.type === "feedback" && this.ctx.event.signal === "down";
    const patch = this.reinforcePatch(hint);
    if (downTargeted) delete patch.confidence;
    this.patch(hint, patch);
    this.touch(hint.nodePath, 0);
    this.audit("hint.reinforced", { hintId: hint.id, nodePath: hint.nodePath, detail: { via: "reinforce_hint" } });
    return OK;
  }

  private retireHint(op: RetireHintOp, _index: number): Outcome {
    void _index;
    const found = this.liveHint(op.hintId);
    if (!found.ok) return found;
    const hint = found.hint;
    if (found.replayed) return this.replayed(hint);
    const off = this.offTarget(hint, hint.id);
    if (off !== undefined) return { ok: false, reason: "off-target", detail: off };
    if (SOURCE_RANK[this.ctx.source] < SOURCE_RANK[hint.source]) {
      return { ok: false, reason: "source-rank", detail: `an ${this.ctx.source} proposal cannot retire an ${hint.source} hint` };
    }
    if (hint.approval === "approved") {
      this.patch(hint, { needsReview: true, provenance: this.provenancePatch() });
      this.touch(hint.nodePath, 0);
      this.audit("hint.needs-review", { hintId: hint.id, nodePath: hint.nodePath, detail: { requested: "retire", reason: op.reason, rationale: op.rationale } });
      return { ok: true, rewrite: { to: "needs-review", reason: "needs-review", target: hint.id } };
    }
    const wasActive = hint.status === "active";
    this.patch(hint, { status: "retired", retiredReason: op.reason, provenance: this.provenancePatch() });
    this.touch(hint.nodePath, wasActive ? -1 : 0);
    this.audit("hint.retired", { hintId: hint.id, nodePath: hint.nodePath, detail: { reason: op.reason, rationale: op.rationale } });
    return OK;
  }

  // ── Nodes ──

  /** Gate 2 for a node about to be created under `parent`; the sibling a clash should land on, when there is one. */
  private nodeGates(parent: TopicNode, slug: string, title: string): { ok: true; clash?: TopicNode } | { ok: false; reason: RejectReason; detail: string } {
    const level = depth(parent.path) + 1;
    if (level > this.ctx.policy.caps.maxNodeDepth) return { ok: false, reason: "max-depth", detail: `a node under ${parent.path} would be at depth ${level}; the cap is ${this.ctx.policy.caps.maxNodeDepth}` };
    if (level <= 1) return { ok: false, reason: "locked", detail: "level-1 nodes are configured categories and cannot be created by a proposal" };
    const path = join(parent.path, slug);
    const holder = this.nodes.get(path)?.node;
    if (holder !== undefined) {
      const live = this.activeNode(path);
      if (live === undefined) return { ok: false, reason: "unknown-node", detail: `${path} exists but is ${holder.status}` };
      return { ok: true, clash: live };
    }
    const siblings = this.children(parent.path);
    const near = siblings.find((s) => slugsClash(s.slug, slug) || jaccard(s.title, title) >= TITLE_JACCARD);
    if (near !== undefined) return { ok: true, clash: near };
    if (siblings.length >= this.ctx.policy.caps.maxChildren) return { ok: false, reason: "max-children", detail: `${parent.path} already has ${siblings.length} children` };
    if (this.nodeCount >= this.ctx.policy.caps.maxNodesPerSubject) return { ok: false, reason: "max-nodes", detail: `the subject already has ${this.nodeCount} nodes` };
    return { ok: true };
  }

  private newNode(parent: TopicNode, fields: { slug: string; title: string; description: string; keywords: string[]; agents?: string[]; properties?: Record<string, JsonValue> }): TopicNode {
    const path = join(parent.path, fields.slug);
    const at = this.ctx.at;
    const row: TopicNode = {
      id: deterministicId("n", this.ctx.ref.tenantId, this.ctx.ref.subjectId, path),
      tenantId: this.ctx.ref.tenantId,
      subjectId: this.ctx.ref.subjectId,
      path,
      parentPath: parent.path,
      slug: fields.slug,
      title: fields.title,
      description: fields.description,
      keywords: [...new Set(fields.keywords)],
      patterns: [],
      agents: (fields.agents ?? []).filter((a) => this.agents.has(a)),
      properties: fields.properties ?? {},
      level: depth(path),
      locked: false,
      status: "active",
      stats: { activeHints: 0, lastIngestAt: at },
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.ops.push({ op: "upsertNode", node: row });
    this.nodes.set(path, { node: row, created: row });
    this.nodeCount += 1;
    this.touched.add(path);
    this.audit("node.created", { nodePath: path, detail: { parentPath: parent.path, title: fields.title } });
    return row;
  }

  private createNode(op: CreateNodeOp, index: number): Outcome {
    const parent = this.activeNode(op.parentPath);
    if (parent === undefined) return { ok: false, reason: "unknown-node", detail: `${op.parentPath} is not an active node of this subject` };
    const gates = this.nodeGates(parent, op.slug, op.title);
    if (!gates.ok) return gates;
    const injected = this.labelInjection({ title: op.title, description: op.description, keywords: op.keywords, properties: op.properties });
    if (injected !== undefined) return injected;
    const clash = gates.clash;
    const path = clash?.path ?? join(parent.path, op.slug);

    // The unit: every inline hint must pass its gates before anything is
    // written, and no two may claim one key with different values — against
    // each other or against a hint an earlier op planned on `path` — since
    // `commit` would refuse the second only after the node row was emitted.
    const prepared: PreparedHint[] = [];
    const problems: string[] = [];
    let firstReason: RejectReason | undefined;
    const claimed = new Map<string, string>();
    op.hints.forEach((body, j) => {
      const label = hintLabel(index, j);
      const result = clash !== undefined ? this.prepare(body, clash.path, label) : this.prepareInline(body, parent.path, label, path);
      if (!result.ok) {
        problems.push(`hints/${j}: ${result.reason} (${result.detail})`);
        firstReason ??= result.reason;
        return;
      }
      const p = result.hint;
      const key = slotKey({ nodePath: path, slot: p.slot, scope: p.scope, ...(p.agent !== undefined ? { agent: p.agent } : {}), ...(p.clientId !== undefined ? { clientId: p.clientId } : {}) });
      const holder = this.activeByKey.get(key);
      const rival = claimed.get(key) ?? (holder !== undefined && this.planned.has(holder.id) ? holder.value : undefined);
      if (rival !== undefined && rival !== p.value) {
        problems.push(`hints/${j}: duplicate (slot ${p.slot} on ${path} is already proposed with another value in this batch)`);
        firstReason ??= "duplicate";
        return;
      }
      claimed.set(key, p.value);
      prepared.push(p);
    });
    if (prepared.length === 0 || problems.length > 0) {
      return { ok: false, reason: firstReason ?? "no-valid-hints", detail: problems.join("; ") || "create_node needs at least one hint" };
    }

    if (clash !== undefined) {
      for (const p of prepared) this.commit(p);
      return { ok: true, rewrite: { to: "add_hint", reason: "sibling-clash", target: clash.path } };
    }
    const node = this.newNode(parent, {
      slug: op.slug,
      title: op.title,
      description: op.description,
      keywords: op.keywords,
      ...(op.agents !== undefined ? { agents: op.agents } : {}),
      ...(op.properties !== undefined ? { properties: op.properties } : {}),
    });
    for (const p of prepared) this.commit({ ...p, node });
    return OK;
  }

  /**
   * An inline hint of a `create_node` is prepared against the node that
   * will exist once the op commits: the gates that need a node (the target
   * constraint, the re-target rule) run against the parent, and the row is
   * swapped in at commit time.
   */
  private prepareInline(body: AddHintBody, parentPath: string, label: string, futurePath: string): Prepared {
    const result = this.prepare(body, parentPath, label);
    if (!result.ok) return result;
    const off = this.offTarget({ scope: body.scope, ...(body.agent !== undefined ? { agent: body.agent } : {}), lane: body.lane, nodePath: futurePath });
    if (off !== undefined) return { ok: false, reason: "off-target", detail: off };
    const { retargeted, ...hint } = result.hint;
    void retargeted;
    return { ok: true, hint };
  }

  private updateNode(op: UpdateNodeOp, _index: number): Outcome {
    void _index;
    const node = this.activeNode(op.nodePath);
    if (node === undefined) return { ok: false, reason: "unknown-node", detail: `${op.nodePath} is not an active node of this subject` };
    const injected = this.labelInjection({ title: op.title, description: op.description, keywords: op.keywords });
    if (injected !== undefined) return injected;
    const patch: NodePatch = {};
    let droppedTitle = false;
    if (op.title !== undefined && op.title !== node.title) {
      if (node.locked) droppedTitle = true;
      else patch.title = op.title;
    }
    if (op.description !== undefined && op.description !== node.description) patch.description = op.description;
    if (op.keywords !== undefined) {
      const merged = mergeKeywords(node.keywords, op.keywords, this.seedKeywords.get(node.path) ?? new Set());
      if (!sameStrings(merged, node.keywords)) patch.keywords = merged;
    }
    if (Object.keys(patch).length === 0) {
      if (droppedTitle) return { ok: false, reason: "locked", detail: `${node.path} is a locked node; its title cannot change` };
      return { ok: true, rewrite: { to: "noop", reason: "already-applied", target: node.path } };
    }
    this.ops.push({ op: "patchNode", nodeId: node.id, patch });
    this.nodes.set(node.path, { ...this.nodes.get(node.path), node: { ...node, ...patch } });
    this.touched.add(node.path);
    this.audit("node.updated", { nodePath: node.path, detail: { fields: Object.keys(patch), ...(droppedTitle ? { droppedTitle: true } : {}) } });
    return droppedTitle ? { ok: true, rewrite: { to: "update_node", reason: "locked-title", target: node.path } } : OK;
  }

  private setProperty(op: SetPropertyOp, _index: number): Outcome {
    void _index;
    const node = this.activeNode(op.nodePath);
    if (node === undefined) return { ok: false, reason: "unknown-node", detail: `${op.nodePath} is not an active node of this subject` };
    const injected = this.labelInjection({ key: op.key, value: op.value });
    if (injected !== undefined) return injected;
    if (JSON.stringify(node.properties[op.key]) === JSON.stringify(op.value)) {
      return { ok: true, rewrite: { to: "noop", reason: "already-applied", target: node.path } };
    }
    const properties = { ...node.properties, [op.key]: op.value };
    const checked = propertiesValidator(this.ctx.policy.caps)(properties);
    if (!checked.ok) return { ok: false, reason: "properties-cap", detail: checked.issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; ") };
    this.ops.push({ op: "patchNode", nodeId: node.id, patch: { properties: checked.value } });
    this.nodes.set(node.path, { ...this.nodes.get(node.path), node: { ...node, properties: checked.value } });
    this.touched.add(node.path);
    this.audit("node.property", { nodePath: node.path, detail: { key: op.key } });
    return OK;
  }

  // ── Consolidation ops (§5.7) ──

  private mergeHints(op: MergeHintsOp, index: number): Outcome {
    const inputs: HintRecord[] = [];
    for (const id of op.hintIds) {
      const found = this.liveHint(id);
      if (!found.ok) return found;
      inputs.push(found.hint);
    }
    const first = inputs[0];
    if (first === undefined) return { ok: false, reason: "invalid", detail: "merge_hints needs at least two hints" };
    const id = deterministicId("h", this.ctx.ref.tenantId, this.ctx.ref.subjectId, this.ctx.eventId, hintLabel(index));
    // A replay: the merged row carries this event, or every input does (an approved input is never patched, so only the row can tell).
    const existing = this.hints.get(id);
    if (existing !== undefined && alreadyApplied(existing, this.ctx.eventId)) return this.replayed(existing);
    if (inputs.every((h) => alreadyApplied(h, this.ctx.eventId))) return this.replayed(first);
    if (inputs.some((h) => h.nodePath !== first.nodePath)) return { ok: false, reason: "mixed-nodes", detail: "merge_hints inputs must share a node" };
    const node = this.activeNode(first.nodePath);
    if (node === undefined) return { ok: false, reason: "unknown-node", detail: `${first.nodePath} is no longer active` };
    // Review over loss (§5.6): one approved input keeps its row and the merge
    // becomes its pending challenger; two human decisions are never folded
    // into one by a model.
    const approved = inputs.filter((h) => h.approval === "approved");
    if (approved.length > 1) return { ok: false, reason: "approved", detail: `hints ${approved.map((h) => h.id).join(", ")} were approved by a human and cannot be merged into one` };
    const challenged = approved[0];
    const text = this.sanitize(op.text);
    if (!text.ok) return text;
    const lead = [...inputs].sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1))[0] ?? first;
    const slot = canonicalSlot(op.slot ?? lead.slot, this.snapshot.slotAliases);
    const value = this.normaliseValue(op.value ?? lead.value);
    if (value.length === 0) return { ok: false, reason: "invalid", detail: "value is empty after normalisation" };
    const injectedValue = this.labelInjection({ value });
    if (injectedValue !== undefined) return injectedValue;
    if (this.snapshot.tombstones.has(id)) return { ok: false, reason: "tombstoned", detail: `hint ${id} was forgotten` };
    const key = slotKey({ nodePath: node.path, slot, scope: lead.scope, ...(lead.agent !== undefined ? { agent: lead.agent } : {}), ...(lead.clientId !== undefined ? { clientId: lead.clientId } : {}) });
    const holder = this.activeByKey.get(key);
    if (holder !== undefined && !inputs.some((h) => h.id === holder.id)) {
      return { ok: false, reason: "slot-conflict", detail: `active hint ${holder.id} already holds ${slot} on ${node.path}` };
    }

    const retired = inputs.filter((h) => h.id !== challenged?.id);
    let activeRetired = 0;
    for (const h of retired) {
      if (h.status === "active") activeRetired += 1;
      this.patch(h, { status: "retired", retiredReason: "merged", provenance: this.provenancePatch() });
      this.audit("hint.retired", { hintId: h.id, nodePath: h.nodePath, detail: { reason: "merged", into: id } });
    }
    const eventIds = [...new Set([...inputs.flatMap((h) => h.provenance.eventIds), this.ctx.eventId])].slice(-MAX_PROVENANCE_IDS);
    const runIds = [...new Set([...inputs.flatMap((h) => h.provenance.runIds), ...(this.ctx.runId !== undefined ? [this.ctx.runId] : [])])].slice(-MAX_PROVENANCE_IDS);
    const origin = [...inputs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))[0] ?? first;
    const maturity = HINT_MATURITIES[Math.max(...inputs.map((h) => MATURITY_RANK[h.maturity]))] ?? "captured";
    const merged: HintRecord = {
      id,
      tenantId: this.ctx.ref.tenantId,
      subjectId: this.ctx.ref.subjectId,
      nodeId: node.id,
      nodePath: node.path,
      slot,
      value,
      text: text.text,
      kind: lead.kind,
      lane: lead.lane,
      scope: lead.scope,
      ...(lead.agent !== undefined ? { agent: lead.agent } : {}),
      ...(lead.clientId !== undefined ? { clientId: lead.clientId } : {}),
      source: inputs.some((h) => h.source === "explicit") ? "explicit" : "inferred",
      priority: Math.max(...inputs.map((h) => h.priority)),
      confidence: Math.max(...inputs.map((h) => h.confidence)),
      status: challenged !== undefined || text.review ? "pending" : "active",
      approval: "auto",
      maturity,
      needsReview: text.review,
      ...(challenged !== undefined ? { supersedes: challenged.id } : {}),
      reinforcements: inputs.reduce((sum, h) => sum + h.reinforcements, 0),
      contradictions: 0,
      applied: inputs.reduce((sum, h) => sum + h.applied, 0),
      provenance: {
        originEventId: origin.provenance.originEventId,
        eventIds,
        runIds,
        extractor: { kind: "llm", promptVersion: this.promptVersion, ...(this.ctx.model !== undefined ? { model: this.ctx.model } : {}) },
        ...(challenged !== undefined ? { supersedes: challenged.id } : {}),
      },
      version: 1,
      createdAt: this.ctx.at,
      updatedAt: this.ctx.at,
      lastReinforcedAt: inputs.map((h) => h.lastReinforcedAt).sort().at(-1) ?? this.ctx.at,
    };
    this.ops.push({ op: "upsertHint", hint: merged });
    this.remember(merged, true);
    this.touch(node.path, (merged.status === "active" ? 1 : 0) - activeRetired);
    this.audit("hint.created", {
      hintId: id,
      nodePath: node.path,
      detail: { via: "merge_hints", merged: retired.map((h) => h.id), slot, ...(challenged !== undefined ? { status: "pending", challenges: challenged.id } : {}) },
    });
    return challenged !== undefined ? { ok: true, rewrite: { to: "add_hint", reason: "challenger", target: challenged.id } } : OK;
  }

  /** The active hint, other than `hint` itself, holding `hint`'s key once it sits on `nodePath` under `slot`. */
  private holderAt(hint: HintRecord, nodePath: string, slot = hint.slot): HintRecord | undefined {
    const holder = this.activeByKey.get(slotKey({ ...hint, nodePath, slot }));
    return holder !== undefined && holder.id !== hint.id ? holder : undefined;
  }

  /** Review over loss (§5.6): the refusal for a move or re-slot that would retire an approved hint into `holder`. */
  private approvedConflict(hint: HintRecord, holder: HintRecord, via: string): Outcome {
    return { ok: false, reason: "slot-conflict", detail: `${via} would retire approved hint ${hint.id} into ${holder.id}, which holds ${holder.slot} on ${holder.nodePath}` };
  }

  /**
   * Move one hint to `node` if its key is free there; otherwise retire it as
   * merged into the holder. Returns the active-count delta on the source.
   * Callers refuse the whole op before emitting anything when the hint that
   * would be retired is approved (`approvedConflict`).
   */
  private relocate(hint: HintRecord, node: TopicNode, detail: Record<string, JsonValue>): number {
    const holder = this.holderAt(hint, node.path);
    const wasActive = hint.status === "active";
    if (holder !== undefined && wasActive) {
      this.patch(hint, { status: "retired", retiredReason: "merged", provenance: this.provenancePatch() });
      this.audit("hint.retired", { hintId: hint.id, nodePath: hint.nodePath, detail: { ...detail, reason: "merged", into: holder.id } });
      return -1;
    }
    this.patch(hint, { nodeId: node.id, nodePath: node.path, provenance: this.provenancePatch() });
    this.touch(node.path, wasActive ? 1 : 0);
    this.audit("hint.moved", { hintId: hint.id, nodePath: node.path, detail: { ...detail, from: hint.nodePath } });
    return wasActive ? -1 : 0;
  }

  private moveHint(op: MoveHintOp, _index: number): Outcome {
    void _index;
    const found = this.liveHint(op.hintId);
    if (!found.ok) return found;
    const hint = found.hint;
    if (found.replayed) return this.replayed(hint);
    const node = this.activeNode(op.nodePath);
    if (node === undefined) return { ok: false, reason: "unknown-node", detail: `${op.nodePath} is not an active node of this subject` };
    if (hint.nodePath === node.path) return this.replayed(hint);
    const holder = this.holderAt(hint, node.path);
    if (holder !== undefined) return { ok: false, reason: "slot-conflict", detail: `active hint ${holder.id} already holds ${hint.slot} on ${node.path}` };
    const from = hint.nodePath;
    const delta = this.relocate(hint, node, { via: "move_hint" });
    this.touch(from, delta);
    return OK;
  }

  private splitNode(op: SplitNodeOp, _index: number): Outcome {
    void _index;
    const parent = this.activeNode(op.nodePath);
    if (parent === undefined) return { ok: false, reason: "unknown-node", detail: `${op.nodePath} is not an active node of this subject` };
    const level = parent.level + 1;
    if (level > this.ctx.policy.caps.maxNodeDepth) return { ok: false, reason: "max-depth", detail: `children of ${parent.path} would be at depth ${level}` };
    // The root's children are the configured categories (§3.1): a split of the root would mint level-1 nodes no config knows.
    if (level <= 1) return { ok: false, reason: "locked", detail: "the root cannot be split; level-1 nodes are configured categories" };
    const siblings = this.children(parent.path);
    if (siblings.length + op.children.length > this.ctx.policy.caps.maxChildren) return { ok: false, reason: "max-children", detail: `${parent.path} would have ${siblings.length + op.children.length} children` };
    if (this.nodeCount + op.children.length > this.ctx.policy.caps.maxNodesPerSubject) return { ok: false, reason: "max-nodes", detail: `the subject would have ${this.nodeCount + op.children.length} nodes` };
    const moves: { child: SplitNodeOp["children"][number]; hints: HintRecord[] }[] = [];
    const claimed = new Set<string>();
    for (const child of op.children) {
      const injected = this.labelInjection({ [`children/${child.slug}/title`]: child.title, [`children/${child.slug}/description`]: child.description, [`children/${child.slug}/keywords`]: child.keywords });
      if (injected !== undefined) return injected;
      const path = join(parent.path, child.slug);
      if (this.nodes.get(path) !== undefined || siblings.some((s) => slugsClash(s.slug, child.slug) || jaccard(s.title, child.title) >= TITLE_JACCARD) || claimed.has(child.slug)) {
        return { ok: false, reason: "duplicate", detail: `${path} already exists or clashes with a sibling` };
      }
      claimed.add(child.slug);
      if (child.hintIds.length === 0) return { ok: false, reason: "no-valid-hints", detail: `child ${child.slug} lists no hints` };
      const hints: HintRecord[] = [];
      for (const id of child.hintIds) {
        const found = this.liveHint(id);
        if (!found.ok) return found;
        if (!found.replayed && found.hint.nodePath !== parent.path) return { ok: false, reason: "mixed-nodes", detail: `hint ${id} is on ${found.hint.nodePath}, not ${parent.path}` };
        hints.push(found.hint);
      }
      moves.push({ child, hints });
    }
    if (moves.every((m) => m.hints.every((h) => alreadyApplied(h, this.ctx.eventId)))) return { ok: true, rewrite: { to: "noop", reason: "already-applied", target: parent.path } };
    // A replay that found the children already there would clash above; one that finds them missing recreates them and moves what is left.
    for (const { child, hints } of moves) {
      const node = this.newNode(parent, { slug: child.slug, title: child.title, description: child.description, keywords: child.keywords });
      let delta = 0;
      for (const hint of hints) {
        if (alreadyApplied(hint, this.ctx.eventId)) continue;
        delta += this.relocate(hint, node, { via: "split_node" });
      }
      this.touch(parent.path, delta);
    }
    return OK;
  }

  private mergeNodes(op: MergeNodesOp, _index: number): Outcome {
    void _index;
    const from = this.activeNode(op.fromPath);
    if (from === undefined) return { ok: false, reason: "unknown-node", detail: `${op.fromPath} is not an active node of this subject` };
    const into = this.activeNode(op.intoPath);
    if (into === undefined) return { ok: false, reason: "unknown-node", detail: `${op.intoPath} is not an active node of this subject` };
    if (from.locked) return { ok: false, reason: "locked", detail: `${from.path} is a locked node and cannot be merged away` };
    if (from.path === into.path || isDescendant(into.path, from.path)) return { ok: false, reason: "cycle", detail: `${into.path} lies under ${from.path}` };
    const subtree = [from, ...[...this.nodes.values()].map((w) => w.node).filter((n) => n.status === "active" && isDescendant(n.path, from.path))];
    const live = [...this.hints.values()].filter((h) => (h.status === "active" || h.status === "pending") && !alreadyApplied(h, this.ctx.eventId));
    const moves = subtree.map((node) => ({ node, hints: live.filter((h) => h.nodePath === node.path) }));
    // Nothing is emitted while an approved hint would fold into a holder — a
    // row already on the target, or one arriving from the subtree ahead of it.
    const claimed = new Map<string, HintRecord>();
    for (const hint of moves.flatMap((m) => m.hints)) {
      if (hint.status !== "active") continue;
      const key = slotKey({ ...hint, nodePath: into.path });
      const holder = this.activeByKey.get(key) ?? claimed.get(key);
      if (holder === undefined || holder.id === hint.id) claimed.set(key, hint);
      else if (hint.approval === "approved") return this.approvedConflict(hint, holder, "merge_nodes");
    }
    for (const { node, hints } of moves) {
      let delta = 0;
      for (const hint of hints) delta += this.relocate(hint, into, { via: "merge_nodes" });
      this.touch(node.path, delta);
      this.ops.push({ op: "patchNode", nodeId: node.id, patch: { status: "merged", mergedInto: into.path } });
      this.nodes.set(node.path, { ...this.nodes.get(node.path), node: { ...node, status: "merged", mergedInto: into.path } });
      this.nodeCount -= 1;
      this.audit("node.merged", { nodePath: node.path, detail: { into: into.path } });
    }
    return OK;
  }

  private aliasSlot(op: AliasSlotOp, _index: number): Outcome {
    void _index;
    const from = canonicalSlot(op.from, this.snapshot.slotAliases);
    const to = canonicalSlot(op.to, this.snapshot.slotAliases);
    if (from === to) return { ok: true, rewrite: { to: "noop", reason: "already-applied", target: to } };
    const movers = [...this.hints.values()].filter((h) => h.slot === from && (h.status === "active" || h.status === "pending") && !alreadyApplied(h, this.ctx.eventId));
    const collides = (hint: HintRecord): HintRecord | undefined => (hint.status === "active" ? this.holderAt(hint, hint.nodePath, to) : undefined);
    for (const hint of movers) {
      const holder = collides(hint);
      if (holder !== undefined && hint.approval === "approved") return this.approvedConflict(hint, holder, "alias_slot");
    }
    // The alias is written for the name proposed and, when that was itself an
    // alias, for the canonical name the hints carried: every name resolves to `to`.
    this.ops.push({ op: "setSlotAlias", from: op.from, to });
    if (from !== op.from) this.ops.push({ op: "setSlotAlias", from, to });
    for (const hint of movers) {
      const holder = collides(hint);
      if (holder !== undefined) {
        this.patch(hint, { status: "retired", retiredReason: "merged", provenance: this.provenancePatch() });
        this.touch(hint.nodePath, -1);
        this.audit("hint.retired", { hintId: hint.id, nodePath: hint.nodePath, detail: { reason: "merged", into: holder.id, via: "alias_slot" } });
        continue;
      }
      this.patch(hint, { slot: to, provenance: this.provenancePatch() });
      this.touch(hint.nodePath, 0);
    }
    this.audit("slot.aliased", { detail: { from: op.from, to, ...(from !== op.from ? { canonicalFrom: from } : {}) } });
    return OK;
  }

  // ── Hint counts (§5.6) ──

  /** `stats.activeHints` for every touched node, recounted from the snapshot plus this proposal's delta; created rows are finalised in place. */
  private finaliseStats(): string[] {
    const cap = this.ctx.policy.caps.maxActiveHintsPerNode;
    const over: string[] = [];
    const counts = new Map<string, number>();
    for (const record of this.snapshot.records) {
      if (record.status === "active") counts.set(record.nodePath, (counts.get(record.nodePath) ?? 0) + 1);
    }
    for (const path of this.touched) {
      const work = this.nodes.get(path);
      if (work === undefined) continue;
      const activeHints = Math.max(0, (counts.get(path) ?? 0) + (this.delta.get(path) ?? 0));
      if (activeHints > cap) over.push(path);
      if (work.created !== undefined) {
        work.created.stats = { activeHints, lastIngestAt: this.ctx.at };
        continue;
      }
      const { node } = work;
      if (node.status !== "active" || (node.stats.activeHints === activeHints && node.stats.lastIngestAt === this.ctx.at)) continue;
      this.ops.push({ op: "patchNode", nodeId: node.id, patch: { stats: { activeHints, lastIngestAt: this.ctx.at } } });
    }
    return over;
  }
}

/**
 * Spec §5.6: gates in order, each op on its own, the well-organised
 * rewrites, and `StoreOp`s with deterministic ids. `snapshot` is the graph
 * the proposal was made against (plus, implicitly, whatever the same
 * proposal creates earlier in its op list). Pure: the same inputs give the
 * same ops, which is what makes a replayed event converge.
 */
export function validateProposal(proposal: Proposal, snapshot: SubjectSnapshot, ctx: OrganiserContext): OrganiserResult {
  return new Organiser(snapshot, ctx).run(proposal);
}
