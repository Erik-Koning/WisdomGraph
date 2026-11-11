/**
 * event.ts — the admission gate for what a consumer hands to `ingest()`.
 *
 * An event is the only way user text enters the library, and its `id` is the
 * idempotency key every store keys on, so the id has a strict character set
 * (safe in a URL, a log line and a Postgres key) while the text fields are
 * merely required to be strings: admission caps them afterwards (spec §5.1),
 * and rejecting a long turn would lose the very feedback the library exists
 * to capture. Unknown keys are dropped, not rejected, because the consumer's
 * event type is allowed to be a superset of ours.
 *
 * `ConsolidateEvent` is validated here too: it travels through the same
 * ledger as the consumer's events, and a store loading a serialised ledger
 * needs one validator for every body it can hold.
 */

import type { ConsolidateEvent, StoredEventBody } from "../ports";
import type { FeedbackEvent, IngestEvent, TurnEvent } from "../types";
import { pathValidator } from "./node";
import { arr, isoDate, nullable, obj, oneOf, opt, str, union, type Validator } from "./validate";

export const EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const SURFACES = ["standalone", "client_sheet", "dashboard", "portfolio"] as const;
export const FEEDBACK_SIGNALS = ["up", "down", "comment", "correction"] as const;
/** `"response"`, `"agent:<name>"` or `"tool:<name>"`, names non-empty. */
export const FEEDBACK_TARGET_PATTERN = /^(?:response|agent:\S+|tool:\S+)$/;

export const eventIdValidator: Validator<string> = str({ pattern: EVENT_ID_PATTERN });

const runId = str({ min: 1, max: 128 });
const subjectId = str({ min: 1, max: 256 });
const clientId = opt(nullable(str({ min: 1, max: 256 })));

export const validateTurnEvent: Validator<TurnEvent> = obj<TurnEvent>({
  type: oneOf(["turn"]),
  id: eventIdValidator,
  runId,
  subjectId,
  clientId,
  threadId: opt(nullable(str({ max: 256 }))),
  category: opt(str({ max: 128 })),
  agentsUsed: opt(arr(str({ min: 1, max: 128 }))),
  toolsUsed: opt(arr(str({ min: 1, max: 128 }))),
  dataSources: opt(arr(str({ min: 1, max: 256 }))),
  userText: str(),
  assistantText: str(),
  model: opt(str({ max: 128 })),
  appliedHintIds: opt(arr(str({ min: 1, max: 128 }))),
  surface: opt(oneOf(SURFACES)),
  at: opt(isoDate()),
});

export const validateFeedbackEvent: Validator<FeedbackEvent> = obj<FeedbackEvent>({
  type: oneOf(["feedback"]),
  id: eventIdValidator,
  runId,
  subjectId,
  clientId,
  signal: oneOf(FEEDBACK_SIGNALS),
  text: opt(str()),
  // The pattern keeps the template-literal type honest at runtime; the
  // validator's declared type is what the `obj` field map requires.
  target: opt(str({ pattern: FEEDBACK_TARGET_PATTERN }) as Validator<FeedbackEvent["target"] & string>),
  at: opt(isoDate()),
});

/** `validators.event`. */
export const validateIngestEvent: Validator<IngestEvent> = union<IngestEvent>("type", {
  turn: validateTurnEvent,
  feedback: validateFeedbackEvent,
});

export const validateConsolidateEvent: Validator<ConsolidateEvent> = obj<ConsolidateEvent>({
  type: oneOf(["consolidate"]),
  id: eventIdValidator,
  subjectId,
  nodePath: pathValidator(),
  at: opt(isoDate()),
});

/** Every body a ledger row can hold. */
export const validateStoredEventBody: Validator<StoredEventBody> = union<StoredEventBody>("type", {
  turn: validateTurnEvent,
  feedback: validateFeedbackEvent,
  consolidate: validateConsolidateEvent,
});
