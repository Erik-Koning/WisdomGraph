/**
 * The testing subpath's surface, pinned (spec §1: each subpath pins its own
 * runtime exports; §2.9 lists them). The fakes are what a consumer's suite
 * runs the engine against, so a name here is a commitment like any on the
 * root barrel — add on purpose, and keep the fakes' building blocks in
 * `fakes.ts` where the package's own tests reach them by relative path.
 *
 * Also the layout rule from §1 that keeps the subpath shippable: every
 * non-test file under testing/ imports core by relative path and nothing
 * else — not a package, not a built-in. The bundle's external list is Node's
 * built-ins plus the (empty) dependency lists, so a bare specifier here
 * would either be bundled from a devDependency without anyone noticing or
 * tie the fakes to Node; neither survives a consumer's browser test runner.
 *
 * `Object.keys` on a module namespace sees runtime exports only; type-only
 * drift is not caught here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_EXPORTS = [
  // §2.9 — port fakes
  "FakeLlm",
  "FakeEmbedding",
  "FakeClock",
  "CollectingLogger",
  "CapturingTracer",
  // §2.9 — text corpora
  "injectionCorpus",
  "benignCorpus",
  // §2.9 — store toolkit: the faulty wrapper, the consumer fixtures, the shared contract suite
  "FaultyStore",
  "advisorCategories",
  "advisorFixture",
  "labelledQueries",
  "storeContractTests",
];

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = resolve(HERE, "..");

function codeOf(file: string): string {
  return readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Specifiers from static imports, re-exports, dynamic imports and `require`.
 * The keyword must stand alone (not the tail of a word or a string such as
 * `"from"`) and the specifier is one unbroken token, so prose in a string
 * literal never reads as an import.
 */
function importsOf(file: string): string[] {
  const code = codeOf(file);
  const found = new Set<string>();
  for (const m of code.matchAll(/(?<![\w"'])(?:from|import)\s*["']([^"'\s]+)["']/g)) found.add(m[1] as string);
  for (const m of code.matchAll(/(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) found.add(m[1] as string);
  return [...found];
}

describe("testing surface", () => {
  it("exports exactly the pinned names", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod).sort()).toEqual([...PUBLIC_EXPORTS].sort());
  });

  it("imports only by relative path inside src/, never a package or a built-in", () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    expect(files.sort()).toEqual(["fakes.ts", "fixtures.ts", "index.ts", "store-contract.ts"]);
    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importsOf(file);
      expect(specifiers.length, `${file} imports nothing — the scan found no specifier`).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
        const target = resolve(dirname(join(HERE, file)), specifier);
        if (!isRelative || relative(SRC, target).startsWith("..")) offenders.push(`${file} → ${specifier}`);
      }
      const source = codeOf(file);
      expect(source, `${file} names the pg driver`).not.toMatch(/from\s+["']pg["']|import\s*\(\s*["']pg["']\s*\)/);
      expect(source, `${file} names LangChain`).not.toContain("@langchain");
    }
    expect(offenders).toEqual([]);
  });
});
