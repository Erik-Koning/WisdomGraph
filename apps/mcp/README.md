# @wisdom-graph/mcp — the WisdomGraph MCP server

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server named `wisdom-graph`
that exposes the `@mosphere/wisdom-graph` loop to any MCP host: Claude Code, Claude Desktop,
the MCP Inspector, or your own client. The host model calls `wisdom_recall` before it answers,
pastes the compiled blocks into its prompt, and hands the finished turn back with
`wisdom_ingest_turn`; a human inspects and governs the graph with `wisdom_explain`,
`wisdom_approve` and `wisdom_forget`.

It runs on the shared test harness (`apps/shared`), so the graph it grows is the same one the
chat REPL, the web inspector and the LangGraph demo read: one store file, one subject.

## Run

```bash
npm run build                            # once: builds the library the harness imports
npm run smoke -w @wisdom-graph/mcp       # offline end-to-end check through a real MCP client
npm run start -w @wisdom-graph/mcp       # the server itself; speaks JSON-RPC on stdout
```

Stdout is the protocol channel. The banner and every log line go to stderr; set
`WISDOM_LOG=info` (or `debug`) to see what each call did.

## Register with Claude Code

```bash
# offline: no API key, the heuristic extractor turns obvious phrasings into hints
claude mcp add wisdom-graph -e WISDOM_OFFLINE=1 -- npx tsx /absolute/path/to/WisdomGraph/apps/mcp/src/server.ts

# online: extraction by the Anthropic model (ANTHROPIC_API_KEY or `ant auth login` in your shell)
claude mcp add wisdom-graph -- npx tsx /absolute/path/to/WisdomGraph/apps/mcp/src/server.ts
```

Add `-e WISDOM_STORE_FILE=.wisdom/claude-code.json` to keep a separate graph for this host, or
`-e WISDOM_SUBJECT=<id>` to run as a different subject. `claude mcp list` should show the server
as connected; `/mcp` inside Claude Code lists its tools.

## Register with Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "wisdom-graph": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/WisdomGraph/apps/mcp/src/server.ts"],
      "env": { "WISDOM_OFFLINE": "1" }
    }
  }
}
```

Drop the `env` block for online extraction (the Desktop app does not inherit your shell, so put
`ANTHROPIC_API_KEY` in `env` instead). Restart Claude Desktop after editing.

## MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx tsx apps/mcp/src/server.ts            # UI in the browser
npx @modelcontextprotocol/inspector --cli npx tsx apps/mcp/src/server.ts --method tools/list
npx @modelcontextprotocol/inspector --cli -e WISDOM_OFFLINE=1 npx tsx apps/mcp/src/server.ts \
  --method tools/call --tool-name wisdom_recall --tool-arg text="how do I fix this typescript error?"
```

## Tools

Every tool returns text. `subjectId` and `clientId` are optional everywhere and default to the
harness config (`WISDOM_SUBJECT` / `WISDOM_CLIENT` / `apps/shared/wisdom.config.json`).

| Tool | Arguments | Returns |
| --- | --- | --- |
| `wisdom_recall` | `text`, `subjectId?`, `clientId?`, `agent?`, `approvedOnly?` | Summary line, then the three compiled blocks (`preRoute`, `agent`, `responseStyle`) as `<<wisdom-hints …>>` sections, then the `provenance` ids to pass back as `appliedHintIds`. |
| `wisdom_ingest_turn` | `runId`, `userText`, `assistantText`, `agentsUsed?`, `appliedHintIds?`, `subjectId?`, `clientId?` | Receipt: `ingest turn_<runId>: processed` (`duplicate` on a repeated runId). |
| `wisdom_feedback` | `runId`, `signal: up\|down\|comment\|correction`, `text?`, `target?`, `subjectId?` | Receipt. `comment` / `correction` text is mined for new hints. |
| `wisdom_remember` | `text`, `subjectId?`, `clientId?` | Receipts for a synthetic turn + comment, then the hints now active. |
| `wisdom_explain` | `subjectId?`, `query?`, `includeRetired?` | The topic tree with every hint, pending / retired hints, recent events, audit; with `query`, a dry-run recall trace. |
| `wisdom_approve` | `hintId`, `status: approved\|rejected`, `by?`, `subjectId?` | Confirmation. |
| `wisdom_forget` | `hintId?`, `subjectId?`, `confirm?` | Deletes one hint, or the whole subject when `hintId` is omitted and `confirm: true`. |
| `wisdom_maintenance` | `action: consolidate\|maintain\|drain`, `subjectId?` | The report as JSON. |
| `wisdom_stats` | — | `EngineStats` as JSON. |

Example calls (as a host model would make them):

```json
{ "name": "wisdom_recall",      "arguments": { "text": "how do I fix this typescript error?" } }
{ "name": "wisdom_remember",    "arguments": { "text": "keep answers short and use bullet points, and call me Erik" } }
{ "name": "wisdom_ingest_turn", "arguments": { "runId": "run_42", "userText": "…", "assistantText": "…", "agentsUsed": ["assist_code"], "appliedHintIds": ["h_…"] } }
{ "name": "wisdom_feedback",    "arguments": { "runId": "run_42", "signal": "comment", "text": "no disclaimers please" } }
{ "name": "wisdom_explain",     "arguments": { "query": "typescript error" } }
{ "name": "wisdom_approve",     "arguments": { "hintId": "h_…", "status": "approved", "by": "erik" } }
{ "name": "wisdom_forget",      "arguments": { "confirm": true } }
{ "name": "wisdom_maintenance", "arguments": { "action": "consolidate" } }
```

Resources and prompt:

- `wisdom://config` — JSON: subject, client, categories, store description, offline flag.
- `wisdom://subject/{subjectId}/explain` — the `wisdom_explain` text for any subject.
- prompt `charter { text, subjectId? }` — the compiled `responseStyle` + `agent` blocks as one
  system-style message, for clients that assemble their own prompt.

## Testing walkthrough (Claude Code)

1. Register the server (above) and start `claude` in any directory. `/mcp` lists `wisdom-graph`.
2. Ask: *"Call wisdom_remember with: keep answers short, use bullet points, and call me Erik."*
   The reply shows the receipts and the hints now active (`Keeps answers short…`,
   `Prefers bullet points…`, `Calls the user Erik.`).
3. Ask a related question and tell it to use the graph: *"Before you answer, call wisdom_recall
   with my question and follow the responseStyle block. How do I fix a TS2322 error?"* The
   answer should be short, bulleted and address you by name; the tool result shows the
   `<<wisdom-hints lane="responseStyle">>` block it followed.
4. Ask it to *"call wisdom_ingest_turn for that exchange with the provenance ids, then
   wisdom_feedback up"*, then *"call wisdom_explain with my question"* — the hint lines show
   `applied=…`, the events list shows the turn and the feedback, and the dry-run trace lists each
   hint as `kept`.
5. Governance: *"approve hint h_… as erik"*, then *"call wisdom_recall with approvedOnly true"* —
   only the approved hint renders. *"wisdom_forget that hint"* removes it; `wisdom_explain
   includeRetired` no longer lists it (forget is a hard delete).

Every app shares the store file, so `npm run chat` afterwards starts with the same preferences.

## Environment

All knobs are read by `apps/shared/src/config.ts` (see its header for the full list):

| Variable | Meaning | Default |
| --- | --- | --- |
| `WISDOM_SUBJECT` / `WISDOM_CLIENT` / `WISDOM_TENANT` | Identity the graph belongs to | config file (`erik`, none, none) |
| `WISDOM_STORE` | `memory` \| `postgres` | `memory` |
| `WISDOM_STORE_FILE` | JSON snapshot of the memory store, relative to the repo root | `.wisdom/store.json` |
| `WISDOM_PG_URL` / `WISDOM_PG_PGVECTOR` | Postgres connection and pgvector flag | `postgres://wg:wg@localhost:55432/wg`, off |
| `WISDOM_MODEL` / `WISDOM_EFFORT` | Anthropic model and effort for extraction | `claude-opus-5`, `medium` |
| `WISDOM_OFFLINE` | `1` → no API calls, heuristic extractor | on automatically without credentials |
| `WISDOM_LOG` | `debug` \| `info` \| `warn` \| `error` \| `silent` (stderr) | `warn` |
| `WISDOM_CONFIG` | Path to a `wisdom.config.json` (categories, default identity) | `apps/shared/wisdom.config.json` |

Offline, the extractor recognises phrasings such as "shorter answers", "bullet points",
"no disclaimers", "call me Erik", "prefer python", "metric units"; anything else that looks like
a preference ("I want …", "always …", "never …") becomes a generic hint.

## Postgres mode

```bash
npm run db:up                                            # docker compose: postgres on :55432
WISDOM_STORE=postgres npm run start -w @wisdom-graph/mcp # migrations applied on start (kg_* tables)
claude mcp add wisdom-graph -e WISDOM_STORE=postgres -e WISDOM_PG_URL=postgres://wg:wg@localhost:55432/wg \
  -- npx tsx /absolute/path/to/WisdomGraph/apps/mcp/src/server.ts
```

Add `WISDOM_PG_PGVECTOR=1` to apply the pgvector migration. In Postgres mode nothing is written to
`.wisdom/`; every app pointed at the same database shares the graph.
