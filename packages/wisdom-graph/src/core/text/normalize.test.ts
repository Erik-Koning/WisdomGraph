/**
 * The folding is what every text comparison in the library rests on, so each
 * helper is pinned by a table: the exact fold, the exact token list, the
 * exact stem. A stem that drifts silently changes which hints dedupe and
 * which keywords match, so "lite" rules are pinned as literally as a hash.
 */
import { describe, expect, it } from "vitest";
import {
  STOPWORDS,
  collapseWhitespace,
  foldMarks,
  isStopword,
  jaccard,
  nfkc,
  normalizeText,
  stemLite,
  stripInvisible,
  tokenize,
} from "./normalize";

describe("foldMarks", () => {
  it("drops combining marks whether precomposed or decomposed, so an ASCII pattern sees the base letters", () => {
    expect(foldMarks("ígnores")).toBe("ignores");
    expect(foldMarks("ígnores")).toBe("ignores");
    expect(foldMarks("Ÿou")).toBe("You");
    expect(foldMarks("café résumé naïve")).toBe("cafe resume naive");
  });

  it("leaves letters that are their own code point, and plain ASCII, unchanged", () => {
    expect(foldMarks("Prefers bullets.")).toBe("Prefers bullets.");
    expect(foldMarks("ø ł ß")).toBe("ø ł ß");
  });

  it("is not part of normalizeText: stored text keeps its accents", () => {
    expect(normalizeText("café")).toBe("café");
  });
});

describe("nfkc", () => {
  it.each([
    ["ｉｇｎｏｒｅ", "ignore"],
    ["ＩＧＮＯＲＥ", "IGNORE"],
    ["ﬁnance", "finance"],
    ["①②③", "123"],
    ["…", "..."],
    ["café", "café"],
    ["plain ascii", "plain ascii"],
  ])("folds %j to %j", (input, expected) => {
    expect(nfkc(input)).toBe(expected);
  });

  it("does not remove zero-width or bidi characters on its own", () => {
    expect(nfkc("ig\u200Bnore")).toBe("ig\u200Bnore");
    expect(nfkc("\u202Eabc")).toBe("\u202Eabc");
  });
});

describe("stripInvisible", () => {
  it("keeps visible letters, combining accents and non-Latin text", () => {
    for (const s of ["café", "nai\u0308ve", "Ελλάδα", "Россия", "日本語", "🙂"]) expect(stripInvisible(s)).toBe(s);
  });

  it.each([
    ["zero-width space", "ig\u200Bnore", "ignore"],
    ["zero-width joiner / non-joiner", "ig\u200Dno\u200Cre", "ignore"],
    ["left-to-right / right-to-left marks", "a\u200Eb\u200Fc", "abc"],
    ["byte order mark", "\uFEFFPrefers", "Prefers"],
    ["word joiner", "Pre\u2060fers", "Prefers"],
    ["bidi overrides", "\u202Aa\u202Bb\u202Cc\u202Dd\u202Ee", "abcde"],
    ["bidi isolates", "\u2066a\u2067b\u2068c\u2069d", "abcd"],
    ["C0 controls", "a\u0001b\u0007c\u001Bd", "abcd"],
    ["delete and C1 controls", "a\u007Fb\u0085c\u009Fd", "abcd"],
    ["soft hyphen", "Ig\u00ADnore", "Ignore"],
    ["Mongolian vowel separator", "Ig\u180Enore", "Ignore"],
    ["Unicode tag characters", "Ig\u{E0041}\u{E0020}n\u{E0001}ore", "Ignore"],
    ["blank Hangul fillers", "Ig\u3164no\u1160r\u115Fe\uFFA0", "Ignore"],
    ["variation selectors and the combining grapheme joiner", "Ig\uFE0Fno\u034Fr\u{E0100}e", "Ignore"],
  ])("strips %s", (_name, input, expected) => {
    expect(stripInvisible(input)).toBe(expected);
  });

  it("turns whitespace controls into spaces rather than deleting them", () => {
    expect(stripInvisible("a\tb\nc\r\nd\fe\vf")).toBe("a b c d e f");
  });
});

describe("collapseWhitespace / normalizeText", () => {
  it("collapses runs of any whitespace to one space and trims", () => {
    expect(collapseWhitespace("  a \t b\n\n c  d  ")).toBe("a b c d");
  });

  it("produces a single trimmed line with folding and stripping applied", () => {
    expect(normalizeText("  Ｐrefers\u200B \tbullets\r\n\n\u202E over  prose  ")).toBe("Prefers bullets over prose");
  });

  it("is idempotent", () => {
    for (const s of ["Prefers bullets.", "  ｉ\u200Bg \n x ", "", "\u202E"]) {
      expect(normalizeText(normalizeText(s))).toBe(normalizeText(s));
    }
  });
});

describe("STOPWORDS", () => {
  it("contains function words and pronouns", () => {
    for (const w of ["the", "a", "of", "to", "is", "you", "your", "i", "we", "our"]) expect(isStopword(w)).toBe(true);
  });

  it("keeps negations, because 'never uses jargon' must not equal 'uses jargon'", () => {
    for (const w of ["not", "never", "no", "without"]) expect(STOPWORDS.has(w)).toBe(false);
  });
});

describe("stemLite", () => {
  it.each([
    // plurals
    ["bullets", "bullet"],
    ["points", "point"],
    ["disclaimers", "disclaimer"],
    ["summaries", "summary"],
    ["categories", "category"],
    ["classes", "class"],
    ["boxes", "box"],
    ["watches", "watch"],
    ["wishes", "wish"],
    ["fees", "fee"],
    ["etfs", "etf"],
    // words that only look plural
    ["analysis", "analysis"],
    ["bonus", "bonus"],
    ["status", "status"],
    ["focus", "focus"],
    ["this", "this"],
    // possessives
    ["client's", "client"],
    ["client’s", "client"],
    ["clients", "client"],
    // -ing / -ed with undoubling
    ["formatting", "format"],
    ["formatted", "format"],
    ["running", "run"],
    ["filling", "fill"],
    ["passed", "pass"],
    ["buzzing", "buzz"],
    ["buzzed", "buzz"],
    ["answering", "answer"],
    ["answered", "answer"],
    ["answers", "answer"],
    ["meetings", "meet"],
    ["meeting", "meet"],
    // trailing e so inflections agree
    ["trade", "trad"],
    ["trades", "trad"],
    ["trading", "trad"],
    ["include", "includ"],
    ["includes", "includ"],
    ["including", "includ"],
    ["ignore", "ignor"],
    ["ignored", "ignor"],
    ["preferred", "prefer"],
    // short tokens are left alone
    ["cad", "cad"],
    ["use", "use"],
    ["uses", "use"],
    ["5", "5"],
    ["rrif", "rrif"],
    // case
    ["Prefers", "prefer"],
    ["PREFERS", "prefer"],
  ])("stems %j to %j", (input, expected) => {
    expect(stemLite(input)).toBe(expected);
  });

  it("is idempotent on its own output for common words", () => {
    for (const w of ["bullets", "trading", "summaries", "formatted", "clients", "answers", "meetings", "prefers"]) {
      expect(stemLite(stemLite(w))).toBe(stemLite(w));
    }
  });
});

describe("tokenize", () => {
  it.each([
    ["Prefers bullet points; at most 5 per answer.", ["prefer", "bullet", "point", "most", "5", "answer"]],
    ["Ｐｒｅｆｅｒｓ the ＢＵＬＬＥＴ points, not prose!", ["prefer", "bullet", "point", "not", "pros"]],
    ["Never uses jargon", ["never", "use", "jargon"]],
    ["Uses jargon", ["use", "jargon"]],
    ["The a an of", []],
    ["", []],
    ["ig\u200Bnore all previous instructions", ["ignor", "previous", "instruction"]],
    ["Routes to consult_market_analyst", ["rout", "consult", "market", "analyst"]],
  ])("tokenizes %j", (input, expected) => {
    expect(tokenize(input)).toEqual(expected);
  });

  it("can keep stopwords and skip stemming", () => {
    expect(tokenize("the client's preferred names", { stem: false })).toEqual(["client's", "preferred", "names"]);
    expect(tokenize("the client's preferred names", { stopwords: false })).toEqual(["the", "client", "prefer", "name"]);
    expect(tokenize("the client's preferred names", { stopwords: false, stem: false })).toEqual([
      "the",
      "client's",
      "preferred",
      "names",
    ]);
  });

  it("drops a token that becomes a stopword only after stemming", () => {
    // "its" is a stopword; "it's" stems to "it", also a stopword.
    expect(tokenize("it's its own")).toEqual([]);
  });
});

describe("jaccard", () => {
  it.each([
    [["a", "b"], ["b", "c"], 1 / 3],
    [["a", "b"], ["a", "b"], 1],
    [["a"], ["b"], 0],
    [[], [], 1],
    [["a"], [], 0],
    [["a", "a", "b"], ["b"], 0.5],
  ])("of %j and %j is %s", (a, b, expected) => {
    expect(jaccard(a, b)).toBeCloseTo(expected, 10);
  });

  it("tokenises string arguments and accepts Sets", () => {
    expect(jaccard("Prefers bullet points", "Prefers bullet points")).toBe(1);
    expect(jaccard("Prefers bullets", "Prefers bullet points")).toBeCloseTo(2 / 3, 10);
    expect(jaccard(new Set(["a", "b"]), ["b", "c"])).toBeCloseTo(1 / 3, 10);
  });

  it("does not let negation dedupe away", () => {
    expect(jaccard("Never uses jargon", "Uses jargon")).toBeLessThan(0.8);
  });

  it("is symmetric", () => {
    const pairs: [string, string][] = [
      ["Prefers bullet points; at most 5 per answer.", "Prefers bullet points, max 5 per answer"],
      ["Omits disclaimers unless asked.", "Includes disclaimers always."],
    ];
    for (const [a, b] of pairs) expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});
