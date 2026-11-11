/**
 * ids.ts — random ids for things that happen once, deterministic ids for
 * things that must converge.
 *
 * Crash idempotency (spec §5.2, decision 12) rests on one idea: replaying an
 * event must produce the same rows it produced the first time, so every id
 * minted while processing an event is a pure function of
 * `(tenant, subject, event, opIndex)` and every node id a function of
 * `(tenant, subject, path)`. `deterministicId` is that function.
 *
 * FNV-1a is used rather than a cryptographic hash because the ids only need to
 * be stable and collision-free at graph scale (hundreds of nodes, thousands of
 * hints per subject), and FNV is ~10 lines with no dependency and no async
 * `crypto.subtle` round-trip. Hashing runs over UTF-8 bytes so the same string
 * hashes identically in every runtime.
 *
 * `newId` is `crypto.randomUUID`: a web-standard global, present in Node ≥ 19
 * and every browser, so core/ stays free of `node:crypto`.
 */

const encoder = new TextEncoder();

/** Random UUID v4 for one-off identities (request ids, audit rows). */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** FNV-1a 32-bit over the UTF-8 bytes of `input`, as an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** `fnv1a32` rendered as 8 lower-case hex digits — the form artifacts and spans carry. */
export function fnv1a32Hex(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, "0");
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/** FNV-1a 64-bit over the UTF-8 bytes of `input`, as 16 lower-case hex digits. */
export function hash64(input: string): string {
  let hash = FNV64_OFFSET;
  for (const byte of encoder.encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** What a deterministic id may be built from. `null`/`undefined` read as "" (tenant null ↔ ''). */
export type IdPart = string | number | boolean | null | undefined;

/**
 * ASCII unit separator (0x1f): cannot appear in ids, slugs, paths or event
 * ids, so joining parts with it keeps `("ab", "c")` and `("a", "bc")` distinct.
 */
const PART_SEPARATOR = String.fromCharCode(0x1f);

/**
 * `"<prefix>_<hash64>"` of the parts. `null`/`undefined` collapse to "" because
 * a null tenant and an empty tenant are the same tenant at the store boundary.
 */
export function deterministicId(prefix: string, ...parts: IdPart[]): string {
  const material = parts.map((p) => (p === null || p === undefined ? "" : String(p))).join(PART_SEPARATOR);
  return `${prefix}_${hash64(material)}`;
}
