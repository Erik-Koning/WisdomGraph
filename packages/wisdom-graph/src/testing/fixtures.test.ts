/**
 * The fixtures are the ground every other suite stands on, so their promises
 * are pinned: the corpora are large enough, the categories are the
 * consumer's, every fixture row satisfies the validators and the sanitiser,
 * and `advisorFixture` contains exactly the population spec §11.1 describes.
 */
import { describe, expect, it } from "vitest";
import { validators } from "../core";
import { deterministicId } from "../core/ids";
import { KEYWORD_PATTERN } from "../core/schema/node";
import { SLOT_PATTERN } from "../core/schema/hint";
import { MemoryStore } from "../core/store/memory";
import { sanitizeStatement } from "../core/text/sanitize";
import type { SubjectRef } from "../core/ports";
import { FakeClock } from "./fakes";
import {
  FIXTURE_T0,
  SIA_CHAIN_IDS,
  benignCorpus,
  fixtureAudit,
  fixtureFeedback,
  fixtureHint,
  fixtureNode,
  fixtureTurn,
  injectionCorpus,
  advisorCategories,
  advisorFixture,
} from "./fixtures";

const SIA_HANDOFFS = [
  "consult_client_intelligence",
  "consult_advice",
  "consult_knowledge",
  "consult_newsroom",
  "consult_performance_coach",
  "consult_market_analyst",
  "consult_kyp",
  "consult_meetings",
];

describe("corpora", () => {
  it("are at least 50 entries each and fresh on every call", () => {
    expect(injectionCorpus().length).toBeGreaterThanOrEqual(50);
    expect(benignCorpus().length).toBeGreaterThanOrEqual(50);
    const a = benignCorpus();
    a.length = 0;
    expect(benignCorpus().length).toBeGreaterThanOrEqual(50);
  });
});

describe("row builders", () => {
  const ref: SubjectRef = { tenantId: null, subjectId: "rm_7" };

  it("fixtureNode derives id, parent, slug, level and lock from the path and validates", () => {
    const root = fixtureNode(ref, "/");
    expect(root).toMatchObject({ id: deterministicId("n", null, "rm_7", "/"), parentPath: null, slug: "", level: 0, locked: true, title: "Global" });
    const category = fixtureNode(ref, "/consult_client_intelligence");
    expect(category).toMatchObject({ parentPath: "/", slug: "consult_client_intelligence", level: 1, locked: true, title: "Consult client intelligence" });
    const leaf = fixtureNode(ref, "/consult_advice/retirement", { title: "Retirement" }, "2026-02-01T00:00:00.000Z");
    expect(leaf).toMatchObject({ parentPath: "/consult_advice", level: 2, locked: false, title: "Retirement", createdAt: "2026-02-01T00:00:00.000Z" });
    for (const node of [root, category, leaf]) expect(validators.node(node)).toEqual({ ok: true, value: node });
    expect(fixtureNode({ tenantId: "acme", subjectId: "rm_7" }, "/").id).not.toBe(root.id);
  });

  it("fixtureHint builds a valid active global hint by default and lets the spec override anything", () => {
    const hint = fixtureHint(ref, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." });
    expect(hint).toMatchObject({
      nodeId: fixtureNode(ref, "/").id,
      scope: "global",
      lane: "agent",
      kind: "preference",
      status: "active",
      approval: "auto",
      maturity: "captured",
      createdAt: FIXTURE_T0,
    });
    expect(validators.hintRecord(hint)).toEqual({ ok: true, value: hint });
    expect(fixtureHint(ref, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone." }).id).toBe(hint.id);
    expect(fixtureHint(ref, { nodePath: "/", slot: "tone", value: "brisk", text: "Prefers a brisk tone." }).id).not.toBe(hint.id);
    const scoped = fixtureHint(ref, { nodePath: "/consult_kyp", slot: "mer", value: "always", text: "Includes the MER.", scope: "agent", agent: "consult_kyp", lane: "preRoute", kind: "constraint" });
    expect(validators.hintRecord(scoped).ok).toBe(true);
    const otherAgent = fixtureHint(ref, { nodePath: "/consult_kyp", slot: "mer", value: "always", text: "Includes the MER.", scope: "agent", agent: "consult_advice", lane: "preRoute", kind: "constraint" });
    expect(otherAgent.id).not.toBe(scoped.id);
    expect(Object.keys(fixtureHint(ref, { nodePath: "/", slot: "tone", value: "warm", text: "Prefers a warm tone.", agent: undefined }))).not.toContain("agent");
  });

  it("fixtureTurn, fixtureFeedback and fixtureAudit build valid rows", () => {
    const turn = fixtureTurn("rm_7", "turn_1", { agentsUsed: ["consult_advice"] });
    expect(validators.event(turn)).toEqual({ ok: true, value: turn });
    expect(turn.runId).toBe("run_turn_1");
    const feedback = fixtureFeedback("rm_7", "fb_1", { signal: "down", text: "too long" });
    expect(validators.event(feedback)).toEqual({ ok: true, value: feedback });
    const audit = fixtureAudit(ref, "a_1", { action: "hint.approved" }, "2026-02-01T00:00:00.000Z");
    expect(audit).toMatchObject({ tenantId: null, subjectId: "rm_7", action: "hint.approved", at: "2026-02-01T00:00:00.000Z", detail: {} });
  });
});

describe("advisorCategories", () => {
  it("names the consumer's eight consult_* handoffs, each with a title, ≥ 6 valid keywords and one safe seed pattern", () => {
    const categories = advisorCategories();
    expect(categories.map((c) => c.name)).toEqual(SIA_HANDOFFS);
    for (const category of categories) {
      expect(category.title, category.name).toBeTruthy();
      expect(category.description, category.name).toBeTruthy();
      expect(category.keywords.length, category.name).toBeGreaterThanOrEqual(6);
      for (const keyword of category.keywords) expect(keyword, `${category.name} keyword ${keyword}`).toMatch(KEYWORD_PATTERN);
      expect(new Set(category.keywords).size).toBe(category.keywords.length);
      expect(category.patterns, category.name).toHaveLength(1);
      const [source] = category.patterns ?? [];
      expect(source?.length ?? 0).toBeLessThanOrEqual(200);
      expect(source).not.toMatch(/\([^)]*[+*]\)[+*]/);
      expect(source).not.toMatch(/\\[1-9]/);
      expect(() => new RegExp(source ?? "", "iu")).not.toThrow();
    }
  });

  it("returns fresh arrays", () => {
    const a = advisorCategories();
    a[0]?.keywords.push("mutated");
    expect(advisorCategories()[0]?.keywords).not.toContain("mutated");
  });

  it("seed patterns hit the queries they were written for", () => {
    const byName = new Map(advisorCategories().map((c) => [c.name, new RegExp(c.patterns?.[0] ?? "", "iu")]));
    expect(byName.get("consult_advice")?.test("How should I plan RRIF withdrawals?")).toBe(true);
    expect(byName.get("consult_client_intelligence")?.test("Who is my top client this quarter?")).toBe(true);
    expect(byName.get("consult_market_analyst")?.test("What did the TSX do today?")).toBe(true);
    expect(byName.get("consult_kyp")?.test("Send me the fund facts for XYZ")).toBe(true);
    expect(byName.get("consult_meetings")?.test("Draft an agenda for tomorrow")).toBe(true);
    expect(byName.get("consult_newsroom")?.test("Any headlines on banks?")).toBe(true);
    expect(byName.get("consult_performance_coach")?.test("Can we role-play an objection?")).toBe(true);
    expect(byName.get("consult_knowledge")?.test("What is a T4RIF?")).toBe(true);
    expect(byName.get("consult_advice")?.test("Draft an agenda for tomorrow")).toBe(false);
  });
});

describe("advisorFixture", () => {
  const fixture = advisorFixture();
  const ref: SubjectRef = { tenantId: null, subjectId: fixture.subjectId };
  const active = fixture.hints.filter((h) => h.status === "active");

  it("returns the eight categories, the subject ids and a null tenant", () => {
    expect(fixture.subjectId).toBe("rm_42");
    expect(fixture.sharedSubjectId).toBe("org_shared");
    expect(fixture.tenantId).toBeNull();
    expect(fixture.categories.map((c) => c.name)).toEqual(SIA_HANDOFFS);
  });

  it("has a root, the eight locked category nodes and six sub-nodes, all valid with deterministic ids", () => {
    expect(fixture.nodes).toHaveLength(15);
    const root = fixture.nodes.find((n) => n.path === "/");
    expect(root).toMatchObject({ level: 0, locked: true });
    const categories = fixture.nodes.filter((n) => n.level === 1);
    expect(categories.map((n) => n.slug)).toEqual(SIA_HANDOFFS);
    for (const node of categories) {
      expect(node.locked).toBe(true);
      expect(node.agents).toEqual([node.slug]);
      expect(node.keywords.length).toBeGreaterThanOrEqual(6);
      expect(node.patterns).toHaveLength(1);
    }
    const subNodes = fixture.nodes.filter((n) => n.level >= 2);
    expect(subNodes).toHaveLength(6);
    expect(subNodes.every((n) => !n.locked)).toBe(true);
    expect(subNodes.some((n) => n.level === 3)).toBe(true);
    for (const node of fixture.nodes) {
      expect(validators.node(node), node.path).toEqual({ ok: true, value: node });
      expect(node.id).toBe(deterministicId("n", null, fixture.subjectId, node.path));
      if (node.parentPath !== null) expect(fixture.nodes.some((p) => p.path === node.parentPath), `parent of ${node.path}`).toBe(true);
    }
    expect(new Set(fixture.nodes.map((n) => n.path)).size).toBe(fixture.nodes.length);
  });

  it("holds ~30 hints that all validate, hang off existing nodes and carry the node's id", () => {
    expect(fixture.hints.length).toBeGreaterThanOrEqual(28);
    expect(fixture.hints.length).toBeLessThanOrEqual(36);
    const byPath = new Map(fixture.nodes.map((n) => [n.path, n]));
    for (const hint of fixture.hints) {
      expect(validators.hintRecord(hint), hint.id).toEqual({ ok: true, value: hint });
      expect(hint.subjectId).toBe(fixture.subjectId);
      expect(hint.slot).toMatch(SLOT_PATTERN);
      const node = byPath.get(hint.nodePath);
      expect(node, `${hint.id} on ${hint.nodePath}`).toBeDefined();
      expect(hint.nodeId).toBe(node?.id);
    }
    expect(new Set(fixture.hints.map((h) => h.id)).size).toBe(fixture.hints.length);
  });

  it("spans every scope, lane, kind, source and maturity, with hints on nodes at every level", () => {
    const values = <K extends keyof (typeof fixture.hints)[number]>(key: K) => new Set(fixture.hints.map((h) => h[key]));
    expect([...values("scope")].sort()).toEqual(["agent", "category", "client", "global"]);
    expect([...values("lane")].sort()).toEqual(["agent", "preRoute", "responseStyle"]);
    expect([...values("kind")].sort()).toEqual(["constraint", "fact", "preference", "routing", "style"]);
    expect([...values("source")].sort()).toEqual(["explicit", "inferred"]);
    expect([...values("maturity")].sort()).toEqual(["captured", "consolidated", "established"]);
    expect([...values("status")].sort()).toEqual(["active", "pending", "retired", "superseded"]);
    const levels = new Set(fixture.hints.map((h) => fixture.nodes.find((n) => n.path === h.nodePath)?.level));
    expect([...levels].sort()).toEqual([0, 1, 2, 3]);
    const agents = new Set(fixture.hints.filter((h) => h.scope === "agent").map((h) => h.agent));
    expect(agents.size).toBeGreaterThanOrEqual(4);
    expect(fixture.hints.some((h) => h.reinforcements > 0 && h.applied > 0)).toBe(true);
    expect(fixture.hints.some((h) => h.needsReview)).toBe(true);
  });

  it("has exactly one approved hint, one pending hint, one retired hint and one supersession chain", () => {
    const approved = fixture.hints.filter((h) => h.approval === "approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]?.provenance.approval).toMatchObject({ by: "rm_admin" });
    expect(approved[0]?.status).toBe("active");

    expect(fixture.hints.filter((h) => h.status === "pending")).toHaveLength(1);
    const retired = fixture.hints.filter((h) => h.status === "retired");
    expect(retired).toHaveLength(1);
    expect(retired[0]?.retiredReason).toBe("decayed");

    const superseded = fixture.hints.filter((h) => h.status === "superseded");
    expect(superseded.map((h) => h.id)).toEqual([SIA_CHAIN_IDS.superseded]);
    const old = superseded[0];
    const current = fixture.hints.find((h) => h.id === old?.supersededBy);
    expect(current).toMatchObject({ id: SIA_CHAIN_IDS.active, status: "active", supersedes: old?.id, slot: old?.slot, nodePath: old?.nodePath });
    expect(current?.value).not.toBe(old?.value);
    expect(current?.provenance.supersedes).toBe(old?.id);
  });

  it("has client-scoped hints for client_A, one of which shares a slot with a category hint on the same node", () => {
    const clientHints = fixture.hints.filter((h) => h.scope === "client");
    expect(clientHints.length).toBeGreaterThanOrEqual(2);
    expect(clientHints.every((h) => h.clientId === "client_A")).toBe(true);
    const conflict = clientHints.find((h) =>
      fixture.hints.some((o) => o.id !== h.id && o.scope === "category" && o.nodePath === h.nodePath && o.slot === h.slot && o.status === "active"),
    );
    expect(conflict).toBeDefined();
  });

  it("keeps the slot-uniqueness invariant among active hints", () => {
    const keys = active.map((h) => [h.nodePath, h.slot, h.scope, h.agent ?? "", h.clientId ?? ""].join("|"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses only texts the sanitiser accepts unchanged and without review", () => {
    const fromShared = fixture.store.snapshot().subjects.find((s) => s.subjectId === fixture.sharedSubjectId)?.hints ?? [];
    for (const hint of [...fixture.hints, ...fromShared]) {
      const result = sanitizeStatement(hint.text);
      expect(result, hint.text).toEqual({ ok: true, text: hint.text, review: false });
      expect(hint.text.length).toBeLessThanOrEqual(200);
    }
  });

  it("mirrors the active hint counts into node stats", () => {
    for (const node of fixture.nodes) {
      const expected = active.filter((h) => h.nodePath === node.path).length;
      expect(node.stats.activeHints, node.path).toBe(expected);
      if (expected > 0) expect(node.stats.lastIngestAt).toBeDefined();
    }
  });

  it("is loaded into the store: the snapshot returns the same nodes and active hints, plus aliases, tombstones and the counter", async () => {
    const snapshot = await fixture.store.loadSnapshot(ref);
    expect(snapshot?.version).toBeGreaterThan(0);
    expect(snapshot?.nodes).toEqual(fixture.nodes);
    expect(snapshot?.hints).toEqual(active);
    expect(snapshot?.slotAliases).toEqual({ "format.list": "format.lists", region: "region.default" });
    expect(snapshot?.tombstones).toEqual(["h_forgotten_1"]);
    expect(snapshot?.eventsSinceConsolidation).toBe(3);
    const everything = await fixture.store.loadSnapshot(ref, { statuses: ["active", "pending", "superseded", "retired"] });
    expect(everything?.hints).toEqual(fixture.hints);
  });

  it("holds a shared subject with one approved and one unapproved hint on its root", async () => {
    const shared = await fixture.store.loadSnapshot({ tenantId: null, subjectId: fixture.sharedSubjectId });
    expect(shared?.nodes.map((n) => n.path)).toEqual(["/"]);
    expect(shared?.hints).toHaveLength(2);
    expect(shared?.hints.filter((h) => h.approval === "approved")).toHaveLength(1);
    expect(shared?.hints.filter((h) => h.approval === "auto")).toHaveLength(1);
    for (const hint of shared?.hints ?? []) expect(validators.hintRecord(hint).ok).toBe(true);
  });

  it("records one processed turn whose applied hints exist and an audit trail", async () => {
    const events = await fixture.store.listEvents(ref, { limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "done", event: { type: "turn", runId: "run_7", agentsUsed: ["consult_advice"] } });
    const turn = await fixture.store.getTurn(ref, "run_7");
    expect(turn?.appliedHintIds?.length).toBe(2);
    for (const id of turn?.appliedHintIds ?? []) expect(fixture.hints.some((h) => h.id === id)).toBe(true);
    const audit = await fixture.store.listAudit(ref, 10);
    expect(audit.map((a) => a.action)).toEqual(["hint.approved", "hint.created"]);
  });

  it("takes its timestamps from the given clock and never from the future", () => {
    const clock = new FakeClock(Date.UTC(2027, 5, 1));
    const shifted = advisorFixture({ clock });
    const latest = Math.max(...shifted.hints.map((h) => Date.parse(h.createdAt)));
    expect(latest).toBeLessThanOrEqual(clock.now());
    expect(latest).toBeGreaterThan(Date.UTC(2027, 4, 1));
    for (const hint of shifted.hints) expect(Date.parse(hint.lastReinforcedAt)).toBeGreaterThanOrEqual(Date.parse(hint.createdAt));
    const epoch = advisorFixture();
    expect(Math.max(...epoch.hints.map((h) => Date.parse(h.createdAt)))).toBeLessThanOrEqual(new FakeClock().now());
  });

  it("returns fresh objects and an independent store on every call", async () => {
    const a = advisorFixture();
    const b = advisorFixture();
    expect(a.store).not.toBe(b.store);
    expect(a.hints).toEqual(b.hints);
    a.hints[0]!.text = "mutated";
    a.nodes[0]!.keywords.push("mutated");
    expect(b.hints[0]?.text).not.toBe("mutated");
    await a.store.deleteSubject(ref);
    await expect(b.store.loadSnapshot(ref)).resolves.not.toBeNull();
  });

  it("round-trips through snapshot()/load()", () => {
    const serialised = fixture.store.snapshot();
    const copy = new MemoryStore();
    copy.load(serialised);
    expect(copy.snapshot()).toEqual(serialised);
  });
});
