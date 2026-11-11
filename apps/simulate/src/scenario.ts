/**
 * scenario.ts — the scenario file format and its loader.
 *
 * A scenario is a scripted conversation: turns, feedback, time jumps,
 * maintenance passes and human actions, interleaved with expectations about
 * the graph. The loader validates the JSON by hand (no zod in this repo) and
 * reports the first problem with its path (`steps[3].turn.user: expected a
 * string`), so a typo in a scenario fails before the clock starts.
 *
 * Scripted proposals are checked against the library's own
 * `validators.proposal` at load time — the same structural gate the extractor
 * output meets — so a bad lane × kind pairing or a missing `rationale` is
 * reported here rather than silently rejected at ingest.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { validators, type FeedbackSignal, type FeedbackTarget, type HintMaturity, type JsonValue, type Proposal } from "@mosphere/wisdom-graph";

export type ExtractMode = "auto" | "force" | "skip";

export interface TurnStep {
  turn: {
    user: string;
    assistant?: string;
    agentsUsed?: string[];
    /** Run a recall on the user text first and pass its provenance as `appliedHintIds`. */
    recall?: boolean;
    /** What the extractor returns for this turn (wins over the offline heuristic / real model). */
    proposal?: Proposal;
    /** Default: "force" when a proposal is scripted, else "auto" (the library's triage gate decides). */
    extract?: ExtractMode;
  };
}

export interface FeedbackStep {
  feedback: {
    signal: FeedbackSignal;
    text?: string;
    target?: FeedbackTarget;
    proposal?: Proposal;
  };
}

export interface AdvanceDaysStep { advanceDays: number }
export interface AdvanceMsStep { advanceMs: number }
export interface ConsolidateStep { consolidate: true }
export interface MaintainStep { maintain: true }
export interface DrainStep { drain: true }

/** A hint is addressed by id or by a case-insensitive substring of its text (active, pending and retired rows all count). */
export type HintRef = { hintText: string; hintId?: undefined } | { hintId: string; hintText?: undefined };

export interface ApproveStep { approve: HintRef & { status?: "approved" | "rejected" } }
export interface ForgetStep { forget: HintRef | { subject: true; hintText?: undefined; hintId?: undefined } }

export interface RecallExpect {
  category?: string;
  /** Substrings that must appear in the rendered artifacts (all three lanes). */
  includes?: string[];
  excludes?: string[];
  minHints?: number;
  maxHints?: number;
}

export interface RecallStep {
  recall: {
    text: string;
    agent?: string;
    approvedOnly?: boolean;
    expect?: RecallExpect;
  };
}

export type ExpectedStatus = "active" | "superseded" | "retired" | "pending" | "absent";

export interface GraphExpect {
  activeHints?: number;
  retired?: number;
  pending?: number;
  nodes?: number;
  /** text substring → status. "absent" passes when no hint matches the substring at all. */
  hintStatus?: Record<string, ExpectedStatus>;
  maturity?: Record<string, HintMaturity>;
  /** text substring → whether the hint carries the human-review flag. */
  needsReview?: Record<string, boolean>;
  /** text substring → minimum reinforcement count. */
  reinforcements?: Record<string, number>;
  /** text substring → bounds on the current decay weight (0..1). */
  decay?: Record<string, { below?: number; above?: number }>;
  nodeExists?: string;
  /** node path → properties that must be present with exactly these values (other keys are ignored). */
  properties?: Record<string, Record<string, JsonValue>>;
}

export interface ExpectStep { expect: GraphExpect }
export interface NoteStep { note: string }

export type Step =
  | TurnStep
  | FeedbackStep
  | AdvanceDaysStep
  | AdvanceMsStep
  | ConsolidateStep
  | MaintainStep
  | DrainStep
  | ApproveStep
  | ForgetStep
  | RecallStep
  | ExpectStep
  | NoteStep;

export type StepKind =
  | "turn" | "feedback" | "advanceDays" | "advanceMs" | "consolidate" | "maintain" | "drain"
  | "approve" | "forget" | "recall" | "expect" | "note";

export interface Scenario {
  name: string;
  subjectId?: string;
  clientId?: string;
  /** ISO-8601; default 2026-01-01T09:00:00Z. */
  startAt?: string;
  steps: Step[];
}

export const DEFAULT_START_AT = "2026-01-01T09:00:00Z";

const STEP_KINDS: readonly StepKind[] = ["turn", "feedback", "advanceDays", "advanceMs", "consolidate", "maintain", "drain", "approve", "forget", "recall", "expect", "note"];

/** The one key of a step object that names its kind. */
export function stepKind(step: Step): StepKind {
  for (const k of STEP_KINDS) if (k in step) return k;
  throw new Error("unreachable: step without a kind");
}

// ── Validation helpers ──────────────────────────────────────────────────────

export class ScenarioError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ScenarioError";
  }
}

type Obj = Record<string, unknown>;

function isObj(u: unknown): u is Obj {
  return typeof u === "object" && u !== null && !Array.isArray(u);
}

function obj(u: unknown, path: string): Obj {
  if (!isObj(u)) throw new ScenarioError(path, "expected an object");
  return u;
}

function str(u: unknown, path: string): string {
  if (typeof u !== "string" || u.length === 0) throw new ScenarioError(path, "expected a non-empty string");
  return u;
}

function optStr(u: unknown, path: string): string | undefined {
  return u === undefined ? undefined : str(u, path);
}

function num(u: unknown, path: string, opts: { min?: number; integer?: boolean } = {}): number {
  if (typeof u !== "number" || !Number.isFinite(u)) throw new ScenarioError(path, "expected a finite number");
  if (opts.integer && !Number.isInteger(u)) throw new ScenarioError(path, "expected an integer");
  if (opts.min !== undefined && u < opts.min) throw new ScenarioError(path, `expected ≥ ${opts.min}`);
  return u;
}

function optNum(u: unknown, path: string, opts: { min?: number; integer?: boolean } = {}): number | undefined {
  return u === undefined ? undefined : num(u, path, opts);
}

function optBool(u: unknown, path: string): boolean | undefined {
  if (u === undefined) return undefined;
  if (typeof u !== "boolean") throw new ScenarioError(path, "expected true or false");
  return u;
}

function literalTrue(u: unknown, path: string): true {
  if (u !== true) throw new ScenarioError(path, "expected the literal true");
  return true;
}

function strArray(u: unknown, path: string): string[] {
  if (!Array.isArray(u)) throw new ScenarioError(path, "expected an array of strings");
  return u.map((v, i) => str(v, `${path}[${i}]`));
}

function optStrArray(u: unknown, path: string): string[] | undefined {
  return u === undefined ? undefined : strArray(u, path);
}

function oneOf<T extends string>(u: unknown, path: string, allowed: readonly T[]): T {
  if (typeof u !== "string" || !allowed.includes(u as T)) throw new ScenarioError(path, `expected one of ${allowed.join(" | ")}`);
  return u as T;
}

function optOneOf<T extends string>(u: unknown, path: string, allowed: readonly T[]): T | undefined {
  return u === undefined ? undefined : oneOf(u, path, allowed);
}

function record<V>(u: unknown, path: string, value: (v: unknown, p: string) => V): Record<string, V> {
  const o = obj(u, path);
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.length === 0) throw new ScenarioError(path, "keys must be non-empty text substrings");
    out[k] = value(v, `${path}["${k}"]`);
  }
  return out;
}

function optRecord<V>(u: unknown, path: string, value: (v: unknown, p: string) => V): Record<string, V> | undefined {
  return u === undefined ? undefined : record(u, path, value);
}

function rejectUnknownKeys(o: Obj, path: string, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ScenarioError(`${path}.${k}`, `unknown key (allowed: ${allowed.join(", ")})`);
}

function proposal(u: unknown, path: string): Proposal | undefined {
  if (u === undefined) return undefined;
  const result = validators.proposal(u);
  if (!result.ok) {
    const issues = result.issues.map((i) => `${i.path || "$"}: ${i.message}`).join("; ");
    throw new ScenarioError(path, `invalid proposal — ${issues}`);
  }
  return result.value;
}

function hintRef(o: Obj, path: string): HintRef {
  const hintText = optStr(o["hintText"], `${path}.hintText`);
  const hintId = optStr(o["hintId"], `${path}.hintId`);
  if (hintText !== undefined && hintId !== undefined) throw new ScenarioError(path, "give hintText or hintId, not both");
  if (hintText !== undefined) return { hintText };
  if (hintId !== undefined) return { hintId };
  throw new ScenarioError(path, "expected hintText or hintId");
}

const SIGNALS: readonly FeedbackSignal[] = ["up", "down", "comment", "correction"];
const EXTRACT_MODES: readonly ExtractMode[] = ["auto", "force", "skip"];
const STATUSES: readonly ExpectedStatus[] = ["active", "superseded", "retired", "pending", "absent"];
const MATURITIES: readonly HintMaturity[] = ["captured", "consolidated", "established"];

function feedbackTarget(u: unknown, path: string): FeedbackTarget | undefined {
  if (u === undefined) return undefined;
  const s = str(u, path);
  if (s === "response" || s.startsWith("agent:") || s.startsWith("tool:")) return s as FeedbackTarget;
  throw new ScenarioError(path, `expected "response", "agent:<name>" or "tool:<name>"`);
}

// ── Step parsers ────────────────────────────────────────────────────────────

function parseStep(u: unknown, path: string): Step {
  const o = obj(u, path);
  const kinds = STEP_KINDS.filter((k) => k in o);
  if (kinds.length !== 1) throw new ScenarioError(path, `expected exactly one of ${STEP_KINDS.join(" | ")} (found: ${kinds.join(", ") || "none"})`);
  const kind = kinds[0] as StepKind;
  rejectUnknownKeys(o, path, [kind]);
  const p = `${path}.${kind}`;
  const v = o[kind];
  switch (kind) {
    case "turn": {
      const t = obj(v, p);
      rejectUnknownKeys(t, p, ["user", "assistant", "agentsUsed", "recall", "proposal", "extract"]);
      const turn: TurnStep["turn"] = { user: str(t["user"], `${p}.user`) };
      const assistant = optStr(t["assistant"], `${p}.assistant`);
      const agentsUsed = optStrArray(t["agentsUsed"], `${p}.agentsUsed`);
      const recall = optBool(t["recall"], `${p}.recall`);
      const prop = proposal(t["proposal"], `${p}.proposal`);
      const extract = optOneOf(t["extract"], `${p}.extract`, EXTRACT_MODES);
      if (assistant !== undefined) turn.assistant = assistant;
      if (agentsUsed !== undefined) turn.agentsUsed = agentsUsed;
      if (recall !== undefined) turn.recall = recall;
      if (prop !== undefined) turn.proposal = prop;
      if (extract !== undefined) turn.extract = extract;
      return { turn };
    }
    case "feedback": {
      const f = obj(v, p);
      rejectUnknownKeys(f, p, ["signal", "text", "target", "proposal"]);
      const feedback: FeedbackStep["feedback"] = { signal: oneOf(f["signal"], `${p}.signal`, SIGNALS) };
      const text = optStr(f["text"], `${p}.text`);
      const target = feedbackTarget(f["target"], `${p}.target`);
      const prop = proposal(f["proposal"], `${p}.proposal`);
      if (text !== undefined) feedback.text = text;
      if (target !== undefined) feedback.target = target;
      if (prop !== undefined) feedback.proposal = prop;
      if (prop !== undefined && text === undefined) throw new ScenarioError(p, "a scripted proposal needs feedback text (the library never calls the extractor for textless feedback)");
      return { feedback };
    }
    case "advanceDays":
      return { advanceDays: num(v, p, { min: 0 }) };
    case "advanceMs":
      return { advanceMs: num(v, p, { min: 0, integer: true }) };
    case "consolidate":
      return { consolidate: literalTrue(v, p) };
    case "maintain":
      return { maintain: literalTrue(v, p) };
    case "drain":
      return { drain: literalTrue(v, p) };
    case "approve": {
      const a = obj(v, p);
      rejectUnknownKeys(a, p, ["hintText", "hintId", "status"]);
      const status = optOneOf(a["status"], `${p}.status`, ["approved", "rejected"] as const);
      return { approve: { ...hintRef(a, p), ...(status !== undefined ? { status } : {}) } };
    }
    case "forget": {
      const f = obj(v, p);
      rejectUnknownKeys(f, p, ["hintText", "hintId", "subject"]);
      if (f["subject"] !== undefined) {
        literalTrue(f["subject"], `${p}.subject`);
        if (f["hintText"] !== undefined || f["hintId"] !== undefined) throw new ScenarioError(p, "subject: true cannot be combined with a hint reference");
        return { forget: { subject: true } };
      }
      return { forget: hintRef(f, p) };
    }
    case "recall": {
      const r = obj(v, p);
      rejectUnknownKeys(r, p, ["text", "agent", "approvedOnly", "expect"]);
      const recall: RecallStep["recall"] = { text: str(r["text"], `${p}.text`) };
      const agent = optStr(r["agent"], `${p}.agent`);
      const approvedOnly = optBool(r["approvedOnly"], `${p}.approvedOnly`);
      if (agent !== undefined) recall.agent = agent;
      if (approvedOnly !== undefined) recall.approvedOnly = approvedOnly;
      if (r["expect"] !== undefined) {
        const e = obj(r["expect"], `${p}.expect`);
        rejectUnknownKeys(e, `${p}.expect`, ["category", "includes", "excludes", "minHints", "maxHints"]);
        const expect: RecallExpect = {};
        const category = optStr(e["category"], `${p}.expect.category`);
        const includes = optStrArray(e["includes"], `${p}.expect.includes`);
        const excludes = optStrArray(e["excludes"], `${p}.expect.excludes`);
        const minHints = optNum(e["minHints"], `${p}.expect.minHints`, { min: 0, integer: true });
        const maxHints = optNum(e["maxHints"], `${p}.expect.maxHints`, { min: 0, integer: true });
        if (category !== undefined) expect.category = category;
        if (includes !== undefined) expect.includes = includes;
        if (excludes !== undefined) expect.excludes = excludes;
        if (minHints !== undefined) expect.minHints = minHints;
        if (maxHints !== undefined) expect.maxHints = maxHints;
        recall.expect = expect;
      }
      return { recall };
    }
    case "expect": {
      const e = obj(v, p);
      rejectUnknownKeys(e, p, ["activeHints", "retired", "pending", "nodes", "hintStatus", "maturity", "needsReview", "reinforcements", "decay", "nodeExists", "properties"]);
      const expect: GraphExpect = {};
      const activeHints = optNum(e["activeHints"], `${p}.activeHints`, { min: 0, integer: true });
      const retired = optNum(e["retired"], `${p}.retired`, { min: 0, integer: true });
      const pending = optNum(e["pending"], `${p}.pending`, { min: 0, integer: true });
      const nodes = optNum(e["nodes"], `${p}.nodes`, { min: 0, integer: true });
      const hintStatus = optRecord(e["hintStatus"], `${p}.hintStatus`, (x, q) => oneOf(x, q, STATUSES));
      const maturity = optRecord(e["maturity"], `${p}.maturity`, (x, q) => oneOf(x, q, MATURITIES));
      const needsReview = optRecord(e["needsReview"], `${p}.needsReview`, (x, q) => {
        const b = optBool(x, q);
        if (b === undefined) throw new ScenarioError(q, "expected true or false");
        return b;
      });
      const reinforcements = optRecord(e["reinforcements"], `${p}.reinforcements`, (x, q) => num(x, q, { min: 0, integer: true }));
      const decay = optRecord(e["decay"], `${p}.decay`, (x, q) => {
        const d = obj(x, q);
        rejectUnknownKeys(d, q, ["below", "above"]);
        const below = optNum(d["below"], `${q}.below`, { min: 0 });
        const above = optNum(d["above"], `${q}.above`, { min: 0 });
        if (below === undefined && above === undefined) throw new ScenarioError(q, "expected below and/or above");
        return { ...(below !== undefined ? { below } : {}), ...(above !== undefined ? { above } : {}) };
      });
      const nodeExists = optStr(e["nodeExists"], `${p}.nodeExists`);
      const properties = optRecord(e["properties"], `${p}.properties`, (x, q) =>
        record(x, q, (val, r) => {
          if (val === undefined) throw new ScenarioError(r, "expected a JSON value");
          return val as JsonValue;
        }),
      );
      for (const path of Object.keys(properties ?? {})) {
        if (!path.startsWith("/")) throw new ScenarioError(`${p}.properties["${path}"]`, "expected a node path starting with /");
      }
      if (activeHints !== undefined) expect.activeHints = activeHints;
      if (retired !== undefined) expect.retired = retired;
      if (pending !== undefined) expect.pending = pending;
      if (nodes !== undefined) expect.nodes = nodes;
      if (hintStatus !== undefined) expect.hintStatus = hintStatus;
      if (maturity !== undefined) expect.maturity = maturity;
      if (needsReview !== undefined) expect.needsReview = needsReview;
      if (reinforcements !== undefined) expect.reinforcements = reinforcements;
      if (decay !== undefined) expect.decay = decay;
      if (nodeExists !== undefined) {
        if (!nodeExists.startsWith("/")) throw new ScenarioError(`${p}.nodeExists`, "expected a node path starting with /");
        expect.nodeExists = nodeExists;
      }
      if (properties !== undefined) expect.properties = properties;
      if (Object.keys(expect).length === 0) throw new ScenarioError(p, "an expect step needs at least one expectation");
      return { expect };
    }
    case "note":
      return { note: str(v, p) };
  }
}

/** Parse a scenario object (already JSON-decoded). Throws `ScenarioError` with the offending path. */
export function parseScenario(u: unknown, fallbackName = "scenario"): Scenario {
  const o = obj(u, "$");
  rejectUnknownKeys(o, "$", ["name", "subjectId", "clientId", "startAt", "steps", "$comment"]);
  const name = o["name"] === undefined ? fallbackName : str(o["name"], "$.name");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new ScenarioError("$.name", "expected letters, digits, dots, dashes or underscores (it names the store file)");
  const scenario: Scenario = { name, steps: [] };
  const subjectId = optStr(o["subjectId"], "$.subjectId");
  const clientId = optStr(o["clientId"], "$.clientId");
  const startAt = optStr(o["startAt"], "$.startAt");
  if (startAt !== undefined && !Number.isFinite(Date.parse(startAt))) throw new ScenarioError("$.startAt", "expected an ISO-8601 date");
  if (subjectId !== undefined) scenario.subjectId = subjectId;
  if (clientId !== undefined) scenario.clientId = clientId;
  if (startAt !== undefined) scenario.startAt = startAt;
  if (!Array.isArray(o["steps"]) || o["steps"].length === 0) throw new ScenarioError("$.steps", "expected a non-empty array of steps");
  scenario.steps = o["steps"].map((s, i) => parseStep(s, `$.steps[${i}]`));
  return scenario;
}

/** Read and validate a scenario file. The file's basename (minus .json) is the default name. */
export function loadScenario(file: string): Scenario {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new ScenarioError(file, `cannot read (${(e as Error).message})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ScenarioError(file, `not valid JSON (${(e as Error).message})`);
  }
  return parseScenario(json, basename(file).replace(/\.json$/i, ""));
}
