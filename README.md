# WisdomGraph

[![CI](https://github.com/Erik-Koning/WisdomGraph/actions/workflows/ci.yml/badge.svg)](https://github.com/Erik-Koning/WisdomGraph/actions/workflows/ci.yml)

A framework for building a memory store on a **Wisdom Graph** — a schema-validated knowledge
graph that separates enterprise wisdom from hand-written prompts. The system prompt becomes a
compiled artifact, and a human-approved charter is assembled per query from the graph. Instead
of relying on static instructions, agents capture, consolidate, refine, and retire knowledge
from conversations and human feedback while remaining observable and governed. Inspired by
biological memory systems, learning occurs across multiple timescales, from real-time capture
to long-term knowledge evolution.

```bash
npm install @mosphere/wisdom-graph
```

Zero runtime dependencies, no peer dependencies, Node ≥ 22, ESM and CJS. LangChain and `pg`
are never imported — messages and the pool are read structurally — so the package fits any
LangChain / LangGraph / deep-agents host without pinning a framework version.

> **Status: pre-1.0.** The public API follows [`docs/spec.md`](docs/spec.md) §2 and is pinned by
> tests, but nothing is a semver commitment until `0.1.0`.
> The package is not on npm yet: until the first release, clone this repository and run
> `npm install && npm run build`.

- [`docs/spec.md`](docs/spec.md) — the definitive specification (module layout, public API, data
  model, pipelines, safety, store contract, integration).
- [`docs/requirements.md`](docs/requirements.md) — the product brief, the reference host's
  contract, the ten must-haves and the caveats the design answers.
- [`docs/work-breakdown.json`](docs/work-breakdown.json) — modules, files and acceptance criteria.

## Entry points

| Import | What it is | Needs |
| --- | --- | --- |
| `@mosphere/wisdom-graph` | The portable core and the engine: `createWisdomGraph`, `createNoopWisdomGraph`, the vocabulary and ports, `validators`, `sanitizeStatement`, the charter compilers, `MemoryStore`. | Web-standard globals only — runs in a backend, a Lambda, an edge worker or a test. |
| `@mosphere/wisdom-graph/postgres` | `PostgresStore` over your own `pg.Pool` (typed as `PgPoolLike`), plus `migrations()`, `renderMigrationsSql()` and `setup()` for the `kg_*` schema. | Your `pg` — never bundled or declared. |
| `@mosphere/wisdom-graph/langgraph` | The LangGraph adapter: `toNeutralMessages`, the `AsyncLocalStorage` recall scope (`createRecallScope`, `startTurnRecall`) and the three injection helpers. | Node (`node:async_hooks`) — the one entry that is not portable. |
| `@mosphere/wisdom-graph/testing` | `FakeLlm`, `FakeEmbedding`, `FakeClock`, `CollectingLogger`, `CapturingTracer`, `FaultyStore`, the `advisorCategories()` / `advisorFixture()` fixtures, the text corpora and `storeContractTests()`. | Nothing; deterministic, no network. |

Each entry ships as `dist/<name>.js` / `.cjs` with `.d.ts` / `.d.cts`, and each has a surface
test that pins its runtime exports (spec §2.8, §2.9). `example/src/main.mjs` imports all four
through the `exports` map and is run by `npm run dev`.

## Usage: two lanes, one request

The consumer's turn starts one recall and reads it twice — a tiny blocking race for the router,
and the remaining budget where the sub-agent or synthesis prompt is built. The scope rides
`AsyncLocalStorage` through the graph, so the three injection sites need no graph changes and
every read is safe under parallel fan-out (spec §8.2, §8.3).

```ts
import { createWisdomGraph } from "@mosphere/wisdom-graph";
import { createPostgresStore } from "@mosphere/wisdom-graph/postgres";
import {
  createRecallScope, startTurnRecall,
  systemPromptPrefix, nodePreamble, synthesizeSuffix,
} from "@mosphere/wisdom-graph/langgraph";

const graph = createWisdomGraph({
  store: createPostgresStore(pool),          // your pg.Pool, structurally typed
  categories: [{ name: "consult_advice", keywords: ["portfolio", "rebalance", "allocation"] }],
  llm, embeddings, logger, tracer,           // injected ports; llm is used by ingest only, never recall
});
const scope = createRecallScope();           // AsyncLocalStorage<RecallHandle>

// chat.ts — request start, before graph.invoke; zero graph changes
const handle = startTurnRecall(graph, { subjectId: advisorId, clientId, text, recentTurns, budgetMs: 2500, signal });
await scope.run(handle, () => supervisorGraph.streamEvents(state));

// router.ts        (START)  — 150 ms race, "" on timeout
const prompt = ROUTER_PROMPT + systemPromptPrefix(await scope.laneA());
// invocation.ts    (MIDDLE) — the single-consult path depends on this
const preamble = basePreamble + nodePreamble(await scope.laneB(), "consult_advice");
// synthesize.ts    (END)
const synth = SYNTHESIZE_PROMPT + synthesizeSuffix(await scope.laneB());

// streaming.ts after [DONE] — fire-and-forget; idempotent on id
void graph.ingest({ type: "turn", id: `turn_${runId}`, runId, subjectId: advisorId, clientId, threadId,
                    category, agentsUsed, toolsUsed, dataSources, userText, assistantText, model,
                    appliedHintIds: (await scope.laneB()).provenance });   // the candidate set; agentsUsed says what rendered
```

`recall()` never rejects and never calls the LLM; on a timeout, an abort or a store failure it
resolves to an empty `Recall` and the helpers render `""`, so concatenation is a no-op. Outside
a scope both lanes return empty. Identity is always passed in the request — nothing is read
from ALS or the environment.

## Postgres: migrations and setup

The store keeps its schema under the `kg_*` prefix and every table carries
`tenant_id text NOT NULL DEFAULT ''`, so tenancy later is a value change, not a migration
(spec §7.3). Two ways to apply it:

```ts
import { migrations, renderMigrationsSql, setup } from "@mosphere/wisdom-graph/postgres";

// 1. Hand the SQL to whoever owns migrations. Each migration is wrapped in a
//    `-- kg migration <id>` header; all DDL is IF NOT EXISTS, so re-running is harmless.
writeFileSync("migrations/0042_wisdom_graph.sql", renderMigrationsSql({ pgvector: true, vectorDimensions: 1536 }));
migrations().map((m) => m.id);               // ["0001_schema"] — "0002_pgvector" only with { pgvector: true }

// 2. Or apply them yourself in dev, like PostgresSaver.setup(): takes an advisory lock,
//    records applied ids in kg_migrations, and runs each missing one in its own transaction.
const { applied, skipped } = await setup(pool, { pgvector: true });
```

`PostgresStore` requires a pool with `connect()` because every batch runs in a transaction on a
dedicated client; a query-only client is accepted only with `allowNonAtomic: true`, which logs a
warning at construction. Set `statementTimeoutMs` so a slow database cannot hold a connection
past the recall budget: it applies `SET LOCAL statement_timeout` to every statement the store
sends — each batch's transaction, and each single statement (the recall snapshot, a hint read, a
lease) inside a short transaction of its own, at the cost of three extra round trips per
statement. Under `allowNonAtomic` there is no transaction to scope it to, so put
`statement_timeout` on the pool's connection options instead. Vector storage lives in one place: `kg_nodes.embedding_json` without
pgvector, `kg_node_vectors.vec` with it. The integration suite runs against a real database when
`WISDOM_PG_URL` is set and is skipped otherwise.

## Testing it

`apps/` holds a terminal chat, a browser inspector, an MCP server, a supervisor-shaped LangGraph demo
and a scenario simulator, all on one shared harness, each runnable with or without an Anthropic
key. Start with [`apps/README.md`](apps/README.md); `npm run smoke:apps` runs every app's
offline smoke.

## Layout

```
packages/wisdom-graph/
  src/index.ts           "."           core + createWisdomGraph + createNoopWisdomGraph + MemoryStore
  src/core/              PORTABLE HALF — relative imports only; no node:, no packages, no process/window
  src/postgres/          "./postgres"  PostgresStore, migrations, setup   (imports core/ only)
  src/langgraph/         "./langgraph" messages, ALS scope, injection helpers (core/ + node:async_hooks)
  src/testing/           "./testing"   fakes, fixtures, store-contract suite (imports core/ only)
example/src/main.mjs     imports all four entries from the built package
docs/                    spec.md, requirements.md, work-breakdown.json
```

The `core/` half has **no dependencies at all** — no Node built-ins, no storage driver, no
LLM client — so it runs wherever the agent does. That, and the absence of `pg` and
`@langchain/*` anywhere under `src/`, are enforced by tests that walk the import graph rather
than trusted to a comment.

## Development

```bash
npm install
npm test           # vitest — every module ships its tests next to it
npm run typecheck  # tsc --noEmit
npm run build      # vite lib build: four entries, ESM + CJS, rolled-up .d.ts and .d.cts
npm run dev        # builds, then runs example/src/main.mjs against the built package
npm run release:dry
```

## Publishing

`npm run release` runs `prepublishOnly` (typecheck, test, build), copies this README and the
LICENSE into the package for the tarball, and publishes `@mosphere/wisdom-graph` with public
access.

## License

MIT © Erik Koning
