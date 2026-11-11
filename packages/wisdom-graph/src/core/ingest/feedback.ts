/**
 * ingest/feedback.ts — what a thumb does to the hints it was aimed at.
 *
 * Spec §5.4 and §6.1. Feedback is the one write-path signal that needs no
 * model: `up` and `down` are arithmetic on the hints the turn actually
 * applied, and the turn row's `appliedHintIds` is the aim (decision 15).
 * That is also why it is a pure function of `(event, turn, snapshot,
 * policy)`: the same inputs produce the same `StoreOp`s and the same audit
 * ids, so a replayed feedback event converges (§5.2) and a test can assert
 * the ops without a store.
 *
 * `down` applies both §6.1 thresholds, because this is the only place in
 * the real-time path where a contradiction is counted: confidence below
 * `retireConfidenceBelow` retires an inferred hint and sends an explicit
 * one to review as `pending`; `contradictionsToRetire` retires an inferred
 * hint and flags an explicit one while it stays active. Explicit hints are
 * never retired by feedback alone — a human said it, a human decides.
 *
 * `targetedHints` is exported on its own because the extraction path
 * (§5.5) lists the same hints in its prompt: one definition of "the hints
 * this feedback is about".
 *
 * Replay is the one input the arithmetic must be immune to. A crash between
 * `applyBatch` and `updateEvent(done)` runs the same event again against
 * rows that already carry its patch (§5.2), and a counter is not an upsert:
 * `+0.05` twice is not `+0.05`. The patch appends the event id to the hint's
 * provenance, so the hint itself records which events have already moved
 * it, and a target that carries this event's id is left alone.
 */

import { deterministicId } from "../ids";
import type { PolicyConfig } from "../policy";
import type { HintPatch, StoreOp, SubjectRef } from "../ports";
import type { FeedbackEvent, HintRecord, JsonValue, TurnEvent } from "../types";
import type { SubjectSnapshot } from "../graph/snapshot";

/** The actor every feedback-driven audit row names (§10.4). */
export const FEEDBACK_ACTOR = "system:feedback";

/** What an audit row written while processing an event carries; the id derives from `(event, seq)`. */
export interface EventAuditFields {
  eventId: string;
  /** Distinguishes this row from the event's other rows; any stable label. */
  seq: string | number;
  at: string;
  actor: string;
  action: string;
  hintId?: string;
  nodePath?: string;
  detail?: Record<string, JsonValue>;
}

/**
 * An `audit` op whose id is a function of the event and a sequence label,
 * so a replayed event writes the same rows (spec §5.2, decision 12; the
 * Postgres insert is `ON CONFLICT DO NOTHING` for exactly this reason).
 */
export function eventAudit(ref: SubjectRef, f: EventAuditFields): StoreOp {
  return {
    op: "audit",
    entry: {
      id: deterministicId("a", ref.tenantId, ref.subjectId, f.eventId, f.seq),
      tenantId: ref.tenantId,
      subjectId: ref.subjectId,
      at: f.at,
      actor: f.actor,
      action: f.action,
      ...(f.hintId !== undefined ? { hintId: f.hintId } : {}),
      ...(f.nodePath !== undefined ? { nodePath: f.nodePath } : {}),
      eventId: f.eventId,
      detail: f.detail ?? {},
    },
  };
}

/** The active records of `turn.appliedHintIds`, in the turn's order, each once. */
export function appliedHints(turn: TurnEvent | null, snapshot: SubjectSnapshot): HintRecord[] {
  const out: HintRecord[] = [];
  const seen = new Set<string>();
  for (const id of turn?.appliedHintIds ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = snapshot.recordsById.get(id);
    if (record !== undefined && record.status === "active") out.push(record);
  }
  return out;
}

/**
 * Spec §5.4 step 2. `agent:x` selects the hints x's preamble carried: those
 * scoped to x, plus the `agent`-lane hints every agent's bucket shares.
 * `response` selects the lanes the final answer rendered. `tool:*` selects
 * nothing — hints never carry tool arguments, so a bad tool call is not a
 * hint's doing. No target means every applied hint.
 */
export function targetedHints(event: Pick<FeedbackEvent, "target">, turn: TurnEvent | null, snapshot: SubjectSnapshot): HintRecord[] {
  const applied = appliedHints(turn, snapshot);
  const target = event.target;
  if (target === undefined) return applied;
  if (target === "response") return applied.filter((h) => h.lane === "responseStyle" || h.lane === "preRoute");
  if (target.startsWith("agent:")) {
    const agent = target.slice("agent:".length);
    return applied.filter((h) => h.agent === agent || (h.lane === "agent" && h.scope !== "agent"));
  }
  return [];
}

/** Confidence stays a clean number in the row and the audit detail: 0.9 + 0.05 is 0.95, not 0.9500000000000001. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, Math.round(x * 1_000_000) / 1_000_000));
}

/** Whether `event` has already moved this hint: the patch below appends the id, so a replay finds it there. */
export function alreadyApplied(hint: HintRecord, eventId: string): boolean {
  return hint.provenance.eventIds.includes(eventId);
}

/**
 * Spec §5.4 steps 3–4 and §6.1 items 3–4 as `StoreOp`s: the patches and
 * the audit rows that explain them, nothing else. `comment` and
 * `correction` produce no ops here — they are extraction's business
 * (§5.4 step 5) — and an unanchored event targets nothing. A target the
 * event has already moved (a replay) gets no patch and no audit row: both
 * are already in the store.
 */
export function applyFeedback(event: FeedbackEvent, turn: TurnEvent | null, snapshot: SubjectSnapshot, policy: PolicyConfig): StoreOp[] {
  const ref = snapshot.ref;
  const at = event.at ?? new Date(snapshot.compiledAt).toISOString();
  const targets = targetedHints(event, turn, snapshot).filter((hint) => !alreadyApplied(hint, event.id));
  const ops: StoreOp[] = [];
  let seq = 0;
  const audit = (fields: Omit<EventAuditFields, "eventId" | "seq" | "at" | "actor">): void => {
    ops.push(eventAudit(ref, { eventId: event.id, seq: seq++, at, actor: FEEDBACK_ACTOR, ...fields }));
  };
  const provenance: HintPatch["provenance"] = { appendEventId: event.id, appendRunId: event.runId };

  if (event.signal === "up") {
    for (const hint of targets) {
      const confidence = clamp01(hint.confidence + policy.feedback.upConfidenceDelta);
      ops.push({ op: "patchHint", hintId: hint.id, patch: { confidence, reinforcements: { add: 1 }, lastReinforcedAt: at, provenance } });
      audit({ action: "hint.reinforced", hintId: hint.id, nodePath: hint.nodePath, detail: { signal: "up", from: hint.confidence, to: confidence } });
    }
    return ops;
  }

  if (event.signal === "down") {
    for (const hint of targets) {
      const confidence = clamp01(hint.confidence * policy.feedback.downFactor[hint.source]);
      const contradictions = hint.contradictions + 1;
      const patch: HintPatch = { confidence, contradictions: { add: 1 }, provenance };
      audit({
        action: "hint.contradicted",
        hintId: hint.id,
        nodePath: hint.nodePath,
        detail: { signal: "down", from: hint.confidence, to: confidence, contradictions },
      });
      const lowConfidence = confidence < policy.feedback.retireConfidenceBelow;
      const contradicted = contradictions >= policy.decay.contradictionsToRetire;
      if (hint.source === "inferred") {
        if (lowConfidence || contradicted) {
          patch.status = "retired";
          patch.retiredReason = lowConfidence ? "feedback" : "contradicted";
          audit({ action: "hint.retired", hintId: hint.id, nodePath: hint.nodePath, detail: { reason: patch.retiredReason } });
        }
      } else if (lowConfidence || contradicted) {
        patch.needsReview = true;
        if (lowConfidence) patch.status = "pending";
        // Spec §6.1 writes the action as `needs-review`; §7.1's audit vocabulary is
        // `<entity>.<verb>` (`hint.reinforced`, `hint.retired`, `event.failed`), and
        // this row is about a hint, so it takes the qualified form deliberately.
        audit({
          action: "hint.needs-review",
          hintId: hint.id,
          nodePath: hint.nodePath,
          detail: { reason: lowConfidence ? "confidence" : "contradictions", status: patch.status ?? hint.status },
        });
      }
      ops.push({ op: "patchHint", hintId: hint.id, patch });
    }
  }
  return ops;
}
