# @wisdom-graph/web — browser tester for `@mosphere/wisdom-graph`

A single-page test app for the library: chat on the left, the graph's internals on the right.
Every turn runs the full loop — `recall` → compile the three injection sites → chat → `ingest` a
`TurnEvent` — and every 👍 / 👎 / comment becomes a `FeedbackEvent`. The right-hand tabs show
what was injected into the prompt, the `explain()` tree with approve / reject / forget per hint,
recent events and audit rows, and the maintenance passes.

Zero dependencies beyond the shared harness: `node:http`, one inline HTML page, plain `fetch` + DOM.

## Run

```sh
# from the repo root (builds the library first)
npm run web                       # http://localhost:8790/
npm run web -- --port 9000        # or PORT=9000 npm run web
```

| Mode | How | What you get |
| --- | --- | --- |
| Online | `ANTHROPIC_API_KEY=… npm run web` (or `ant auth login`) | Real streamed chat replies; the library's LLM extractor turns your comments into hints. |
| Offline | `WISDOM_OFFLINE=1 npm run web`, or automatically when no credentials are found | An echo assistant that reports every preference bullet it finds in its system prompt, and a heuristic extractor that understands "shorter answers", "bullet points", "no disclaimers", "call me Erik", "prefer python", "no emojis", "metric", "formal tone", … |
| Postgres | `npm run db:up` then `WISDOM_STORE=postgres npm run web` | Same app on `PostgresStore` (migrations applied on start). Default URL `postgres://wg:wg@localhost:55432/wg`; add `WISDOM_PG_PGVECTOR=1` for the vector migration. |

The memory store persists to `.wisdom/store.json` after every write, so the graph you grow here is
the same one the REPL (`npm run chat`) and the MCP server see. All the other knobs
(`WISDOM_SUBJECT`, `WISDOM_CLIENT`, `WISDOM_MODEL`, `WISDOM_EFFORT`, `WISDOM_LOG`, `WISDOM_CONFIG`)
are documented in `apps/shared/src/config.ts`. Logs go to stderr; only the URL and banner are printed
to stdout.

## API

Every route accepts `subjectId` and `clientId` in the JSON body or the query string, defaulting to
the harness config (`subjectId` from `wisdom.config.json` / `WISDOM_SUBJECT`). Errors are
`{ "error": "…" }` with a 4xx / 5xx status; a bad request never takes the server down.

| Method & path | Body / query | Returns |
| --- | --- | --- |
| `GET /` | | The tester page (`text/html`). |
| `GET /api/config` | | `{ subjectId, clientId, defaults, sharedSubjectId, categories[{name,title,description}], store, offline, model, effort, historyLimit }` |
| `GET /api/stats` | | The engine's `EngineStats`. |
| `GET /api/history` | | Server-side chat history for the subject/client (last 20 `NeutralMessage`s). |
| `POST /api/chat` | `{ text }` | `{ runId, reply, agent, recall: { topic, meta, provenance, laneCounts, tokenEstimate, suppressed, dropped, summary }, injected: { preRoute, agent, responseStyle }, systemPrompt, receipt }` |
| `GET /api/chat/stream?text=…` | | Server-Sent Events: `delta` events (`{ text }`) then one `done` event carrying the same JSON as `POST /api/chat`; `error` on failure. The page uses this. |
| `POST /api/reset` | | Clears the chat history for the subject/client. |
| `POST /api/feedback` | `{ runId, signal: up\|down\|comment\|correction, text?, target? }` | `{ runId, eventId, receipt }` — ingests a `FeedbackEvent` anchored to that run. `comment` / `correction` require `text`. |
| `POST /api/remember` | `{ text }` | `{ runId, turn, feedback }` — a synthetic turn (extraction skipped) plus a `comment` feedback so a preference can be stored without a conversation. |
| `GET /api/explain?query=&includeRetired=1` | | The `Explanation` (§10.3) plus `text` (`formatExplanation`). With `query` it includes a dry-run recall `trace`. |
| `POST /api/hint/:id/approve` | `{ status: approved\|rejected, by, note? }` | `{ ok, hintId, status, by }` |
| `DELETE /api/hint/:id?by=` | | `{ ok, hintId }` — `forget(subjectId, hintId)`. |
| `DELETE /api/subject?by=` | | `{ ok, subjectId }` — deletes the subject's nodes, hints, events and audit, and its chat history. |
| `POST /api/maintenance/consolidate` | | `{ action, subjectId, elapsedMs, report: ConsolidationReport, stats }` |
| `POST /api/maintenance/maintain` | | `{ …, report: MaintenanceReport, stats }` |
| `POST /api/maintenance/drain` | | `{ …, report: { processed, failed }, stats }` |

How a turn builds its prompt (`src/server.ts: runTurn`):

```
BASE_PERSONA
+ systemPromptPrefix(recall)                       // preRoute lane      (START)
+ nodePreamble(recall, recall.topic.category)      // agent lane         (MIDDLE) — skipped when the topic is "direct"
+ synthesizeSuffix(recall)                         // responseStyle lane (END)
```

The `TurnEvent` carries `agentsUsed: [category]`, `category`, and `appliedHintIds: recall.provenance`
so the library can count which hints actually rendered.

## Testing walkthrough

1. Open the page. The header shows the model (or `offline model`), the store and the categories.
   The status line under it echoes the subject and client. The Graph tab shows the seeded tree:
   `/ (global)` plus one level-1 node per category, all with 0 hints.
2. **Send** "how do I fix a typescript error". Watch the reply stream in. The message footer shows
   the run id, `topic=assist_code (1.00, keyword)`, the lane counts (all 0) and `ingest processed`.
   The **Injected** tab shows the recall summary and three empty blocks — nothing to inject yet.
3. **Give feedback.** Type "shorter answers, bullet points, no disclaimers, call me Erik" into the
   comment box under the reply and press **Comment** (or put the same text into the *Remember*
   box). The receipt under the message reads `comment "…" → processed`.
   - **Graph** tab: `/ (global)` now has four hints — `format.length="short"` and
     `format.lists="bullets"` and `greeting.name="erik"` in the `responseStyle` lane, `disclaimers="omit"`
     in the `agent` lane — each with chips for lane / scope / source / status / approval / maturity /
     kind, the slot value, confidence and effective score, and the `why` line.
   - **Events & audit** tab: the feedback event with `+4` accepted ops, and four `hint.created`
     audit rows by `llm:extract@1`.
4. **Send** the same question again. The **Injected** tab now shows the compiled
   `<<wisdom-hints lane="responseStyle">>` block (bullets, short, Erik) and the
   `<<wisdom-hints lane="agent" agent="assist_code">>` block (the disclaimers constraint plus the
   mirrored style hints). In offline mode the reply itself lists the bullets it found in its
   prompt ("My system prompt carries N preferences"); mirrored copies in the agent block count
   once. Online, the model simply answers shorter, in bullets, calling you Erik.
   The footer shows `agent assist_code:4 · responseStyle 3` and the token estimate.
5. **👍** the reply: the applied hints' confidence goes up (`conf` chips in the Graph tab) and the
   audit gains `hint.reinforced` rows. **👎** with a comment such as "too long" lowers confidence
   on the applied hints (`hint.contradicted` in the audit); an inferred hint that drops below the
   threshold is retired (tick *retired* in the Graph tab to see it), an explicit one is flagged
   `needs review`. The comment text itself goes through the extractor too, so "too long" also
   reinforces the existing `format.length="short"` hint.
6. **Approve** a hint: its approval chip turns `approved`, `hint.approved` appears in the audit,
   and it now wins slot conflicts and never decays. **Reject** retires it. **Forget** deletes it and
   adds a tombstone so a replayed event cannot bring it back (`hint.forgotten` in the audit).
7. **Dry-run**: type "typescript error" in the Graph tab's query box. The trace table shows every
   candidate with relevance, decay, effective score and `kept` / `suppressed` / `dropped`, plus the
   classifier's topic and node paths — without touching the LLM or the cache.
8. **Maintenance** tab: **Consolidate** promotes / merges within the subject (offline it promotes
   `captured` → `consolidated`); **Maintain** runs decay, promotion, node GC and retention;
   **Drain** processes anything left in the ingest queue (always 0 here — the harness ingests
   inline). The report and refreshed engine stats appear underneath.
9. **Switch** subject or client at the top to see a different graph; **Forget subject** wipes it.

## Smoke

```sh
npm run smoke -w @wisdom-graph/web       # from the repo root; offline, own store file
```

`src/smoke.ts` starts the same server on a random port and drives it with `fetch`:
config → chat (no preferences yet) → remember "shorter answers, bullet points, no disclaimers" →
chat again (asserts the reply mentions preferences, `injected.responseStyle` contains "bullet",
`injected.agent` carries the disclaimers constraint) → 👍 → 👎 with text → explain (≥ 2 active
hints, dry-run trace routes to `assist_code`) → approve one hint → forget another (both verified
in the tree and the audit) → consolidate / maintain / drain → stats → `/` is HTML, the SSE stream
carries `delta` then `done`, malformed JSON is a 400, unknown routes 404 → forget the subject.
Exit code 0 on success, 1 with the failed assertion; the harness is always closed. It uses
`WISDOM_STORE_FILE=.wisdom/smoke-web.json` and subject `smoke_web`, so it never touches your
real graph.
