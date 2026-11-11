/**
 * node.ts — the shape rules for a topic node, and the path/slug/keyword/
 * properties rules that hints and proposals reuse.
 *
 * A node row is trusted by everything downstream (the classifier index, the
 * outline shown to the LLM, ancestor maths), so a row that disagrees with
 * itself — a `path` whose `parentPath`, `slug` or `level` say something else —
 * is rejected rather than repaired: it means the writer and the reader
 * disagree on the path algebra, and hiding that would corrupt relevance
 * scoring silently. Caps default to `defaultPolicy.caps`; `nodeValidator`
 * takes overrides so a consumer's policy applies at every boundary.
 *
 * `properties` is the one free-form bag the LLM may write into. It is
 * validated as JSON, capped in keys, bytes and depth, and reserved keys are
 * rejected so the bag can never shadow a node's real fields in the outline.
 * Prototype keys (`__proto__`, `constructor`, `prototype`) are rejected too:
 * a `set_property` with one of those would reach past the bag into whatever
 * object the bag is later merged into, and nothing legitimate needs them.
 */

import type { JsonValue, TopicNode } from "../types";
import { defaultPolicy, type PolicyConfig } from "../policy";
import { SLUG_PATTERN, depth, isValidPath, parentPath, slugOf } from "../graph/paths";
import {
  arr,
  bool,
  fail,
  int,
  isoDate,
  json,
  nullable,
  num,
  obj,
  ok,
  oneOf,
  opt,
  pointer,
  refine,
  str,
  type Issue,
  type Validator,
} from "./validate";

/** The policy caps the structural validators consult. */
export type ValidatorCaps = Pick<
  PolicyConfig["caps"],
  "maxHintChars" | "maxNodeDepth" | "maxPropertiesKeys" | "maxPropertiesBytes" | "maxOpsPerEvent"
>;

export function resolveCaps(caps: Partial<ValidatorCaps> = {}): ValidatorCaps {
  return { ...defaultPolicy.caps, ...caps };
}

export const KEYWORD_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,39}$/;
export const NODE_STATUSES = ["active", "merged", "retired"] as const;
/** Property keys that would shadow a node's own fields in the outline. */
export const RESERVED_PROPERTY_KEYS = ["keywords", "patterns", "agents", "title", "description"] as const;
/** Property keys that reach an object's prototype instead of a property. */
export const PROTOTYPE_PROPERTY_KEYS = ["__proto__", "constructor", "prototype"] as const;
export const MAX_KEYWORDS = 40;
/** Longest string the LLM may put inside a property value (§9.2). */
export const MAX_PROPERTY_STRING_CHARS = 1000;
/** Properties bag nesting, bag included: `{ a: { b: { c: 1 } } }` is 3. */
export const MAX_PROPERTIES_DEPTH = 3;

const reserved = new Set<string>(RESERVED_PROPERTY_KEYS);
const prototypeKeys = new Set<string>(PROTOTYPE_PROPERTY_KEYS);

/** `"/"` or slugs joined by `"/"`, at most `maxDepth` segments. */
export function pathValidator(maxDepth: number = defaultPolicy.caps.maxNodeDepth): Validator<string> {
  return (u, path = "") => {
    if (typeof u !== "string") return fail(path, "expected a path string");
    if (!isValidPath(u)) return fail(path, 'expected "/" or "/" + slugs joined by "/"');
    if (depth(u) > maxDepth) return fail(path, `path depth must be at most ${maxDepth}`);
    return ok(u);
  };
}

export const slugValidator: Validator<string> = str({ pattern: SLUG_PATTERN });

/** Lower-cased and trimmed before the pattern check, so "RRSP " and "rrsp" agree. */
export const keywordValidator: Validator<string> = str({ trim: true, lower: true, pattern: KEYWORD_PATTERN });

export const keywordsValidator: Validator<string[]> = arr(keywordValidator, { max: MAX_KEYWORDS });

/** Non-empty, bounded, not a reserved name, not a prototype key. */
export const propertyKeyValidator: Validator<string> = refine(str({ min: 1, max: 64 }), (key, path) => {
  if (reserved.has(key)) return [{ path, message: `"${key}" is a reserved property key` }];
  if (prototypeKeys.has(key)) return [{ path, message: `"${key}" is not an allowed property key` }];
  return [];
});

/** One property value: JSON nested at most two levels below the bag, strings ≤ 1 000 chars. */
export const propertyValueValidator: Validator<JsonValue> = json({
  maxDepth: MAX_PROPERTIES_DEPTH - 1,
  maxStringChars: MAX_PROPERTY_STRING_CHARS,
});

/** The whole bag: key count, reserved keys, per-value rules, then serialised size. */
export function propertiesValidator(caps: Partial<ValidatorCaps> = {}): Validator<Record<string, JsonValue>> {
  const { maxPropertiesKeys, maxPropertiesBytes } = resolveCaps(caps);
  const sized = json({ maxBytes: maxPropertiesBytes });
  return (u, path = "") => {
    if (u === null || typeof u !== "object" || Array.isArray(u)) return fail(path, "expected an object");
    const entries = Object.entries(u);
    if (entries.length > maxPropertiesKeys) return fail(path, `must have at most ${maxPropertiesKeys} keys`);
    const issues: Issue[] = [];
    const out: Record<string, JsonValue> = {};
    for (const [key, value] of entries) {
      const childPath = pointer(path, key);
      const keyResult = propertyKeyValidator(key, childPath);
      if (!keyResult.ok) {
        // "__proto__" fails here, so the assignment below never rewrites `out`'s prototype.
        issues.push(...keyResult.issues);
        continue;
      }
      const valueResult = propertyValueValidator(value, childPath);
      if (valueResult.ok) out[key] = valueResult.value;
      else issues.push(...valueResult.issues);
    }
    if (issues.length > 0) return { ok: false, issues };
    const size = sized(out, path);
    return size.ok ? ok(out) : size;
  };
}

/** Cross-field consistency between `path` and the fields derived from it. */
function pathConsistencyIssues(node: TopicNode, path: string): Issue[] {
  const issues: Issue[] = [];
  const expectedParent = parentPath(node.path);
  if (node.parentPath !== expectedParent) {
    issues.push({ path: pointer(path, "parentPath"), message: `must be ${JSON.stringify(expectedParent)} for path ${node.path}` });
  }
  const expectedSlug = slugOf(node.path);
  if (node.slug !== expectedSlug) {
    issues.push({ path: pointer(path, "slug"), message: `must be ${JSON.stringify(expectedSlug)} for path ${node.path}` });
  }
  const expectedLevel = depth(node.path);
  if (node.level !== expectedLevel) {
    issues.push({ path: pointer(path, "level"), message: `must be ${expectedLevel} for path ${node.path}` });
  }
  return issues;
}

export function nodeValidator(caps: Partial<ValidatorCaps> = {}): Validator<TopicNode> {
  const { maxNodeDepth } = resolveCaps(caps);
  const nodePath = pathValidator(maxNodeDepth);
  const shape = obj<TopicNode>({
    id: str({ min: 1, max: 128 }),
    tenantId: nullable(str()),
    subjectId: str({ min: 1, max: 256 }),
    path: nodePath,
    parentPath: nullable(nodePath),
    // Root's slug is "" — the only place an empty slug is legal; the
    // consistency check below ties it to `path === "/"`.
    slug: str({ max: 40 }),
    title: str({ min: 1, max: 80 }),
    description: str({ max: 200 }),
    keywords: keywordsValidator,
    patterns: arr(str({ min: 1, max: 200 })),
    agents: arr(str({ min: 1 })),
    properties: propertiesValidator(caps),
    level: int({ min: 0, max: maxNodeDepth }),
    locked: bool(),
    status: oneOf(NODE_STATUSES),
    mergedInto: opt(nodePath),
    stats: obj<TopicNode["stats"]>({ activeHints: int({ min: 0 }), lastIngestAt: opt(isoDate()) }),
    embedding: opt(arr(num())),
    version: int({ min: 0 }),
    createdAt: isoDate(),
    updatedAt: isoDate(),
  });
  return refine(shape, pathConsistencyIssues);
}

/** `validators.node`: the default caps. */
export const validateNode: Validator<TopicNode> = nodeValidator();
