/**
 * paths.ts — the algebra of materialised node paths.
 *
 * A subject's topic tree is keyed by path (`"/"`, `"/consult_advice"`,
 * `"/consult_advice/retirement"`), not by parent pointers, because recall
 * needs ancestor chains and category lookups without a second query and the
 * store needs a unique key per `(tenant, subject, path)`. Everything that
 * reasons about the tree — seeding, snapshot overlay, relevance decay by
 * ancestor distance, the organiser's depth cap — goes through these helpers
 * so the string format is defined exactly once.
 *
 * All functions are total: they never throw on a malformed path, they just
 * treat it as the segments they can find. Validation is `isValidPath` /
 * `isValidSlug`, used by the schema validators, not implicit here.
 */

/** The root node's path. */
export const ROOT_PATH = "/";

/** Segment rule from spec §3.5. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** True for one segment that may appear in a path. Root's slug is "" and is not a valid segment. */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** `"/"` or `"/"` + valid slugs joined by `"/"`, with no trailing slash and no empty segment. */
export function isValidPath(path: string): boolean {
  if (path === ROOT_PATH) return true;
  if (!path.startsWith("/") || path.endsWith("/")) return false;
  return path.slice(1).split("/").every(isValidSlug);
}

/** The slugs of a path, root-first; `[]` for `"/"`. */
export function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** `"/"` → 0, `"/a"` → 1, `"/a/b"` → 2. */
export function depth(path: string): number {
  return segments(path).length;
}

/** The last segment; `""` for root. */
export function slugOf(path: string): string {
  return segments(path).at(-1) ?? "";
}

/** The containing path, or `null` for root. */
export function parentPath(path: string): string | null {
  const segs = segments(path);
  if (segs.length === 0) return null;
  return segs.length === 1 ? ROOT_PATH : `/${segs.slice(0, -1).join("/")}`;
}

/** Every proper ancestor, root-first: `"/a/b/c"` → `["/", "/a", "/a/b"]`; `[]` for root. */
export function ancestors(path: string): string[] {
  const segs = segments(path);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) out.push(i === 0 ? ROOT_PATH : `/${segs.slice(0, i).join("/")}`);
  return out;
}

/** `join("/", "a")` → `"/a"`, `join("/a", "b")` → `"/a/b"`. An empty slug returns the parent. */
export function join(parent: string, slug: string): string {
  const segs = [...segments(parent), ...segments(slug)];
  return segs.length === 0 ? ROOT_PATH : `/${segs.join("/")}`;
}

/** True when `path` lies strictly below `ancestor` (a path is not its own descendant). */
export function isDescendant(path: string, ancestor: string): boolean {
  const a = segments(ancestor);
  const p = segments(path);
  if (p.length <= a.length) return false;
  return a.every((seg, i) => p[i] === seg);
}

/** The level-1 segment (the category slug), or `null` for root. */
export function categoryOf(path: string): string | null {
  return segments(path)[0] ?? null;
}

/**
 * Fold free text into a valid slug, or `""` when nothing survives. Accents are
 * stripped rather than transliterated, runs of anything non-slug become one
 * dash, and the result is cut to the 40-char rule so a slug the LLM proposes
 * and a slug derived from a title agree on the same form.
 */
export function slugify(input: string): string {
  const folded = input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return folded.slice(0, 40).replace(/[-_]+$/, "");
}
