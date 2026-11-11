/**
 * The decay model is one exponential read from a policy table, and the
 * promotion and retirement predicates are threshold checks against it. The
 * maths is pinned at a FakeClock — every maturity × source lands on exactly
 * 0.5 after one half-life — because a drift here silently changes which
 * hints render and which `maintain()` forgets.
 */
import { describe, expect, it } from "vitest";
import { defaultPolicy, mergePolicy } from "../policy";
import type { SubjectRef } from "../ports";
import type { Hint, HintMaturity, HintRecord, HintSource } from "../types";
import { FakeClock } from "../../testing/fakes";
import { fixtureHint } from "../../testing/fixtures";
import { toHint } from "../graph/snapshot";
import {
  DEFAULT_MATURITY,
  ageDays,
  decayWeight,
  effectiveScore,
  halfLifeDays,
  promotionDue,
  retirementDue,
  scoreHint,
} from "./decay";

const ref: SubjectRef = { tenantId: null, subjectId: "rm_42" };
const DAY_MS = 86_400_000;
const MATURITIES: HintMaturity[] = ["captured", "consolidated", "established"];
const SOURCES: HintSource[] = ["explicit", "inferred"];

function record(over: Partial<HintRecord>, at: string): HintRecord {
  return fixtureHint(
    ref,
    { nodePath: "/", slot: "format.lists", value: "bullets", text: "Prefers bullet points.", createdAt: at, updatedAt: at, lastReinforcedAt: at, ...over },
    at,
  );
}

function hintOf(over: Partial<HintRecord>, at: string): Hint {
  const h = toHint(record(over, at));
  if (h === null) throw new Error("fixture hint is never rejected");
  return h;
}

describe("halfLifeDays", () => {
  it("reads the policy table by maturity × source", () => {
    const clock = new FakeClock();
    for (const maturity of MATURITIES) {
      for (const source of SOURCES) {
        const r = record({ maturity, source }, clock.iso());
        expect(halfLifeDays(r, defaultPolicy)).toBe(defaultPolicy.decay.halfLifeDays[maturity][source]);
      }
    }
  });

  it("is null for approved hints whatever the table says", () => {
    const clock = new FakeClock();
    for (const maturity of MATURITIES) {
      for (const source of SOURCES) {
        expect(halfLifeDays(record({ maturity, source, approval: "approved" }, clock.iso()), defaultPolicy)).toBeNull();
      }
    }
  });

  it("treats a non-positive configured half-life as no decay", () => {
    const clock = new FakeClock();
    const policy = mergePolicy({ decay: { halfLifeDays: { captured: { inferred: 0, explicit: -5 } } } });
    expect(halfLifeDays(record({ maturity: "captured", source: "inferred" }, clock.iso()), policy)).toBeNull();
    expect(halfLifeDays(record({ maturity: "captured", source: "explicit" }, clock.iso()), policy)).toBeNull();
  });

  it("takes the maturity for a Hint from the context, defaulting to captured", () => {
    const clock = new FakeClock();
    const h = hintOf({ source: "inferred" }, clock.iso());
    expect(DEFAULT_MATURITY).toBe("captured");
    expect(halfLifeDays(h, defaultPolicy)).toBe(defaultPolicy.decay.halfLifeDays.captured.inferred);
    expect(halfLifeDays(h, defaultPolicy, "established")).toBe(defaultPolicy.decay.halfLifeDays.established.inferred);
  });
});

describe("decayWeight (§6.2)", () => {
  it.each(MATURITIES.flatMap((maturity) => SOURCES.map((source) => [maturity, source] as const)))(
    "%s × %s is 1 when fresh, 0.5 at one half-life, 0.25 at two (or 1 forever when the table says null)",
    (maturity, source) => {
      const clock = new FakeClock();
      const r = record({ maturity, source }, clock.iso());
      const halfLife = defaultPolicy.decay.halfLifeDays[maturity][source];
      expect(decayWeight(r, { now: clock.now(), policy: defaultPolicy })).toBe(1);
      if (halfLife === null) {
        clock.advanceDays(10_000);
        expect(decayWeight(r, { now: clock.now(), policy: defaultPolicy })).toBe(1);
        return;
      }
      clock.advanceDays(halfLife);
      expect(decayWeight(r, { now: clock.now(), policy: defaultPolicy })).toBeCloseTo(0.5, 12);
      clock.advanceDays(halfLife);
      expect(decayWeight(r, { now: clock.now(), policy: defaultPolicy })).toBeCloseTo(0.25, 12);
    },
  );

  it("is exactly 1 for approved hints at any age", () => {
    const clock = new FakeClock();
    const rows = MATURITIES.flatMap((maturity) => SOURCES.map((source) => record({ maturity, source, approval: "approved" }, clock.iso())));
    clock.advanceDays(3_650);
    for (const r of rows) expect(decayWeight(r, { now: clock.now(), policy: defaultPolicy })).toBe(1);
  });

  it("uses the recall-facing Hint's provenance timestamp and the context maturity", () => {
    const clock = new FakeClock();
    const h = hintOf({ source: "inferred" }, clock.iso());
    clock.advanceDays(30);
    expect(decayWeight(h, { now: clock.now(), policy: defaultPolicy })).toBeCloseTo(0.5, 12);
    expect(decayWeight(h, { now: clock.now(), policy: defaultPolicy, maturity: "consolidated" })).toBeCloseTo(Math.pow(0.5, 30 / 90), 12);
  });

  it("never exceeds 1 for a reinforcement timestamp in the future", () => {
    const clock = new FakeClock();
    const future = new Date(clock.now() + 10 * DAY_MS).toISOString();
    expect(decayWeight(record({ source: "inferred" }, future), { now: clock.now(), policy: defaultPolicy })).toBe(1);
  });

  it("reads an unparseable instant as just now", () => {
    expect(ageDays("not a date", 0)).toBe(0);
    expect(ageDays(new Date(0).toISOString(), 2 * DAY_MS)).toBe(2);
  });
});

describe("effectiveScore / scoreHint", () => {
  it("multiplies priority, confidence, decay, scope, source and relevance", () => {
    const clock = new FakeClock();
    const r = record({ priority: 80, confidence: 0.9, scope: "agent", agent: "consult_advice", source: "explicit" }, clock.iso());
    const ctx = { now: clock.now(), policy: defaultPolicy, relevance: 0.5 };
    expect(effectiveScore(r, ctx)).toBeCloseTo(0.8 * 0.9 * 1 * 0.9 * 1 * 0.5, 12);
    expect(scoreHint(r, ctx)).toBe(effectiveScore(r, ctx));
  });

  it("applies the source and scope weights from the policy and the decay at the clock", () => {
    const clock = new FakeClock();
    const r = record({ priority: 100, confidence: 1, scope: "global", source: "inferred", maturity: "captured" }, clock.iso());
    clock.advanceDays(30);
    const expected = 1 * 1 * 0.5 * defaultPolicy.recall.scopeWeight.global * defaultPolicy.recall.sourceWeight.inferred * 1;
    expect(scoreHint(r, { now: clock.now(), policy: defaultPolicy, relevance: 1 })).toBeCloseTo(expected, 12);
  });
});

describe("promotionDue", () => {
  const clock = new FakeClock();
  const now = clock.now();
  const ctx = { now, policy: defaultPolicy };
  const at = (daysAgo: number): string => new Date(now - daysAgo * DAY_MS).toISOString();

  it("captured → consolidated when applied enough, or reinforced at all", () => {
    expect(promotionDue(record({ maturity: "captured", applied: 3 }, at(1)), ctx)).toBe("consolidated");
    expect(promotionDue(record({ maturity: "captured", applied: 0, reinforcements: 1 }, at(1)), ctx)).toBe("consolidated");
    expect(promotionDue(record({ maturity: "captured", applied: 2, reinforcements: 0 }, at(1)), ctx)).toBeNull();
  });

  it("consolidated → established with 3 reinforcements spanning 7 days", () => {
    const spanning = record({ maturity: "consolidated", reinforcements: 3, createdAt: at(10), lastReinforcedAt: at(1) }, at(10));
    expect(promotionDue(spanning, ctx)).toBe("established");
    const tooFast = record({ maturity: "consolidated", reinforcements: 3, createdAt: at(5), lastReinforcedAt: at(1) }, at(5));
    expect(promotionDue(tooFast, ctx)).toBeNull();
    const tooFew = record({ maturity: "consolidated", reinforcements: 2, createdAt: at(30), lastReinforcedAt: at(1) }, at(30));
    expect(promotionDue(tooFew, ctx)).toBeNull();
  });

  it("consolidated → established with 10 applications and zero contradictions", () => {
    expect(promotionDue(record({ maturity: "consolidated", applied: 10, contradictions: 0 }, at(1)), ctx)).toBe("established");
    expect(promotionDue(record({ maturity: "consolidated", applied: 10, contradictions: 1 }, at(1)), ctx)).toBeNull();
    expect(promotionDue(record({ maturity: "consolidated", applied: 9, contradictions: 0 }, at(1)), ctx)).toBeNull();
  });

  it("never promotes established, inactive, or beyond the policy's thresholds", () => {
    expect(promotionDue(record({ maturity: "established", applied: 100, reinforcements: 100 }, at(1)), ctx)).toBeNull();
    expect(promotionDue(record({ maturity: "captured", applied: 10, status: "pending" }, at(1)), ctx)).toBeNull();
    expect(promotionDue(record({ maturity: "captured", applied: 10, status: "retired" }, at(1)), ctx)).toBeNull();
    const strict = { now, policy: mergePolicy({ promotion: { consolidatedMinApplied: 20 } }) };
    expect(promotionDue(record({ maturity: "captured", applied: 10 }, at(1)), strict)).toBeNull();
  });
});

describe("retirementDue (§6.2, §6.4)", () => {
  it("retires an unreinforced, unapplied captured inferred hint once its weight falls under retireBelow", () => {
    const clock = new FakeClock();
    const r = record({ maturity: "captured", source: "inferred" }, clock.iso());
    clock.advanceDays(60);
    expect(decayWeight(r, { now: clock.now(), policy: defaultPolicy })).toBeCloseTo(0.25, 12);
    expect(retirementDue(r, { now: clock.now(), policy: defaultPolicy })).toBe(false);
    clock.advanceDays(40);
    expect(decayWeight(r, { now: clock.now(), policy: defaultPolicy })).toBeLessThan(defaultPolicy.decay.retireBelow);
    expect(retirementDue(r, { now: clock.now(), policy: defaultPolicy })).toBe(true);
  });

  it("keeps a decayed hint that was applied within the last half-life", () => {
    const clock = new FakeClock();
    const born = clock.iso();
    clock.advanceDays(100);
    const recentlyUsed = record({ maturity: "captured", source: "inferred", lastAppliedAt: new Date(clock.now() - 10 * DAY_MS).toISOString() }, born);
    expect(retirementDue(recentlyUsed, { now: clock.now(), policy: defaultPolicy })).toBe(false);
    const longUnused = record({ maturity: "captured", source: "inferred", lastAppliedAt: new Date(clock.now() - 40 * DAY_MS).toISOString() }, born);
    expect(retirementDue(longUnused, { now: clock.now(), policy: defaultPolicy })).toBe(true);
  });

  it("never retires approved, non-decaying, or inactive hints", () => {
    const clock = new FakeClock();
    const born = clock.iso();
    clock.advanceDays(10_000);
    const ctx = { now: clock.now(), policy: defaultPolicy };
    expect(retirementDue(record({ maturity: "captured", source: "inferred", approval: "approved" }, born), ctx)).toBe(false);
    expect(retirementDue(record({ maturity: "established", source: "explicit" }, born), ctx)).toBe(false);
    expect(retirementDue(record({ maturity: "captured", source: "inferred", status: "superseded" }, born), ctx)).toBe(false);
  });
});
