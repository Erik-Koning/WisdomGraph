/**
 * Build guard for the published declarations. Two things must hold, and
 * neither is something `vite build` would report:
 *
 *   1. Every runtime export of each built entry is declared in that entry's
 *      rolled-up `.d.ts`. api-extractor reports nothing when it drops a
 *      re-export or re-rolls a stale entry file — the bundle still builds,
 *      and the package would publish JavaScript with a `.d.ts` that types
 *      almost none of it. The names to expect are not pinned here: they are
 *      read from the built JavaScript, so this stays correct as entries and
 *      surfaces grow.
 *   2. Values cross entries. Each rolled-up `.d.ts` carries its own copy of
 *      whatever it reaches, so the testing entry's `advisorFixture().store` is
 *      declared by a second `MemoryStore` — and a class with a private
 *      member is a nominal type, which would make the two copies
 *      unassignable while the runtime is one class in a shared chunk. A
 *      consumer file that moves values between all four entries is compiled
 *      against `dist/` under `nodenext`, once as `.mts` (the `import`
 *      condition, `.d.ts`) and once as `.cts` (the `require` condition,
 *      `.d.cts`), through the package's own `exports` map by self-reference.
 *      The consumer is never written to disk: it lives in a compiler host so
 *      nothing lands in `dist/` or the tarball.
 *
 * Runs last in `npm run build`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

/** `{ js, dts }` per subpath that declares an ESM `types` entry. */
const entries = Object.entries(pkg.exports ?? {}).flatMap(([subpath, target]) => {
  const esm = target && typeof target === "object" ? target.import : undefined;
  return esm && typeof esm === "object" && esm.types && esm.default
    ? [{ subpath, js: resolve(root, esm.default), dts: resolve(root, esm.types) }]
    : [];
});

if (entries.length === 0) {
  console.error("check-dts: package.json exports declare no { import: { types, default } } entries");
  process.exit(1);
}

/** A declaration or an `export { ... }` listing for `name`, as api-extractor emits them. */
function declares(text, name) {
  const declared = new RegExp(`(?:^|\\s)declare\\s+(?:const|let|var|function|class|enum|namespace)\\s+${name}\\b`, "m");
  const listed = new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "m");
  return declared.test(text) || listed.test(text);
}

let failed = false;
for (const { subpath, js, dts } of entries) {
  const runtime = Object.keys(await import(pathToFileURL(js).href)).filter((name) => name !== "default");
  const text = readFileSync(dts, "utf8");
  const missing = runtime.filter((name) => !declares(text, name));
  if (missing.length > 0) {
    failed = true;
    console.error(`check-dts: ${subpath} — ${dts} lacks declarations for: ${missing.join(", ")}`);
  } else {
    console.log(`check-dts: ${subpath} — ${runtime.length} runtime exports declared`);
  }
}
if (failed) process.exit(1);

// ── 2. A consumer that hands values across entries ───────────────────────────

/**
 * Every line moves a value between two entries, so a declaration that has
 * drifted into a nominal copy fails here, not in a consumer's build. The
 * root store is also fed to both other subpaths' entry points.
 */
const CONSUMER = `
import { MemoryStore, createWisdomGraph, type StorePort, type WisdomGraph } from "${pkg.name}";
import { createPostgresStore, type PgPoolLike } from "${pkg.name}/postgres";
import { FaultyStore, advisorCategories, advisorFixture } from "${pkg.name}/testing";
import { startTurnRecall, type RecallHandle } from "${pkg.name}/langgraph";

declare const pool: PgPoolLike;
const fixture = advisorFixture();
// testing → root: the fixture's store is the root's MemoryStore, by name.
export const memory: MemoryStore = fixture.store;
export const fresh: MemoryStore = new MemoryStore();
// postgres → root: a PostgresStore is a StorePort the root graph accepts.
export const overPostgres: WisdomGraph = createWisdomGraph({ store: createPostgresStore(pool), categories: fixture.categories });
// root → testing → root: the wrapper takes and yields the root's port.
export const faulty: StorePort = new FaultyStore(memory, { throwOn: ["loadSnapshot"] });
export const overFaulty: WisdomGraph = createWisdomGraph({ store: faulty, categories: advisorCategories() });
// root → langgraph: the graph and request types are the root's.
export const handle: RecallHandle = startTurnRecall(overFaulty, { subjectId: fixture.subjectId, text: "hello", budgetMs: 150 });
`;

/** Compile `CONSUMER` as one virtual file at `root/<name>` and return its diagnostics. */
function compileConsumer(name) {
  const file = resolve(root, name);
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    // The engine is Node ≥ 22 and `AbortSignal` comes from its types, as it
    // does for every consumer this package is for; nothing else is ambient.
    types: ["node"],
    strict: true,
    noEmit: true,
    // The rolled-up declarations are checked too: a consumer without
    // `skipLibCheck` sees every error in them.
    skipLibCheck: false,
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => f === file || fileExists.call(host, f);
  host.readFile = (f) => (f === file ? CONSUMER : readFile.call(host, f));
  host.getSourceFile = (f, lang, onError, shouldCreate) =>
    f === file ? ts.createSourceFile(f, CONSUMER, lang, true) : getSourceFile.call(host, f, lang, onError, shouldCreate);
  const program = ts.createProgram([file], options, host);
  return ts.getPreEmitDiagnostics(program);
}

const formatHost = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n" };
for (const name of ["check-dts-consumer.mts", "check-dts-consumer.cts"]) {
  const diagnostics = compileConsumer(name);
  if (diagnostics.length > 0) {
    failed = true;
    console.error(`check-dts: cross-entry consumer ${name} does not compile against dist/:`);
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  } else {
    console.log(`check-dts: cross-entry consumer ${name} compiles against dist/`);
  }
}
if (failed) process.exit(1);

