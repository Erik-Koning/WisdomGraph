/**
 * proposal.ts — the output schema of the extraction and consolidation
 * prompts, and its structural gate.
 *
 * This is the one boundary where the input comes from a model, so the
 * objects are strict: an unknown key is an issue, not noise, because the
 * issue list is fed back into the retry prompt and a model that invented a
 * field needs to hear so. The gate is purely structural (spec §5.6 gate 1):
 * shapes, enums, ranges, the op count, lane × kind, agent ⇔ scope, slot and
 * path syntax, reserved property keys, and — when the purpose is extraction —
 * the consolidation-only ops. Whether a `hintId` exists, a parent is locked or
 * a slug clashes with a sibling needs the snapshot and belongs to the
 * organiser's referential gate.
 *
 * `validateProposalShape` — `validators.proposal` — is the extraction gate:
 * the 8-op cap and no consolidation ops, because that is the boundary a
 * consumer or the retry prompt meets. `proposalValidator` builds one for a
 * specific purpose, cap and agent vocabulary, so the consolidation pass, which
 * allows 24 ops and the extra op set, uses the same code with different
 * numbers.
 */

import type { HintKind, HintLane, HintScope, JsonValue } from "../types";
import { HINT_KINDS, HINT_LANES, HINT_SCOPES, placementIssues, slotValidator, type AgentVocabulary, type PlacementRules } from "./hint";
import {
  keywordsValidator,
  pathValidator,
  propertiesValidator,
  propertyKeyValidator,
  propertyValueValidator,
  resolveCaps,
  slugValidator,
  type ValidatorCaps,
} from "./node";
import {
  arr,
  bool,
  int,
  num,
  obj,
  oneOf,
  opt,
  pointer,
  refine,
  str,
  union,
  type Issue,
  type ObjectFields,
  type Validator,
} from "./validate";

// ── Shapes (spec §5.5) ───────────────────────────────────────────────────────

export interface Proposal {
  ops: Operation[];
  notes?: string;
}

export type AddHintBody = {
  slot: string;
  value: string;
  text: string;
  kind: HintKind;
  lane: HintLane;
  scope: HintScope;
  agent?: string;
  clientScoped?: boolean;
  priority: number;
  confidence: number;
  rationale: string;
};

export type AddHintOp = { op: "add_hint"; nodePath: string } & AddHintBody;
export type UpdateHintOp = {
  op: "update_hint";
  hintId: string;
  text?: string;
  value?: string;
  priority?: number;
  confidence?: number;
  rationale: string;
};
export type ReinforceHintOp = { op: "reinforce_hint"; hintId: string };
export type RetireHintOp = {
  op: "retire_hint";
  hintId: string;
  reason: "contradicted" | "withdrawn" | "obsolete";
  rationale: string;
};
export type CreateNodeOp = {
  op: "create_node";
  parentPath: string;
  slug: string;
  title: string;
  description: string;
  keywords: string[];
  agents?: string[];
  properties?: Record<string, JsonValue>;
  hints: AddHintBody[];
  rationale: string;
};
export type UpdateNodeOp = {
  op: "update_node";
  nodePath: string;
  title?: string;
  description?: string;
  keywords?: string[];
  rationale: string;
};
export type SetPropertyOp = { op: "set_property"; nodePath: string; key: string; value: JsonValue };
export type NoopOp = { op: "noop"; rationale: string };
// consolidation-only (purpose "consolidate"); rejected in extraction responses
export type MergeHintsOp = { op: "merge_hints"; hintIds: string[]; text: string; value?: string; slot?: string; rationale: string };
export type MoveHintOp = { op: "move_hint"; hintId: string; nodePath: string; rationale: string };
export type SplitNodeChild = { slug: string; title: string; description: string; keywords: string[]; hintIds: string[] };
export type SplitNodeOp = { op: "split_node"; nodePath: string; children: SplitNodeChild[]; rationale: string };
export type MergeNodesOp = { op: "merge_nodes"; fromPath: string; intoPath: string; rationale: string };
export type AliasSlotOp = { op: "alias_slot"; from: string; to: string; rationale: string };

export type Operation =
  | AddHintOp
  | UpdateHintOp
  | ReinforceHintOp
  | RetireHintOp
  | CreateNodeOp
  | UpdateNodeOp
  | SetPropertyOp
  | NoopOp
  | MergeHintsOp
  | MoveHintOp
  | SplitNodeOp
  | MergeNodesOp
  | AliasSlotOp;

export type OperationKind = Operation["op"];

export const EXTRACTION_OPS = [
  "add_hint",
  "update_hint",
  "reinforce_hint",
  "retire_hint",
  "create_node",
  "update_node",
  "set_property",
  "noop",
] as const;
export const CONSOLIDATION_OPS = ["merge_hints", "move_hint", "split_node", "merge_nodes", "alias_slot"] as const;
export const RETIRE_REASONS = ["contradicted", "withdrawn", "obsolete"] as const;
/** Cap on a rationale: it is echoed into audit detail, never rendered. */
export const MAX_RATIONALE_CHARS = 1000;

const consolidationOnly = new Set<string>(CONSOLIDATION_OPS);

export function isConsolidationOp(op: OperationKind): boolean {
  return consolidationOnly.has(op);
}

export interface ProposalValidatorOptions extends AgentVocabulary {
  /** Default `caps.maxOpsPerEvent` (8); the consolidation pass passes 24. */
  maxOps?: number;
  /** `"extract"` rejects the consolidation-only ops; `"consolidate"` or absent allows every op. */
  purpose?: "extract" | "consolidate";
  caps?: Partial<ValidatorCaps>;
}

// ── Validators ───────────────────────────────────────────────────────────────

const rationale = str({ trim: true, min: 1, max: MAX_RATIONALE_CHARS });
const hintId = str({ min: 1, max: 128 });
const title = str({ trim: true, min: 1, max: 80 });
const description = str({ trim: true, min: 1, max: 200 });
const agentName = str({ min: 1, max: 128 });

/** The per-key rules of an `AddHintBody`; shared by the inline body and the `add_hint` op so they cannot drift. */
function addHintFields(caps: ValidatorCaps): ObjectFields<AddHintBody> {
  return {
    slot: slotValidator,
    // Raw here; the organiser normalises and truncates to the stored 80-char form.
    value: str({ trim: true, min: 1, max: 200 }),
    text: str({ trim: true, min: 1, max: caps.maxHintChars }),
    kind: oneOf(HINT_KINDS),
    lane: oneOf(HINT_LANES),
    scope: oneOf(HINT_SCOPES),
    agent: opt(agentName),
    clientScoped: opt(bool()),
    priority: int({ min: 0, max: 100 }),
    confidence: num({ min: 0, max: 1 }),
    rationale,
  };
}

function proposalPlacement<T extends AddHintBody>(shape: Validator<T>, rules: PlacementRules): Validator<T> {
  return refine(shape, (body, path) => placementIssues(body, path, rules));
}

function operationValidator(caps: ValidatorCaps, maxOps: number, rules: PlacementRules): Validator<Operation> {
  const nodePath = pathValidator(caps.maxNodeDepth);
  const strict = { strict: true };

  const addHintBody = proposalPlacement(obj<AddHintBody>(addHintFields(caps), strict), rules);

  const addHint = proposalPlacement(
    obj<AddHintOp>({ op: oneOf(["add_hint"]), nodePath, ...addHintFields(caps) }, strict),
    rules,
  );

  const updateHint = obj<UpdateHintOp>(
    {
      op: oneOf(["update_hint"]),
      hintId,
      text: opt(str({ trim: true, min: 1, max: caps.maxHintChars })),
      value: opt(str({ trim: true, min: 1, max: 200 })),
      priority: opt(int({ min: 0, max: 100 })),
      confidence: opt(num({ min: 0, max: 1 })),
      rationale,
    },
    strict,
  );

  const reinforceHint = obj<ReinforceHintOp>({ op: oneOf(["reinforce_hint"]), hintId }, strict);

  const retireHint = obj<RetireHintOp>(
    { op: oneOf(["retire_hint"]), hintId, reason: oneOf(RETIRE_REASONS), rationale },
    strict,
  );

  const createNode = obj<CreateNodeOp>(
    {
      op: oneOf(["create_node"]),
      parentPath: nodePath,
      slug: slugValidator,
      title,
      description,
      keywords: keywordsValidator,
      agents: opt(arr(agentName)),
      properties: opt(propertiesValidator(caps)),
      hints: arr(addHintBody, { min: 1, max: maxOps }),
      rationale,
    },
    strict,
  );

  const updateNode = obj<UpdateNodeOp>(
    {
      op: oneOf(["update_node"]),
      nodePath,
      title: opt(title),
      description: opt(description),
      keywords: opt(keywordsValidator),
      rationale,
    },
    strict,
  );

  const setProperty = obj<SetPropertyOp>(
    { op: oneOf(["set_property"]), nodePath, key: propertyKeyValidator, value: propertyValueValidator },
    strict,
  );

  const noop = obj<NoopOp>({ op: oneOf(["noop"]), rationale }, strict);

  const mergeHints = obj<MergeHintsOp>(
    {
      op: oneOf(["merge_hints"]),
      hintIds: arr(hintId, { min: 2, unique: true }),
      text: str({ trim: true, min: 1, max: caps.maxHintChars }),
      value: opt(str({ trim: true, min: 1, max: 200 })),
      slot: opt(slotValidator),
      rationale,
    },
    strict,
  );

  const moveHint = obj<MoveHintOp>({ op: oneOf(["move_hint"]), hintId, nodePath, rationale }, strict);

  const splitChild = obj<SplitNodeChild>(
    { slug: slugValidator, title, description, keywords: keywordsValidator, hintIds: arr(hintId, { unique: true }) },
    strict,
  );
  const splitNode = obj<SplitNodeOp>(
    { op: oneOf(["split_node"]), nodePath, children: arr(splitChild, { min: 1 }), rationale },
    strict,
  );

  const mergeNodes = refine(
    obj<MergeNodesOp>({ op: oneOf(["merge_nodes"]), fromPath: nodePath, intoPath: nodePath, rationale }, strict),
    (op, path) => (op.fromPath === op.intoPath ? [{ path: pointer(path, "intoPath"), message: "must differ from fromPath" }] : []),
  );

  const aliasSlot = refine(
    obj<AliasSlotOp>({ op: oneOf(["alias_slot"]), from: slotValidator, to: slotValidator, rationale }, strict),
    (op, path) => (op.from === op.to ? [{ path: pointer(path, "to"), message: "must differ from from" }] : []),
  );

  return union<Operation>("op", {
    add_hint: addHint,
    update_hint: updateHint,
    reinforce_hint: reinforceHint,
    retire_hint: retireHint,
    create_node: createNode,
    update_node: updateNode,
    set_property: setProperty,
    noop,
    merge_hints: mergeHints,
    move_hint: moveHint,
    split_node: splitNode,
    merge_nodes: mergeNodes,
    alias_slot: aliasSlot,
  });
}

export function proposalValidator(opts: ProposalValidatorOptions = {}): Validator<Proposal> {
  const caps = resolveCaps(opts.caps);
  const maxOps = opts.maxOps ?? caps.maxOpsPerEvent;
  // `clientId` never appears in a proposal: `clientScoped` stands in for it,
  // and the organiser attaches the event's client id when it is true.
  const rules: PlacementRules = {
    clientScoped: true,
    agents: opts.agents === undefined ? undefined : new Set(opts.agents),
  };
  const operation = operationValidator(caps, maxOps, rules);
  const gated: Validator<Operation> =
    opts.purpose === "extract"
      ? refine(operation, (op, path): Issue[] =>
          isConsolidationOp(op.op) ? [{ path: pointer(path, "op"), message: `"${op.op}" is a consolidation-only op` }] : [],
        )
      : operation;
  return obj<Proposal>({ ops: arr(gated, { max: maxOps }), notes: opt(str({ max: 2000 })) }, { strict: true });
}

/**
 * `validators.proposal`: the extraction gate of spec §5.6 — default caps (8
 * ops), consolidation-only ops refused, no agent vocabulary (a fixed export
 * has no engine to ask). The consolidation pass builds its own with
 * `proposalValidator({ purpose: "consolidate", maxOps: 24 })`.
 */
export const validateProposalShape: Validator<Proposal> = proposalValidator({ purpose: "extract" });
