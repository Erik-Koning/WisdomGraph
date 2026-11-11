/**
 * The core half's one real promise: you can copy it into any runtime and run
 * it. That only holds if nothing in it reaches for Node built-ins, an npm
 * package, or a browser global — and a promise that isn't tested is a comment.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Every non-test `.ts` file under core/, recursively, as paths relative to core/. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push(relative(HERE, full));
  }
  return out;
}

const sources = walk(HERE);

/** Source with comments stripped, so a mention in prose is not a false positive. */
function codeOf(file: string): string {
  return readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Import specifiers of a file. */
function importsOf(file: string): string[] {
  return [...codeOf(file).matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)].map(
    (m) => (m[1] ?? m[2]) as string,
  );
}

describe("core isolation", () => {
  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThanOrEqual(1);
  });

  it("imports nothing outside itself", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const specifier of importsOf(file)) {
        // A relative import is fine as long as it resolves inside core/.
        // Everything else — `node:*`, a bare package name, `../` escaping
        // upward — is not. That covers every kind of dependency in one rule.
        const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
        const target = resolve(dirname(join(HERE, file)), specifier);
        const ok = isRelative && !relative(HERE, target).startsWith("..");
        if (!ok) offenders.push(`${file} → ${specifier}`);
      }
    }
    expect(offenders, "core/ must stay dependency-free").toEqual([]);
  });

  it("touches no runtime-specific global", () => {
    // `process.env` ties the code to Node; `window`/`document` to a browser.
    // Either would make the portability promise false at runtime, not just in
    // the import graph.
    for (const file of sources) {
      const source = codeOf(file);
      for (const global of ["process.", "require(", "document.", "window.", "navigator.", "localStorage"]) {
        expect(source.includes(global), `${file} uses ${global}`).toBe(false);
      }
    }
  });

  it("loads with no DOM present", async () => {
    // This file's vitest environment is `node` — there is genuinely no DOM
    // here, so a successful import is the real proof.
    expect("document" in globalThis).toBe(false);
    const core = await import("./index");
    expect(core).toBeDefined();
  });
});
