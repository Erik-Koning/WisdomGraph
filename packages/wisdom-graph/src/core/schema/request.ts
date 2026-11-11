/**
 * request.ts — the gate on `recall()`'s input.
 *
 * Recall must never reject, so an invalid request is not an exception but an
 * `emptyRecall(req, "invalid-request")`; this validator is what decides. It
 * is lenient on purpose: unknown keys are dropped (the consumer's contract
 * type may grow ahead of ours), `text` is any string (it is truncated later),
 * and `signal` is checked structurally — anything with a boolean `aborted` —
 * because an `AbortSignal` from another realm or a polyfill is still usable
 * and a validator must not depend on a runtime class.
 */

import type { NeutralMessage, RecallRequest } from "../types";
import { SURFACES } from "./event";
import { arr, bool, fail, num, obj, ok, oneOf, opt, nullable, raw, str, type Validator } from "./validate";

export const MESSAGE_ROLES = ["user", "assistant", "tool", "system"] as const;

export const validateNeutralMessage: Validator<NeutralMessage> = obj<NeutralMessage>({
  role: oneOf(MESSAGE_ROLES),
  content: str(),
  name: opt(str({ max: 256 })),
  toolCalls: opt(arr(obj<{ name: string; args: unknown }>({ name: str({ max: 256 }), args: raw() }))),
});

/** Structural: any object with a boolean `aborted` is treated as an AbortSignal. */
export const abortSignalValidator: Validator<AbortSignal> = (u, path = "") => {
  if (u !== null && typeof u === "object" && typeof (u as { aborted?: unknown }).aborted === "boolean") {
    return ok(u as AbortSignal);
  }
  return fail(path, "expected an AbortSignal");
};

/** `validators.recallRequest`. */
export const validateRecallRequest: Validator<RecallRequest> = obj<RecallRequest>({
  subjectId: str({ min: 1, max: 256 }),
  clientId: opt(nullable(str({ min: 1, max: 256 }))),
  text: str(),
  recentTurns: opt(arr(validateNeutralMessage)),
  surface: opt(oneOf(SURFACES)),
  budgetMs: num({ min: 0 }),
  signal: opt(abortSignalValidator),
  approvedOnly: opt(bool()),
  refine: opt(bool()),
  requestId: opt(str({ min: 1, max: 128 })),
});
