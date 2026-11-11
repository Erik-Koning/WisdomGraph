/**
 * The postgres subpath's surface, pinned (spec §1: each subpath pins its own
 * runtime exports; §2.9 lists them), plus the layout rule that makes the
 * subpath safe to ship without a driver: every file under postgres/ imports
 * by relative path into `src/` and never names `pg`, `@langchain/*` or a
 * `node:` built-in.
 *
 * `Object.keys` on a module namespace sees runtime exports only; type-only
 * drift is not caught here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_EXPORTS = [
  // §2.9 — the store
  "PostgresStore",
  "createPostgresStore",
  // §2.9 — the schema
  "migrations",
  "renderMigrationsSql",
  "setup",
];

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

describe("postgres surface", () => {
  it("exports exactly the pinned names", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod).sort()).toEqual([...PUBLIC_EXPORTS].sort());
  });

  it("imports only by relative path inside src/, never a driver, a package or a built-in", () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    expect(files.length).toBeGreaterThanOrEqual(5);
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
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
