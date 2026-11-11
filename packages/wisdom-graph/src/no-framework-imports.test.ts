/**
 * Must-have 1, checked at the source: nothing anywhere under `src/` names
 * the `pg` driver or a LangChain package. Both are reached structurally —
 * `PgPoolLike` for the pool, `MessageLike` for messages — and that is what
 * lets the package ship with zero runtime dependencies and no peer
 * dependencies. The per-subpath surface tests guard their own folders; this
 * sweep is the one place that walks every file, tests included, so a
 * convenience import in a test cannot drift into a dev dependency the
 * package would then need.
 *
 * The same walk enforces the general form of spec §1's layout rule: shipped
 * code imports by relative path inside `src/` and nothing else. The bundle
 * externalises Node's built-ins and the (empty) dependency lists, so any
 * bare specifier is either a built-in the entry now needs or a devDependency
 * silently bundled in; both are packaging decisions, and the one that has
 * been made — `node:async_hooks` in langgraph/scope.ts — is the single
 * allowance.
 *
 * Comments are stripped before matching so prose about `pg` (this file, the
 * postgres client types) is not a false positive; only import specifiers,
 * `require` calls and dynamic imports count.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Every `.ts` file under src/, tests included, relative to src/. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(relative(SRC, full));
  }
  return out;
}

function codeOf(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Specifiers from static imports, re-exports, dynamic imports and `require`.
 * The keyword must stand alone (not the tail of a word or a string such as
 * `"from"`) and the specifier is one unbroken token, so prose in a string
 * literal never reads as an import.
 */
function specifiersOf(file: string): string[] {
  const code = codeOf(file);
  const found = new Set<string>();
  for (const m of code.matchAll(/(?<![\w"'])(?:from|import)\s*["']([^"'\s]+)["']/g)) found.add(m[1] as string);
  for (const m of code.matchAll(/(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) found.add(m[1] as string);
  return [...found];
}

const FORBIDDEN = [
  { label: "the pg driver", test: (s: string) => s === "pg" || s.startsWith("pg/") || s.startsWith("pg-") },
  { label: "LangChain", test: (s: string) => s.startsWith("@langchain/") || s === "langchain" || s.startsWith("langchain/") },
  { label: "LangGraph", test: (s: string) => s === "langgraph" || s.startsWith("langgraph/") || s === "@langchain/langgraph" },
  { label: "deep-agents", test: (s: string) => s === "deepagents" || s.startsWith("deepagents/") },
];

const files = walk(SRC);

describe("no framework or driver imports under src/", () => {
  it("walks the whole tree, tests included", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("postgres/store.ts");
    expect(files).toContain("langgraph/scope.ts");
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(true);
  });

  it("finds no 'pg', '@langchain', 'langgraph' or 'deepagents' specifier in any file", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(file)) {
        const hit = FORBIDDEN.find((rule) => rule.test(specifier));
        if (hit) offenders.push(`${file} → ${specifier} (${hit.label})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names neither package anywhere in shipped code, not only in import position", () => {
    // Belt and braces for the two must-have names: a string literal such as
    // `await import("@langchain/core")` built from pieces would slip past the
    // specifier scan, so the raw code of every non-test file is checked for
    // the substrings too. Tests are covered by the specifier scan alone —
    // the guard tests legitimately spell the names in their assertions.
    for (const file of files.filter((f) => !f.includes(".test."))) {
      const code = codeOf(file);
      expect(code, `${file} mentions @langchain`).not.toContain("@langchain");
      expect(code, `${file} imports pg`).not.toMatch(/(?:from|import|require)\s*\(?\s*["']pg["']/);
    }
  });

  it("only langgraph/scope.ts reaches a Node built-in outside tests", () => {
    // The root and the other subpaths stay portable (spec §1); `node:*` in a
    // non-test file is a packaging decision, so a new one must be made here.
    const builtinUsers = files
      .filter((f) => !f.includes(".test."))
      .filter((f) => specifiersOf(f).some((s) => s.startsWith("node:") || s === "async_hooks" || s === "fs" || s === "path"));
    expect(builtinUsers).toEqual(["langgraph/scope.ts"]);
  });

  it("every shipped file imports only by relative path inside src/, except langgraph/scope.ts → node:async_hooks", () => {
    // Not a list of known offenders: anything that is not `./` or `../`
    // resolving under src/ is refused, so `util`, `crypto` or an installed
    // devDependency fail here the same way a driver would.
    const ALLOWED = new Map([["langgraph/scope.ts", "node:async_hooks"]]);
    const shipped = files.filter((f) => !f.includes(".test."));
    expect(shipped.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    const allowancesUsed: string[] = [];
    for (const file of shipped) {
      for (const specifier of specifiersOf(file)) {
        if (ALLOWED.get(file) === specifier) {
          allowancesUsed.push(`${file} → ${specifier}`);
          continue;
        }
        const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
        const target = resolve(dirname(join(SRC, file)), specifier);
        if (!isRelative || relative(SRC, target).startsWith("..")) offenders.push(`${file} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
    // The allowance is real, not stale: scope.ts still takes it.
    expect(allowancesUsed).toEqual(["langgraph/scope.ts → node:async_hooks"]);
  });
});
