/**
 * The smallest real consumer: resolves `@mosphere/wisdom-graph` and its three
 * subpaths through the workspace link exactly as an npm install would, so it
 * exercises the package's `exports` map and the built `dist/`, not the source
 * tree. Each subpath is imported for something it actually does — a recall
 * that renders through the langgraph helpers, the fixture graph from
 * `./testing`, and the migrations `./postgres` hands a migration owner — so a
 * broken entry fails loudly here rather than in a consumer.
 *
 *   npm run build && npm run dev -w example
 */
import { createWisdomGraph, PACKAGE_NAME } from "@mosphere/wisdom-graph";
import { migrations, renderMigrationsSql } from "@mosphere/wisdom-graph/postgres";
import { createRecallScope, startTurnRecall, systemPromptPrefix, nodePreamble, synthesizeSuffix } from "@mosphere/wisdom-graph/langgraph";
import { FakeClock, advisorFixture } from "@mosphere/wisdom-graph/testing";

console.log(`${PACKAGE_NAME} loaded from the built package.`);

// ── ./testing: the consumer's advisor graph, pre-loaded in a MemoryStore ────
const clock = new FakeClock();
const fixture = advisorFixture({ clock });
console.log(`fixture: subject ${fixture.subjectId}, ${fixture.nodes.length} nodes, ${fixture.hints.length} hints`);

// ── ".": the engine over that store ──────────────────────────────────────────
const graph = createWisdomGraph({
  store: fixture.store,
  categories: fixture.categories,
  sharedSubjectId: fixture.sharedSubjectId,
  clock,
});

// ── ./langgraph: two lanes, one request (spec §8.2) ──────────────────────────
const scope = createRecallScope();
const handle = startTurnRecall(graph, {
  subjectId: fixture.subjectId,
  clientId: "client_A",
  text: "What should I tell my top client about rebalancing before the review meeting?",
  budgetMs: 2500,
});

await scope.run(handle, async () => {
  const laneA = await scope.laneA(); // START: raced at 150 ms, empty on timeout
  const laneB = await scope.laneB(); // MIDDLE/END: the rest of the budget
  console.log(`recall: status=${laneB.meta.status} topic=${laneB.topic.category} agents=[${laneB.topic.agents.join(", ")}] applied=${laneB.provenance.length}`);
  const prefix = systemPromptPrefix(laneA);
  const preamble = nodePreamble(laneB, laneB.topic.agents[0] ?? "consult_advice");
  const suffix = synthesizeSuffix(laneB);
  console.log(`lanes: preRoute ${prefix.length} chars, agent ${preamble.length} chars, responseStyle ${suffix.length} chars`);
  if (preamble) console.log(preamble);
});

// ── ./postgres: the schema a migration owner includes ────────────────────────
const ids = migrations({ pgvector: true }).map((m) => m.id);
const sql = renderMigrationsSql();
console.log(`postgres: migrations [${ids.join(", ")}]; plain SQL ${sql.length} chars`);

await graph.close();
