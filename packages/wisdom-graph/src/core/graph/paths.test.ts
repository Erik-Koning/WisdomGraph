/**
 * Path algebra: examples for each helper, then the identities that tie them
 * together (`join(parent, slug)` round-trips, ancestors count equals depth),
 * because the classifier's ancestor credit and the organiser's depth cap
 * both assume those identities hold.
 */
import { describe, expect, it } from "vitest";
import {
  ROOT_PATH,
  ancestors,
  categoryOf,
  depth,
  isDescendant,
  isValidPath,
  isValidSlug,
  join,
  parentPath,
  segments,
  slugOf,
  slugify,
} from "./paths";

describe("isValidSlug / isValidPath", () => {
  it.each(["a", "consult_advice", "retirement-2026", "a1", "x".repeat(40)])("accepts slug %j", (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });
  it.each(["", "-a", "_a", "A", "a b", "a.b", "a/b", "x".repeat(41), "é"])("rejects slug %j", (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });
  it.each(["/", "/a", "/consult_advice/retirement", "/a/b/c/d/e/f"])("accepts path %j", (path) => {
    expect(isValidPath(path)).toBe(true);
  });
  it.each(["", "a", "/a/", "//", "/a//b", "/A", "/a b", "a/b", " /a"])("rejects path %j", (path) => {
    expect(isValidPath(path)).toBe(false);
  });
});

describe("segments / depth / slugOf / categoryOf", () => {
  it.each([
    ["/", [], 0, "", null],
    ["/a", ["a"], 1, "a", "a"],
    ["/consult_advice/retirement", ["consult_advice", "retirement"], 2, "retirement", "consult_advice"],
    ["/a/b/c/d", ["a", "b", "c", "d"], 4, "d", "a"],
  ])("%s", (path, segs, d, slug, category) => {
    expect(segments(path)).toEqual(segs);
    expect(depth(path)).toBe(d);
    expect(slugOf(path)).toBe(slug);
    expect(categoryOf(path)).toBe(category);
  });

  it("tolerates malformed input without throwing", () => {
    expect(segments("a//b/")).toEqual(["a", "b"]);
    expect(depth("")).toBe(0);
    expect(slugOf("")).toBe("");
  });
});

describe("parentPath", () => {
  it.each([
    ["/", null],
    ["/a", "/"],
    ["/a/b", "/a"],
    ["/a/b/c", "/a/b"],
  ])("%s → %s", (path, parent) => {
    expect(parentPath(path)).toBe(parent);
  });
});

describe("ancestors", () => {
  it.each([
    ["/", []],
    ["/a", ["/"]],
    ["/a/b", ["/", "/a"]],
    ["/a/b/c", ["/", "/a", "/a/b"]],
  ])("%s → %j (root-first, excluding self)", (path, expected) => {
    expect(ancestors(path)).toEqual(expected);
  });
});

describe("join", () => {
  it.each([
    ["/", "a", "/a"],
    ["/a", "b", "/a/b"],
    ["/a/b", "c", "/a/b/c"],
    ["/a", "", "/a"],
    ["/", "", "/"],
  ])("join(%j, %j) → %j", (parent, slug, expected) => {
    expect(join(parent, slug)).toBe(expected);
  });
  it("never produces a double slash from sloppy input", () => {
    expect(join("/a/", "/b")).toBe("/a/b");
  });
});

describe("isDescendant", () => {
  it.each([
    ["/a", "/", true],
    ["/a/b", "/", true],
    ["/a/b", "/a", true],
    ["/a/b/c", "/a", true],
    ["/a", "/a", false],
    ["/", "/", false],
    ["/a", "/a/b", false],
    ["/ab", "/a", false],
    ["/b/a", "/a", false],
  ])("isDescendant(%j, %j) → %s", (path, ancestor, expected) => {
    expect(isDescendant(path, ancestor)).toBe(expected);
  });
});

describe("slugify", () => {
  it.each([
    ["Client Reporting", "client-reporting"],
    ["  RRSP / RRIF withdrawals  ", "rrsp-rrif-withdrawals"],
    ["Café société", "cafe-societe"],
    ["consult_advice", "consult_advice"],
    ["---leading", "leading"],
    ["trailing---", "trailing"],
    ["!!!", ""],
    ["", ""],
    ["a".repeat(50), "a".repeat(40)],
    ["x".repeat(39) + "-y", "x".repeat(39)],
  ])("%j → %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("yields a valid slug or the empty string for arbitrary text", () => {
    for (const s of ["Hello, World!", "über-cool", "123 go", "\u{1F389} party", "a__b--c", "MiXeD_CaSe-42"]) {
      const slug = slugify(s);
      expect(slug === "" || isValidSlug(slug), `${s} → ${slug}`).toBe(true);
    }
  });
});

describe("identities", () => {
  const paths = ["/a", "/a/b", "/consult_advice/retirement/withdrawals", "/a/b/c/d"];

  it.each(paths)("join(parentPath(p), slugOf(p)) === p for %s", (p) => {
    expect(join(parentPath(p) as string, slugOf(p))).toBe(p);
  });

  it.each([ROOT_PATH, ...paths])("ancestors(p).length === depth(p) and each ancestor is an ancestor of p for %s", (p) => {
    const as = ancestors(p);
    expect(as).toHaveLength(depth(p));
    for (const a of as) expect(isDescendant(p, a)).toBe(true);
    if (as.length > 0) expect(as.at(-1)).toBe(parentPath(p));
  });

  it("depth(join(p, slug)) === depth(p) + 1", () => {
    for (const p of [ROOT_PATH, ...paths]) expect(depth(join(p, "z"))).toBe(depth(p) + 1);
  });
});
