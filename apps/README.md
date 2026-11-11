# Testing WisdomGraph

Five small apps and a shared harness for exercising `@mosphere/wisdom-graph` as a person would:
talk to it, give it feedback, watch the graph change, jump time forward, plug it into an agent
host. They all share one config (`apps/shared/wisdom.config.json`) and one store, so a
preference taught in the terminal shows up in the browser, in the MCP server and in the
LangGraph demo.

| App | What it is | Start | Smoke (offline) |
| --- | --- | --- | --- |
| `apps/chat` | Terminal REPL: chat + slash commands for feedback, governance, maintenance | `npm run chat` | `npm run smoke -w @wisdom-graph/chat` |
| `apps/web` | Browser chat with an inspector: injected blocks, graph tree with approve/forget, events, maintenance | `npm run web` → http://localhost:8790 | `npm run smoke -w @wisdom-graph/web` |
| `apps/mcp` | MCP server (stdio) exposing recall / remember / feedback / explain / approve / forget / maintenance as tools | `npm run mcp` or register with Claude Code | `npm run smoke -w @wisdom-graph/mcp` |
| `apps/langgraph-demo` | A supervisor-shaped LangGraph supervisor (router → specialists → synthesize) with the two recall lanes and three injection sites | `npm run langgraph` | `npm run smoke -w @wisdom-graph/langgraph-demo` |
| `apps/simulate` | Scenario runner: scripted turns, feedback, time jumps, maintenance, with assertions | `npm run simulate -- apps/simulate/scenarios/<file>.json` | `npm run all -w @wisdom-graph/simulate` |
| `apps/shared` | The harness the others use (config, store, model ports, formatters) | — | `npm run smoke -w @wisdom-graph/harness` |

`npm run smoke:apps` builds the library and runs every smoke offline. Each app has its own
README with commands, a testing walkthrough and what to look for.

## Setup

```bash
npm install
npm run build                 # the apps import the built dist
npm run smoke:apps            # everything offline, ~1 min
```

Two modes, chosen automatically:

- **Online** — `export ANTHROPIC_API_KEY=…` (or `ant auth login`). The chat is Claude, and the
  library's extractor is Claude: sub-topics get created, slots get updated, feedback is
  interpreted. Model and effort via `WISDOM_MODEL` (default `claude-opus-5`) and
  `WISDOM_EFFORT` (`medium`).
- **Offline** — no credentials, or `WISDOM_OFFLINE=1`. The chat is an echo that reports how many
  preferences are in its system prompt; the extractor is a rule table that understands
  "shorter answers", "bullet points", "no disclaimers", "call me Erik", "prefer python",
  "canadian", "metric", "formal tone", "cite sources" and generic "from now on / always /
  never …" phrasings. Every pipeline stage still runs for real; only the two models are fake.

All knobs are environment variables documented in `apps/shared/README.md` (subject, client,
tenant, store, log level, config path).

## A testing plan, in layers

1. **Library unit tests** — `npm test` (2,179 tests, ~4 s). The contract.
2. **Scenario regression** — `npm run all -w @wisdom-graph/simulate`. Deterministic, clock-driven,
   asserts on graph state: capture → reinforce → supersede → decay → retire, sub-node creation,
   thumbs-down retirement vs. review, approval and the approved-only charter, forget. Write a
   new scenario for every behaviour you care about; it fails the build when the library drifts.
3. **Offline smokes** — `npm run smoke:apps`. Every app drives itself end to end without a model.
4. **Interactive, offline** — `WISDOM_OFFLINE=1 npm run chat`. Teach it (`/remember shorter
   answers, bullet points`), ask again, watch the recall line and `/hints` change, `/explain` to
   read the graph's own account, `/down` and `/up` to see `hint.contradicted` / `hint.reinforced`
   in the audit, `/consolidate` and `/maintain` to run the slower timescales on demand.
5. **Interactive, online** — same apps with credentials. This is where the extractor's judgement
   is tested: does feedback update the right hint, land on the right node, create a sub-node when
   a topic recurs, coin sensible slots. Use the web app's Graph tab to see placements; use
   `/explain <query>` for the dry-run trace when a hint you expected did not render.
6. **Agent host** — register `apps/mcp` with Claude Code (`claude mcp add wisdom-graph -e
   WISDOM_OFFLINE=1 -- npx tsx <repo>/apps/mcp/src/server.ts`) and ask Claude to remember a
   preference, then to recall for a related question and use the block. `apps/mcp/README.md`
   has the Claude Desktop and MCP Inspector variants.
7. **LangGraph shape** — `npm run langgraph`: the closest thing to the consumer's real graph.
   Watch the `[node] lane=… hints=N` lines to see Lane A in the router, Lane B in each
   specialist, `synthesize` skipped on single-specialist turns and run on fan-out.
8. **Postgres** — `npm run db:up` (pgvector container on :55432), then any app with
   `WISDOM_STORE=postgres`; migrations apply on start. `npm run test:pg` runs the library's
   store-contract suite against it.

## Things to evolve

- **Categories and keywords** — `apps/shared/wisdom.config.json`. They are the level-1 nodes and
  the agent names; the classifier scores on their keywords. Add a category, restart, and the next
  write materialises it.
- **Policy** — the `policy` object in the same file is a deep-partial `PolicyConfig` (caps,
  decay half-lives, feedback factors, approval mode). `"approval": "review-inferred"` makes
  every inferred hint start pending so you can drive governance through `/approve`.
- **The offline extractor** — `apps/shared/src/llm.ts` `RULES`. Add phrasings you want the
  no-key mode to understand.
- **Personas and prompt assembly** — each app builds its system prompt in one place
  (`apps/chat/src/session.ts`, `apps/web/src/server.ts`, `apps/langgraph-demo/src/graph.ts`).
  The library only renders the delimited blocks; the host owns the rest.
- **Scenarios** — `apps/simulate/scenarios/*.json`; the schema and a scripted-proposal example
  are in `apps/simulate/README.md`.

## Library behaviour worth knowing while you test

- Hints flagged `needsReview` (an explicit hint after three thumbs-down) are withheld from every
  charter until a human approves them; the spec's §2.2 wording says "still active", the recall
  path hides them. Decide which you want.
- Approval wins conflicts and stops decay, but not the score floor: an approved hint whose
  confidence was driven low by feedback can still be `dropped` for `minEffectiveScore`. The
  simulator prints `dropped: <id> (reason)` when it happens.
- A thumbs-down without a target lowers *every* hint applied on that turn, including ones the
  feedback text agrees with. Pass `target: "agent:<name>"` or `"response"` to narrow it.
- Feedback for a run the library has not seen waits `3 × 5 s` for the turn to arrive; the apps'
  `/remember` avoids that by ingesting a synthetic turn first.
- The offline extractor puts every hint on the root; "add over create" retargets a hint to a
  category node when the text matches that node's keywords, so a Python preference lands on
  `/assist_code`.
