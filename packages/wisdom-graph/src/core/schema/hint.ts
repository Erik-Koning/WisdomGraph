/**
 * hint.ts — the shape rules for hints, in both their recall-facing and
 * stored forms, plus the placement rules every hint-like thing shares.
 *
 * Four rules from spec §3.5 are cross-field and cannot be expressed per key,
 * so they live here as `placementIssues` and are reused by the proposal
 * validator: `agent` is present exactly when `scope === "agent"` and, when the
 * caller supplies the vocabulary, names a configured category or an agent the
 * subject's history has seen; `clientId` is present exactly when
 * `scope === "client"` — or, in a proposal where the id never reaches the LLM,
 * `clientScoped: true` stands in for it; and a `kind` must fit its `lane` (a
 * `preRoute` hint shapes routing, so a `style` hint there would be rendered
 * where nobody reads style). Keeping them in one place means the LLM gate,
 * the store-row gate and the fixtures cannot drift on what "placed" means.
 *
 * `text` is checked for length only. Whether it is a safe, canonical
 * statement is `sanitizeStatement`'s job (spec §9), applied by the organiser
 * on the way in and by `compileSnapshot` on the way out; the structural
 * validator stays free of the text-safety module so it can run anywhere.
 */

import type {
  Hint,
  HintKind,
  HintLane,
  HintProvenance,
  HintProvenanceSummary,
  HintRecord,
  HintScope,
} from "../types";
import { arr, bool, int, isoDate, nullable, num, obj, oneOf, opt, pointer, refine, str, type Issue, type Validator } from "./validate";
import { pathValidator, resolveCaps, type ValidatorCaps } from "./node";

export const SLOT_PATTERN = /^[a-z0-9_.]{2,60}$/;
export const HINT_SCOPES = ["global", "category", "agent", "client"] as const;
export const HINT_LANES = ["preRoute", "agent", "responseStyle"] as const;
export const HINT_KINDS = ["preference", "style", "routing", "fact", "constraint"] as const;
export const HINT_SOURCES = ["explicit", "inferred"] as const;
export const HINT_STATUSES = ["pending", "active", "superseded", "retired"] as const;
export const HINT_MATURITIES = ["captured", "consolidated", "established"] as const;
export const APPROVALS = ["auto", "approved", "rejected"] as const;
export const EXTRACTORS = ["llm", "rule", "human"] as const;
export const RETIRED_REASONS = ["decayed", "contradicted", "withdrawn", "obsolete", "merged", "rejected", "feedback"] as const;
/** Slot value cap after normalisation. */
export const MAX_SLOT_VALUE_CHARS = 80;
/** Provenance list caps (`eventIds`, `runIds`). */
export const MAX_PROVENANCE_IDS = 50;

/** Which kinds may render in which lane (spec §3.5). */
export const LANE_KINDS: Record<HintLane, readonly HintKind[]> = {
  preRoute: ["routing", "fact", "constraint"],
  agent: HINT_KINDS,
  responseStyle: ["style", "preference", "constraint"],
};

export function laneAllowsKind(lane: HintLane, kind: HintKind): boolean {
  return LANE_KINDS[lane].includes(kind);
}

export const slotValidator: Validator<string> = str({ pattern: SLOT_PATTERN });

/**
 * The canonical form of a slot value: what reinforce-vs-conflict compares.
 * Lower-case, whitespace collapsed, trailing sentence punctuation dropped so
 * "Bullets, max 5." and "bullets max 5" are the same value.
 */
export function normaliseSlotValue(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!]+$/, "")
    .trim();
}

/** A stored slot value: normalised, then 1..80 chars. */
export const slotValueValidator: Validator<string> = (u, path = "") => {
  const base = str()(u, path);
  if (!base.ok) return base;
  return str({ min: 1, max: MAX_SLOT_VALUE_CHARS })(normaliseSlotValue(base.value), path);
};

export interface Placement {
  scope: HintScope;
  lane: HintLane;
  kind: HintKind;
  agent?: string;
  clientId?: string;
  /** The proposal form of `clientId`: the id itself is never shown to the LLM. */
  clientScoped?: boolean;
}

export interface PlacementRules {
  /** Check `clientId` presence against `scope === "client"` (rows). */
  clientId?: boolean;
  /** Check `clientScoped === true` against `scope === "client"` (proposals). */
  clientScoped?: boolean;
  /** When given, an agent-scoped hint's `agent` must be one of these names. */
  agents?: ReadonlySet<string>;
}

/** The names an agent-scoped hint may target; the validator factories take it as `readonly string[]`. */
export interface AgentVocabulary {
  /** Configured category names plus agents seen in the subject's `agentsUsed` history. */
  agents?: readonly string[];
}

function agentSet(vocabulary: AgentVocabulary): ReadonlySet<string> | undefined {
  return vocabulary.agents === undefined ? undefined : new Set(vocabulary.agents);
}

/** The cross-field placement rules: agent ⇔ scope agent (and in the vocabulary), clientId/clientScoped ⇔ scope client, lane × kind. */
export function placementIssues(p: Placement, path: string, rules: PlacementRules = { clientId: true }): Issue[] {
  const issues: Issue[] = [];
  if (p.scope === "agent" && p.agent === undefined) {
    issues.push({ path: pointer(path, "agent"), message: 'required when scope is "agent"' });
  }
  if (p.scope !== "agent" && p.agent !== undefined) {
    issues.push({ path: pointer(path, "agent"), message: 'only allowed when scope is "agent"' });
  }
  if (p.scope === "agent" && p.agent !== undefined && rules.agents !== undefined && !rules.agents.has(p.agent)) {
    issues.push({ path: pointer(path, "agent"), message: `"${p.agent}" is not a configured agent` });
  }
  if (rules.clientId) {
    if (p.scope === "client" && p.clientId === undefined) {
      issues.push({ path: pointer(path, "clientId"), message: 'required when scope is "client"' });
    }
    if (p.scope !== "client" && p.clientId !== undefined) {
      issues.push({ path: pointer(path, "clientId"), message: 'only allowed when scope is "client"' });
    }
  }
  if (rules.clientScoped) {
    if (p.scope === "client" && p.clientScoped !== true) {
      issues.push({ path: pointer(path, "clientScoped"), message: 'must be true when scope is "client"' });
    }
    if (p.scope !== "client" && p.clientScoped === true) {
      issues.push({ path: pointer(path, "clientScoped"), message: 'only allowed when scope is "client"' });
    }
  }
  if (!laneAllowsKind(p.lane, p.kind)) {
    issues.push({
      path: pointer(path, "kind"),
      message: `kind "${p.kind}" is not allowed in lane "${p.lane}" (allowed: ${LANE_KINDS[p.lane].join(", ")})`,
    });
  }
  return issues;
}

const provenanceSummary: Validator<HintProvenanceSummary> = obj<HintProvenanceSummary>({
  originEventId: str({ min: 1, max: 128 }),
  runId: opt(str({ min: 1, max: 128 })),
  createdAt: isoDate(),
  lastReinforcedAt: isoDate(),
  extractor: oneOf(EXTRACTORS),
});

const provenance: Validator<HintProvenance> = obj<HintProvenance>({
  originEventId: str({ min: 1, max: 128 }),
  eventIds: arr(str({ min: 1, max: 128 }), { max: MAX_PROVENANCE_IDS }),
  runIds: arr(str({ min: 1, max: 128 }), { max: MAX_PROVENANCE_IDS }),
  extractor: obj<HintProvenance["extractor"]>({
    kind: oneOf(EXTRACTORS),
    promptVersion: opt(str({ min: 1, max: 64 })),
    model: opt(str({ min: 1, max: 128 })),
  }),
  approval: opt(
    obj<NonNullable<HintProvenance["approval"]>>({
      by: str({ min: 1, max: 128 }),
      at: isoDate(),
      note: opt(str({ max: 500 })),
    }),
  ),
  supersedes: opt(str({ min: 1, max: 128 })),
});

/** The contract + placement fields shared by `Hint` and `HintRecord`. */
function contractFields(caps: ValidatorCaps) {
  return {
    id: str({ min: 1, max: 128 }),
    text: str({ trim: true, min: 1, max: caps.maxHintChars }),
    priority: int({ min: 0, max: 100 }),
    scope: oneOf(HINT_SCOPES),
    source: oneOf(HINT_SOURCES),
    confidence: num({ min: 0, max: 1 }),
    lane: oneOf(HINT_LANES),
    kind: oneOf(HINT_KINDS),
    slot: slotValidator,
    nodePath: pathValidator(caps.maxNodeDepth),
    agent: opt(str({ min: 1, max: 128 })),
    clientId: opt(str({ min: 1, max: 256 })),
  };
}

export function hintValidator(caps: Partial<ValidatorCaps> = {}, vocabulary: AgentVocabulary = {}): Validator<Hint> {
  const rules: PlacementRules = { clientId: true, agents: agentSet(vocabulary) };
  const shape = obj<Hint>({
    ...contractFields(resolveCaps(caps)),
    approval: oneOf(["auto", "approved"]),
    provenance: provenanceSummary,
  });
  return refine(shape, (hint, path) => placementIssues(hint, path, rules));
}

export function hintRecordValidator(caps: Partial<ValidatorCaps> = {}, vocabulary: AgentVocabulary = {}): Validator<HintRecord> {
  const rules: PlacementRules = { clientId: true, agents: agentSet(vocabulary) };
  const shape = obj<HintRecord>({
    ...contractFields(resolveCaps(caps)),
    tenantId: nullable(str()),
    subjectId: str({ min: 1, max: 256 }),
    nodeId: str({ min: 1, max: 128 }),
    value: slotValueValidator,
    status: oneOf(HINT_STATUSES),
    approval: oneOf(APPROVALS),
    maturity: oneOf(HINT_MATURITIES),
    needsReview: bool(),
    supersedes: opt(str({ min: 1, max: 128 })),
    supersededBy: opt(str({ min: 1, max: 128 })),
    retiredReason: opt(oneOf(RETIRED_REASONS)),
    reinforcements: int({ min: 0 }),
    contradictions: int({ min: 0 }),
    applied: int({ min: 0 }),
    lastAppliedAt: opt(isoDate()),
    provenance,
    version: int({ min: 0 }),
    createdAt: isoDate(),
    updatedAt: isoDate(),
    lastReinforcedAt: isoDate(),
  });
  return refine(shape, (record, path) => placementIssues(record, path, rules));
}

/** `validators.hint`: the default caps, no vocabulary (the engine has none to give at a fixed export). */
export const validateHint: Validator<Hint> = hintValidator();
/** `validators.hintRecord`: the default caps. */
export const validateHintRecord: Validator<HintRecord> = hintRecordValidator();
