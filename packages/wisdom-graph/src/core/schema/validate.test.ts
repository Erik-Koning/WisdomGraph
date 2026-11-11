/**
 * Every combinator, valid and invalid, with the JSON-pointer path each issue
 * lands on — because the organiser feeds those paths back to the LLM and a
 * wrong path sends the retry to the wrong field.
 */
import { describe, expect, it } from "vitest";
import {
  arr,
  bool,
  int,
  isoDate,
  json,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  pointer,
  raw,
  record,
  refine,
  str,
  union,
  type Validator,
} from "./validate";

function paths(result: ReturnType<Validator<unknown>>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.path);
}

function expectValid<T>(v: Validator<T>, input: unknown, expected: T = input as T): void {
  const result = v(input);
  expect(result).toEqual({ ok: true, value: expected });
}

/** A printable form of any input, including ones JSON.stringify refuses (bigint, cycles). */
function describe_(input: unknown): string {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

function expectIssues<T>(v: Validator<T>, input: unknown, expectedPaths: string[], path?: string): void {
  const result = v(input, path);
  expect(result.ok, `expected issues for ${describe_(input)}`).toBe(false);
  expect(paths(result)).toEqual(expectedPaths);
}

describe("pointer", () => {
  it("builds RFC 6901 pointers and escapes ~ and /", () => {
    expect(pointer("", "a")).toBe("/a");
    expect(pointer("/a", 0)).toBe("/a/0");
    expect(pointer("/a", "b/c")).toBe("/a/b~1c");
    expect(pointer("", "x~y")).toBe("/x~0y");
  });
});

describe("str", () => {
  it.each([
    ["plain", {}, "hello", "hello"],
    ["trim", { trim: true }, "  hi  ", "hi"],
    ["lower", { lower: true }, "RRSP", "rrsp"],
    ["min boundary", { min: 2 }, "ab", "ab"],
    ["max boundary", { max: 2 }, "ab", "ab"],
    ["pattern", { pattern: /^[a-z]+$/ }, "abc", "abc"],
  ])("accepts %s", (_, opts, input, expected) => {
    expectValid(str(opts), input, expected);
  });

  it.each([
    ["number", {}, 5],
    ["null", {}, null],
    ["too short", { min: 1 }, ""],
    ["too long", { max: 3 }, "abcd"],
    ["pattern miss", { pattern: /^[a-z]+$/ }, "ABC"],
    ["trim then too short", { trim: true, min: 1 }, "   "],
  ])("rejects %s at the given path", (_, opts, input) => {
    expectIssues(str(opts), input, ["/field"], "/field");
  });

  it("names the empty-string rule plainly", () => {
    const r = str({ min: 1 })("");
    expect(r).toEqual({ ok: false, issues: [{ path: "", message: "must not be empty" }] });
  });
});

describe("num / int / bool", () => {
  it.each([
    ["integer", num(), 3],
    ["float", num(), 0.5],
    ["negative", num(), -1],
    ["min boundary", num({ min: 0 }), 0],
    ["max boundary", num({ max: 1 }), 1],
  ])("num accepts %s", (_, v, input) => {
    expectValid(v, input);
  });

  it.each([
    ["string", num(), "3"],
    ["NaN", num(), Number.NaN],
    ["Infinity", num(), Number.POSITIVE_INFINITY],
    ["below min", num({ min: 0 }), -0.1],
    ["above max", num({ max: 1 }), 1.1],
    ["null", num(), null],
  ])("num rejects %s", (_, v, input) => {
    expectIssues(v, input, ["/n"], "/n");
  });

  it.each([
    ["integer", int(), 7],
    ["zero", int({ min: 0 }), 0],
    ["boundary", int({ min: 0, max: 100 }), 100],
  ])("int accepts %s", (_, v, input) => {
    expectValid(v, input);
  });

  it.each([
    ["float", int(), 1.5],
    ["string", int(), "1"],
    ["below min", int({ min: 0 }), -1],
    ["above max", int({ max: 100 }), 101],
  ])("int rejects %s", (_, v, input) => {
    expectIssues(v, input, ["/i"], "/i");
  });

  it("bool accepts booleans only", () => {
    expectValid(bool(), true);
    expectValid(bool(), false);
    expectIssues(bool(), "true", ["/b"], "/b");
    expectIssues(bool(), 1, ["/b"], "/b");
    expectIssues(bool(), undefined, ["/b"], "/b");
  });
});

describe("oneOf", () => {
  const v = oneOf(["a", "b"]);
  it("accepts members", () => {
    expectValid(v, "a");
    expectValid(v, "b");
  });
  it("rejects non-members and non-strings, naming the allowed set", () => {
    expectIssues(v, "c", ["/k"], "/k");
    expectIssues(v, 1, ["/k"], "/k");
    const r = v("c");
    expect(r.ok ? [] : r.issues[0]?.message).toBe("expected one of a, b");
  });
});

describe("isoDate", () => {
  it.each([
    "2026-09-01T14:02:11Z",
    "2026-09-01T14:02:11.123Z",
    "2026-09-01T14:02:11.123456+00:00",
    "2026-09-01T14:02:11-05:00",
    new Date(0).toISOString(),
  ])("accepts %s", (input) => {
    expectValid(isoDate(), input);
  });

  it.each(["2026-09-01", "yesterday", "2026-09-01T14:02:11", "2026-13-01T00:00:00Z", 1_700_000_000, null])(
    "rejects %s",
    (input) => {
      expectIssues(isoDate(), input, ["/at"], "/at");
    },
  );
});

describe("opt / nullable", () => {
  it("opt passes undefined through and validates anything else", () => {
    expectValid(opt(str()), undefined);
    expectValid(opt(str()), "x");
    expectIssues(opt(str()), null, ["/o"], "/o");
    expectIssues(opt(str()), 1, ["/o"], "/o");
  });
  it("nullable passes null through and validates anything else", () => {
    expectValid(nullable(str()), null);
    expectValid(nullable(str()), "x");
    expectIssues(nullable(str()), undefined, ["/n"], "/n");
    expectIssues(nullable(str()), 1, ["/n"], "/n");
  });
  it("compose for `string | null | undefined`", () => {
    const v = opt(nullable(str()));
    expectValid(v, undefined);
    expectValid(v, null);
    expectValid(v, "x");
    expectIssues(v, 0, ["/c"], "/c");
  });
});

describe("arr", () => {
  it("validates every item and reports each bad index", () => {
    expectValid(arr(int()), [1, 2, 3]);
    expectValid(arr(int()), []);
    expectIssues(arr(int()), [1, "x", 3, "y"], ["/xs/1", "/xs/3"], "/xs");
  });
  it("rejects non-arrays at the array path", () => {
    expectIssues(arr(int()), "abc", ["/xs"], "/xs");
    expectIssues(arr(int()), { length: 1 }, ["/xs"], "/xs");
  });
  it("enforces min and max", () => {
    expectIssues(arr(int(), { max: 2 }), [1, 2, 3], ["/xs"], "/xs");
    expectIssues(arr(int(), { min: 1 }), [], ["/xs"], "/xs");
    expectValid(arr(int(), { min: 1, max: 2 }), [1]);
  });
  it("flags duplicates at the repeated index", () => {
    expectIssues(arr(str(), { unique: true }), ["a", "b", "a"], ["/xs/2"], "/xs");
    expectIssues(arr(obj<{ k: string }>({ k: str() }), { unique: true }), [{ k: "a" }, { k: "a" }], ["/xs/1"], "/xs");
    expectValid(arr(str(), { unique: true }), ["a", "b"]);
  });
  it("returns a fresh array of the item validators' values", () => {
    const input = [" a ", "b"];
    const r = arr(str({ trim: true }))(input);
    expect(r).toEqual({ ok: true, value: ["a", "b"] });
    expect(input).toEqual([" a ", "b"]);
  });
});

describe("obj", () => {
  type Shape = { id: string; n?: number; tags: string[] };
  const v = obj<Shape>({ id: str({ min: 1 }), n: opt(int()), tags: arr(str()) });

  it("accepts a full and a minimal object", () => {
    expectValid(v, { id: "a", n: 1, tags: ["x"] });
    expectValid(v, { id: "a", tags: [] });
  });

  it("reports every failing field at its pointer", () => {
    expectIssues(v, { id: "", n: "1", tags: [1] }, ["/id", "/n", "/tags/0"]);
    expectIssues(v, {}, ["/id", "/tags"]);
  });

  it("nests pointers through the parent path", () => {
    const outer = obj<{ inner: Shape }>({ inner: v });
    expectIssues(outer, { inner: { id: "x", tags: "no" } }, ["/doc/inner/tags"], "/doc");
  });

  it("rejects non-objects at the object path", () => {
    expectIssues(v, null, ["/o"], "/o");
    expectIssues(v, [], ["/o"], "/o");
    expectIssues(v, "str", ["/o"], "/o");
    expectIssues(v, new Date(), ["/o"], "/o");
  });

  it("drops unknown keys and undefined values unless strict", () => {
    const r = v({ id: "a", tags: [], extra: true, n: undefined });
    expect(r).toEqual({ ok: true, value: { id: "a", tags: [] } });
  });

  it("strict objects reject unknown keys, one issue per key", () => {
    const strict = obj<Shape>({ id: str(), n: opt(int()), tags: arr(str()) }, { strict: true });
    expectIssues(strict, { id: "a", tags: [], extra: true, more: 1 }, ["/extra", "/more"]);
    expectValid(strict, { id: "a", tags: [] });
    // An own "__proto__" key (as JSON.parse creates it) is an unknown key like any other.
    expectIssues(strict, JSON.parse('{"id":"a","tags":[],"__proto__":{"x":1}}'), ["/__proto__"]);
  });

  it("does not mutate its input", () => {
    const input = { id: " a ", tags: [] as string[] };
    const trimmed = obj<Shape>({ id: str({ trim: true }), n: opt(int()), tags: arr(str()) });
    expect(trimmed(input)).toEqual({ ok: true, value: { id: "a", tags: [] } });
    expect(input.id).toBe(" a ");
  });

  it("reads own properties only (a prototype key is not a value)", () => {
    expectValid(v, Object.assign(Object.create(null), { id: "a", tags: [] }), { id: "a", tags: [] });
  });
});

describe("refine / raw", () => {
  it("refine runs cross-field checks after the shape passes", () => {
    const v = refine(obj<{ lo: number; hi: number }>({ lo: num(), hi: num() }), (r, path) =>
      r.lo > r.hi ? [{ path: pointer(path, "hi"), message: "must be ≥ lo" }] : [],
    );
    expectValid(v, { lo: 1, hi: 2 });
    expectIssues(v, { lo: 3, hi: 2 }, ["/r/hi"], "/r");
    // Shape issues come first and the refinement does not run on garbage.
    expectIssues(v, { lo: "x", hi: 2 }, ["/r/lo"], "/r");
  });
  it("raw accepts anything unchanged", () => {
    const fn = (): void => {};
    expectValid(raw(), fn);
    expectValid(raw(), undefined);
  });
});

describe("union", () => {
  type A = { type: "a"; x: number };
  type B = { type: "b"; y: string };
  const v = union<A | B>("type", {
    a: obj<A>({ type: oneOf(["a"]), x: num() }),
    b: obj<B>({ type: oneOf(["b"]), y: str() }),
  });
  it("dispatches on the discriminant", () => {
    expectValid(v, { type: "a", x: 1 });
    expectValid(v, { type: "b", y: "s" });
  });
  it("reports an unknown or missing discriminant at its pointer", () => {
    expectIssues(v, { type: "c" }, ["/e/type"], "/e");
    expectIssues(v, { x: 1 }, ["/e/type"], "/e");
    expectIssues(v, { type: 1 }, ["/e/type"], "/e");
  });
  it("reports variant issues under the same path", () => {
    expectIssues(v, { type: "a", x: "no" }, ["/e/x"], "/e");
    expectIssues(v, "not an object", ["/e"], "/e");
  });
});

describe("record", () => {
  it("validates every value at its key", () => {
    expectValid(record(int()), { a: 1, b: 2 });
    expectValid(record(int()), {});
    expectIssues(record(int()), { a: 1, b: "x" }, ["/m/b"], "/m");
  });
  it("caps keys and checks the key pattern", () => {
    expectIssues(record(int(), { maxKeys: 1 }), { a: 1, b: 2 }, ["/m"], "/m");
    expectIssues(record(int(), { keyPattern: /^[a-z]+$/ }), { ok: 1, "Not Ok": 2 }, ["/m/Not Ok"], "/m");
  });
  it("rejects arrays and null", () => {
    expectIssues(record(int()), [], ["/m"], "/m");
    expectIssues(record(int()), null, ["/m"], "/m");
  });
  it("refuses a __proto__ key instead of rewriting the output's prototype", () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
    expectIssues(record(json()), polluted, ["/m/__proto__"], "/m");
    expectIssues(record(int()), polluted, ["/m/__proto__"], "/m");
    const clean = record(json())({ ok: 1 });
    expect(clean.ok && Object.getPrototypeOf(clean.value)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("json", () => {
  it.each([
    ["null", null],
    ["string", "s"],
    ["number", 1.5],
    ["boolean", true],
    ["array", [1, "a", null]],
    ["object", { a: { b: [1, { c: null }] } }],
    ["empty containers", { a: [], b: {} }],
  ])("accepts %s", (_, input) => {
    expectValid(json(), input);
  });

  it.each([
    ["undefined", undefined, ["/v"]],
    ["function", () => 1, ["/v"]],
    ["bigint", 10n, ["/v"]],
    ["symbol", Symbol("s"), ["/v"]],
    ["NaN", Number.NaN, ["/v"]],
    ["Date instance", new Date(), ["/v"]],
    ["nested undefined", { a: [1, undefined] }, ["/v/a/1"]],
    ["nested class instance", { a: new Map() }, ["/v/a"]],
  ])("rejects %s at the offending path", (_, input, expected) => {
    expectIssues(json(), input, expected, "/v");
  });

  it("rejects cycles instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectIssues(json(), cyclic, ["/v/self"], "/v");
  });

  it("measures depth as container nesting", () => {
    expectValid(json({ maxDepth: 1 }), [1]);
    expectValid(json({ maxDepth: 2 }), { a: [1] });
    expectValid(json({ maxDepth: 3 }), { a: { b: { c: 1 } } });
    expectValid(json({ maxDepth: 1 }), { a: 1, b: "s" });
    expectIssues(json({ maxDepth: 1 }), [[1]], [""]);
    expectIssues(json({ maxDepth: 2 }), { a: { b: { c: 1 } } }, [""]);
    expectIssues(json({ maxDepth: 1 }), { a: [1], b: [2] }, [""]);
    expectIssues(json({ maxDepth: 2 }), { a: [[1]], b: [[2]] }, [""]);
  });

  it("reports the subtree that is exactly one level too deep, once per branch", () => {
    // The container of height maxDepth + 1 is where the excess starts; its
    // ancestors are not reported again, so the retry prompt names one spot.
    expectIssues(json({ maxDepth: 2 }), { a: { b: { c: { d: 1 } } } }, ["/a"]);
    expectIssues(json({ maxDepth: 2 }), { a: { b: { c: { d: 1 } } }, e: { f: { g: { h: 1 } } } }, ["/a", "/e"]);
    expectIssues(json({ maxDepth: 1 }), { a: { b: { c: { d: 1 } } } }, ["/a/b"]);
  });

  it("caps serialised size in UTF-8 bytes", () => {
    expectValid(json({ maxBytes: 10 }), "12345678");
    expectIssues(json({ maxBytes: 10 }), "123456789", ["/v"], "/v");
    // "é" is two bytes in UTF-8: 4 × "é" + 2 quotes = 10 bytes; 5 × "é" is 12.
    expectValid(json({ maxBytes: 10 }), "éééé");
    expectIssues(json({ maxBytes: 10 }), "ééééé", ["/v"], "/v");
  });

  it("caps the longest string anywhere inside", () => {
    expectValid(json({ maxStringChars: 3 }), { a: ["abc"] });
    expectIssues(json({ maxStringChars: 3 }), { a: ["abcd"] }, ["/v/a/0"], "/v");
  });

  it("rebuilds every container, so the value aliases nothing in the input", () => {
    const input = { a: { b: [1, { c: null }] }, d: [] as number[] };
    const result = json()(input);
    expect(result).toEqual({ ok: true, value: input });
    if (!result.ok) return;
    const value = result.value as typeof input;
    expect(value).not.toBe(input);
    expect(value.a).not.toBe(input.a);
    expect(value.a.b).not.toBe(input.a.b);
    expect(value.a.b[1]).not.toBe(input.a.b[1]);
    expect(value.d).not.toBe(input.d);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(json()("s")).toEqual({ ok: true, value: "s" });
  });

  it("refuses a __proto__ key at any depth", () => {
    expectIssues(json(), JSON.parse('{"__proto__":{"polluted":true}}'), ["/v/__proto__"], "/v");
    expectIssues(json(), JSON.parse('{"a":[{"__proto__":1}]}'), ["/v/a/0/__proto__"], "/v");
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("validators never throw", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const hostile: unknown[] = [
    undefined,
    null,
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    "x",
    [],
    [undefined],
    {},
    Object.create(null),
    new Date(),
    () => {},
    Symbol("s"),
    10n,
    cyclic,
    { type: null },
    { type: {} },
    JSON.parse('{"__proto__":{"polluted":true},"a":"x","type":"a"}'),
  ];
  const validators: [string, Validator<unknown>][] = [
    ["str", str({ min: 1, max: 5, pattern: /x/, trim: true, lower: true })],
    ["num", num({ min: 0, max: 1 })],
    ["int", int({ min: 0 })],
    ["bool", bool()],
    ["oneOf", oneOf(["a"])],
    ["isoDate", isoDate()],
    ["opt", opt(str())],
    ["nullable", nullable(str())],
    ["arr", arr(str(), { max: 1, unique: true })],
    ["obj", obj<{ a: string }>({ a: str() }, { strict: true })],
    ["record", record(str(), { maxKeys: 1, keyPattern: /a/ })],
    ["union", union<{ type: "a" }>("type", { a: obj<{ type: "a" }>({ type: oneOf(["a"]) }) })],
    ["json", json({ maxBytes: 8, maxDepth: 1, maxStringChars: 1 })],
    ["refine", refine(str(), () => [])],
  ];
  it.each(validators)("%s returns a result for every hostile input", (_, v) => {
    for (const input of hostile) {
      const result = v(input);
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});
