/*
 * tokens.ts — the token estimate every cap is measured in.
 *
 * The library never sees the consumer's model tokenizer, and running one on
 * the recall hot path would cost more than the hints it budgets. `chars / 4`
 * is the usual English approximation and errs slightly high, so a charter
 * that fits under the estimate fits under the real count too. Consumers with
 * a real tokenizer pass it as `tokenizer` (spec §2.7); everything that counts
 * tokens takes a `Tokenizer` so the swap is one option, not a fork.
 */

/** Anything that turns text into a token count. */
export type Tokenizer = (text: string) => number;

/** `ceil(chars / 4)`; 0 for the empty string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
