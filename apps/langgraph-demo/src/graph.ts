/**
 * graph.ts — a supervisor-shaped supervisor graph with the three injection sites.
 *
 *   START → router ─┬─ "direct" ───────────────────→ respond ──────→ END
 *                   ├─ one category ───────────────→ <specialist> ─→ END   (no synthesize)
 *                   └─ many categories (Send fan-out) → <specialist>×N → synthesize → END
 *
 * The specialists are the harness's categories (`assist_code`, `assist_writing`,
 * …), standing in for the host app's `consult_*` agents. Recall is never a node: the
 * per-turn handle rides `scope` (AsyncLocalStorage) and each site awaits its
 * own lane with its own budget —
 *
 *   router      ROUTER_PROMPT + systemPromptPrefix(await scope.laneA())     Lane A, 150 ms race
 *   specialist  basePersona   + nodePreamble(await scope.laneB(), category) Lane B, rest of budget
 *   synthesize  SYNTH_PROMPT  + synthesizeSuffix(await scope.laneB())       Lane B, rest of budget
 *
 * Every node appends a `NodeTrace` to state (append reducer, so parallel
 * specialists merge) and logs one `[node] lane=… hints=N` line to stderr.
 * `toNeutralMessages` is exercised on the live LangChain objects in the
 * state, not on plain records, which is the adapter claim this app proves.
 */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { Annotation, END, START, Send, StateGraph, messagesStateReducer } from "@langchain/langgraph";
import { z } from "zod";
import type { CategorySpec, Recall } from "@mosphere/wisdom-graph";
import { lastUserText, nodePreamble, synthesizeSuffix, systemPromptPrefix, toNeutralMessages } from "@mosphere/wisdom-graph/langgraph";
import { hintLinesIn, type Harness } from "@wisdom-graph/harness";
import type { DemoModels } from "./models";
import { scope } from "./scope";

// ── State ────────────────────────────────────────────────────────────────────

/** What one node injected and when it ran; `/hints` and `/route` read these. */
export interface NodeTrace {
  node: string;
  lane: "A" | "B";
  /** `recall.meta.status` (+ reason) the lane resolved with — "budget" means the race timed out. */
  recall: string;
  /** `<<wisdom-hints>>` blocks rendered into this node's prompt. */
  blocks: number;
  /** Bullet lines inside those blocks. */
  hints: string[];
  startedAt: number;
  endedAt: number;
}

export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  /** The router's decision: ["direct"] or one or more category names. */
  route: Annotation<string[]>({ reducer: (_l, r) => r, default: () => [] }),
  /** Parallel specialists each write their own key; the reducer merges. */
  specialistOutputs: Annotation<Record<string, string>>({ reducer: (l, r) => ({ ...l, ...r }), default: () => ({}) }),
  answer: Annotation<string>({ reducer: (_l, r) => r, default: () => "" }),
  trace: Annotation<NodeTrace[]>({ reducer: (l, r) => l.concat(r), default: () => [] }),
});
export type State = typeof GraphState.State;

// ── Prompts ──────────────────────────────────────────────────────────────────

export const DIRECT = "direct";

function routerPrompt(categories: CategorySpec[]): string {
  const list = categories.map((c) => `- ${c.name}: ${c.description ?? c.title ?? c.name}`).join("\n");
  return [
    "You are the router of a supervisor. Decide which specialists should answer the user's latest message.",
    "Specialists:",
    list,
    `Reply with strict JSON only, no prose: {"route": ["direct"]} for greetings, chit-chat or clarifying questions, otherwise {"route": ["<specialist>", ...]} with one entry per specialist that is genuinely needed (several only when the message spans several domains).`,
  ].join("\n");
}

function basePersona(c: CategorySpec): string {
  return `You are the ${c.title ?? c.name} specialist of a supervisor. ${c.description ?? ""} Answer the user's latest message directly and concretely.`.trim();
}

const DIRECT_PROMPT = "You are a friendly assistant. The router judged this message needs no specialist: answer briefly, or ask one clarifying question.";
const SYNTH_PROMPT = "You are the synthesizer of a supervisor. Several specialists answered the user's latest message in parallel; combine their answers into one coherent reply. Do not mention the specialists.";

// ── Router decision ──────────────────────────────────────────────────────────

const RouteReply = z.object({ route: z.array(z.string()).min(1) });

/** Strict-JSON parse of the online router's reply; anything unparseable or unknown falls back to direct. */
export function parseRoute(text: string, known: ReadonlySet<string>): string[] {
  const body = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const parsed = RouteReply.safeParse(JSON.parse(body));
    if (!parsed.success) return [DIRECT];
    const picked = [...new Set(parsed.data.route.filter((r) => known.has(r)))];
    return picked.length === 0 ? [DIRECT] : picked;
  } catch {
    return [DIRECT];
  }
}

/**
 * Offline routing: the Lane A topic first (the library's own classifier over
 * the same text), then a keyword score per category on the harness config so
 * a multi-domain question fans out and a Lane A timeout still routes.
 */
export function offlineRoute(text: string, recall: Recall, categories: CategorySpec[]): string[] {
  const lower = text.toLowerCase();
  const scored = categories
    .map((c) => ({ name: c.name, hits: c.keywords.filter((k) => lower.includes(k.toLowerCase())).length }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  const picked = new Set<string>();
  if (recall.topic.category !== DIRECT && recall.topic.confidence >= 0.3 && categories.some((c) => c.name === recall.topic.category)) {
    picked.add(recall.topic.category);
  }
  for (const s of scored) if (picked.size < 3) picked.add(s.name);
  return picked.size === 0 ? [DIRECT] : [...picked];
}

// ── Graph ────────────────────────────────────────────────────────────────────

function describe(r: Recall): string {
  return r.meta.reason ? `${r.meta.status}/${r.meta.reason}` : r.meta.status;
}

function log(node: string, lane: "A" | "B", prompt: string, r: Recall, extra = ""): NodeTrace {
  const hints = hintLinesIn(prompt);
  const blocks = (prompt.match(/<<wisdom-hints\b/g) ?? []).length;
  process.stderr.write(`[${node}] lane=${lane} hints=${hints.length} blocks=${blocks} recall=${describe(r)}${extra ? ` ${extra}` : ""}\n`);
  return { node, lane, recall: describe(r), blocks, hints, startedAt: Date.now(), endedAt: Date.now() };
}

export function buildGraph(h: Harness, models: DemoModels) {
  const categories = h.cfg.categories;
  const names = categories.map((c) => c.name);
  const known = new Set<string>([DIRECT, ...names]);

  // START — Lane A (150 ms race) into the router prompt. Mirrors router.ts.
  const router = async (state: State) => {
    const startedAt = Date.now();
    const recall = await scope.laneA();
    const system = routerPrompt(categories) + systemPromptPrefix(recall);
    // The adapter on live LangChain objects: the same neutral turns the request built recentTurns from.
    const text = lastUserText(state.messages);
    const neutral = toNeutralMessages(state.messages, { last: 6 });
    let route: string[];
    if (models.kind === "fake") {
      route = offlineRoute(text, recall, categories);
    } else {
      const reply = await models.model.invoke([new SystemMessage(system), ...state.messages]);
      route = parseRoute(reply.text, known);
    }
    const trace = log("router", "A", system, recall, `topic=${recall.topic.category}(${recall.topic.confidence.toFixed(2)}) neutralTurns=${neutral.length} route=${route.join(",")}`);
    return { route, trace: [{ ...trace, startedAt, endedAt: Date.now() }] };
  };

  // Direct path — in the host app the router answers itself under Lane A; here a tiny node answers under Lane B
  // through nodePreamble(…, "direct"), which serves `agentDefaults` for an agent without a bucket.
  const respond = async (state: State) => {
    const startedAt = Date.now();
    const recall = await scope.laneB();
    const system = DIRECT_PROMPT + nodePreamble(recall, DIRECT);
    const reply = await models.model.invoke([new SystemMessage(system), ...state.messages]);
    const trace = log("respond", "B", system, recall);
    return { answer: reply.text, messages: [new AIMessage(reply.text)], trace: [{ ...trace, startedAt, endedAt: Date.now() }] };
  };

  // MIDDLE — Lane B into each specialist's preamble. Mirrors invocation.ts. This is the site the
  // single-specialist path depends on, because that path never reaches synthesize.
  const specialist = (c: CategorySpec) => async (state: State) => {
    const startedAt = Date.now();
    const recall = await scope.laneB();
    const preamble = basePersona(c) + nodePreamble(recall, c.name);
    const reply = await models.model.invoke([new SystemMessage(preamble), ...state.messages]);
    const single = state.route.length === 1;
    const trace = log(c.name, "B", preamble, recall, single ? "final=yes" : "final=no(synthesize)");
    return {
      specialistOutputs: { [c.name]: reply.text },
      trace: [{ ...trace, startedAt, endedAt: Date.now() }],
      ...(single ? { answer: reply.text, messages: [new AIMessage(reply.text)] } : {}),
    };
  };

  // END — Lane B into the synthesizer prompt. Mirrors synthesize.ts. Only reached after a fan-out.
  const synthesize = async (state: State) => {
    const startedAt = Date.now();
    const recall = await scope.laneB();
    const system = SYNTH_PROMPT + synthesizeSuffix(recall);
    const question = lastUserText(state.messages);
    const drafts = Object.entries(state.specialistOutputs).map(([name, out]) => `## ${name}\n${out}`).join("\n\n");
    const reply = await models.model.invoke([new SystemMessage(system), new HumanMessage(`Question: ${question}\n\nSpecialist answers:\n\n${drafts}`)]);
    const trace = log("synthesize", "B", system, recall, `drafts=${Object.keys(state.specialistOutputs).length}`);
    return { answer: reply.text, messages: [new AIMessage(reply.text)], trace: [{ ...trace, startedAt, endedAt: Date.now() }] };
  };

  const afterRouter = (state: State) => (state.route[0] === DIRECT ? "respond" : state.route.map((name) => new Send(name, state)));
  const afterSpecialist = (state: State) => (state.route.length > 1 ? "synthesize" : END);

  // Specialists are registered from a tuple array: that overload widens the node-name union to
  // `string`, which is what a category list read from config needs (the literal overload would not).
  const specialists: [string, (state: State) => Promise<Partial<State>>][] = categories.map((c) => [c.name, specialist(c)]);
  const builder = new StateGraph(GraphState)
    .addNode("router", router)
    .addNode("respond", respond)
    .addNode("synthesize", synthesize)
    .addNode(specialists)
    .addEdge(START, "router")
    .addConditionalEdges("router", afterRouter, ["respond", ...names])
    .addEdge("respond", END)
    .addEdge("synthesize", END);
  for (const name of names) builder.addConditionalEdges(name, afterSpecialist, ["synthesize", END]);
  return builder.compile();
}

export type DemoGraph = ReturnType<typeof buildGraph>;
