import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `__dirname` is undefined in an ESM config (package.json has "type": "module").
const here = fileURLToPath(new URL(".", import.meta.url));

const pkg = JSON.parse(readFileSync(`${here}package.json`, "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export default defineConfig({
  plugins: [
    dts({
      include: ["src"],
      exclude: ["src/**/*.test.*"],
      // One rolled-up `.d.ts` per entry. api-extractor inlines everything an
      // entry reaches, so a class the root and a subpath both expose (the
      // testing entry's `advisorFixture().store` is a `MemoryStore`) is declared
      // once per file. Copies of a class are only interchangeable when none
      // of them declares a private member, so the source marks private
      // members `@internal` and `stripInternal` drops them here;
      // `scripts/check-dts.mjs` compiles a cross-entry consumer to prove it.
      rollupTypes: true,
      compilerOptions: { stripInternal: true },
    }),
  ],
  build: {
    lib: {
      // Four entries so each subpath in package.json `exports` is a real
      // build artifact, not a source-tree convention (spec §1). The split is
      // what keeps the promises the subpaths make: a backend that imports
      // only "." never loads `node:async_hooks` (langgraph is the one entry
      // that needs it), and a consumer's test bundle can take `./testing`
      // without dragging the Postgres store along. Rollup hoists the shared
      // core into common chunks that the entries import by relative path, so
      // one copy of every core module ships regardless of how many subpaths
      // a consumer uses.
      entry: {
        "wisdom-graph": `${here}src/index.ts`,
        postgres: `${here}src/postgres/index.ts`,
        langgraph: `${here}src/langgraph/index.ts`,
        testing: `${here}src/testing/index.ts`,
      },
      formats: ["es", "cjs"],
    },
    rollupOptions: {
      // Nothing the host can install itself is bundled: Node built-ins and
      // every runtime or peer dependency stay external, so the consumer's
      // package manager supplies exactly one copy of each. Both lists are
      // empty by design (zero runtime dependencies, must-have 1) and read
      // from package.json so a dependency added later cannot be bundled by
      // accident.
      external: [
        ...builtinModules,
        /^node:/,
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ],
    },
    // A library, not an app: ship modern syntax and let the host downlevel.
    target: "es2022",
    sourcemap: true,
    emptyOutDir: true,
  },
});
