# @wisdom-graph/harness

The wiring every test app shares, so a graph grown in one app is visible in all the others
(same subject, same store file, same model settings).

```ts
import { createHarness, formatRecall, formatExplanation } from "@wisdom-graph/harness";
import { systemPromptPrefix, nodePreamble, synthesizeSuffix } from "@mosphere/wisdom-graph/langgraph";

const h = await createHarness();                    // config + logger + store + engine + chat
const recall = await h.graph.recall({ subjectId: h.cfg.subjectId, text, budgetMs: 2500 });
const system = BASE + systemPromptPrefix(recall) + nodePreamble(recall, recall.topic.category) + synthesizeSuffix(recall);
const reply = await h.chat({ system, messages, onDelta: (t) => process.stdout.write(t) });
await h.graph.ingest({ type: "turn", id: `turn_${runId}`, runId, subjectId: h.cfg.subjectId,
                       agentsUsed: [recall.topic.category], userText: text, assistantText: reply,
                       appliedHintIds: recall.provenance });
await h.close();                                    // flush the store, stop the queue
```

`createHarness({ inline, clock, llm, config })` — `inline` (default true) processes ingests before the
receipt resolves so tests are deterministic; `clock` injects a ClockPort (the simulator's time travel);
`llm` replaces the extraction model; `config` overrides any knob below.

## Knobs (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `WISDOM_SUBJECT` | `erik` (config file) | The subject the graph belongs to |
| `WISDOM_CLIENT` | none | Optional client sub-scope |
| `WISDOM_TENANT` | none | Tenant id |
| `WISDOM_STORE` | `memory` | `memory` (JSON file) or `postgres` |
| `WISDOM_STORE_FILE` | `.wisdom/store.json` | Where the memory store is persisted (repo-relative) |
| `WISDOM_PG_URL` | `postgres://wg:wg@localhost:55432/wg` | Postgres connection (`npm run db:up` starts one) |
| `WISDOM_PG_PGVECTOR` | off | `1` to apply the pgvector migration |
| `WISDOM_MODEL` | `claude-opus-5` | Anthropic model for chat and extraction |
| `WISDOM_EFFORT` | `medium` | `low` / `medium` / `high` |
| `WISDOM_OFFLINE` | auto | `1` forces offline; auto-on when no Anthropic credentials are found |
| `WISDOM_LOG` | `warn` | `debug` / `info` / `warn` / `error` / `silent` (stderr) |
| `WISDOM_CONFIG` | `apps/shared/wisdom.config.json` | Categories, default subject, policy overrides |

Credentials: `ANTHROPIC_API_KEY`, or `ant auth login` (the SDK picks up the profile).

## Offline mode

No API calls at all. The chat echoes and reports how many preference bullets it found inside the
`<<wisdom-hints …>>` blocks of its own system prompt — the one number a tester wants to see change.
The extractor is a rule table (`src/llm.ts`): "shorter answers", "bullet points", "no disclaimers",
"call me Erik", "prefer python", "canadian", "metric", "formal tone", "cite sources", … each become a
canonical hint on the root node (`scope: global`). Anything else that reads like a preference
("from now on …", "always …", "never …") becomes a generic `Prefers …` / `Avoids …` statement. Sub-node
creation and slot-level updates need the real model (or the simulator's scripted proposals).

## Categories

`wisdom.config.json` seeds the level-1 topic nodes; their names are also the "agent" names the
`agent` lane is bucketed by. Edit the keywords to steer the classifier, add categories to grow the
tree; restart the app afterwards. Existing graphs are not migrated (a new category simply appears
as a new locked node on the next write).

## Smoke

```bash
npm run smoke -w @wisdom-graph/harness      # offline: capture → recall → render → chat → explain
```
