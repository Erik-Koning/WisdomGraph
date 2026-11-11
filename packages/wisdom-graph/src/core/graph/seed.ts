/**
 * seed.ts — the configured categories as rows, and the one place a seed
 * regex is judged safe.
 *
 * A subject's tree starts from configuration, not from the LLM: the root and
 * one locked level-1 node per `CategorySpec` (spec §3.1). Two things about
 * that seeding are load-bearing and live here so they are defined once:
 *
 *   - Ids are `deterministicId("n", tenant, subject, path)`. Materialisation
 *     happens on a subject's first write and again whenever a category is
 *     added later; the same path must mint the same id every time, so an
 *     `upsertNode` replayed after a crash is a no-op and the virtual overlay
 *     `compileSnapshot` builds for a subject with no rows carries the ids the
 *     rows will have once written.
 *   - Seed `patterns` are the only regexes the library ever compiles from
 *     text, and they run on raw user text at recall time (§4.2 step 3). They
 *     are validated at construction (§9.2) — length, no nested quantifiers,
 *     no back-references, flags `iu` only — and an unsafe one is a
 *     `TypeError` before any engine exists, because a catastrophic regex
 *     discovered on the hot path would break the never-reject budget, and
 *     the LLM cannot write patterns (decision 8), so construction is the
 *     only gate needed.
 *
 * Category names become path slugs, so they obey the slug rule, must be
 * unique, and may not be `direct`: the router's "no specialist" outcome is
 * implicit and is never a node. Everything else a spec leaves out takes the
 * default spec §2.7 names (the title from the name, empty description), and
 * the built row is run through the node validator so a keyword or title the
 * store would refuse fails here, at construction, with the category named.
 */

import { deterministicId } from "../ids";
import { systemClock, type ClockPort, type SubjectRef } from "../ports";
import type { CategorySpec, HintLane, TopicNode } from "../types";
import { validateNode } from "../schema/node";
import { HINT_LANES } from "../schema/hint";
import { ROOT_PATH, isValidSlug, join } from "./paths";

/** Longest seed pattern source accepted (§9.2). */
export const MAX_PATTERN_CHARS = 200;
/** The only flags a seed pattern is compiled with (§9.2). */
export const SEED_PATTERN_FLAGS = "iu";
/** The implicit category: the router's "answer directly" outcome, never a node (§2.7). */
export const DIRECT_CATEGORY = "direct";

/** The root node's fixed title and description; the row every subject's tree hangs off. */
export const ROOT_TITLE = "Global";
export const ROOT_DESCRIPTION = "Preferences that apply to every conversation.";

// ── Pattern safety ───────────────────────────────────────────────────────────

/** A quantifier that repeats: `+`, `*`, or a `{n}`/`{n,}`/`{n,m}` brace form. */
const BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

/**
 * Why `source` must not be compiled, or `undefined` when it is safe on the
 * §9.2 rules. A small scanner rather than a regex over the regex: it tracks
 * escapes, character classes and group nesting, so `[+]` and `\(` are
 * literals, `(?:…)`'s `?` is not a quantifier, and a repeat inside a group
 * is noticed even when the group is itself nested in another.
 */
function unsafeReason(source: string): string | undefined {
  if (source.length === 0) return "is empty";
  if (source.length > MAX_PATTERN_CHARS) return `is longer than ${MAX_PATTERN_CHARS} characters`;
  const open: { repeats: boolean }[] = [];
  let inClass = false;
  // The group that just closed, until the next atom: a quantifier here
  // applies to it, and that is the nesting the rule forbids.
  let closed: { repeats: boolean } | undefined;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) return "ends with a backslash";
      if (!inClass && next >= "1" && next <= "9") return `contains the back-reference \\${next}`;
      if (!inClass && next === "k" && source[i + 2] === "<") return "contains a named back-reference";
      i += 1;
      closed = undefined;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    switch (ch) {
      case "[":
        inClass = true;
        closed = undefined;
        break;
      case "(":
        open.push({ repeats: false });
        if (source[i + 1] === "?") i += 1;
        closed = undefined;
        break;
      case ")": {
        const group = open.pop();
        if (group === undefined) return "has an unbalanced parenthesis";
        const parent = open.at(-1);
        if (group.repeats && parent !== undefined) parent.repeats = true;
        closed = group;
        break;
      }
      case "+":
      case "*":
      case "{": {
        let width = 1;
        if (ch === "{") {
          const brace = BRACE_QUANTIFIER.exec(source.slice(i));
          // A lone brace is not a quantifier; the compiler will judge it.
          if (brace === null) {
            closed = undefined;
            break;
          }
          width = brace[0].length;
        }
        if (closed?.repeats) return "nests a quantifier inside a quantified group";
        const parent = open.at(-1);
        if (parent !== undefined) parent.repeats = true;
        i += width - 1;
        closed = undefined;
        break;
      }
      default:
        // `?` (optional, or the lazy marker) never repeats; anything else is an atom.
        closed = undefined;
    }
  }
  if (open.length > 0) return "has an unbalanced parenthesis";
  if (inClass) return "has an unterminated character class";
  return undefined;
}

/** Throws `TypeError` unless `source` obeys the §9.2 rules and compiles with flags `iu`. */
export function assertSafePattern(source: string): void {
  const reason = unsafeReason(source);
  if (reason !== undefined) throw new TypeError(`unsafe seed pattern ${JSON.stringify(source)}: ${reason}`);
  try {
    new RegExp(source, SEED_PATTERN_FLAGS);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new TypeError(`invalid seed pattern ${JSON.stringify(source)}: ${detail}`);
  }
}

/** The compiled form of a safe seed pattern; `TypeError` otherwise. */
export function compileSeedPattern(source: string): RegExp {
  assertSafePattern(source);
  return new RegExp(source, SEED_PATTERN_FLAGS);
}

// ── Category resolution ──────────────────────────────────────────────────────

/** Timestamp of the throw-away row `resolveCategories` validates; never stored. */
const EPOCH = new Date(0).toISOString();

/** A `CategorySpec` with every default applied and every rule checked. */
export interface ResolvedCategory {
  name: string;
  title: string;
  description: string;
  keywords: string[];
  patterns: string[];
  lanes: HintLane[];
  /** The level-1 path the category occupies: `"/" + name`. */
  path: string;
  /**
   * Word-bounded, case-insensitive match of the name or the title, for the
   * classifier's agent-mention bonus (§4.2 step 3). Compiled here, once per
   * configuration, because the classifier runs per query and would otherwise
   * rebuild the same two regexes for every category on every recall.
   */
  mention: RegExp;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex that matches any of `phrases` as whole words in normalised text —
 * `alpha` in "ask alpha" but not in "the alphabet". Boundaries are spelled
 * out with Unicode classes because `\b` is ASCII-only even under the `u`
 * flag. Never global: a shared, frozen regex must carry no `lastIndex`.
 */
export function mentionPattern(phrases: readonly string[]): RegExp {
  const alternatives = phrases
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map(escapeRegex);
  // `(?!)` never matches: an empty phrase list mentions nothing.
  const body = alternatives.length > 0 ? `(?:${alternatives.join("|")})` : "(?!)";
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${body}(?:$|[^\\p{L}\\p{N}_])`, "iu");
}

/** `"consult_market_analyst"` → `"Market Analyst"`: the §2.7 default title. */
export function defaultCategoryTitle(name: string): string {
  const stripped = name.replace(/^consult[_ -]+/, "");
  const words = stripped
    .split(/[_ -]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length === 0 ? name : words.join(" ");
}

function categoryError(name: string, message: string): TypeError {
  return new TypeError(`category ${JSON.stringify(name)}: ${message}`);
}

/**
 * Apply defaults and check every construction-time rule: slug-shaped, unique,
 * not `direct`, safe patterns, and a row the node validator accepts.
 * Keywords come back the way the validator stores them — trimmed,
 * lower-cased, de-duplicated — so the seeded node and the classifier index
 * agree on their spelling.
 */
export function resolveCategories(categories: readonly CategorySpec[]): ResolvedCategory[] {
  const seen = new Set<string>();
  const out: ResolvedCategory[] = [];
  for (const spec of categories) {
    const name = spec.name;
    if (typeof name !== "string" || !isValidSlug(name)) {
      throw new TypeError(`category name ${JSON.stringify(name)} must be a slug (^[a-z0-9][a-z0-9_-]{0,39}$)`);
    }
    if (name === DIRECT_CATEGORY) throw categoryError(name, "is implicit and cannot be configured as a node");
    if (seen.has(name)) throw categoryError(name, "is configured twice");
    seen.add(name);
    const patterns = [...(spec.patterns ?? [])];
    for (const source of patterns) assertSafePattern(source);
    const lanes = spec.lanes === undefined ? [...HINT_LANES] : [...spec.lanes];
    for (const lane of lanes) {
      if (!HINT_LANES.includes(lane)) throw categoryError(name, `unknown lane ${JSON.stringify(lane)}`);
    }
    const title = spec.title?.trim() || defaultCategoryTitle(name);
    const description = spec.description?.trim() ?? "";
    // The validator is the authority on title/description/keyword shape; a
    // throw-away ref is enough to run it, since only the text fields matter.
    const probe = validateNode(
      buildNode({ tenantId: null, subjectId: "seed" }, join(ROOT_PATH, name), {
        title,
        description,
        keywords: [...spec.keywords],
        patterns,
        agents: [name],
      }, EPOCH),
    );
    if (!probe.ok) {
      throw categoryError(name, probe.issues.map((i) => `${i.path} ${i.message}`).join("; "));
    }
    out.push({
      name,
      title,
      description,
      keywords: [...new Set(probe.value.keywords)],
      patterns,
      lanes,
      path: probe.value.path,
      mention: mentionPattern([name, title]),
    });
  }
  return out;
}

// ── Node rows ────────────────────────────────────────────────────────────────

function buildNode(
  ref: SubjectRef,
  path: string,
  fields: Pick<TopicNode, "title" | "description" | "keywords" | "patterns" | "agents">,
  at: string,
): TopicNode {
  const level = path === ROOT_PATH ? 0 : 1;
  return {
    id: deterministicId("n", ref.tenantId, ref.subjectId, path),
    tenantId: ref.tenantId,
    subjectId: ref.subjectId,
    path,
    parentPath: level === 0 ? null : ROOT_PATH,
    slug: level === 0 ? "" : path.slice(1),
    title: fields.title,
    description: fields.description,
    keywords: fields.keywords,
    patterns: fields.patterns,
    agents: fields.agents,
    properties: {},
    level,
    locked: true,
    status: "active",
    stats: { activeHints: 0 },
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

/** The locked root row for `ref`, stamped `at`. */
export function rootNode(ref: SubjectRef, at: string): TopicNode {
  return buildNode(ref, ROOT_PATH, { title: ROOT_TITLE, description: ROOT_DESCRIPTION, keywords: [], patterns: [], agents: [] }, at);
}

/** The locked level-1 row for one resolved category, seeded with its own name as the handoff agent. */
export function categoryNode(category: ResolvedCategory, ref: SubjectRef, at: string): TopicNode {
  return buildNode(
    ref,
    category.path,
    {
      title: category.title,
      description: category.description,
      keywords: [...category.keywords],
      patterns: [...category.patterns],
      agents: [category.name],
    },
    at,
  );
}

/**
 * The root and one level-1 node per category for `ref` (spec §3.1), with
 * deterministic ids and every construction-time rule applied. Written on a
 * subject's first write as `upsertNode` ops that are no-ops when present.
 */
export function materialiseCategories(
  categories: readonly CategorySpec[],
  ref: SubjectRef,
  opts: { clock?: ClockPort } = {},
): TopicNode[] {
  const at = new Date((opts.clock ?? systemClock).now()).toISOString();
  const resolved = resolveCategories(categories);
  return [rootNode(ref, at), ...resolved.map((category) => categoryNode(category, ref, at))];
}
