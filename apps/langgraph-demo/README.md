# @wisdom-graph/langgraph-demo

The LangGraph reference integration for `@mosphere/wisdom-graph`. A supervisor graph shaped like
the host app's (`docs/requirements.md`), built on real `@langchain/langgraph` / `@langchain/core` objects,
with the library's three injection sites wired exactly as `docs/spec.md` §8 prescribes. The
harness's categories (`apps/shared/wisdom.config.json`) stand in for the host app's `consult_*` specialists.

## The graph

```
                       ┌─ "direct" ───────────────────────────→ respond ─────────→ END
START → router ────────┼─ one category ──────────────────────→ <specialist> ─────→ END   (synthesize is skipped)
   Lane A (150 ms)     └─ many categories ── Send fan-out ───→ <specialist> ×N ──→ synthesize → END
                                                                 Lane B               Lane B
```

- `router` reads **Lane A** — the recall promise raced at 150 ms — and puts the `preRoute` lane into
  its prompt. Online it answers with strict JSON (`{"route": [...]}`, validated with zod); offline it
  routes by the Lane A topic plus a keyword score over the configured categories.
- Each specialist (`assist_code`, `assist_writing`, `assist_research`, `assist_planning`,
  `assist_finance`) reads **Lane B** — the same promise with the rest of the 2.5 s budget — and puts
  `agentHints[<category>]` into its preamble. On the single-specialist path its output *is* the
  answer, so this site is the one that matters most.
- Several categories fan out with `Send` in one superstep; their outputs merge through a reducer and
  `synthesize` (Lane B, `responseStyle`) combines them. It runs once, even though every specialist's
  conditional edge points at it.
- Recall is never a node. It rides an `AsyncLocalStorage` (`src/scope.ts`) from the request handler
  into every node, so the graph has no extra state and a slow store blocks nothing but the site that
  awaits it.

## The three injection sites

| Site | Host app file | Here | Lane | Helper |
| --- | --- | --- | --- | --- |
| START | `router.ts` | `src/graph.ts:136-137` | A | `routerPrompt(...) + systemPromptPrefix(await scope.laneA())` |
| MIDDLE | `invocation.ts` | `src/graph.ts:167-168` | B | `basePersona(c) + nodePreamble(await scope.laneB(), c.name)` |
| END | `synthesize.ts` | `src/graph.ts:182-183` | B | `SYNTH_PROMPT + synthesizeSuffix(await scope.laneB())` |

The direct path (`src/graph.ts:156-157`) is a fourth, demo-only site: in the host app the router answers a
greeting itself under Lane A, while here a tiny `respond` node answers under Lane B through
`nodePreamble(recall, "direct")`, which serves `recall.agentDefaults` for an agent that has no bucket
— the same fallback a misrouted specialist gets.

How the lanes are read (`src/main.ts:80-87`):

```ts
const req = { subjectId, clientId, text, recentTurns: toNeutralMessages(history, { last: 6 }), budgetMs: 2500 };
const handle = startTurnRecall(h.graph, req);                       // recall starts; nothing awaits it
const result = await scope.run(handle, () => app.invoke({ messages: [...history, new HumanMessage(text)] }));
// inside the graph: scope.laneA() → settleWithin(handle.base, 150, empty); scope.laneB() → the rest of the budget
```

`toNeutralMessages` is fed the live `HumanMessage` / `AIMessage` objects from the LangGraph state and
the REPL history — the library never imports LangChain; it reads `_getType()`, `content`, `name`
and `tool_calls` structurally. This app type-checks that claim against `BaseMessage[]` and runs it.

## Run

From the repo root (the library must be built once: `npm run build`):

```sh
npm run langgraph                                  # build + REPL (online when credentials exist)
npm run start -w @wisdom-graph/langgraph-demo      # REPL without rebuilding
npm run smoke -w @wisdom-graph/langgraph-demo      # offline script, exit 0/1
```

- **Online** needs `ANTHROPIC_API_KEY` (or `ant auth login`); the graph then runs `ChatAnthropic`
  with `WISDOM_MODEL` (default `claude-opus-5`).
- **Offline** (`WISDOM_OFFLINE=1`, or automatically when there are no credentials) swaps in
  `HintReportingChatModel` (`src/models.ts`): a deterministic `BaseChatModel` whose reply reports how
  many `<<wisdom-hints>>` blocks and bullet lines it found in its own system prompt, and echoes the
  question. The number changing after `/remember` is the whole demo.
- `--script <file>` replays a file: one input per line, `#` comments, no prompts, exit code 0/1.
  `/expect <substring>` asserts on the last printed block.

Every knob is an environment variable read by the shared harness (`apps/shared/src/config.ts`):
`WISDOM_SUBJECT`, `WISDOM_CLIENT`, `WISDOM_STORE`, `WISDOM_STORE_FILE`, `WISDOM_MODEL`,
`WISDOM_LOG=debug` for the library's own log lines, and so on.

## Commands

| Command | What it does |
| --- | --- |
| `<text>` | One turn through the graph; prints the answer, then ingests a `TurnEvent` (`agentsUsed` = the specialists that ran, `appliedHintIds` = `(await handle.base).provenance`). |
| `/up`, `/down [text]`, `/comment <text>`, `/correct <text>` | A `FeedbackEvent` on the last run (`target: "response"`). |
| `/remember <text>` | A standalone preference: a synthetic anchoring turn (extraction skipped) plus a `comment` feedback on it, so it is processed now rather than deferred waiting for its run. |
| `/explain [query]` | `graph.explain(subjectId, { text })` — the tree, hints with scores and ids, recent events, audit, and a dry-run recall for the query. |
| `/hints` | What each node of the last turn injected: lane, recall status, block count and the bullet lines. |
| `/route` | The last route decision: `mode=direct|single|fanout`, whether `synthesize` ran, and whether the specialists overlapped in time. |
| `/expect <substring>` | Script mode: assert on the last printed block. |
| `/quit` | Flush the store and exit. |

## What to look for

stderr shows one line per node, so you can see where injection happened and which lane served it:

```
[router] lane=A hints=0 blocks=0 recall=ok topic=assist_code(1.00) neutralTurns=3 route=assist_code
[assist_code] lane=B hints=3 blocks=1 recall=ok final=yes
[ingest] ingest turn_run_…: processed agentsUsed=assist_code appliedHintIds=3
```

`recall=ok/budget` on the router line means Lane A lost its 150 ms race and the router ran with no
hints while the specialists still got them — the intended degradation. `/hints` prints the same per
node with the bullets; `/route` prints `synthesize=skipped` on the single path and
`parallel=yes overlap=…ms` on the fan-out path (the fake model sleeps ~120 ms per call, so two
specialists finishing within one call's time proves they ran in one superstep).

`scripts/smoke.txt` asserts all of it offline: greeting → `direct`; one question → single specialist,
no synthesize, 0 hints; `/remember shorter answers, bullet points, no disclaimers`; the same question
→ 3 hints in the specialist preamble; a trip-and-budget question → planning + finance in parallel →
synthesize with the `responseStyle` lane; `/up`, `/down`, `/explain`.

## Postgres

```sh
npm run db:up                                            # docker compose: postgres on :55432
WISDOM_STORE=postgres npm run start -w @wisdom-graph/langgraph-demo
WISDOM_STORE=postgres WISDOM_PG_URL=postgres://… WISDOM_PG_PGVECTOR=1 npm run start -w @wisdom-graph/langgraph-demo
```

The harness applies the `kg_*` migrations on start (`setup()` from `@mosphere/wisdom-graph/postgres`)
and hands the engine a `PostgresStore` over a `pg.Pool`; nothing in this app changes.

## How this maps to the host integration plan

| Host app (`docs/requirements.md`) | Here |
| --- | --- |
| a request-scoped `AsyncLocalStorage` around the supervisor graph's stream | `scope.run(handle, () => app.invoke(...))` in `src/main.ts` |
| one recall promise at request start, raced at 150 ms for the router | `startTurnRecall` + `scope.laneA()` |
| pre-route hints appended to the router prompt | `systemPromptPrefix(recall)` in the `router` node |
| per-agent hints in the sub-agent preamble | `nodePreamble(recall, category)` in each specialist node |
| response-style hints in the synthesize prompt | `synthesizeSuffix(recall)` in `synthesize` |
| single-consult turns skip `synthesize` | same: one category → specialist → `END` |
| fan-out in one superstep, reducers merge | `Send` per category; `specialistOutputs` and `trace` have merge reducers |
| `TurnEvent` fire-and-forget after the stream ends, with `appliedHintIds` | awaited here so the receipt prints; same payload |
| a feedback endpoint (up, down, comment, correction) | `/up` `/down` `/comment` `/correct` |
| never mutate the user's `HumanMessage` | prompts are augmented; the `messages` channel only ever gains an `AIMessage` |

Files: `src/scope.ts` (the ALS), `src/models.ts` (ChatAnthropic or the fake), `src/graph.ts` (state,
nodes, edges, the three sites), `src/main.ts` (REPL, script runner, ingest), `scripts/smoke.txt`.
