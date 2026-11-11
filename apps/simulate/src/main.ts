/**
 * main.ts — `tsx src/main.ts <scenario.json> [--days N] [--json] [--verbose] [--store-file path]`
 *
 * Plays one scenario file (see scenario.ts) against a real engine on a fake
 * clock and prints a timeline: one block per step with the clock date, what
 * ran, the graph diff against the previous step, and any expectation results.
 * Ends with the full explanation and `PASS` / `FAIL n expectation(s)`; the
 * exit code is 1 when any expectation failed (or the scenario would not load),
 * so a directory of scenarios doubles as a regression suite.
 *
 *   --days N          append { advanceDays: N } + { maintain: true } to the steps
 *   --json            print the timeline as JSON lines instead of text
 *   --verbose         also print rendered recall artifacts and per-step detail
 *   --store-file p    where the isolated MemoryStore snapshot goes (default .wisdom/sim-<name>.json,
 *                     relative to the repo root; deleted before the run so it is reproducible)
 *
 * Everything diagnostic goes to stderr; stdout carries only the timeline.
 */
import { formatExplanation } from "@wisdom-graph/harness";
import { runScenario, type TimelineEntry } from "./run";
import { loadScenario, ScenarioError, type Scenario, type Step } from "./scenario";

interface Cli {
  file: string;
  days?: number;
  json: boolean;
  verbose: boolean;
  storeFile?: string;
}

const USAGE = "usage: tsx src/main.ts <scenario.json> [--days N] [--json] [--verbose] [--store-file path]";

function parseArgs(argv: string[]): Cli {
  let file: string | undefined;
  const cli: Cli = { file: "", json: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
      i += 1;
      return v;
    };
    if (a === "--days") {
      const d = Number(next());
      if (!Number.isFinite(d) || d < 0) throw new Error("--days needs a non-negative number");
      cli.days = d;
    } else if (a === "--json") cli.json = true;
    else if (a === "--verbose" || a === "-v") cli.verbose = true;
    else if (a === "--store-file") cli.storeFile = next();
    else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE + "\n");
      process.exit(0);
    } else if (a.startsWith("-")) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else if (file === undefined) file = a;
    else throw new Error(`unexpected argument ${a}\n${USAGE}`);
  }
  if (file === undefined) throw new Error(USAGE);
  cli.file = file;
  return cli;
}

function printText(entry: TimelineEntry, verbose: boolean): void {
  const out: string[] = [];
  out.push(`#${String(entry.step).padStart(2, " ")} ${entry.kind.padEnd(11)} ${entry.at.slice(0, 16).replace("T", " ")}`);
  for (const s of entry.summary) out.push(`    ${s}`);
  for (const w of entry.warnings) out.push(`    ! ${w}`);
  for (const d of entry.diffLines) out.push(`    ${d}`);
  if (verbose) for (const d of entry.detail) for (const line of d.split("\n")) out.push(`    │ ${line}`);
  for (const r of entry.expectations) {
    if (r.ok) out.push(`    ✓ ${r.what} = ${r.expected}`);
    else {
      out.push(`    ✗ ${r.what}`);
      out.push(`        expected: ${r.expected}`);
      for (const line of r.actual.split("\n")) out.push(`        actual:   ${line}`);
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}

function printJson(entry: TimelineEntry): void {
  const { diff, ...rest } = entry;
  process.stdout.write(
    JSON.stringify({
      ...rest,
      diff: {
        addedHints: diff.addedHints.map((h) => ({ id: h.id, text: h.text, slot: h.slot, value: h.value, lane: h.lane, scope: h.scope, source: h.source, status: h.status, nodePath: h.nodePath })),
        changedHints: diff.changedHints,
        removedHints: diff.removedHints.map((h) => ({ id: h.id, text: h.text })),
        addedNodes: diff.addedNodes.map((n) => ({ path: n.path, title: n.title })),
        changedNodes: diff.changedNodes,
        removedNodes: diff.removedNodes.map((n) => n.path),
      },
    }) + "\n",
  );
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));
  const scenario: Scenario = loadScenario(cli.file);
  if (cli.days !== undefined) {
    const extra: Step[] = [{ note: `--days ${cli.days}: jump ahead and run maintenance` }, { advanceDays: cli.days }, { maintain: true }];
    scenario.steps.push(...extra);
  }
  process.stderr.write(`scenario "${scenario.name}" · ${scenario.steps.length} steps · ${cli.file}\n`);

  const result = await runScenario({
    scenario,
    ...(cli.storeFile !== undefined ? { storeFile: cli.storeFile } : {}),
    verbose: cli.verbose,
    onEntry: (entry) => (cli.json ? printJson(entry) : printText(entry, cli.verbose)),
  });

  const explanation = await result.harness.graph.explain(result.subjectId, { clientId: result.clientId, includeRetired: true });
  await result.harness.close();

  const verdict = result.failures.length === 0 ? "PASS" : `FAIL ${result.failures.length} expectation(s)`;
  if (cli.json) {
    process.stdout.write(JSON.stringify({ final: true, verdict, failures: result.failures, explanation }) + "\n");
  } else {
    process.stdout.write("\n── final graph ──\n" + formatExplanation(explanation, { hints: true, audit: 8, events: 5 }) + "\n\n");
    for (const f of result.failures) {
      process.stdout.write(`FAILED step ${f.step} (${f.kind}) ${f.result.what}\n  expected: ${f.result.expected}\n  actual:   ${f.result.actual.split("\n").join("\n            ")}\n`);
    }
    process.stdout.write(`${verdict} · ${scenario.name} · store=${result.harness.storeDescription}\n`);
  }
  return result.failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const msg = e instanceof ScenarioError ? `scenario error — ${e.message}` : e instanceof Error ? e.stack ?? e.message : String(e);
    process.stderr.write(msg + "\n");
    process.exit(1);
  },
);
