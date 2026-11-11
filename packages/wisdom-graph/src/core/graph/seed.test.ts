/**
 * Seeding is where configuration becomes rows, so two promises are pinned:
 * the ids are a pure function of (tenant, subject, path) — the crash
 * idempotency of every later `upsertNode` depends on it — and an unsafe seed
 * regex is refused before any engine exists, because the same pattern would
 * otherwise run on raw user text inside the recall budget.
 */
import { describe, expect, it } from "vitest";
import { deterministicId } from "../ids";
import type { SubjectRef } from "../ports";
import type { CategorySpec } from "../types";
import { validators } from "../index";
import { FakeClock } from "../../testing/fakes";
import { advisorCategories } from "../../testing/fixtures";
import {
  DIRECT_CATEGORY,
  MAX_PATTERN_CHARS,
  ROOT_TITLE,
  SEED_PATTERN_FLAGS,
  assertSafePattern,
  compileSeedPattern,
  defaultCategoryTitle,
  materialiseCategories,
  mentionPattern,
  resolveCategories,
} from "./seed";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const clock = new FakeClock();

describe("pattern safety (§9.2)", () => {
  it.each([
    "\\b(rrsp|rrif|tfsa|resp|cpp|oas)\\b",
    "\\b(coach(ing)?|practi[cs]e|role[ -]?play)\\b",
    "(?:ab)+",
    "(a|b)+c*",
    "a{2,5}b{3}",
    "[+*]+",
    "\\(a+\\)+",
    "(a+)?",
    "(?<year>\\d{4})-(?<month>\\d{2})",
    "(?=foo)bar",
    "[\\]+]+",
    "x".repeat(MAX_PATTERN_CHARS),
  ])("accepts %j", (source) => {
    expect(() => assertSafePattern(source)).not.toThrow();
    const compiled = compileSeedPattern(source);
    expect(compiled.flags).toBe(SEED_PATTERN_FLAGS);
  });

  it.each(advisorCategories().flatMap((c) => c.patterns ?? []))("accepts the consumer's seed pattern %j", (source) => {
    expect(() => compileSeedPattern(source)).not.toThrow();
  });

  it.each([
    ["(a+)+", "nests a quantifier"],
    ["(a*)*", "nests a quantifier"],
    ["(a+)*", "nests a quantifier"],
    ["(ab|a+)*", "nests a quantifier"],
    ["((a+)b)+", "nests a quantifier"],
    ["(a{2,})+", "nests a quantifier"],
    ["(?:a+){2,5}", "nests a quantifier"],
    ["(a)\\1", "back-reference"],
    ["(?<w>a)\\k<w>", "named back-reference"],
    ["x".repeat(MAX_PATTERN_CHARS + 1), `longer than ${MAX_PATTERN_CHARS}`],
    ["", "is empty"],
    ["(abc", "unbalanced"],
    ["abc)", "unbalanced"],
    ["[abc", "unterminated"],
    ["abc\\", "backslash"],
    ["a{", "invalid seed pattern"],
    ["(?<", "unbalanced"],
  ])("rejects %j with a TypeError", (source, reason) => {
    expect(() => assertSafePattern(source)).toThrow(TypeError);
    expect(() => compileSeedPattern(source)).toThrow(reason);
  });

  it("compiles with flags iu only, so a hit is case-insensitive and Unicode-aware", () => {
    const pattern = compileSeedPattern("\\brrif\\b");
    expect(pattern.test("Plan my RRIF withdrawals")).toBe(true);
    expect(pattern.test("rrifs")).toBe(false);
    expect(pattern.global).toBe(false);
  });
});

describe("defaultCategoryTitle (§2.7)", () => {
  it.each([
    ["consult_market_analyst", "Market Analyst"],
    ["consult_advice", "Advice"],
    ["consult_kyp", "Kyp"],
    ["research-desk", "Research Desk"],
    ["consult", "Consult"],
  ])("%s → %s", (name, title) => {
    expect(defaultCategoryTitle(name)).toBe(title);
  });
});

describe("resolveCategories", () => {
  it("applies defaults: title from the name, empty description, every lane, normalised keywords", () => {
    const [resolved] = resolveCategories([{ name: "consult_market_analyst", keywords: [" Market ", "RATES", "market"] }]);
    expect(resolved).toEqual({
      name: "consult_market_analyst",
      title: "Market Analyst",
      description: "",
      keywords: ["market", "rates"],
      patterns: [],
      lanes: ["preRoute", "agent", "responseStyle"],
      path: "/consult_market_analyst",
      mention: expect.any(RegExp),
    });
  });

  it("compiles one word-bounded, case-insensitive mention regex per category from its name and title", () => {
    const [resolved] = resolveCategories([{ name: "alpha", title: "Alpha Desk", keywords: [] }]);
    const mention = resolved?.mention as RegExp;
    expect(mention.flags).toBe("iu");
    expect(mention.global).toBe(false);
    for (const text of ["ask alpha", "ALPHA?", "alpha", "the Alpha desk, please", "(alpha)"]) expect(mention.test(text), text).toBe(true);
    for (const text of ["the alphabet is long", "alpha_desk", "malpha", "desk", ""]) expect(mention.test(text), text).toBe(false);
    expect(mention.test("ask alpha")).toBe(true);
  });

  it("mentionPattern escapes regex metacharacters, skips blank phrases and matches nothing for none", () => {
    const dotted = mentionPattern(["a.b", "  ", "c+d"]);
    expect(dotted.test("call a.b now")).toBe(true);
    expect(dotted.test("call axb now")).toBe(false);
    expect(dotted.test("c+d")).toBe(true);
    expect(dotted.test("ccd")).toBe(false);
    expect(mentionPattern([]).test("anything")).toBe(false);
    expect(mentionPattern([""]).test("")).toBe(false);
  });

  it("keeps an explicit title, description, patterns and lanes", () => {
    const [resolved] = resolveCategories([
      { name: "consult_kyp", title: " Know your product ", description: "Product facts.", keywords: ["fund"], patterns: ["\\bmer\\b"], lanes: ["agent"] },
    ]);
    expect(resolved).toMatchObject({ title: "Know your product", description: "Product facts.", patterns: ["\\bmer\\b"], lanes: ["agent"] });
  });

  it.each<[string, CategorySpec[]]>([
    ["Consult_Advice", [{ name: "Consult_Advice", keywords: [] }]],
    ["a name with spaces", [{ name: "a name", keywords: [] }]],
    ["an empty name", [{ name: "", keywords: [] }]],
    [DIRECT_CATEGORY, [{ name: DIRECT_CATEGORY, keywords: [] }]],
    ["a duplicate", [{ name: "consult_advice", keywords: [] }, { name: "consult_advice", keywords: [] }]],
    ["an unsafe pattern", [{ name: "consult_advice", keywords: [], patterns: ["(a+)+"] }]],
    ["a pattern over 200 chars", [{ name: "consult_advice", keywords: [], patterns: ["x".repeat(201)] }]],
    ["a back-reference", [{ name: "consult_advice", keywords: [], patterns: ["(a)\\1"] }]],
    ["an invalid keyword", [{ name: "consult_advice", keywords: ["Bad keyword!"] }]],
    ["too many keywords", [{ name: "consult_advice", keywords: Array.from({ length: 41 }, (_, i) => `k${i}`) }]],
    ["a title over 80 chars", [{ name: "consult_advice", title: "t".repeat(81), keywords: [] }]],
    ["a description over 200 chars", [{ name: "consult_advice", description: "d".repeat(201), keywords: [] }]],
    // The lane is wrong at runtime; the cast is the test reaching past the type.
    ["an unknown lane", [{ name: "consult_advice", keywords: [], lanes: ["router" as "agent"] }]],
  ])("throws TypeError for %s", (_label, categories) => {
    expect(() => resolveCategories(categories)).toThrow(TypeError);
    expect(() => materialiseCategories(categories, ref, { clock })).toThrow(TypeError);
  });

  it("names the offending category in the error", () => {
    expect(() => resolveCategories([{ name: "consult_kyp", keywords: ["Bad keyword!"] }])).toThrow(/consult_kyp/);
    expect(() => resolveCategories([{ name: "consult_kyp", keywords: [], patterns: ["(a+)+"] }])).toThrow(/\(a\+\)\+/);
  });

  it("accepts an empty configuration", () => {
    expect(resolveCategories([])).toEqual([]);
    expect(materialiseCategories([], ref, { clock })).toHaveLength(1);
  });
});

describe("materialiseCategories (§3.1)", () => {
  const nodes = materialiseCategories(advisorCategories(), ref, { clock });

  it("returns the root and one locked level-1 node per category, all valid", () => {
    expect(nodes.map((n) => n.path)).toEqual(["/", ...advisorCategories().map((c) => `/${c.name}`)]);
    for (const node of nodes) {
      expect(validators.node(node), node.path).toEqual({ ok: true, value: node });
      expect(node.locked).toBe(true);
      expect(node.status).toBe("active");
      expect(node.level).toBe(node.path === "/" ? 0 : 1);
      expect(node.tenantId).toBeNull();
      expect(node.subjectId).toBe("rm_42");
      expect(node.createdAt).toBe(clock.iso());
      expect(node.updatedAt).toBe(clock.iso());
    }
    expect(nodes[0]).toMatchObject({ path: "/", parentPath: null, slug: "", title: ROOT_TITLE, keywords: [], patterns: [], agents: [] });
  });

  it("seeds each category node with its title, description, keywords, patterns and itself as the handoff agent", () => {
    const advice = nodes.find((n) => n.path === "/consult_advice");
    const spec = advisorCategories().find((c) => c.name === "consult_advice");
    expect(advice).toMatchObject({
      parentPath: "/",
      slug: "consult_advice",
      title: spec?.title,
      description: spec?.description,
      keywords: spec?.keywords,
      patterns: spec?.patterns,
      agents: ["consult_advice"],
      properties: {},
      stats: { activeHints: 0 },
      version: 1,
    });
  });

  it("mints deterministic ids per (tenant, subject, path): stable across calls, distinct per subject and tenant", () => {
    for (const node of nodes) expect(node.id).toBe(deterministicId("n", null, "rm_42", node.path));
    const again = materialiseCategories(advisorCategories(), ref, { clock: new FakeClock(Date.UTC(2030, 0, 1)) });
    expect(again.map((n) => n.id)).toEqual(nodes.map((n) => n.id));
    const otherSubject = materialiseCategories(advisorCategories(), { tenantId: null, subjectId: "rm_43" }, { clock });
    const otherTenant = materialiseCategories(advisorCategories(), { tenantId: "acme", subjectId: "rm_42" }, { clock });
    const ids = new Set(nodes.map((n) => n.id));
    for (const node of [...otherSubject, ...otherTenant]) expect(ids.has(node.id), node.path).toBe(false);
    expect(new Set([...nodes, ...otherSubject, ...otherTenant].map((n) => n.id)).size).toBe(nodes.length * 3);
  });

  it("returns fresh rows on every call", () => {
    const a = materialiseCategories(advisorCategories(), ref, { clock });
    const b = materialiseCategories(advisorCategories(), ref, { clock });
    a[1]?.keywords.push("mutated");
    expect(b[1]?.keywords).not.toContain("mutated");
  });

  it("stamps rows with the system clock when none is given", () => {
    const before = Date.now();
    const [root] = materialiseCategories([], ref);
    expect(Date.parse(root?.createdAt ?? "")).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(root?.createdAt ?? "")).toBeLessThanOrEqual(Date.now() + 1);
  });
});
