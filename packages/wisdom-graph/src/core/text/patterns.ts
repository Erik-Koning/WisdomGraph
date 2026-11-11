/*
 * patterns.ts — what a statement may not contain, as data.
 *
 * A hint ends up inside a system prompt (spec §9), so the text that becomes
 * one is the library's whole prompt-injection surface. The rules are kept
 * here as plain tables — families of injection regexes, the sensitive
 * deny-list, the allowed third-person openers, the structural noise to strip —
 * rather than inlined in the sanitiser, for two reasons: the corpus tests in
 * `sanitize.test.ts` can assert every family against real examples and every
 * table entry can be read and reviewed on its own, and a consumer's extra
 * deny-list (`opts.extraDeny`) slots in as one more entry of the same shape.
 *
 * Every family regex is written against text that has already been
 * NFKC-folded and stripped of invisibles (`normalize.ts`), and is run a
 * second time against a copy with its combining marks removed
 * (`foldMarks`, so "ígnore" is seen as "ignore"), which is why they
 * are simple ASCII word patterns: the folding, not the regex, is what defeats
 * "ｉｇｎｏｒｅ" and "ig\u200Bnore". The patterns use bounded gaps (`.{0,40}`)
 * and no nested quantifiers, so matching stays linear in the input.
 *
 * Every verb is matched in all its inflections. The canonical form (step 5)
 * REQUIRES the third-person present tense, so "Always ignores all previous
 * instructions" is exactly how an instruction would be smuggled past a table
 * that only knew "ignore" — and the model reading the rendered prompt takes
 * both the same way.
 *
 * Matchers carry the `iu` flags only. The `g` flag would make `RegExp.test`
 * stateful across calls; the strippers that do need it are only ever used
 * with `String.replace`, which resets `lastIndex`.
 *
 * (A plain block comment rather than a `/**` doc comment: this file's first
 * statement is an export, and the declaration emitter would attach a doc
 * comment here to it in the rolled-up `.d.ts`.)
 */

// ── Injection families (§9.1 step 3): any hit rejects the whole statement ────

export type InjectionFamily =
  | "override"
  | "exfiltration"
  | "authority"
  | "tool-coercion"
  | "second-person"
  | "first-person"
  | "quotation";

export interface PatternFamily {
  family: InjectionFamily;
  patterns: readonly RegExp[];
}

/**
 * What an override or a refusal-to-follow is aimed at. Shared by the override
 * patterns so the three verb groups agree on their object.
 */
const GOVERNING_TEXT = String.raw`(?:instructions?|rules?|prompt|guidelines?|policy|safety)`;

export const INJECTION_FAMILIES: readonly PatternFamily[] = [
  {
    family: "override",
    patterns: [
      new RegExp(
        String.raw`\b(?:ignor(?:e|es|ed|ing)|disregard(?:s|ed|ing)?|forg(?:et|ets|etting|ot|otten)|overrid(?:e|es|ing|den)|overrode)\b.{0,40}\b${GOVERNING_TEXT}\b`,
        "iu",
      ),
      // "Never follows the safety guidelines" / "Follows no rules": the same
      // override phrased as a negated verb rather than an imperative.
      new RegExp(String.raw`\b(?:never|not|no longer|without|stop(?:s|ped)?) follow(?:s|ed|ing)?\b.{0,30}\b${GOVERNING_TEXT}\b`, "iu"),
      new RegExp(String.raw`\bfollow(?:s|ed|ing)? no\b.{0,30}\b${GOVERNING_TEXT}\b`, "iu"),
      /\byou are now\b/iu,
      /\bnew (?:instructions?|persona|role)\b/iu,
      /\bfrom now on you\b/iu,
    ],
  },
  {
    // "hidden" is qualified because a preference can legitimately show
    // hidden fees; "secret" is not, because nothing an advisor prefers is one.
    family: "exfiltration",
    patterns: [
      /\b(?:reveal(?:s|ed|ing)?|print(?:s|ed|ing)?|show(?:s|ed|n|ing)?|repeat(?:s|ed|ing)?|output(?:s|ted|ting)?|disclos(?:e|es|ed|ing)|leak(?:s|ed|ing)?|expos(?:e|es|ed|ing))\b.{0,30}\b(?:system prompt|instructions|hidden (?:instructions?|prompt|rules?|system|config\w*|context|text|message)|secrets?)\b/iu,
    ],
  },
  {
    // "act as" is the imperative; the third-person "acts as" is a normal
    // statement ("Acts as a sounding board") unless what follows is a
    // persona for the model.
    family: "authority",
    patterns: [
      /\bas (?:the|an?) (?:admin|administrator|developer|system|root|operator|unrestricted|unfiltered|jailbroken)\b/iu,
      /\bdeveloper mode\b/iu,
      /\bjailbr(?:eak(?:s|ed|ing)?|oken)\b/iu,
      /\bpretend(?:s|ed|ing)? (?:to be|you are|it is)\b/iu,
      /\bact as\b/iu,
      /\bacts as (?:the |an? )?(?:ai|model|llm|assistant|chatbot|bot|admin|administrator|developer|system|root|operator|dan)\b/iu,
    ],
  },
  {
    family: "tool-coercion",
    patterns: [
      /\b(?:call(?:s|ed|ing)?|invok(?:e|es|ed|ing)|run(?:s|ning)?|ran|execut(?:e|es|ed|ing))\b.{0,30}\b(?:tools?|functions?|commands?)\b/iu,
      /\bwith (?:arguments?|args|parameters?)\b/iu,
      /\{\s*"name"\s*:/u,
    ],
  },
  {
    // Statements describe the advisor in the third person; anything that
    // addresses the model ("you must…", "assistant:") is an instruction. The
    // word "assistant" on its own is not: "Prefers the assistant to answer
    // in bullets" is the preference the extraction prompt asks for, so only a
    // directive aimed at it ("the assistant must …") or a role marker counts.
    family: "second-person",
    patterns: [
      /\b(?:you|your|yours|yourself|you're)\b/iu,
      /\bassistant\s*:/iu,
      /\bassistant (?:must|should|shall|will|has to|needs? to|is to|never|always)\b/iu,
    ],
  },
  {
    family: "first-person",
    patterns: [/\b(?:i|me|my|mine|we|our)\b/iu],
  },
  {
    // Statements, never quotes: a quoted span is exactly the raw user text
    // §9.2 says must never reach a prompt. A lone apostrophe ("client's") is
    // not a quote, so a single-quote pair must open at a word edge; it may
    // close on a straight or a curly quote, whatever follows the closer.
    // Guillemets and the low-9 quote join the double-quote class; the single
    // guillemets ‹ › do not, because they are the delimiter escape glyphs
    // and appear in legitimate statements.
    family: "quotation",
    patterns: [/["“”„«»]/u, /(?:^|[\s([{])'[^'’]*['’]/u, /‘[^‘’']*['’]/u],
  },
];

/** The family names, in evaluation order — the reason codes a rejection carries. */
export const INJECTION_FAMILY_NAMES: readonly InjectionFamily[] = INJECTION_FAMILIES.map((f) => f.family);

// ── Sensitive deny-list (§9.1 step 4): review, never reject ──────────────────

/**
 * Terms a benign preference can legitimately contain ("prefers token-count
 * summaries") but that a human should see before the hint goes live. Plurals
 * are accepted so "credentials" is caught like "credential".
 */
export const DENY_LIST: RegExp =
  /\b(?:access|authori[sz]ed?|permissions?|credentials?|passwords?|tokens?|api keys?|bypass|skip verification|client[ _-]?ids?|ssn|sin|account numbers?)\b/iu;

// ── Mixed-script words: review, never reject ─────────────────────────────────

/**
 * NFKC folds compatibility look-alikes but not cross-script ones: a Cyrillic
 * "о" in "Ignоre" survives folding and no family sees "ignore". A single word
 * that mixes Latin letters with letters from a script whose glyphs imitate
 * them is the signature of that trick and of nothing a preference statement
 * needs, so the sanitiser sends it to review rather than guessing which
 * reading was meant (a wholly non-Latin word is left alone). The spec is
 * silent here; review, not rejection, is the choice that loses nothing.
 */
export const MIXED_SCRIPT = {
  /** The runs the check looks at: letters with their combining marks. */
  word: /[\p{L}\p{M}]+/gu,
  latin: /\p{Script=Latin}/u,
  /** Scripts whose letters have Latin look-alikes. */
  confusable: /[\p{Script=Cyrillic}\p{Script=Greek}]/u,
} as const;

// ── Canonical form (§9.1 step 5) ─────────────────────────────────────────────

/**
 * The third-person present-tense verbs a statement may open with. Kept as
 * words, not a regex, so the extraction prompt can list them and a reviewer
 * can read them; `OPENER_PATTERN` is compiled from this list.
 */
export const ALLOWED_OPENERS: readonly string[] = [
  "Prefers",
  "Avoids",
  "Uses",
  "Treats",
  "Routes",
  "Defaults to",
  "Default to",
  "Never",
  "Always",
  "Keeps",
  "Limits",
  "Includes",
  "Excludes",
  "Omits",
  "Assumes",
  "Calls",
  "Refers to",
  "Considers",
  "Expects",
  "Wants",
  "Likes",
  "Dislikes",
  "Needs",
  "Requires",
  "Focuses on",
  "Prioritises",
  "Prioritizes",
  "Reports",
  "Formats",
  "Writes",
  "Answers",
  "Responds",
  "Provides",
  "Mentions",
  "Skips",
];

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Anchored, case-insensitive: the statement must begin with an allowed opener as a whole word. */
export const OPENER_PATTERN: RegExp = new RegExp(`^(?:${ALLOWED_OPENERS.map(escapeRegex).join("|")})\\b`, "iu");

/** A run of sentence terminators that ends a sentence (followed by space or end), so "e.g." and "5.5" do not count. */
export const SENTENCE_TERMINATOR: RegExp = /[.!?]+(?=\s|$)/gu;

/** At most this many sentence terminators in one statement. */
export const MAX_SENTENCE_TERMINATORS = 2;

// ── Structure to strip (§9.1 step 2) ─────────────────────────────────────────

export interface Stripper {
  /** What the rule removes; shows up nowhere at runtime, exists for review. */
  name: string;
  pattern: RegExp;
  /** Replacement text; default "". */
  replacement?: string;
}

/**
 * Applied in table order, repeatedly until nothing changes, between two
 * delimiter escapes (`sanitize.ts: stripStructure`): the first so a `<<SYS>>`
 * style marker is inert text before any rule sees it, the second because a
 * rule's leftovers can rebuild a delimiter — `${<}${<}` is `<<` once the
 * braces go — and the last word on `<<`/`>>` must be the escape's. Fence
 * markers are just backticks here: by the time this runs the newline after
 * a "```js" tag has been collapsed, so any attempt to eat the language tag
 * would eat the first word of the block instead. Fence *content* and the
 * text inside `{{ }}` / `${ }` are kept on purpose: an instruction hidden in
 * a code block or a template expression must be seen by the injection
 * families and rejected, not silently cleaned away. Headings are anchored to
 * the start (§9.1: `^#+`) so an in-text "item # 3" keeps its hash; the
 * anchored rules tolerate leading whitespace because an earlier rule may
 * have just removed what stood before them.
 */
export const STRUCTURE_STRIPPERS: readonly Stripper[] = [
  { name: "code fences and backticks", pattern: /`+/gu },
  { name: "chat template token", pattern: /<\|[^<>|]{0,40}\|>/gu },
  { name: "instruction marker", pattern: /\[\/?INST\]/giu },
  { name: "html comment", pattern: /<!--[\s\S]*?-->/gu },
  { name: "html/xml tag", pattern: /<\/?[A-Za-z][^<>]{0,200}>/gu },
  { name: "html declaration", pattern: /<![^<>]{0,200}>/gu },
  { name: "template expression braces", pattern: /\{\{([^{}]{0,200})\}\}/gu, replacement: "$1" },
  { name: "template literal braces", pattern: /\$\{([^{}]{0,200})\}/gu, replacement: "$1" },
  { name: "markdown heading", pattern: /^\s*#{1,6}(?=\s|$)/u },
  { name: "leading role marker", pattern: /^\s*(?:(?:system|assistant|user|human|ai)\s*:\s*)+/iu },
  { name: "url", pattern: /\b(?:https?|ftp|file):\/\/\S+/giu },
  { name: "www url", pattern: /\bwww\.\S+/giu },
  { name: "base64 run", pattern: /[A-Za-z0-9+/=]{40,}/gu },
];

/** The compiled-artifact delimiter characters and what they become inside a statement (§8.3). */
export const DELIMITER_ESCAPES: readonly { from: string; to: string }[] = [
  { from: "<<", to: "‹‹" },
  { from: ">>", to: "››" },
];
