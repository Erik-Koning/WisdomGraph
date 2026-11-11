/**
 * The gate tables of spec §5.3: every user-side and assistant-side
 * alternative hits, ordinary text does not, folding makes look-alikes hit,
 * sampling is a scripted die consulted only for un-gated turns, and the
 * override wins outright. The query-embedded corpus pins the brief's
 * promise that a preference stated inside a question is captured, and the
 * plain-question table pins the precision that keeps the gate cheap.
 */
import { describe, expect, it, vi } from "vitest";
import { mergePolicy, defaultPolicy } from "../policy";
import { ASSISTANT_TRIGGER, USER_TRIGGER, foldForTriage, shouldExtract } from "./triage";

const turn = (userText: string, assistantText = "Here is the breakdown."): { userText: string; assistantText: string } => ({ userText, assistantText });

describe("USER_TRIGGER (§5.3 user-side regex)", () => {
  const hits = [
    "Always show the as-of date.",
    "Never mention fees in the summary.",
    "I prefer bullet points.",
    "Preferred format is a table.",
    "Stop adding disclaimers.",
    "Don't include the preamble.",
    "Don’t include the preamble.",
    "Do not quote intraday prices.",
    "From now on answer in French.",
    "In future keep it shorter.",
    "Going forward, use CAD.",
    "Use ETFs instead of mutual funds.",
    "Call me Erik.",
    "My top client is the Smith household.",
    "my main concern is fees",
    "MY BIGGEST account is a TFSA",
    "That was too long.",
    "Too short, expand it.",
    "This is too verbose.",
    "Shorter please.",
    "Briefer next time.",
    "Give me more detail on the MER.",
    "Remember that I only cover Ontario.",
    "Remember this: no jargon.",
    "Note that I use quarterly windows.",
    "Actually, I meant the RRIF.",
    "That's not what I asked.",
    "I want a table.",
    "I need the ticker.",
    "I like short headlines.",
    "I hate exclamation marks.",
    "I dislike bullet lists.",
  ];
  it.each(hits)("matches %j", (text) => {
    expect(USER_TRIGGER.test(foldForTriage(text))).toBe(true);
    expect(shouldExtract(turn(text), defaultPolicy)).toEqual({ extract: true, reason: "user-text" });
  });

  const misses = [
    "How should we sequence RRIF withdrawals for a retiree?",
    "What is the MER on this fund?",
    "Summarise today's TSX headlines.",
    "Draft an agenda for the Smith meeting.",
    "Which accounts does the household hold?",
    "Explain the difference between an RRSP and a TFSA.",
    "The stoplight is red.",
    "Alwaysland is a fictional place.",
    "",
  ];
  it.each(misses)("does not match %j", (text) => {
    expect(USER_TRIGGER.test(foldForTriage(text))).toBe(false);
    expect(shouldExtract(turn(text), defaultPolicy)).toEqual({ extract: false, reason: "none" });
  });

  /**
   * The brief's promise (requirements.md: "whenever the user's query has any
   * feedback or preferences laid out in it"): a preference stated inside an
   * ordinary question, in the imperative and format-shaped phrasing people
   * actually use, reaches the extractor. Every line here produced zero LLM
   * calls under the spec §5.3 regex alone.
   */
  const queryEmbedded = [
    "What's the outlook for Canadian banks? Keep it brief please.",
    "Give me the TSX summary in bullet points only.",
    "Can you skip the disclaimers and just tell me the RRIF minimum for age 72?",
    "Short answer: is the Fed cutting in March?",
    "Please avoid jargon — explain what an MER is.",
    "Use CAD for all figures. What did the Smith portfolio return last quarter?",
    "No preamble. Which GIC has the best 3-year rate?",
    "Preferably in a table: compare RRSP and TFSA contribution room.",
    "Make it concise: what changed in the CPP enhancement this year?",
    "Can you answer in French? Quel est le plafond CELI?",
    "Keep it to three action items for the Smith meeting.",
    "Just the headline numbers, no commentary: how did the TSX close?",
    "Bullet points please: what are the RESP withdrawal rules?",
    "Without the caveats, is a spousal RRSP worth it here?",
    "One paragraph max — why did bond yields rise this week?",
    "I prefer bullet points. What's the RRSP limit?",
    "Don't add disclaimers. What's the OAS clawback threshold?",
    "Explain the FHSA in plain English.",
    "Step by step, how do I open a RRIF for this client?",
    "In two sentences, what is a covered call?",
    "I'd rather see the figures in basis points. What's the MER spread?",
    "Be direct: should the Smiths defer CPP?",
    "TL;DR on the budget's capital gains change?",
    "As a list, what documents does the KYC refresh need?",
    "Next time, include the as-of date. What's the CAD/USD rate?",
    "By default, quote fees after tax. What does this fund cost?",
  ];
  it.each(queryEmbedded)("a preference laid out inside a query reaches the extractor: %j", (text) => {
    expect(shouldExtract(turn(text), defaultPolicy)).toEqual({ extract: true, reason: "user-text" });
  });

  it("captures the whole query-embedded corpus, not a lucky subset", () => {
    const hitCount = queryEmbedded.filter((text) => USER_TRIGGER.test(foldForTriage(text))).length;
    expect(hitCount).toBe(queryEmbedded.length);
  });

  /** Plain questions that share a word with the vocabulary above but lay out no preference: the cost side of the gate. */
  const plainQuestions = [
    "What's the max RRSP contribution for 2026?",
    "Is a short-term bond ladder appropriate here?",
    "Show me the rate table for 5-year GICs.",
    "What does the term 'bullet bond' mean?",
    "Which funds only hold Canadian equities?",
    "Should I keep this account open after the transfer?",
    "How much tax is withheld each time I withdraw from an RRIF?",
    "Is 5% too much to allocate to gold?",
    "The client is interested in French bonds.",
    "What was the TSX return in percent last year?",
    "Can you format a cheque for a corporate account?",
  ];
  it.each(plainQuestions)("a plain question that shares a word with the vocabulary does not match: %j", (text) => {
    expect(USER_TRIGGER.test(foldForTriage(text))).toBe(false);
    expect(shouldExtract(turn(text), defaultPolicy)).toEqual({ extract: false, reason: "none" });
  });

  it("folds full-width letters and invisible characters before matching", () => {
    expect(shouldExtract(turn("ｓｔｏｐ adding disclaimers"), defaultPolicy).extract).toBe(true);
    expect(shouldExtract(turn("st​op adding disclaimers"), defaultPolicy).extract).toBe(true);
  });
});

describe("ASSISTANT_TRIGGER (§5.3 assistant-side regex)", () => {
  const hits = [
    "Apologies, I will keep it shorter.",
    "I apologise for the confusion.",
    "Sorry about that.",
    "You're right, the MER was wrong.",
    "You’re right — I misread the question.",
    "I'll avoid disclaimers from now on.",
    "I’ll stop including the preamble.",
    "I'll keep answers under 150 words.",
    "Noted.",
    "Understood, I will omit them.",
    "Going forward I will use CAD.",
  ];
  it.each(hits)("matches %j", (text) => {
    expect(ASSISTANT_TRIGGER.test(foldForTriage(text))).toBe(true);
    expect(shouldExtract(turn("Thanks.", text), defaultPolicy)).toEqual({ extract: true, reason: "assistant-text" });
  });

  const misses = [
    "The MER on this fund is 0.85%.",
    "Here is the agenda for Tuesday.",
    "The TSX closed up 0.4% today.",
    "An RRSP defers tax; a TFSA does not.",
    "I'll keep you posted on the sorry-looking Q3 numbers... no, just kidding — the numbers are fine.",
    "",
  ].filter((text) => !ASSISTANT_TRIGGER.test(text));
  it.each(misses)("does not match %j", (text) => {
    expect(shouldExtract(turn("Thanks.", text), defaultPolicy)).toEqual({ extract: false, reason: "none" });
  });

  it("the user side is consulted first, so a turn that trips both reports user-text", () => {
    expect(shouldExtract(turn("Stop it.", "Sorry."), defaultPolicy).reason).toBe("user-text");
  });
});

describe("sampling (§5.3, decision 24)", () => {
  const policy = (rate: number) => mergePolicy({ ingest: { extractionSampleRate: rate } });
  const plain = turn("What is the MER on this fund?");

  it("extracts an un-gated turn when the die lands under the rate, and not otherwise", () => {
    expect(shouldExtract(plain, policy(0.1), () => 0.05)).toEqual({ extract: true, reason: "sampled" });
    expect(shouldExtract(plain, policy(0.1), () => 0.1)).toEqual({ extract: false, reason: "none" });
    expect(shouldExtract(plain, policy(0.1), () => 0.5)).toEqual({ extract: false, reason: "none" });
    expect(shouldExtract(plain, policy(1), () => 0.999)).toEqual({ extract: true, reason: "sampled" });
  });

  it("never rolls the die at the default rate of 0, nor for a turn a regex already gated", () => {
    const die = vi.fn(() => 0);
    expect(shouldExtract(plain, defaultPolicy, die).extract).toBe(false);
    expect(die).not.toHaveBeenCalled();
    expect(shouldExtract(turn("Stop it."), policy(1), die).reason).toBe("user-text");
    expect(die).not.toHaveBeenCalled();
  });

  it("a seeded sampler makes the extraction rate reproducible over many turns", () => {
    let seed = 42;
    const lcg = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const decisions = Array.from({ length: 1_000 }, () => shouldExtract(plain, policy(0.25), lcg).extract);
    const sampled = decisions.filter(Boolean).length;
    expect(sampled).toBeGreaterThan(200);
    expect(sampled).toBeLessThan(300);
    seed = 42;
    const again = Array.from({ length: 1_000 }, () => shouldExtract(plain, policy(0.25), lcg).extract);
    expect(again).toEqual(decisions);
  });
});

describe("extract override (§5.3 step 3)", () => {
  it("`force` extracts a plain turn and `skip` suppresses a gated one, without touching the die", () => {
    const die = vi.fn(() => 0);
    expect(shouldExtract(turn("What is the MER?"), defaultPolicy, die, "force")).toEqual({ extract: true, reason: "forced" });
    expect(shouldExtract(turn("Stop it.", "Sorry."), mergePolicy({ ingest: { extractionSampleRate: 1 } }), die, "skip")).toEqual({ extract: false, reason: "skipped" });
    expect(die).not.toHaveBeenCalled();
  });

  it("`auto` is the default and behaves like no override", () => {
    expect(shouldExtract(turn("Stop it."), defaultPolicy, undefined, "auto")).toEqual(shouldExtract(turn("Stop it."), defaultPolicy));
  });
});
