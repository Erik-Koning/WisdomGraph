/**
 * snapshot.ts — store rows become the immutable value recall reads.
 *
 * `loadSnapshot` returns whatever the store holds; a recall must trust none
 * of it. Rows are re-validated and hint texts re-sanitised here (spec §3.5,
 * the fourth boundary), because a row written by an older version, edited by
 * hand, or corrupted in transit must degrade to "one hint dropped and
 * logged", never to a rejected recall or an unsanitised statement in a
 * prompt. The labels a row carries into the extraction outline — a node's
 * title, description, keywords and properties, a hint's slot value — pass
 * the label gate (`matchLabelInjection`, §9.1) the same way: a row whose
 * label reads as an instruction is dropped, so the store can never become a
 * second-order injection channel into a later prompt. Dropped hint ids are
 * kept on the snapshot so the charter can record them as `invalid-row`
 * (§2.5) and `explain()` can show them.
 *
 * Every dropped row is recorded on `dropped`, but only the first
 * `MAX_LOGGED_DROPS` are logged one line each; past that one summary line
 * carries the count. A subject with thousands of bad rows is compiled on
 * every cache miss, stale refresh and `explain()`, and a log that grows with
 * the damage would amplify it.
 *
 * Three more things happen once here rather than per query:
 *
 *   - **Virtual overlay.** A subject that has never been written has no rows,
 *     and a category added to the config after the subject's first write has
 *     no node yet. Both still classify against the seed keywords (§3.1):
 *     missing category nodes — and the root — are overlaid as `virtual`
 *     nodes with the ids seeding would give them, so nothing downstream
 *     needs to know whether the row exists.
 *   - **Slot canonicalisation.** Aliases (`format.list → format.lists`) are
 *     applied to every stored slot so the conflict pass compares canonical
 *     keys without knowing aliases exist. Chains are followed a bounded
 *     number of hops; a cycle simply stops.
 *   - **Projection and index.** `HintRecord → Hint` is done once (§3.3) and
 *     the classifier index is built once, both from the validated rows, so
 *     the hot path allocates nothing per query but its own scores.
 *
 * The result is deep-frozen. Recall freezes what it returns; if the two
 * disagreed, freezing a `Recall` would freeze a store row (the memory store
 * hands out clones for exactly this reason) or a later query would see an
 * earlier one's mutation.
 */

import { systemClock, type ClockPort, type GraphSnapshotData, type LoggerPort, type SubjectRef } from "../ports";
import type { PolicyConfig } from "../policy";
import type { CategorySpec, Hint, HintRecord, JsonValue, TopicNode } from "../types";
import { nodeValidator } from "../schema/node";
import { SLOT_PATTERN, hintRecordValidator } from "../schema/hint";
import { matchLabelInjection, sanitizeStatement } from "../text/sanitize";
import { ClassifierIndex } from "../classify/index";
import { ROOT_PATH } from "./paths";
import { categoryNode, resolveCategories, rootNode, type ResolvedCategory } from "./seed";

/** A node as the snapshot holds it: the row, plus whether it was overlaid rather than read. */
export type SnapshotNode = TopicNode & { readonly virtual: boolean };

export interface DroppedRow {
  table: "node" | "hint";
  id: string;
  reason: "invalid-row";
  /** `<pointer>: <message>` per issue; never the row's text. */
  issues: string[];
}

export interface SubjectSnapshot {
  readonly ref: SubjectRef;
  /** `kg_subjects.version`; 0 when the subject has no rows. */
  readonly version: number;
  /** False when the store returned `null`: everything here is virtual. */
  readonly exists: boolean;
  /** Epoch ms of the compile, from the injected clock. */
  readonly compiledAt: number;
  readonly slotAliases: Readonly<Record<string, string>>;
  readonly tombstones: ReadonlySet<string>;
  readonly eventsSinceConsolidation: number;
  /** Validated rows plus the virtual overlay; every path unique. */
  readonly nodes: readonly SnapshotNode[];
  readonly nodesByPath: ReadonlyMap<string, SnapshotNode>;
  readonly nodesById: ReadonlyMap<string, SnapshotNode>;
  /** Validated, re-sanitised, slot-canonicalised records, in store order. */
  readonly records: readonly HintRecord[];
  readonly recordsById: ReadonlyMap<string, HintRecord>;
  /**
   * The recall-facing projection (§3.3) of every record whose approval is not
   * `rejected`, in `records` order — whatever the record's `status`. A `Hint`
   * carries no lifecycle, so the store's status filter (`loadSnapshot`
   * defaults to `active`) is the only one applied here; when a caller loads
   * more statuses (`explain()` does), step 4's `active`/`pending`/`needsReview`
   * selection is charter assembly's job over `records`, and a consumer of
   * `hints` reads a hint's status from `recordsById.get(hint.id)`.
   */
  readonly hints: readonly Hint[];
  readonly hintsByNodePath: ReadonlyMap<string, readonly Hint[]>;
  /** Rows that failed validation or sanitisation. */
  readonly dropped: readonly DroppedRow[];
  /** The configured categories, defaults applied. */
  readonly categories: readonly ResolvedCategory[];
  readonly categoryNames: ReadonlySet<string>;
  readonly index: ClassifierIndex;
  /** True when at least one active node carries an embedding (the re-rank precondition). */
  readonly hasEmbeddings: boolean;
}

export interface CompileSnapshotOptions {
  /** The subject being compiled; also the identity of the virtual overlay when `data` is null. */
  ref: SubjectRef;
  /** Configured categories to overlay when their level-1 node is missing. */
  categories?: readonly CategorySpec[];
  clock?: ClockPort;
}

/** The `GraphSnapshotData` of a subject with no rows. */
export function emptySnapshotData(ref: SubjectRef): GraphSnapshotData {
  return { ref, version: 0, slotAliases: {}, tombstones: [], eventsSinceConsolidation: 0, nodes: [], hints: [] };
}

/** Alias chains longer than this stop where they are; a cycle can never spin. */
const MAX_ALIAS_HOPS = 8;

/** Dropped rows logged one line each per compile; the rest are counted in one `snapshot.invalid-rows` line. */
export const MAX_LOGGED_DROPS = 20;

/** Aliases with a well-formed slot on both sides and no self-mapping; the map is store content, so values are checked, not trusted. */
export function cleanAliases(aliases: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(aliases)) {
    if (typeof to === "string" && from !== to && SLOT_PATTERN.test(from) && SLOT_PATTERN.test(to)) out[from] = to;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Follow `aliases` from `slot` up to `MAX_ALIAS_HOPS` times. */
export function canonicalSlot(slot: string, aliases: Readonly<Record<string, string>>): string {
  let current = slot;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
    const next = aliases[current];
    if (next === undefined || next === current) break;
    current = next;
  }
  return current;
}

/** The recall-facing projection (§3.3), or `null` for a rejected record — those never reach a Recall. */
export function toHint(record: HintRecord): Hint | null {
  if (record.approval === "rejected") return null;
  const runId = record.provenance.runIds[0];
  const hint: Hint = {
    id: record.id,
    text: record.text,
    priority: record.priority,
    scope: record.scope,
    source: record.source,
    confidence: record.confidence,
    lane: record.lane,
    kind: record.kind,
    slot: record.slot,
    nodePath: record.nodePath,
    ...(record.agent !== undefined ? { agent: record.agent } : {}),
    ...(record.clientId !== undefined ? { clientId: record.clientId } : {}),
    approval: record.approval,
    provenance: {
      originEventId: record.provenance.originEventId,
      ...(runId !== undefined ? { runId } : {}),
      createdAt: record.createdAt,
      lastReinforcedAt: record.lastReinforcedAt,
      extractor: record.provenance.extractor.kind,
    },
  };
  return hint;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Compile `data` (or the empty subject when `null`) into a `SubjectSnapshot`
 * for `opts.ref`, overlaying `opts.categories`. Never throws on store
 * content: a bad row is dropped, and a container that is not what the port
 * promises (`nodes: null`, `tombstones: 5`) is treated as empty and logged
 * once, so a corrupt subject degrades to its virtual overlay rather than
 * failing every recall. An invalid category configuration is a `TypeError`,
 * as at construction.
 */
export function compileSnapshot(
  data: GraphSnapshotData | null,
  policy: PolicyConfig,
  logger: LoggerPort,
  opts: CompileSnapshotOptions,
): SubjectSnapshot {
  const ref = opts.ref;
  // `Partial` because the store's rows are the fourth trust boundary: the
  // port's type is what the store promised, not what it delivered.
  const source: Partial<GraphSnapshotData> = data ?? emptySnapshotData(ref);
  const clock = opts.clock ?? systemClock;
  const compiledAt = clock.now();
  const at = new Date(compiledAt).toISOString();
  const categories = resolveCategories(opts.categories ?? []);
  const dropped: DroppedRow[] = [];

  const drop = (table: DroppedRow["table"], id: string, issues: string[]): void => {
    dropped.push({ table, id, reason: "invalid-row", issues });
    if (dropped.length > MAX_LOGGED_DROPS) return;
    logger.warn(
      { lib: "wisdom-graph", op: "compileSnapshot", tenantId: ref.tenantId, subjectId: ref.subjectId, table, id, issues },
      "snapshot.invalid-row",
    );
  };
  /** `<field>: <families>` for every label of a row that reads as an instruction; empty when all pass. */
  const labelIssues = (labels: Readonly<Record<string, string | readonly string[] | Readonly<Record<string, JsonValue>>>>): string[] => {
    const issues: string[] = [];
    for (const [field, value] of Object.entries(labels)) {
      const reasons = matchLabelInjection(value as JsonValue);
      if (reasons.length > 0) issues.push(`/${field}: ${reasons.join(", ")}`);
    }
    return issues;
  };
  const issueList = (issues: { path: string; message: string }[]): string[] => issues.map((i) => `${i.path}: ${i.message}`);
  /** A subject-level field the store returned in the wrong shape; its safe default is used. */
  const malformed = (field: keyof GraphSnapshotData, expected: string): void => {
    logger.warn(
      { lib: "wisdom-graph", op: "compileSnapshot", tenantId: ref.tenantId, subjectId: ref.subjectId, field, expected },
      "snapshot.invalid-shape",
    );
  };
  /** The rows of a table, or none when the container itself is not an array — recorded like a row that failed. */
  const rowsOf = <T>(table: DroppedRow["table"], value: T[] | undefined): readonly T[] => {
    if (Array.isArray(value)) return value;
    drop(table, "?", [`/${table}s: must be an array`]);
    return [];
  };
  const countOf = (field: "version" | "eventsSinceConsolidation", value: number | undefined): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    malformed(field, "a finite number");
    return 0;
  };

  // ── Nodes ──
  const validateNode = nodeValidator(policy.caps);
  const nodes: SnapshotNode[] = [];
  const nodesByPath = new Map<string, SnapshotNode>();
  for (const row of rowsOf("node", source.nodes)) {
    const id = typeof row?.id === "string" ? row.id : "?";
    const result = validateNode(row);
    if (!result.ok) {
      drop("node", id, issueList(result.issues));
      continue;
    }
    if (nodesByPath.has(result.value.path)) {
      drop("node", id, [`/path: a node already holds ${result.value.path}`]);
      continue;
    }
    const { title, description, keywords, properties } = result.value;
    const injected = labelIssues({ title, description, keywords, properties });
    if (injected.length > 0) {
      drop("node", id, injected);
      continue;
    }
    const node: SnapshotNode = { ...result.value, virtual: false };
    nodes.push(node);
    nodesByPath.set(node.path, node);
  }

  const overlay = (row: TopicNode): void => {
    const node: SnapshotNode = { ...row, virtual: true };
    nodes.push(node);
    nodesByPath.set(node.path, node);
  };
  if (!nodesByPath.has(ROOT_PATH)) overlay(rootNode(ref, at));
  for (const category of categories) {
    if (!nodesByPath.has(category.path)) overlay(categoryNode(category, ref, at));
  }
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  // ── Hints ──
  let slotAliases: Record<string, string> = {};
  if (isPlainObject(source.slotAliases)) slotAliases = cleanAliases(source.slotAliases);
  else malformed("slotAliases", "an object");
  let tombstones = new Set<string>();
  if (Array.isArray(source.tombstones)) tombstones = new Set(source.tombstones.filter((t): t is string => typeof t === "string"));
  else malformed("tombstones", "an array");
  const validateRecord = hintRecordValidator(policy.caps);
  const records: HintRecord[] = [];
  const recordsById = new Map<string, HintRecord>();
  for (const row of rowsOf("hint", source.hints)) {
    const id = typeof row?.id === "string" ? row.id : "?";
    const result = validateRecord(row);
    if (!result.ok) {
      drop("hint", id, issueList(result.issues));
      continue;
    }
    const record = result.value;
    if (recordsById.has(record.id)) {
      drop("hint", record.id, ["/id: duplicate row"]);
      continue;
    }
    if (tombstones.has(record.id)) {
      drop("hint", record.id, ["/id: tombstoned"]);
      continue;
    }
    const sanitised = sanitizeStatement(record.text, { maxChars: policy.caps.maxHintChars });
    if (!sanitised.ok) {
      drop("hint", record.id, [`/text: ${sanitised.reasons.join(", ")}`]);
      continue;
    }
    const injectedValue = labelIssues({ value: record.value });
    if (injectedValue.length > 0) {
      drop("hint", record.id, injectedValue);
      continue;
    }
    record.text = sanitised.text;
    record.slot = canonicalSlot(record.slot, slotAliases);
    records.push(record);
    recordsById.set(record.id, record);
  }

  const hints: Hint[] = [];
  const hintsByNodePath = new Map<string, Hint[]>();
  for (const record of records) {
    const hint = toHint(record);
    if (hint === null) continue;
    hints.push(hint);
    const list = hintsByNodePath.get(hint.nodePath);
    if (list) list.push(hint);
    else hintsByNodePath.set(hint.nodePath, [hint]);
  }

  if (dropped.length > MAX_LOGGED_DROPS) {
    logger.warn(
      { lib: "wisdom-graph", op: "compileSnapshot", tenantId: ref.tenantId, subjectId: ref.subjectId, dropped: dropped.length, logged: MAX_LOGGED_DROPS },
      "snapshot.invalid-rows",
    );
  }

  // ── Index ──
  const index = new ClassifierIndex(nodes, records);
  for (const rejected of index.rejectedPatterns) {
    logger.warn(
      { lib: "wisdom-graph", op: "compileSnapshot", tenantId: ref.tenantId, subjectId: ref.subjectId, path: rejected.path, reason: rejected.reason },
      "snapshot.invalid-pattern",
    );
  }
  const hasEmbeddings = nodes.some((n) => n.status === "active" && n.path !== ROOT_PATH && (n.embedding?.length ?? 0) > 0);

  const snapshot: SubjectSnapshot = {
    ref: { tenantId: ref.tenantId, subjectId: ref.subjectId },
    version: countOf("version", source.version),
    exists: data !== null,
    compiledAt,
    slotAliases,
    tombstones,
    eventsSinceConsolidation: countOf("eventsSinceConsolidation", source.eventsSinceConsolidation),
    nodes,
    nodesByPath,
    nodesById,
    records,
    recordsById,
    hints,
    hintsByNodePath,
    dropped,
    categories,
    categoryNames: new Set(categories.map((c) => c.name)),
    index,
    hasEmbeddings,
  };
  // Maps and Sets are frozen as objects (their entries stay live); the rows
  // and lists inside them are the same references frozen through `nodes`,
  // `records`, `hints` and `dropped`.
  for (const list of hintsByNodePath.values()) Object.freeze(list);
  deepFreeze(nodes);
  deepFreeze(records);
  deepFreeze(hints);
  deepFreeze(dropped);
  deepFreeze(categories);
  Object.freeze(slotAliases);
  return Object.freeze(snapshot);
}
