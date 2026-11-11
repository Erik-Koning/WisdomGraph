/**
 * Public API.
 *
 *   import { ... } from "@mosphere/wisdom-graph";
 *
 * Exports are curated: every name that leaves this barrel is a deliberate
 * semver commitment, and `src/api-surface.test.ts` pins the list. Add to it on
 * purpose, and keep the internals (id plumbing, storage details, constants)
 * module-private.
 *
 * The package is organised in halves, mirroring the graph's own separation of
 * concerns:
 *
 *   core/  — zero dependencies. The graph schema and its validation, charter
 *            assembly, system-prompt compilation, the recall pipeline and the
 *            engine that composes them. Runs wherever the agent does: a
 *            backend, a Lambda, an edge worker, or a test.
 *
 * The engine factories are exported here rather than from the core barrel
 * (spec §1): `createWisdomGraph` is the package's front door, and keeping it
 * at the root makes the import a consumer writes the one the README shows.
 * The storage and framework adapters live behind their own subpaths
 * (`./postgres`, `./langgraph`, `./testing`).
 */

/** The published package name, as a typed constant. */
export const PACKAGE_NAME = "@mosphere/wisdom-graph" as const;

// ── The portable core ────────────────────────────────────────────────────────
export * from "./core";

// ── The engine (§2.7) ────────────────────────────────────────────────────────
export { createWisdomGraph, createNoopWisdomGraph } from "./core/engine";
