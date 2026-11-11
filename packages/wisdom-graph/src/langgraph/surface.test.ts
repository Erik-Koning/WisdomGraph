/**
 * The langgraph subpath's surface, pinned (spec §1: each subpath pins its
 * own runtime exports; §2.9 lists them), plus the layout rule that makes it
 * a LangChain adapter with no LangChain in it: every file under langgraph/
 * imports by relative path into `src/` or `node:async_hooks`, and nothing
 * names `@langchain/*`, `langgraph` or any other package or built-in.
 *
 * `Object.keys` on a module namespace sees runtime exports only; type-only
 * drift is not caught here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_EXPORTS = [
  // §2.9 — messages
  "toNeutralMessage",
  "toNeutralMessages",
  "lastUserText",
  // §2.9 — scope and lanes
  "startTurnRecall",
  "createRecallScope",
  // §2.9 — injection helpers
  "systemPromptPrefix",
  "nodePreamble",
  "synthesizeSuffix",
  "charterMessages",
  "createPromptDecorator",
  // §2.9 — re-exported core primitives
  "settleWithin",
  "emptyRecall",
];

/** The one Node built-in the subpath is allowed (spec §1). */
const ALLOWED_BUILTINS = ["node:async_hooks"];

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = resolve(HERE, "..");

function codeOf(file: string): string {
  return readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function importsOf(file: string): string[] {
  return [...codeOf(file).matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)].map((m) => (m[1] ?? m[2]) as string);
}

describe("langgraph surface", () => {
  it("exports exactly the pinned names", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod).sort()).toEqual([...PUBLIC_EXPORTS].sort());
  });

  it("re-exports the same settleWithin and emptyRecall the root barrel does", async () => {
    const mod = await import("./index");
    const root = await import("../index");
    expect(mod.settleWithin).toBe(root.settleWithin);
    expect(mod.emptyRecall).toBe(root.emptyRecall);
  });

  it("imports only by relative path inside src/ or node:async_hooks — never LangChain, langgraph, a package or another built-in", () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    expect(files.sort()).toEqual(["index.ts", "inject.ts", "messages.ts", "scope.ts"]);
    const offenders: string[] = [];
    const builtins = new Set<string>();
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
        if (isRelative) {
          const target = resolve(dirname(join(HERE, file)), specifier);
          if (relative(SRC, target).startsWith("..")) offenders.push(`${file} → ${specifier}`);
        } else if (ALLOWED_BUILTINS.includes(specifier)) {
          builtins.add(specifier);
        } else {
          offenders.push(`${file} → ${specifier}`);
        }
      }
      const source = codeOf(file);
      expect(source, `${file} names LangChain`).not.toContain("@langchain");
      expect(source, `${file} names langgraph as a package`).not.toMatch(/from\s+["']@?langgraph|import\s*\(\s*["']@?langgraph/);
      expect(source, `${file} names the pg driver`).not.toMatch(/from\s+["']pg["']/);
    }
    expect(offenders).toEqual([]);
    expect([...builtins]).toEqual(ALLOWED_BUILTINS);
  });

  it("keeps node:async_hooks in scope.ts alone, so the messages and injection helpers stay portable", () => {
    for (const file of ["index.ts", "inject.ts", "messages.ts"]) {
      expect(importsOf(file).some((s) => s.startsWith("node:")), `${file} imports a built-in`).toBe(false);
    }
    expect(importsOf("scope.ts")).toContain("node:async_hooks");
  });
});
