/**
 * Deterministic ids are the crash-idempotency guarantee, so they are pinned
 * to exact values: a change in the hash or the separator would silently make
 * every replayed event create duplicate rows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deterministicId, fnv1a32, fnv1a32Hex, hash64, newId } from "./ids";

describe("fnv1a32", () => {
  it.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
  ])("matches the reference vector for %j", (input, expected) => {
    expect(fnv1a32(input)).toBe(expected);
  });

  it("is an unsigned 32-bit integer and renders as 8 hex digits", () => {
    for (const s of ["", "x", "wisdom", "é", "\u{1F600}"]) {
      const n = fnv1a32(s);
      expect(Number.isInteger(n) && n >= 0 && n <= 0xffffffff).toBe(true);
      expect(fnv1a32Hex(s)).toMatch(/^[0-9a-f]{8}$/);
      expect(parseInt(fnv1a32Hex(s), 16)).toBe(n);
    }
    expect(fnv1a32Hex("")).toBe("811c9dc5");
  });

  it("hashes UTF-8 bytes, so non-ASCII is stable and distinct", () => {
    expect(fnv1a32("é")).toBe(fnv1a32("é"));
    expect(fnv1a32("é")).not.toBe(fnv1a32("e"));
  });
});

describe("hash64", () => {
  it.each([
    ["", "cbf29ce484222325"],
    ["a", "af63dc4c8601ec8c"],
    ["foobar", "85944171f73967e8"],
  ])("matches the reference vector for %j", (input, expected) => {
    expect(hash64(input)).toBe(expected);
  });

  it("always renders 16 hex digits", () => {
    for (const s of ["x", "wisdom", "rm_42", "\u{1F600}"]) expect(hash64(s)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("deterministicId", () => {
  it("is stable for equal inputs and shaped <prefix>_<16 hex>", () => {
    const a = deterministicId("h", null, "rm_42", "turn_1", 0);
    expect(a).toBe(deterministicId("h", null, "rm_42", "turn_1", 0));
    expect(a).toMatch(/^h_[0-9a-f]{16}$/);
    expect(deterministicId("n", "acme", "rm_42", "/consult_advice")).toMatch(/^n_[0-9a-f]{16}$/);
  });

  it("differs across tenant, subject, event and opIndex", () => {
    const base = deterministicId("h", null, "rm_42", "turn_1", 0);
    expect(deterministicId("h", "acme", "rm_42", "turn_1", 0)).not.toBe(base);
    expect(deterministicId("h", null, "rm_43", "turn_1", 0)).not.toBe(base);
    expect(deterministicId("h", null, "rm_42", "turn_2", 0)).not.toBe(base);
    expect(deterministicId("h", null, "rm_42", "turn_1", 1)).not.toBe(base);
    expect(deterministicId("n", null, "rm_42", "turn_1", 0)).not.toBe(base);
  });

  it("treats null, undefined and '' as the same tenant", () => {
    expect(deterministicId("n", null, "rm_42", "/")).toBe(deterministicId("n", "", "rm_42", "/"));
    expect(deterministicId("n", undefined, "rm_42", "/")).toBe(deterministicId("n", "", "rm_42", "/"));
  });

  it("separates parts so concatenation cannot collide", () => {
    expect(deterministicId("x", "ab", "c")).not.toBe(deterministicId("x", "a", "bc"));
    expect(deterministicId("x", "a", "")).not.toBe(deterministicId("x", "a"));
  });

  it("is pinned: prefix + hash64 of the unit-separated parts", () => {
    // Changing the hash, separator or null handling changes this and breaks
    // replay against existing stores.
    const sep = String.fromCharCode(0x1f);
    expect(deterministicId("n", null, "rm_42", "/")).toBe(`n_${hash64(["", "rm_42", "/"].join(sep))}`);
    expect(deterministicId("h", "acme", "rm_42", "turn_1", 3)).toBe(`h_${hash64(["acme", "rm_42", "turn_1", "3"].join(sep))}`);
  });
});

describe("newId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to globalThis.crypto.randomUUID", () => {
    const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
    expect(newId()).toBe("00000000-0000-4000-8000-000000000000");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns fresh UUIDs", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
