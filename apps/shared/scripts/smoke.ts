/** Offline end-to-end smoke of the harness: capture → recall → render → explain. */
import { createHarness, formatExplanation, formatRecall, formatReceipt } from "../src/index";
import { synthesizeSuffix, nodePreamble } from "@mosphere/wisdom-graph/langgraph";

const h = await createHarness({ config: { offline: true, storeFile: ".wisdom/smoke-harness.json", logLevel: "info" } });
console.log(h.banner());
const subjectId = h.cfg.subjectId;
const runId = `run_${Date.now()}`;
const r0 = await h.graph.recall({ subjectId, text: "how do I fix this typescript error?", budgetMs: 2000 });
console.log(formatRecall(r0));
console.log(formatReceipt(await h.graph.ingest({ type: "turn", id: `turn_${runId}`, runId, subjectId, agentsUsed: ["assist_code"], userText: "how do I fix this typescript error?", assistantText: "Here is a long answer...", appliedHintIds: r0.provenance })));
console.log(formatReceipt(await h.graph.ingest({ type: "feedback", id: `fb_${runId}`, runId, subjectId, signal: "comment", text: "please keep answers shorter, use bullet points, and no disclaimers. Call me Erik." })));
const r1 = await h.graph.recall({ subjectId, text: "how do I fix this typescript error?", budgetMs: 2000 });
console.log(formatRecall(r1));
console.log(nodePreamble(r1, "assist_code"));
console.log(synthesizeSuffix(r1));
const reply = await h.chat({ system: "You are helpful." + synthesizeSuffix(r1), messages: [{ role: "user", content: "hi" }] });
console.log(reply);
console.log(formatExplanation(await h.graph.explain(subjectId, { text: "typescript error" })));
await h.close();
