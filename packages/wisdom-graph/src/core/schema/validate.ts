/**
 * validate.ts — hand-rolled validator combinators.
 *
 * The library has four trust boundaries (consumer input to `ingest()` and
 * `recall()`, LLM proposals, rows read back from a store) and zero runtime
 * dependencies, so it cannot lean on zod. What it needs is small: a
 * `Validator<T>` is a function from `unknown` to either a typed value or a
 * list of `{ path, message }` issues with JSON-pointer paths, and the
 * combinators below compose them. Validators never throw — a boundary that
 * throws would turn "bad row" into "recall failed", which must-have 2
 * forbids — and never mutate their input.
 *
 * Three deliberate behaviours:
 *
 *   - A validated value is rebuilt, not passed through. `obj` copies only the
 *     declared keys, so unknown keys are stripped unless `strict` (LLM output)
 *     asks for them to be issues; keys whose value is `undefined` are omitted so
 *     the result is JSON-clean; `json` rebuilds every container, so nothing an
 *     LLM or a store handed in is aliased by what the library keeps or freezes.
 *   - A `__proto__` key is an issue, never copied. Assigning it on a rebuilt
 *     object swaps that object's prototype instead of adding a property, and
 *     the same trap would wait for any caller that later spreads or
 *     `Object.assign`s the value — so every combinator that copies input keys
 *     (`record`, `json`) refuses it at the key's pointer.
 *   - `str` can trim and lower-case before checking. That is parsing, not just
 *     validation, and it is there so the same combinator canonicalises what an
 *     LLM proposes and what a store returns.
 */

import type { JsonValue } from "../types";

export type Issue = { path: string; message: string };
export type Valid<T> = { ok: true; value: T };
export type Invalid = { ok: false; issues: Issue[] };
export type Validation<T> = Valid<T> | Invalid;

/** `path` is the JSON pointer of `u` inside the document being validated; "" at the root. */
export type Validator<T> = (u: unknown, path?: string) => Validation<T>;

/** The output type of a validator. */
export type Output<V> = V extends Validator<infer T> ? T : never;

export function ok<T>(value: T): Valid<T> {
  return { ok: true, value };
}

export function fail(path: string, message: string): Invalid {
  return { ok: false, issues: [{ path, message }] };
}

export function invalid(issues: Issue[]): Invalid {
  return { ok: false, issues };
}

/** JSON-pointer child: `pointer("", "a")` → `"/a"`, `pointer("/a", 0)` → `"/a/0"`; `~` and `/` escaped per RFC 6901. */
export function pointer(path: string, key: string | number): string {
  const segment = typeof key === "number" ? String(key) : key.replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path}/${segment}`;
}

/** The issue for the one key a rebuilt object must never carry (see the header). */
function prototypeKeyIssue(path: string, key: string): Issue | undefined {
  return key === "__proto__" ? { path: pointer(path, key), message: '"__proto__" is not an allowed key' } : undefined;
}

/** A plain object: not null, not an array, not a class instance. */
export function isPlainObject(u: unknown): u is Record<string, unknown> {
  if (u === null || typeof u !== "object" || Array.isArray(u)) return false;
  const proto = Object.getPrototypeOf(u) as unknown;
  return proto === Object.prototype || proto === null;
}

// ── Objects ──────────────────────────────────────────────────────────────────

/** One validator per key of `T`; optional keys take `opt(...)`. */
export type ObjectFields<T> = { [K in keyof T]-?: Validator<T[K]> };

/**
 * Validate every declared key and rebuild the object from the results.
 * `strict` turns unknown keys into issues; otherwise they are dropped.
 */
export function obj<T extends object>(fields: ObjectFields<T>, opts: { strict?: boolean } = {}): Validator<T> {
  const keys = Object.keys(fields) as (keyof T & string)[];
  return (u, path = "") => {
    if (!isPlainObject(u)) return fail(path, "expected an object");
    const issues: Issue[] = [];
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const result = fields[key](u[key], pointer(path, key));
      if (!result.ok) issues.push(...result.issues);
      else if (result.value !== undefined) out[key] = result.value;
    }
    if (opts.strict) {
      for (const key of Object.keys(u)) {
        if (!Object.hasOwn(fields, key)) issues.push({ path: pointer(path, key), message: "unknown key" });
      }
    }
    // `out` holds exactly the keys of `fields`, each already validated to
    // `T[K]`; the record type is only how it was assembled.
    return issues.length > 0 ? invalid(issues) : ok(out as unknown as T);
  };
}

/** Run `v`, then `check` on the typed value for rules that span several fields. */
export function refine<T>(v: Validator<T>, check: (value: T, path: string) => Issue[]): Validator<T> {
  return (u, path = "") => {
    const result = v(u, path);
    if (!result.ok) return result;
    const issues = check(result.value, path);
    return issues.length > 0 ? invalid(issues) : result;
  };
}

/** Accept anything as-is (for `args: unknown`-style pass-through fields). */
export function raw(): Validator<unknown> {
  return (u) => ok(u);
}

// ── Scalars ──────────────────────────────────────────────────────────────────

export interface StrOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** Trim before checking; the trimmed string is the value. */
  trim?: boolean;
  /** Lower-case before checking; the lower-cased string is the value. */
  lower?: boolean;
}

export function str(opts: StrOptions = {}): Validator<string> {
  return (u, path = "") => {
    if (typeof u !== "string") return fail(path, "expected a string");
    let value = u;
    if (opts.trim) value = value.trim();
    if (opts.lower) value = value.toLowerCase();
    if (opts.min !== undefined && value.length < opts.min) {
      return fail(path, opts.min === 1 ? "must not be empty" : `must be at least ${opts.min} characters`);
    }
    if (opts.max !== undefined && value.length > opts.max) return fail(path, `must be at most ${opts.max} characters`);
    if (opts.pattern && !opts.pattern.test(value)) return fail(path, `must match ${opts.pattern.source}`);
    return ok(value);
  };
}

export interface NumOptions {
  min?: number;
  max?: number;
}

function rangeIssue(value: number, opts: NumOptions, path: string): Invalid | null {
  if (opts.min !== undefined && value < opts.min) return fail(path, `must be at least ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) return fail(path, `must be at most ${opts.max}`);
  return null;
}

/** A finite number (NaN and ±Infinity are rejected: they do not survive JSON). */
export function num(opts: NumOptions = {}): Validator<number> {
  return (u, path = "") => {
    if (typeof u !== "number" || !Number.isFinite(u)) return fail(path, "expected a number");
    return rangeIssue(u, opts, path) ?? ok(u);
  };
}

export function int(opts: NumOptions = {}): Validator<number> {
  return (u, path = "") => {
    if (typeof u !== "number" || !Number.isInteger(u)) return fail(path, "expected an integer");
    return rangeIssue(u, opts, path) ?? ok(u);
  };
}

export function bool(): Validator<boolean> {
  return (u, path = "") => (typeof u === "boolean" ? ok(u) : fail(path, "expected a boolean"));
}

export function oneOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  const allowed = new Set<string>(values);
  const list = values.join(", ");
  return (u, path = "") => {
    if (typeof u === "string" && allowed.has(u)) return ok(u as T[number]);
    return fail(path, `expected one of ${list}`);
  };
}

/** ISO-8601 date-time with a zone (`Z` or `±hh:mm`), as `toISOString()` and Postgres emit it. */
export function isoDate(): Validator<string> {
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  return (u, path = "") => {
    if (typeof u !== "string") return fail(path, "expected an ISO-8601 date-time string");
    if (!shape.test(u) || Number.isNaN(Date.parse(u))) return fail(path, "expected an ISO-8601 date-time");
    return ok(u);
  };
}

// ── Wrappers ─────────────────────────────────────────────────────────────────

export function opt<T>(v: Validator<T>): Validator<T | undefined> {
  return (u, path = "") => (u === undefined ? ok(undefined) : v(u, path));
}

export function nullable<T>(v: Validator<T>): Validator<T | null> {
  return (u, path = "") => (u === null ? ok(null) : v(u, path));
}

// ── Collections ──────────────────────────────────────────────────────────────

export interface ArrOptions {
  min?: number;
  max?: number;
  /** Reject repeated items (compared by value for primitives, by JSON text otherwise). */
  unique?: boolean;
}

export function arr<T>(item: Validator<T>, opts: ArrOptions = {}): Validator<T[]> {
  return (u, path = "") => {
    if (!Array.isArray(u)) return fail(path, "expected an array");
    if (opts.min !== undefined && u.length < opts.min) {
      return fail(path, opts.min === 1 ? "must not be empty" : `must have at least ${opts.min} items`);
    }
    if (opts.max !== undefined && u.length > opts.max) return fail(path, `must have at most ${opts.max} items`);
    const issues: Issue[] = [];
    const out: T[] = [];
    const seen = new Set<unknown>();
    u.forEach((element, index) => {
      const result = item(element, pointer(path, index));
      if (!result.ok) {
        issues.push(...result.issues);
        return;
      }
      if (opts.unique) {
        const key = typeof result.value === "object" && result.value !== null ? JSON.stringify(result.value) : result.value;
        if (seen.has(key)) issues.push({ path: pointer(path, index), message: "duplicate item" });
        seen.add(key);
      }
      out.push(result.value);
    });
    return issues.length > 0 ? invalid(issues) : ok(out);
  };
}

export interface RecordOptions {
  maxKeys?: number;
  keyPattern?: RegExp;
}

export function record<T>(value: Validator<T>, opts: RecordOptions = {}): Validator<Record<string, T>> {
  return (u, path = "") => {
    if (!isPlainObject(u)) return fail(path, "expected an object");
    const entries = Object.entries(u);
    if (opts.maxKeys !== undefined && entries.length > opts.maxKeys) {
      return fail(path, `must have at most ${opts.maxKeys} keys`);
    }
    const issues: Issue[] = [];
    const out: Record<string, T> = {};
    for (const [key, element] of entries) {
      const childPath = pointer(path, key);
      const prototype = prototypeKeyIssue(path, key);
      if (prototype) {
        issues.push(prototype);
        continue;
      }
      if (opts.keyPattern && !opts.keyPattern.test(key)) {
        issues.push({ path: childPath, message: `key must match ${opts.keyPattern.source}` });
        continue;
      }
      const result = value(element, childPath);
      if (result.ok) out[key] = result.value;
      else issues.push(...result.issues);
    }
    return issues.length > 0 ? invalid(issues) : ok(out);
  };
}

/** Selects the variant named by `u[discriminant]`; the issue for an unknown tag sits at the discriminant's path. */
export function union<T>(discriminant: string, variants: Record<string, Validator<T>>): Validator<T> {
  const names = Object.keys(variants).join(", ");
  return (u, path = "") => {
    if (!isPlainObject(u)) return fail(path, "expected an object");
    const tag = u[discriminant];
    const variant = typeof tag === "string" && Object.hasOwn(variants, tag) ? variants[tag] : undefined;
    if (!variant) return fail(pointer(path, discriminant), `expected one of ${names}`);
    return variant(u, path);
  };
}

// ── JSON ─────────────────────────────────────────────────────────────────────

export interface JsonOptions {
  /** UTF-8 bytes of the serialised value. */
  maxBytes?: number;
  /** Container nesting: a scalar is 0, `[1]` is 1, `{ a: [1] }` is 2. */
  maxDepth?: number;
  /** Longest string anywhere inside the value. */
  maxStringChars?: number;
}

const encoder = new TextEncoder();

/**
 * A `JsonValue`: only what `JSON.parse` can produce. Functions, `undefined`,
 * bigints, non-finite numbers, class instances (a `Date`, say), cycles and a
 * `__proto__` key are issues at the offending path rather than silently
 * coerced. Containers come back as fresh arrays and objects — the walk visits
 * every node anyway, and a value that aliases LLM or store input could be
 * mutated behind a frozen row.
 */
export function json(opts: JsonOptions = {}): Validator<JsonValue> {
  type Walked = { value: JsonValue; depth: number };
  const walk = (u: unknown, path: string, issues: Issue[], seen: Set<object>): Walked => {
    if (u === null || typeof u === "string" || typeof u === "boolean") {
      if (typeof u === "string" && opts.maxStringChars !== undefined && u.length > opts.maxStringChars) {
        issues.push({ path, message: `must be at most ${opts.maxStringChars} characters` });
      }
      return { value: u, depth: 0 };
    }
    if (typeof u === "number") {
      if (!Number.isFinite(u)) issues.push({ path, message: "expected a finite number" });
      return { value: u, depth: 0 };
    }
    if (Array.isArray(u) || isPlainObject(u)) {
      if (seen.has(u)) {
        issues.push({ path, message: "circular reference" });
        return { value: null, depth: 0 };
      }
      seen.add(u);
      let deepest = 0;
      let value: JsonValue;
      if (Array.isArray(u)) {
        const items: JsonValue[] = [];
        u.forEach((element, index) => {
          const child = walk(element, pointer(path, index), issues, seen);
          deepest = Math.max(deepest, child.depth);
          items.push(child.value);
        });
        value = items;
      } else {
        const fields: { [k: string]: JsonValue } = {};
        for (const [key, element] of Object.entries(u)) {
          const prototype = prototypeKeyIssue(path, key);
          if (prototype) {
            issues.push(prototype);
            continue;
          }
          const child = walk(element, pointer(path, key), issues, seen);
          deepest = Math.max(deepest, child.depth);
          fields[key] = child.value;
        }
        value = fields;
      }
      seen.delete(u);
      const here = 1 + deepest;
      if (opts.maxDepth !== undefined && here === opts.maxDepth + 1) {
        // Report once per branch, at the container that first crosses the limit.
        issues.push({ path, message: `nesting must be at most ${opts.maxDepth} deep` });
      }
      return { value, depth: here };
    }
    issues.push({ path, message: "expected a JSON value" });
    return { value: null, depth: 0 };
  };
  return (u, path = "") => {
    const issues: Issue[] = [];
    const { value } = walk(u, path, issues, new Set());
    if (issues.length > 0) return invalid(issues);
    if (opts.maxBytes !== undefined) {
      const bytes = encoder.encode(JSON.stringify(value)).length;
      if (bytes > opts.maxBytes) return fail(path, `must serialise to at most ${opts.maxBytes} bytes`);
    }
    return ok(value);
  };
}
