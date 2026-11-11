/**
 * normalize.ts — one definition of "the same text".
 *
 * Three places compare text and must agree on what counts as equal: the
 * sanitiser (spec §9.1 step 1) before it pattern-matches for injection, the
 * classifier (§4.2 step 3) when it scores query tokens against node
 * keywords, and the dedupe/merge passes (§4.2 step 5, §5.7) when they decide
 * two hints say the same thing. If each folded case, width or plurals
 * differently, an attacker could slip "ｉｇｎｏｒｅ" past a regex written for
 * "ignore", or a query for "bullets" would miss a keyword "bullet". So the
 * folding lives here, once, and everything else calls it.
 *
 * NFKC is the fold of choice because it maps the compatibility look-alikes
 * an injection hides behind (full-width letters, ligatures, enclosed digits)
 * onto their plain forms while leaving ordinary accented text intact. It does
 * not touch the invisible code points — zero-width, bidi override, soft
 * hyphen, tag characters — so those are stripped explicitly; they carry no
 * meaning in a preference statement and exist in user text mostly to split a
 * word a regex is looking for. What NFKC also cannot do is fold one script
 * onto another, so a Cyrillic "о" inside a Latin word survives normalisation;
 * the sanitiser flags that case for review instead (`patterns.ts`).
 *
 * `stemLite` is deliberately not Porter. A handful of suffix rules is enough
 * to make "bullets"/"bullet", "trading"/"trade" and "summaries"/"summary" meet
 * in the middle, and because both sides of every comparison go through the
 * same function, what matters is that it is stable, not that it is
 * linguistically right. Negations are kept out of the stopword list on
 * purpose: "never uses jargon" and "uses jargon" must not dedupe to one hint.
 */

/** Unicode compatibility fold: full-width, ligature and enclosed forms become plain. */
export function nfkc(text: string): string {
  return text.normalize("NFKC");
}

/**
 * Code points that render as nothing and exist in prose only to hide from a
 * regex. The whole format class (`\p{Cf}`) rather than the spec's enumerated
 * ranges: it contains every one of them — zero-width spaces and joiners, the
 * BOM, the bidi overrides and isolates, the word joiner — and also the soft
 * hyphen, the Mongolian vowel separator and the Unicode tag characters that
 * "ASCII smuggling" splits a keyword with; an enumerated list is exactly what
 * the next unlisted code point walks past. The tag block is named in full
 * because its unassigned slots are not `Cf`. Alongside sit the marks that are
 * not format characters but render just as blank — the blank Hangul fillers,
 * variation selectors and the combining grapheme joiner — while ordinary
 * combining accents stay, since they are visible. Whitespace controls (tab,
 * newline) are handled by `collapseWhitespace` and are not in this class.
 */
const INVISIBLE =
  /[\p{Cf}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0\u034F\u180B-\u180D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
/** Whitespace-like controls become a space so words on either side stay separate. */
const WHITESPACE_CONTROLS = /[\t\n\v\f\r]+/gu;
/** Every other control character is dropped outright. */
const OTHER_CONTROLS = /\p{Cc}/gu;

/** Remove control, zero-width and bidi-override characters; whitespace controls become a space. */
export function stripInvisible(text: string): string {
  return text.replace(WHITESPACE_CONTROLS, " ").replace(OTHER_CONTROLS, "").replace(INVISIBLE, "");
}

/** Runs of any whitespace become one space; leading and trailing whitespace go. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Spec §9.1 step 1: NFKC, invisibles stripped, whitespace collapsed to a single line. */
export function normalizeText(text: string): string {
  return collapseWhitespace(stripInvisible(nfkc(text)));
}

const COMBINING_MARKS = /\p{M}/gu;

/**
 * Accents off, for matching only: canonical decomposition (NFD) followed by
 * dropping every combining mark, so an ASCII pattern written for "ignores"
 * also sees "ígnores" and "ignorés". This is deliberately not part of
 * `normalizeText` — an accent is meaning in a stored statement ("café"),
 * not noise — so the sanitiser matches on the folded copy and keeps the
 * original. Letters that are their own code point ("ø", "ł") do not
 * decompose and are left as they are.
 */
export function foldMarks(text: string): string {
  return text.normalize("NFD").replace(COMBINING_MARKS, "");
}

/**
 * Function words that carry no topical signal. Negations ("not", "never",
 * "no", "without") are intentionally absent — see the module comment.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by", "from",
  "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these",
  "those", "than", "then", "so", "if", "do", "does", "did", "has", "have", "had", "will", "would",
  "can", "could", "should", "may", "might", "must", "into", "onto", "per", "up", "out", "over",
  "about", "also", "any", "all", "each", "every", "when", "where", "which", "who", "whom", "what",
  "how", "why", "there", "here", "such", "some", "other", "own", "same", "very", "just", "only",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them", "their", "his", "her",
]);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Letters and digits, with one internal apostrophe allowed so "client's" is one token. */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
const DOUBLED_CONSONANT = /([b-df-hj-km-np-rtv-x])\1$/u;

/** Undo the consonant doubling of "-ing"/"-ed" ("formatt" → "format"); l, s and z stay doubled. */
function undouble(stem: string): string {
  return DOUBLED_CONSONANT.test(stem) ? stem.slice(0, -1) : stem;
}

/**
 * Light suffix stripping: possessive, plural, "-ing", "-ed", and a trailing
 * "e" on longer words so "trade"/"trading"/"trades" agree. Tokens of three
 * characters or fewer are returned as they are (after the possessive), since
 * every rule below would mangle them.
 */
export function stemLite(token: string): string {
  let t = token.toLowerCase().replace(/['’]s$/u, "");
  if (t.length <= 3) return t;
  if (t.endsWith("sses")) t = t.slice(0, -2);
  else if (t.endsWith("ies") && t.length > 4) t = `${t.slice(0, -3)}y`;
  else if (/(?:x|ch|sh|z)es$/u.test(t)) t = t.slice(0, -2);
  else if (t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us") && !t.endsWith("is")) t = t.slice(0, -1);
  if (t.endsWith("ing") && t.length >= 6) t = undouble(t.slice(0, -3));
  else if (t.endsWith("ed") && t.length >= 5) t = undouble(t.slice(0, -2));
  if (t.endsWith("e") && t.length >= 5) t = t.slice(0, -1);
  return t;
}

export interface TokenizeOptions {
  /** Drop `STOPWORDS`. Default true. */
  stopwords?: boolean;
  /** Apply `stemLite`. Default true. */
  stem?: boolean;
}

/**
 * Lower-case, NFKC-folded word tokens of `text` in order, stopwords removed
 * and stems applied unless told otherwise. Punctuation never yields a token.
 */
export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const dropStopwords = opts.stopwords ?? true;
  const stem = opts.stem ?? true;
  const words = normalizeText(text).toLowerCase().match(WORD) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (dropStopwords && isStopword(word)) continue;
    const token = stem ? stemLite(word) : word;
    if (token.length === 0) continue;
    if (dropStopwords && isStopword(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * Jaccard similarity of two token sets in [0, 1]. A string argument is
 * tokenised first; anything else is used as the token collection it is.
 * Identical sets — including two empty ones — score 1.
 */
export function jaccard(a: string | Iterable<string>, b: string | Iterable<string>): number {
  const setA = new Set(typeof a === "string" ? tokenize(a) : a);
  const setB = new Set(typeof b === "string" ? tokenize(b) : b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}
