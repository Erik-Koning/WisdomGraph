/**
 * The public API surface, pinned.
 *
 * Every name below is a semver commitment. A new export must be added here
 * deliberately; a removed or renamed one is a breaking change. If this test
 * fails because you added `export *` or a new symbol to a barrel, that is the
 * test doing its job — curate, then update the list.
 *
 * `Object.keys` on a module namespace sees runtime exports only; type-only
 * drift is not caught here.
 */
import { describe, expect, it } from "vitest";

const PUBLIC_EXPORTS = [
  "PACKAGE_NAME",
  // core/ — ports (§2.6, §7.1)
  "noopLogger",
  "noopTracer",
  "systemClock",
  "VersionConflictError",
  // core/ — policy (§2.7)
  "defaultPolicy",
  // core/ — extraction protocol (§2.8, §5.5)
  "PROMPT_VERSION",
  // core/ — validation and text (§2.8, §9.1)
  "validators",
  "estimateTokens",
  "sanitizeStatement",
  // core/ — charter policy and compilation (§2.8, §6, §8.3)
  "resolveConflicts",
  "scoreHint",
  "compileCharter",
  "compilePreRoute",
  "compileAgentPreamble",
  "compileResponseStyle",
  // core/ — recall helpers (§2.8, §4.1)
  "emptyRecall",
  "settleWithin",
  "linkSignals",
  // core/ — reference store (§2.8, §7.2)
  "MemoryStore",
  // engine (§2.7)
  "createWisdomGraph",
  "createNoopWisdomGraph",
];

describe("public API surface", () => {
  it("exports exactly the pinned names", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod).sort()).toEqual([...PUBLIC_EXPORTS].sort());
  });

  it("reports the published package name", async () => {
    const mod = await import("./index");
    expect(mod.PACKAGE_NAME).toBe("@mosphere/wisdom-graph");
  });
});
