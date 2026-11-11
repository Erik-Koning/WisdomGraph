# @wisdom-graph/simulate — scenario simulator

Evolve a wisdom graph deterministically without waiting real days or talking
to a model. A scenario is a scripted conversation — turns, feedback, time
jumps, maintenance passes, human approvals — replayed against the real
`@mosphere/wisdom-graph` engine on a **fake clock** with a **scripted
extractor**. After every step the simulator prints what changed in the graph
(hints captured, reinforced, superseded, promoted, decayed, retired, pending;
sub-nodes created), and `expect` steps turn the file into a regression test.

```
npm run simulate -- scenarios/preferences-evolve.json          # from the repo root (builds the library first)
npx tsx src/main.ts scenarios/preferences-evolve.json          # from apps/simulate
npx tsx src/main.ts scenarios/sub-topics.json --verbose        # also print the rendered recall artifacts
npx tsx src/main.ts scenarios/feedback-loop.json --json        # timeline as JSON lines
npx tsx src/main.ts scenarios/approval-and-charter.json --days 400   # append a 400-day jump + maintain
```

Flags: `--days N` appends `{ advanceDays: N }` + `{ maintain: true }` to the
steps; `--json` prints JSON lines instead of text; `--verbose` prints per-step
detail (rendered artifacts); `--store-file path` chooses the isolated
MemoryStore snapshot (default `.wisdom/sim-<name>.json` under the repo root,
deleted before every run so runs are reproducible). The run ends with the full
`explain()` rendering and `PASS` or `FAIL n expectation(s)`; the exit code is
1 on any failure, with expected vs actual printed for each.

Diagnostics go to stderr; stdout carries only the timeline.

## What a step does under the hood

- The clock is a `FakeClock` (from `@mosphere/wisdom-graph/testing`) starting
  at the scenario's `startAt` (default `2026-01-01T09:00:00Z`). It ticks one
  minute per step so rows get distinct timestamps, and jumps on
  `advanceDays` / `advanceMs`. Decay, retirement and promotion are pure
  functions of this clock.
- The extractor is a scripted `LlmPort`: when the current step carries a
  `proposal`, the next `extract` call returns it verbatim. Otherwise the call
  falls through to the harness's own port — the **offline heuristic** with
  `WISDOM_OFFLINE=1` (turns phrasings like "shorter answers", "bullet points",
  "no disclaimers", "call me Erik", "in Python" into canonical proposals), or
  the **real model** when credentials are present and `WISDOM_OFFLINE=0`.
  Scripted proposals in the file always win when present. A proposal that the
  library never asked for (the triage gate said no) is reported as a warning
  on that step instead of leaking into a later one.
- Ingest is inline, so a receipt means the event was fully processed before
  the next step runs.
- Every step is followed by `explain(subjectId, { includeRetired: true })`;
  the diff against the previous step becomes the `+hint` / `~hint` / `-hint`
  / `+node` / `~node` lines.

Timeline lines:

```
# 5 feedback    2026-01-01 09:04
    ingest fb_5: processed accepted=2 rejected=0 · signal=comment run=run_2 · llm=extract(fallback)
    +hint "Prefers bullet points over prose." (format.lists=bullets, responseStyle/global/explicit, active) @/ id=h_…
#16 feedback    2026-01-01 09:15
    +hint "Prefers detailed explanations with the reasoning shown." (format.length=detailed, responseStyle/global/explicit, active) @/ id=h_…
    ~hint h_… "Keeps answers short and to the point.": status active→superseded
#27 maintain    2026-04-01 09:26
    maintain: examined=3 promoted=0 retired=1 …
    ~hint h_… "Prefers Python for code examples.": status active→retired / retiredReason —→decayed
```

`+hint` shows `(slot=value, lane/scope[:agent]/source, status)` and the node
path; `~hint` lists every watched field that changed (status, maturity,
confidence, approval, needsReview, reinforcements, contradictions, applied,
source, text, value, nodePath, retiredReason). Recall lines are the harness's
`formatRecall` plus the charter's `suppressed` / `dropped` reasons and, for
turns with `recall: true`, the applied hint ids.

## Scenario schema

```jsonc
{
  "name": "preferences-evolve",      // names the store file; letters, digits, . _ -
  "subjectId": "erik",               // optional; default from apps/shared/wisdom.config.json
  "clientId": "acme",                // optional
  "startAt": "2026-01-01T09:00:00Z", // optional ISO date the fake clock starts at
  "steps": [ /* Step, in order */ ]
}
```

Each step is an object with exactly one key:

| Step | Meaning |
| --- | --- |
| `{ "turn": { "user", "assistant"?, "agentsUsed"?, "recall"?, "proposal"?, "extract"? } }` | Ingest a turn (`runId = run_<step>`). `recall: true` runs a recall on the user text first and passes its provenance as `appliedHintIds` (and, if `agentsUsed` is absent, the predicted agents). `proposal` is the JSON the extractor returns (see below). `extract` is `"auto"` (library triage gate decides), `"force"` or `"skip"`; default `"force"` when a proposal is scripted, else `"auto"`. |
| `{ "feedback": { "signal", "text"?, "target"?, "proposal"? } }` | Feedback anchored to the last turn's `runId`. `signal` is `up` / `down` / `comment` / `correction`; `target` is `"response"`, `"agent:<name>"` or `"tool:<name>"`. Text-carrying feedback goes through the extractor with `source: explicit`; a scripted `proposal` needs `text` (the library never calls the model for textless feedback). |
| `{ "advanceDays": n }` / `{ "advanceMs": n }` | Move the clock. |
| `{ "consolidate": true }` | `maintenance.consolidate(subjectId)` — fold supersession chains, merge duplicates, promote `captured → consolidated` (reinforced or applied ≥ 3), retire low-confidence inferred hints. |
| `{ "maintain": true }` | `maintenance.maintain({ subjectId })` — decay retirement (weight < 0.15 and unapplied for a half-life), `consolidated → established`, contradiction retirement, node GC. |
| `{ "drain": true }` | `maintenance.drain()` (a no-op with inline ingest; present for parity). |
| `{ "approve": { "hintText" \| "hintId", "status"?: "approved" \| "rejected" } }` | `approve(subjectId, id, { status, by: "simulate" })`. Default `approved`. |
| `{ "forget": { "hintText" \| "hintId" } }` / `{ "forget": { "subject": true } }` | Hard-delete a hint, or the whole subject. |
| `{ "recall": { "text", "agent"?, "approvedOnly"?, "expect"? } }` | Run a recall and render the three lanes (`compilePreRoute`, `compileAgentPreamble` for `agent` and every predicted agent, `compileResponseStyle`). `expect`: `category`, `includes` / `excludes` (case-insensitive substrings of the rendered artifacts), `minHints` / `maxHints` (charter entries). |
| `{ "expect": { … } }` | Assertions on the graph — see below. |
| `{ "note": "…" }` | Free text printed in the timeline. |

**Hint references** (`hintText`, and the keys of `hintStatus`, `maturity`,
`needsReview`, `reinforcements`, `decay`) are case-insensitive substrings of a
hint's statement, matched over *every* row `explain()` knows about — active,
pending, superseded and retired. For `approve` / `forget` the live row wins
when several match (active, then pending, then the oldest). For expectations,
the check passes if any matching row satisfies it; the failure message lists
every match with its actual value.

`expect` keys:

| Key | Passes when |
| --- | --- |
| `activeHints`, `pending`, `retired`, `nodes` | `explain().stats` equals the number (`retired` counts superseded rows too). |
| `hintStatus: { "<substring>": "active" \| "superseded" \| "retired" \| "pending" \| "absent" }` | A matching hint has that status; `absent` when nothing matches. |
| `maturity: { "<substring>": "captured" \| "consolidated" \| "established" }` | A live (active/pending) matching hint has that maturity. |
| `needsReview: { "<substring>": true \| false }` | A live matching hint has that review flag. |
| `reinforcements: { "<substring>": n }` | A matching hint has `reinforcements ≥ n`. |
| `decay: { "<substring>": { "below"?: x, "above"?: y } }` | An active matching hint's current decay weight is within the bounds. |
| `nodeExists: "/path"` | The node exists and is active. |
| `properties: { "/path": { "key": value } }` | The node carries each property with exactly that JSON value. |

### Scripted proposals

`proposal` is the exact JSON the extractor would return (spec §5.5) and is
validated at load with the library's own `validators.proposal`, so a bad
lane × kind pairing fails before the run starts. Rules worth knowing:

- Ops: `add_hint` (with `nodePath`), `update_hint`, `reinforce_hint`,
  `retire_hint`, `create_node` (with inline `hints`), `update_node`,
  `set_property`, `noop`. Consolidation-only ops are rejected in extraction.
- `nodePath` / `parentPath` must exist: `/`, a category from
  `apps/shared/wisdom.config.json` (`/assist_code`, `/assist_writing`,
  `/assist_research`, `/assist_planning`, `/assist_finance`), or a sub-node an
  earlier step created. Level-1 nodes are locked (cannot be retired/merged).
- Lane × kind: `preRoute` takes `routing` / `fact` / `constraint`; `agent`
  takes everything; `responseStyle` takes `style` / `preference` / `constraint`.
- `scope`: `global` / `category` / `agent` (then `agent` is required and must
  be a configured category) / `client`.
- `text` must be a canonical third-person statement ≤ 200 chars starting with
  an allowed opener (Prefers, Avoids, Uses, Keeps, Omits, Includes, Assumes,
  Calls, Writes, Never, Always, …) — no quotes, no "you"/"I", nothing that
  reads as an instruction to the model (spec §9.1). `slot` matches
  `^[a-z0-9_.]{2,60}$`; `priority` 0–100; `confidence` 0–1; `rationale` required.
- `source` is never yours to set: turns produce `inferred`, feedback `explicit`.
- The organiser rewrites: same node + slot + scope with the **same value** →
  reinforce the existing hint; **new value** → supersede (or a pending
  challenger when the holder is approved / higher-ranked source). An
  `add_hint` on a locked node whose text matches a sub-node's keywords is
  re-targeted there.

## Shipped scenarios

| File | What it proves |
| --- | --- |
| `preferences-evolve.json` | Capture from a feedback comment via the offline heuristic (two hints from one sentence) → restating the same preference **reinforces** (status unchanged, reinforcements +1, confidence +0.05) → `consolidate` promotes `captured → consolidated` → a scripted contradiction on `format.length` **supersedes** the old hint → a plain turn ("I usually write in Python") yields an **inferred** hint that decays to ~0.35 after 45 d (still active) and is **retired (decayed)** at 90 d, while the explicit hints (90 d / 180 d half-lives) survive → the final recall renders detail + bullets and never the superseded or retired ones. `npm run smoke` runs it with `--days 400` appended. |
| `sub-topics.json` | `create_node` under `/assist_code` with an inline category-scoped hint, then `set_property` + a second hint on the sub-node → a recall about mocking in Vitest classifies into the sub-node (category `assist_code`) and renders both hints; a writing question renders neither (category scope) → a restatement on the sub-node reinforces rather than duplicates. Asserts `nodeExists` and `properties`. |
| `feedback-loop.json` | Three rated rounds (`recall: true` so `appliedHintIds` are the real provenance, then `down`). An **inferred** hint at 0.9 falls 0.54 → 0.32 → 0.19 and is **retired (feedback)** on the third down; an **explicit** hint at 0.7 falls to 0.36 with 3 contradictions → `needsReview`, **still active**; an explicit hint at 0.55 falls to 0.28 < 0.3 → **pending** + `needsReview`. Neither flagged hint is recalled until a human approves them; approval clears the flag and restores the pending one. |
| `approval-and-charter.json` | Two explicit hints from one comment; `approve` one → `approvedOnly` recall renders only it (a normal recall renders both) → 400 days + `maintain` retires the auto hint (0.5^4.4 < 0.15) while the approved one keeps decay weight 1 → `forget` removes the approved hint and the next recall is empty. |

## Writing a new scenario

1. Copy the closest shipped file; keep `name` unique (it names the store file).
2. Decide, per turn, whether the offline heuristic is enough (feedback like
   "shorter answers, no disclaimers", turns containing "I usually …", "I
   prefer …") or you need a scripted `proposal` for an exact slot / value /
   node. Scripted proposals are the only way to create sub-nodes offline.
3. Remember the triage gate: a plain question ("How do I fix this error?")
   never reaches the extractor with `extract: "auto"`. Use feedback text, a
   standing-instruction phrasing, or `extract: "force"`.
4. Use `recall: true` on turns that should count as *applications* of hints —
   feedback `up` / `down` only touches hints that were applied to that run.
5. Interleave `expect` steps generously; the timeline prints every diff, so
   run once without expectations, read the diff, then pin what matters.
6. Half-lives to plan time jumps: captured inferred 30 d / explicit 90 d;
   consolidated 90 d / 180 d; established 365 d / never; approved never.
   Retirement needs decay weight < 0.15, i.e. ≈ 2.74 half-lives, and no
   application within the last half-life.

## Using the scenarios as a regression suite

```
npm run all -w @wisdom-graph/simulate        # every scenarios/*.json, stops at the first failure
# equivalently, from apps/simulate:
for f in scenarios/*.json; do npx tsx src/main.ts $f || exit 1; done
```

`all` forces `WISDOM_OFFLINE=1` unless you set it yourself, so it never needs
credentials and is deterministic. `npm run smoke -w @wisdom-graph/simulate`
runs the smoke scenario alone; the root `npm run smoke:apps` includes it.

## Running against the real model

```
WISDOM_OFFLINE=0 ANTHROPIC_API_KEY=… npx tsx src/main.ts scenarios/preferences-evolve.json
```

With credentials and `WISDOM_OFFLINE=0` the fallback extractor is the
Anthropic model (`WISDOM_MODEL`, `WISDOM_EFFORT`), so turns and feedback
without a scripted `proposal` are extracted by the model and consolidation's
LLM pass runs too. Proposals present in the file still win — script the steps
whose outcome the expectations depend on and leave the rest to the model. The
clock stays fake, so decay and promotion behave identically; only the
proposals (and therefore which expectations hold) can differ from an offline
run.
