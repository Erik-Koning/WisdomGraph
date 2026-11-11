# WisdomGraph — requirements

Two sources: the product brief, and the integration requirements of the reference host — a
LangGraph supervisor app for financial advisors (a router that hands a turn to one or more
`consult_*` specialists and, after a fan-out, a synthesizer). The host is described here only as
far as the library has to fit around it. `docs/spec.md` is the design that answers this document.

---

## Product brief

> A framework lib for making a memory store for Wisdom Graph, a schema-validated knowledge
> graph that separates enterprise wisdom from hand-written prompts. The system prompt becomes
> a compiled artifact, and any human-approved charter is assembled per query from the graph.
> Instead of relying on static instructions, agents capture, consolidate, refine, and retire
> knowledge from conversations and human feedback while remaining observable and governed.
> Inspired by biological memory systems, learning occurs across multiple timescales, from
> real-time capture to long-term knowledge evolution.

> We need to make a package that can act as a wisdom knowledge graph for any LangChain, deep
> agent, LangGraph project where the agent can have context injected into the beginning or the
> end or middle of a LangGraph AI flow such that the prompt is adjusted so the AI behaves
> slightly differently based on the preferences that are embedded in the graph.
>
> The graph is organized by topics or categories and has any number of properties at each
> node. Each node is titled by a category or topic and branches off of that into subcategories
> or topics as the AI deems needed.
>
> Whenever the user gives feedback, or whenever the user's query has any feedback or
> preferences laid out in it, the AI will pick that up and that triggers saving preferences or
> knowledge into the knowledge graph. If it's a critique or a preference for a category that
> already exists in the knowledge graph then it will update that existing node or make
> sub-nodes as the LLM deems fit, to keep it well organized.

---

## The reference host

### Shape of a turn

```
chat request
  └ request-scoped AsyncLocalStorage (identity, run, model)
      └ supervisorGraph.streamEvents(state)
          START → router ─┬─ "direct" ─────────────────→ END  (greeting/clarify)
                          ├─ 1 consult_* ──────────────→ END  (specialist output IS the answer)
                          ├─ N consult_* (parallel) → synthesize → END
                          └─ synthesize (fallback) ────→ END
```

### Facts that shape the design

| Fact | Consequence |
| --- | --- |
| Single-consult turns skip `synthesize` | "Add context at synthesize" alone misses the most common path. The sub-agent preamble must also receive hints. |
| Three string-concatenation prompt sites (router, specialist invocation, synthesize), no prompt abstraction | These are the hook points: START, MIDDLE, END. |
| The full thread is replayed to the router each turn from checkpoints | Never mutate the user's `HumanMessage` to "rewrite the query" — it would be checkpointed and replayed forever. Augment prompts instead. |
| `AsyncLocalStorage` propagates through LangGraph nodes and tools | A recall promise can be stashed in ALS at request start and awaited late: true parallelism with zero graph changes. |
| Fan-out nodes run in one superstep; reducers merge | Any new state field would need a reducer that tolerates parallel writes. |
| Streaming has node-specific handling (router tokens retract, fan-out suppresses specialist tokens) | A new graph node would need handling in the stream bridge; the ALS approach avoids it. |
| No message or run id reaches the client | Feedback has nothing to reference until the host adds one. |
| Thread ids are not stable identities | Key the graph on the subject (the advisor), never on a thread id. |
| Identity is the advisor, with an optional client; no tenant | Subject = advisor; client is a sub-scope. |
| The host already fires work it never awaits (usage accounting) | Use the same pattern for ingestion. |

### Design: two recall lanes, one promise

```
request start (before graph.invoke)
  │
  ├─ recallPromise = engine.recall({subjectId, clientId, text, recentTurns, budgetMs: 2500})
  │
  ├─ LANE A (blocking, tiny budget):  hints = await raceTimeout(recallPromise, 150ms)
  │     → appended to the router prompt
  │
  │     Only "query-shaping" rules: disambiguation ("my top client" = X), domain defaults
  │     ("markets" = Canadian), routing preferences. On timeout → empty, proceed.
  │
  └─ LANE B (non-blocking): the same promise stored in ALS, awaited with the remaining
     budget at the *consumer*:
        • specialist invocation → agentHints[consult_x] into the sub-agent preamble
                                  (by the time a consult starts, the router's model call has
                                  taken 1-3 s, so this is effectively free)
        • synthesize            → responseStyle into the synthesize system prompt
        • router direct path    → covered by the Lane A hints already in the router prompt
```

**Why ALS rather than a `recall` graph node:** a node from `START` in parallel with `router`
would still sit behind the superstep barrier (consults can't start until *both* finish), so a
slow graph store would block the turn. The ALS promise never blocks anything except at the point
of use, and each use has its own budget and falls back to "no hints". It also requires no change
to the graph, the stream bridge or the wire contract.

### Write path (feedback → graph)

1. **Turn record.** At the end of the stream, fire-and-forget `engine.ingest(TurnEvent{runId,
   subjectId, clientId, threadId, category, agentsUsed, toolsUsed, dataSources, userText,
   assistantText, model, appliedHintIds})`. The library uses this both for implicit preference
   extraction ("stop adding disclaimers") and as the anchor for explicit feedback.
2. **Run id on the wire.** The host emits the run id to its client first, so feedback can
   reference a turn.
3. **Explicit feedback.** A feedback endpoint calls `engine.ingest(FeedbackEvent{runId,
   subjectId, signal: up|down|comment|correction, text?, target?: "response" | "agent:<name>" |
   "tool:<name>"})`.
4. **Nothing on the write path may be awaited by the response path.**

### Where code lives

- **Library:** a separate npm package with zero LangChain dependencies. A host that deploys
  with `pnpm deploy` should verify the package survives it before relying on a workspace link.
- **Host adapter:** a lazy engine singleton that wires the ports, the ALS scope, a
  `BaseMessage` → neutral-message converter, the feedback route, and three one-line edits at the
  injection sites behind a feature flag.

### Phases

| Phase | Deliverable |
| --- | --- |
| 0 | Contract: ports and types published (below). The library is built against a spec; the host builds against a no-op engine. |
| 1 | Host plumbing with the no-op engine: run id on the wire, feedback route and UI, `TurnEvent` emission, ALS scope, three injection sites behind a flag. |
| 2 | Library MVP: classify + recall + ingest, in-memory store (tests) + Postgres store (injected `pg.Pool`). The host swaps in the real engine. |
| 3 | Observability: OTel spans, `appliedHintIds` in the turn log, an optional debug frame listing the hints applied. |
| 4 | Implicit extraction from turns (via the injected LLM port), conflict resolution, decay, per-client sub-scope, an admin "what does the assistant know about me" view. |

---

## Contract

Framework-neutral; `docs/spec.md` §2 is the built surface.

```ts
// Neutral types — no LangChain imports anywhere in the library.
type NeutralMessage = { role: "user"|"assistant"|"tool"|"system"; content: string;
                        name?: string; toolCalls?: {name: string; args: unknown}[] };

interface RecallRequest {
  subjectId: string;                // the ONLY identity key
  clientId?: string | null;         // optional sub-scope
  text: string;                     // latest user message, verbatim
  recentTurns?: NeutralMessage[];   // last N, for topic continuity
  surface?: "standalone"|"client_sheet"|"dashboard"|"portfolio";
  budgetMs: number; signal: AbortSignal;
}

interface Recall {
  topic: { category: string; agents: string[]; confidence: number };
  preRoute: Hint[];                     // Lane A: query/routing shaping
  agentHints: Record<string, Hint[]>;   // keyed by consult_* name
  responseStyle: Hint[];                // Lane B: synthesize/final voice
  provenance: string[];                 // hint ids applied, for logging/feedback
}

type Hint = { id: string; text: string; priority: number;
              scope: "global"|"category"|"agent"|"client";
              source: "explicit"|"inferred"; confidence: number };

interface WisdomGraph {
  recall(req: RecallRequest): Promise<Recall>;   // MUST resolve (possibly empty) — never reject
  ingest(ev: TurnEvent | FeedbackEvent): Promise<void>;  // idempotent on ev.id; may be slow
  explain(subjectId): Promise<...>; forget(subjectId, hintId?): Promise<void>;
}

// Ports the host injects — the library brings NO provider SDKs and NO DB driver of its own.
interface LlmPort       { complete(prompt: string, opts: {json?: boolean; signal}): Promise<string> }
interface EmbeddingPort { embed(texts: string[]): Promise<number[][]> }
interface StorePort     { ... }  // Postgres impl accepts an existing pg.Pool; in-memory impl for tests
interface LoggerPort    { info/warn/error(obj, msg) }  // pino-compatible
```

## Must-haves

1. **Pure TypeScript ESM, Node ≥ 22, no `@langchain/*` / LangGraph / deepagents imports or peer
   deps.** The host's adapter converts `BaseMessage` → `NeutralMessage`.
2. **`recall()` never throws and always honours `budgetMs`/`AbortSignal`, returning partial or
   empty results.** The host races it at 150 ms (Lane A) and about 2.5 s (Lane B). Internal
   store or model failures → empty + logged.
3. **`recall()` uses no LLM on the hot path.** Classification must be regex, embedding or a
   cached lookup. LLM use (via `LlmPort`) is allowed only in `ingest()`.
4. **`ingest()` is idempotent (dedupe on event id) and safe to fire-and-forget;** the library
   must own queuing and retry if it wants durability.
5. **Identity is passed explicitly (`subjectId`).** Never read it from the environment, ALS or
   model output. Never key anything on a thread id.
6. **Injected ports for LLM, embeddings, storage, logging, tracing.** Model governance, usage
   accounting, provider routing and the single `pg.Pool` all live in the host.
7. **Output is short hint statements, not prompts.** The host owns prompt assembly and output
   post-processing. Enforce a per-stage token cap (e.g. ≤ 300 tokens total), sorted by priority,
   deduped. Provide canonical normalized statements ("Prefers bullet points; max 5"), never raw
   user quotes.
8. **Postgres schema under its own prefix (`kg_*`) with SQL migrations exported** so the host's
   migration owner can include them, plus a `setup()` for development like
   `PostgresSaver.setup()`. The default Postgres store must accept the injected pool; pgvector is
   available if embeddings are used.
9. **In-memory store + deterministic fixtures for vitest;** no network in unit tests.
10. **Every hint carries provenance** (event id, timestamp, explicit vs inferred, confidence) so
    the host can log `appliedHintIds` per turn and feedback can down-weight the exact hint that
    caused a bad answer.

## Caveats

1. **Single-consult turns skip `synthesize`.** Hints for "how sub-agents respond" must arrive via
   `agentHints[consult_x]` (used in the sub-agent preamble), not via `responseStyle`.
2. **Hints are advisory, not authoritative.** They cannot grant access to a client's data, cannot
   inject tool arguments, and cannot change security-relevant routing. The host only renders
   them into prompt text.
3. **Prompt-injection surface.** Feedback text is user-controlled and ends up in a system prompt.
   The library must normalize into canonical preference statements, strip instructions that
   target the system ("ignore your rules"), and cap length. The host additionally wraps hints in
   a clearly delimited block.
4. **Conflict and decay policy is the library's job:** explicit > inferred, newer > older,
   client-scoped > agent-scoped > category > global; contradictions should resolve, not both
   apply. Expose `explain()` so an advisor can see and delete what is stored.
5. **Two histories exist in the host** (graph checkpoints and its own chat tables). The library
   should read neither; everything it needs arrives in `TurnEvent`.
6. **Parallel fan-out:** several consult nodes run concurrently and each calls the Lane B
   accessor — recall results must be safe to read concurrently (they are, if it is a resolved
   promise; just don't mutate per call).
7. **Streaming is the host's problem, not the library's.** The library never touches the
   streaming layer.
8. **A feedback UI may not exist yet;** the library shouldn't assume a signal set beyond
   `up | down | comment | correction`, and should treat a `TurnEvent` without any feedback as
   the common case.
9. **No tenant concept today.** Design the schema with an optional `tenantId` column anyway so a
   future multi-tenant deployment isn't a migration.

## Category vocabulary

Categories are the host's handoff names — in the reference host `consult_client_intelligence`,
`consult_advice`, `consult_knowledge`, `consult_newsroom`, `consult_performance_coach`,
`consult_market_analyst`, `consult_kyp` and `consult_meetings`, plus `direct`. The host also
passes `agentsUsed` on every `TurnEvent`, so the library learns categories from actual routing
and not only from its own classifier. Treat the list as configurable: specialists get added.
`advisorCategories()` in `@mosphere/wisdom-graph/testing` is this vocabulary as a fixture.
