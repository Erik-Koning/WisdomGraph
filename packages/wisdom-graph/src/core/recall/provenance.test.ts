/**
 * `Recall.provenance` is the whole candidate set — every bucket, every
 * agent that might run — and the consumer passes it straight back as
 * `TurnEvent.appliedHintIds` (README, spec §8.4). What actually rendered
 * depends on which specialist the router ran, which only the turn knows,
 * so this test pins the contract across the two halves: after a turn that
 * used one agent, the hints of the agents that did not run keep their
 * `applied` count, and everything that rendered moves by exactly one.
 */
import { describe, expect, it } from "vitest";
import { createWisdomGraph } from "../engine";
import type { HintRecord } from "../types";
import { FakeClock } from "../../testing/fakes";
import { advisorFixture } from "../../testing/fixtures";

const QUERY = "How should we sequence RRIF withdrawals for a retiree with a large TFSA?";

describe("provenance → appliedHintIds → applied (§5.3 step 1)", () => {
  it("bumps applied only for hints that rendered on the turn: an agent's own hints count when that agent ran", async () => {
    const clock = new FakeClock();
    const fixture = advisorFixture({ clock });
    const ref = { tenantId: null, subjectId: fixture.subjectId };
    const graph = createWisdomGraph({ store: fixture.store, categories: fixture.categories, clock, sharedSubjectId: fixture.sharedSubjectId });
    const recall = await graph.recall({ subjectId: fixture.subjectId, text: QUERY, budgetMs: 1_000 });
    expect(recall.meta.status).toBe("ok");
    expect(recall.topic.agents).toContain("consult_advice");

    const before = new Map<string, HintRecord>();
    for (const id of recall.provenance) {
      const row = await fixture.store.getHint(ref, id);
      if (row !== null) before.set(id, row);
    }
    const ownOf = (agent: string): HintRecord[] => [...before.values()].filter((h) => h.lane === "agent" && h.scope === "agent" && h.agent === agent);
    const shared = [...before.values()].filter((h) => h.lane !== "agent" || h.scope !== "agent");
    expect(ownOf("consult_advice").length).toBeGreaterThan(0);
    expect(ownOf("consult_kyp").length).toBeGreaterThan(0);
    expect(shared.length).toBeGreaterThan(0);

    const receipt = await graph.ingest(
      {
        type: "turn",
        id: "turn_provenance",
        runId: "run_provenance",
        subjectId: fixture.subjectId,
        agentsUsed: ["consult_advice"],
        userText: QUERY,
        assistantText: "Start with the RRIF minimum, then top up from the TFSA.",
        appliedHintIds: [...recall.provenance],
      },
      { waitFor: "processed", extract: "skip" },
    );
    expect(receipt.status).toBe("processed");

    for (const hint of ownOf("consult_advice")) expect((await fixture.store.getHint(ref, hint.id))?.applied, hint.slot).toBe(hint.applied + 1);
    for (const hint of shared) expect((await fixture.store.getHint(ref, hint.id))?.applied, hint.slot).toBe(hint.applied + 1);
    for (const hint of ownOf("consult_kyp")) {
      const after = await fixture.store.getHint(ref, hint.id);
      expect(after?.applied, hint.slot).toBe(hint.applied);
      expect(after?.provenance.eventIds, hint.slot).not.toContain("turn_provenance");
    }
    await graph.close();
  });
});
