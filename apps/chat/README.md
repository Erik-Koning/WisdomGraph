# @wisdom-graph/chat

A terminal chat for exercising `@mosphere/wisdom-graph` by hand: every turn does the
full loop the library is built for — **recall → inject the three lane artifacts into the
system prompt → answer → ingest the turn** — and slash commands drive feedback, governance
and maintenance so you can watch the graph change between questions.

It runs on the shared harness (`apps/shared`), so the graph it grows is the same one the
web inspector, the MCP server and the LangGraph demo read.

## Run

From the repo root (builds the library first):

```bash
npm run chat                       # interactive REPL
npm run chat -- --subject alice    # start as another subject
npm run chat -- --client acme      # with a client sub-scope
```

Or directly: `npm run start -w @wisdom-graph/chat -- [--script <file>] [--subject <id>] [--client <id>]`.

- **Online** — set `ANTHROPIC_API_KEY`, or sign in with `ant auth login`. Chat streams from
  the model named by `WISDOM_MODEL`, and the same model extracts preferences on ingest.
- **Offline** — `WISDOM_OFFLINE=1` (also automatic when no credentials are found). The
  assistant is an echo that reports *how many preference bullets its system prompt carries*,
  and extraction is a heuristic that recognises obvious phrasings (`shorter answers`,
  `bullet points`, `no disclaimers`, `call me Erik`, `prefer python`, `use tables`, `metric`,
  `no emojis`, `cite sources`, …). Enough to see the whole capture → recall → render loop
  with no API calls.

The conversation is on stdout; harness logs go to stderr (`WISDOM_LOG=info` to see ingest
receipts and recall timings, `debug` for the offline extractor's decisions).

### Environment knobs

All read by `apps/shared/src/config.ts`; nothing here reads `process.env` directly.

| Variable | Meaning | Default |
| --- | --- | --- |
| `WISDOM_SUBJECT` | subjectId the graph belongs to (`--subject` overrides) | `wisdom.config.json` → `erik` |
| `WISDOM_CLIENT` | clientId sub-scope, empty for none (`--client` overrides) | config file → none |
| `WISDOM_TENANT` | tenantId, empty for none | none |
| `WISDOM_STORE` | `memory` \| `postgres` | `memory` |
| `WISDOM_STORE_FILE` | where the memory store is persisted as JSON | `<repo>/.wisdom/store.json` |
| `WISDOM_PG_URL` | postgres connection string (`WISDOM_STORE=postgres`) | `postgres://wg:wg@localhost:55432/wg` |
| `WISDOM_PG_PGVECTOR` | `1` to enable the pgvector migration | off |
| `WISDOM_MODEL` | Anthropic model id for chat and extraction | `claude-opus-5` |
| `WISDOM_EFFORT` | `low` \| `medium` \| `high` | `medium` |
| `WISDOM_OFFLINE` | `1` → no API calls | off (on when no credentials) |
| `WISDOM_LOG` | `debug` \| `info` \| `warn` \| `error` \| `silent` | `warn` |
| `WISDOM_CONFIG` | path to a `wisdom.config.json` (categories, default identity, policy) | `apps/shared/wisdom.config.json` |

## Commands

Free text is a chat turn. Lines starting with `/`:

| Command | What it does |
| --- | --- |
| `/help` | the list below |
| `/up`, `/down [text]` | thumbs on the last answer (`FeedbackEvent` signal `up` / `down`; text is stored with it) |
| `/comment <text>` | free-form feedback on the last answer — preferences are extracted from it |
| `/correct <text>` | a correction of the last answer (signal `correction`) |
| `/remember <text>` | store a preference without a conversation: a synthetic turn anchors a runId (no extraction), then a `comment` on that run carries the text through the normal feedback path |
| `/explain [query]` | `graph.explain()`: the topic tree with every hint, pending/retired hints, recent events, audit; with a query, a dry-run recall trace showing which hints were kept, suppressed or dropped and why |
| `/hints` | the three compiled artifacts injected on the last turn (`systemPromptPrefix` / `nodePreamble(agent)` / `synthesizeSuffix`) with hint counts, token estimates and hashes, plus the charter summary |
| `/prompt` | the full system prompt sent on the last turn |
| `/approve <hintId>`, `/reject <hintId>` | human governance: approved hints never decay and win slot conflicts; rejected hints are retired and never recalled |
| `/forget <hintId>` \| `/forget all` | hard-delete one hint (tombstoned, so a replayed event cannot resurrect it) or the whole subject — `all` asks `y/N` interactively, never in `--script` |
| `/consolidate` | the consolidation pass for the subject (merge / promote / retire) |
| `/maintain` | the maintenance pass (decay, promotion, retention scrubbing) |
| `/drain` | process any ingest events still queued in the ledger |
| `/subject <id>` | switch subject; clears the conversation history and last-turn state |
| `/client <id>` \| `/client none` | set or clear the client sub-scope |
| `/stats` | `graph.stats()` engine counters |
| `/quit` | exit (also Ctrl-C / Ctrl-D) |

## What to look for

- **The recall line.** Every answer is preceded by `· recall ok · topic=assist_code (1.00,
  keyword) agents=[assist_code] · preRoute 0 · agent assist_code:5 · responseStyle 3 · 43 tok
  · miss 2ms · suppressed=0 dropped=0`. Watch the topic classification change with the
  question, the per-lane counts rise after `/remember` or `/comment`, `cache` flip to `hit`
  on a repeated question, and `suppressed` go up when two hints fight over one slot.
- **`/hints`** shows exactly what reached the prompt, per injection site, and is what to check
  when a preference "did not take": it may be in the charter but dropped for budget, suppressed
  by an approved hint, or mirrored into the agent bucket. When the topic is `direct` the agent
  preamble is skipped and the command says so.
- **`/explain`** is the graph's own account — effective scores, decay, reinforcement counts,
  `needs-review` flags, the audit trail (`hint.created`, `hint.reinforced`,
  `hint.contradicted`, `hint.approved`, `hint.forgotten`) — and with a query, the dry-run trace
  of what a recall for that text would keep. A `/down` after an answer shows up here as
  `hint.contradicted` on the hints that answer applied; `/up` as `hint.reinforced`.
- **Offline count.** The offline assistant reports the *distinct* bullets across all
  `<<wisdom-hints>>` blocks in its prompt. Voice hints (`responseStyle`) are mirrored into the
  agent bucket by the library on purpose, so `/hints` can show the same statement in two blocks
  while the count names it once; the per-lane numbers in the recall line are the exact view.
- **Persistence.** The memory store is written to `WISDOM_STORE_FILE` after every change, so
  quitting and restarting keeps the graph; delete the file (or `/forget all`) to start over.

## Against Postgres

```bash
npm run db:up                        # docker compose: pgvector/pgvector:pg16 on localhost:55432
WISDOM_STORE=postgres npm run chat   # migrations are applied on start (idempotent)
WISDOM_STORE=postgres WISDOM_PG_PGVECTOR=1 npm run chat   # with the pgvector migration
npm run db:down
```

`WISDOM_PG_URL` points elsewhere if the database is not the compose one.

## The smoke

```bash
npm run smoke -w @wisdom-graph/chat        # from the repo root
```

It replays `scripts/smoke.txt` offline (`WISDOM_OFFLINE=1`) against a private store file
(`.wisdom/smoke-chat.json`), echoing each line as `erik> …`. The script asks a coding
question, `/remember`s several preferences, asks the same question again, then runs `/up`,
`/down`, `/comment`, `/explain`, `/hints`, `/stats`, `/consolidate`, `/maintain`, `/drain`,
`/prompt`, `/quit`. It proves the loop end to end: the first answer says *"My system prompt
carries no preferences yet"*, the second lists the remembered ones (the count rises from 0),
`/hints` shows them rendered into the agent and responseStyle lanes, and `/explain` shows the
hints, their slots and the audit rows the feedback commands wrote. The process exits 0 only
if no line threw; an unknown command or a failing engine call makes it exit 1.

`--script` works for your own scenarios too: blank lines and `#` comments are skipped, every
line is echoed, nothing prompts, and the run ends at end-of-file or `/quit`.

## Layout

```
src/main.ts        flags, harness start-up, the readline / script loop, exit code
src/session.ts     the turn (recall → inject → stream → ingest) and every slash command
scripts/smoke.txt  the offline smoke scenario
```
