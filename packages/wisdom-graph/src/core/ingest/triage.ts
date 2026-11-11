/**
 * ingest/triage.ts — whether a turn is worth a model call.
 *
 * The LLM is the only expensive thing on the write path, and most turns
 * carry no preference at all (spec §5.3: "common case: no feedback, no
 * LLM"). The gate is two regexes and a coin: the user side catches the
 * phrasing people use when they are telling the assistant how to behave;
 * the assistant side catches the phrasing an assistant uses when it has
 * just been corrected ("sorry", "you're right", "I'll avoid"), which is
 * the strongest signal of all — a correction the user made in words the
 * first regex does not know is still answered with an apology.
 * `extractionSampleRate` is the knob for turns that trip neither: a
 * deployment that wants implicit preferences pays for them in
 * expectation, not per turn (decision 24).
 *
 * The user side is two vocabularies in one regex. The first is spec §5.3's
 * list of standing-instruction words ("always", "stop", "from now on",
 * "too long"). The second is the way a preference is laid out *inside an
 * ordinary query* — "keep it brief", "in bullet points", "skip the
 * disclaimers", "answer in French", "use CAD", "one paragraph max" — which
 * the brief promises to capture ("whenever the user's query has any
 * feedback or preferences laid out in it") and which the first vocabulary
 * almost never sees: it is imperative and format-shaped rather than
 * declarative. Every alternative is anchored to a phrase that reads as an
 * instruction to the assistant, never a bare noun, so "bullet bond", "the
 * rate table" and "the max RRSP contribution" stay out of the model's way;
 * `triage.test.ts` pins both the hit corpus and the plain-question misses.
 * What neither vocabulary knows is what the sample rate is for: a
 * deployment that wants every last preference phrased in its own way sets
 * `extractionSampleRate` above zero and pays in expectation.
 *
 * Text is folded (NFKC, invisibles stripped, curly apostrophes plain)
 * before matching, so "don’t" and "ｓｔｏｐ" hit the same way "don't" and
 * "stop" do. The assistant regex is spec §5.3's; the one liberty is
 * `apolog\w*` where the spec writes `apolog` inside `\b…\b` — a stem that
 * no word boundary can follow, so the literal form would match nothing.
 *
 * The sampler is a port for the same reason the clock is: a test that
 * asserts "10 % of turns are extracted" must be able to roll the die.
 */

import type { PolicyConfig } from "../policy";
import type { TurnEvent } from "../types";
import { normalizeText } from "../text/normalize";

/** Spec §5.3's user-side alternatives: standing instructions and reactions to the last answer. `prefer\w*` covers the spec's `prefer|preferred` and the "preferably"/"preference" forms too. */
const INSTRUCTION_VOCABULARY = [
  "always",
  "never",
  "prefer\\w*",
  "stop",
  "don'?t",
  "do not",
  "from now on",
  "in future",
  "going forward",
  "instead of",
  "call me",
  "my (?:top|main|biggest)",
  "too (?:long|short|verbose|wordy|technical|detailed|vague|formal|casual|basic)",
  "shorter",
  "briefer",
  "more detail",
  "remember (?:that|this)",
  "note that",
  "actually",
  "not what i asked",
  "i (?:want|need|like|hate|dislike)",
];

/** Things a user asks to have left out of an answer; the object of "no", "skip", "avoid", "without" and friends. */
const OMISSIBLE = "(?:preamble|commentary|caveats?|disclaimers?|jargon|fluff|filler|intros?|introductions?|small talk|pleasantries|emojis?|exclamation marks|hedging|apologies|boilerplate|footnotes?)";
/** A count a length limit is stated in. */
const COUNT = "(?:one|two|three|four|five|a single|a few|a couple of|\\d+)";
/** The unit a length limit is stated in. */
const UNIT = "(?:paragraph|sentence|line|word|bullet|point|item|action item)s?";
/** Languages an answer is asked for in; matched only after a verb ("answer in French"), never bare ("French bonds"). */
const LANGUAGE =
  "(?:french|français|english|spanish|español|german|deutsch|italian|italiano|portuguese|português|mandarin|cantonese|chinese|japanese|korean|hindi|punjabi|arabic|dutch|russian|polish|tagalog|vietnamese|ukrainian|farsi|persian|urdu|bengali|tamil|greek|hebrew|turkish|swedish|norwegian|danish|finnish)";
/** Currencies and units a user asks figures in. */
const MEASURE = "(?:cad|usd|eur|gbp|aud|jpy|chf|canadian dollars|us dollars|american dollars|euros|pounds|basis points|bps|percent|percentages?|decimals?|metric|imperial|celsius|fahrenheit|kilometres|kilometers|miles)";

/**
 * How a preference is laid out inside a query: length, format, omissions,
 * language, units and tone, each as an instruction-shaped phrase.
 */
const QUERY_PREFERENCE_VOCABULARY = [
  // Length.
  "brief",
  "briefly",
  "concise",
  "concisely",
  "succinct",
  "succinctly",
  "terse",
  "wordy",
  "short answer",
  "quick answer",
  "one[- ](?:word|line|sentence) answer",
  "straight answer",
  "direct answer",
  "yes(?:\\/| or )no",
  "tl;?dr",
  "in short",
  `keep (?:it|answers|responses|replies|things) (?:brief|short|shorter|concise|simple|quick|tight|snappy|focused|minimal|plain|clean|formal|casual|high[- ]level|to the point|to|under|below|at|around)`,
  "keep (?:the|your) (?:answer|response|reply|summary|explanation)s?",
  "make (?:it|this|that|them) (?:brief|short|shorter|concise|quick|simple|snappy|tight|long|longer|detailed|clear|plain|formal|casual|friendly)",
  `(?:in|within|under|max(?:imum)?|at most|no more than|up to) ${COUNT} ${UNIT}`,
  `${COUNT}[- ]${UNIT} (?:max|maximum|tops|at most|only)`,
  "(?:less|fewer) (?:jargon|detail|words|text|fluff|caveats|disclaimers|hedging|bullets|numbers)",
  "more (?:concise|detailed|formal|casual|specific|precise|direct|concrete|examples)",
  "to the point",
  "cut to the chase",
  "bottom line",
  // Format.
  "bullets",
  "bulleted",
  "bullet (?:points?|lists?|form)",
  "point form",
  "(?:in|as) (?:a |one )?tables?",
  "in table form",
  "tabular",
  "(?:in|as) a (?:numbered |ordered )?list",
  "in list form",
  "numbered (?:list|steps)",
  "step[- ]by[- ]step",
  "(?:in|as) (?:markdown|json|csv|html|plain text|prose)",
  "format (?:it|this|that|as|in|the (?:answer|response|output))",
  "formatted as",
  "(?:output|response|answer) format",
  "(?:just|only) the (?:headlines?|numbers|figures|facts|answer|bottom line|key points|highlights|essentials|basics|gist|totals?)",
  "(?:bullets?|bullet points|numbers|figures|facts|headlines|essentials|highlights|key points) only",
  // Omissions.
  `no ${OMISSIBLE}`,
  `(?:skip|avoid|omit|drop|cut|lose|hold|without|minus|spare me|leave out|leave off) (?:the |any |all |your )?${OMISSIBLE}`,
  "no explanation needed",
  "no need (?:to|for)",
  // Language, register and units.
  `(?:answer|respond|reply|write|explain|say|speak|talk|translate|put|do)(?: it| this| that| everything| this one)? in ${LANGUAGE}`,
  "en français",
  "auf deutsch",
  "en español",
  "in (?:plain|simple) (?:english|language|terms|words)",
  "in layman'?s terms",
  "eli5",
  "like i'?m (?:five|5|a child|new|a beginner)",
  `use ${MEASURE}`,
  `(?:all |the )?(?:figures|numbers|amounts|prices|values) in ${MEASURE}`,
  "(?:be|sound|stay) (?:formal|informal|casual|friendly|professional|direct|blunt|neutral|polite|warm|plain|simple)",
  "(?:formal|informal|casual|friendly|conversational|professional) tone",
  // Standing requests phrased around a query.
  "i'?d (?:rather|prefer|like|love|appreciate)",
  "i would (?:rather|prefer|like|love|appreciate)",
  "from here on",
  "henceforth",
  "next time",
  "in the future",
  "by default",
  "as a rule",
  "standing (?:request|instruction)",
  "i (?:usually|typically|normally|generally|mostly|tend to|specialise|specialize)",
];

/** User-side gate (§5.3, widened for query-embedded preferences), on `userText`. */
export const USER_TRIGGER = new RegExp(`\\b(?:${[...INSTRUCTION_VOCABULARY, ...QUERY_PREFERENCE_VOCABULARY].join("|")})\\b`, "i");

/** Assistant-side gate (§5.3), on `assistantText`. */
export const ASSISTANT_TRIGGER = /\b(apolog\w*|sorry|you'?re right|i'?ll (avoid|stop|keep)|noted|understood|going forward)\b/i;

/** A number in [0, 1); `Math.random` in production, a scripted value in tests. */
export type Sampler = () => number;

export type ExtractOverride = "auto" | "force" | "skip";

export type TriageReason = "forced" | "skipped" | "user-text" | "assistant-text" | "sampled" | "none";

export interface TriageDecision {
  extract: boolean;
  reason: TriageReason;
}

/** The fold every regex runs on: NFKC, invisibles out, one line, straight apostrophes. */
export function foldForTriage(text: string): string {
  return normalizeText(text).replace(/[‘’]/g, "'");
}

/**
 * Spec §5.3 step 3. `override` wins outright; then the user regex, then the
 * assistant regex, then — only for a turn neither matched — the sample. The
 * sampler is not consulted when a regex hit, so a scripted die only
 * decides the turns it is meant to.
 */
export function shouldExtract(
  turn: Pick<TurnEvent, "userText" | "assistantText">,
  policy: PolicyConfig,
  sampler: Sampler = Math.random,
  override: ExtractOverride = "auto",
): TriageDecision {
  if (override === "skip") return { extract: false, reason: "skipped" };
  if (override === "force") return { extract: true, reason: "forced" };
  if (USER_TRIGGER.test(foldForTriage(turn.userText))) return { extract: true, reason: "user-text" };
  if (ASSISTANT_TRIGGER.test(foldForTriage(turn.assistantText))) return { extract: true, reason: "assistant-text" };
  const rate = policy.ingest.extractionSampleRate;
  if (rate > 0 && sampler() < rate) return { extract: true, reason: "sampled" };
  return { extract: false, reason: "none" };
}
