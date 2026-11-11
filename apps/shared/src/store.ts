/**
 * store.ts — the StorePort the test apps run on.
 *
 * Two modes, chosen by WISDOM_STORE:
 *
 *   memory   — the library's MemoryStore, persisted to a JSON file after every
 *              write so a chat session, an MCP call and the web inspector all
 *              see the same graph across restarts. Persistence is a Proxy over
 *              the store: every mutating method schedules a debounced
 *              `snapshot()` → file write, and `persist()` flushes it. Reads
 *              never touch the disk.
 *   postgres — the library's PostgresStore over a `pg.Pool`, with `setup()`
 *              applying the kg_* migrations (idempotent) on start. Point it at
 *              `docker compose up postgres`.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore, type ClockPort, type LoggerPort, type StorePort } from "@mosphere/wisdom-graph";
import { createPostgresStore, setup } from "@mosphere/wisdom-graph/postgres";
import type { HarnessConfig } from "./config";

export interface HarnessStore {
  store: StorePort;
  /** Human-readable description for banners: "memory (.wisdom/store.json)" */
  describe: string;
  /** Flush any pending write (memory mode). */
  persist(): Promise<void>;
  close(): Promise<void>;
}

/** Every StorePort method that changes state. Reads are not listed. */
const MUTATING = new Set<keyof StorePort>([
  "applyBatch", "deleteHint", "deleteSubject", "claimEvent", "leaseEvents", "updateEvent", "scrubEvents", "purge",
]);

function createMemoryStore(cfg: HarnessConfig, logger: LoggerPort, clock?: ClockPort): HarnessStore {
  const inner = new MemoryStore(clock ? { clock } : {});
  if (existsSync(cfg.storeFile)) {
    inner.load(JSON.parse(readFileSync(cfg.storeFile, "utf8")));
    logger.info({ file: cfg.storeFile }, "store.loaded");
  }
  let timer: NodeJS.Timeout | null = null;
  let dirty = false;
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    mkdirSync(dirname(cfg.storeFile), { recursive: true });
    const tmp = `${cfg.storeFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(inner.snapshot(), null, 2));
    renameSync(tmp, cfg.storeFile);
  };
  const schedule = (): void => {
    dirty = true;
    if (!timer) timer = setTimeout(flush, 50);
  };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || !MUTATING.has(prop as keyof StorePort)) return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          schedule();
        }
      };
    },
  }) as unknown as StorePort;
  return {
    store,
    describe: `memory (${cfg.storeFile})`,
    persist: async () => flush(),
    close: async () => flush(),
  };
}

async function createPgStore(cfg: HarnessConfig, logger: LoggerPort): Promise<HarnessStore> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: cfg.pgUrl });
  const result = await setup(pool, { pgvector: cfg.pgvector, logger });
  logger.info({ applied: result.applied, skipped: result.skipped }, "store.migrated");
  const store = createPostgresStore(pool, { pgvector: cfg.pgvector, statementTimeoutMs: 5_000 });
  return {
    store,
    describe: `postgres (${cfg.pgUrl.replace(/:\/\/[^@]*@/, "://***@")}${cfg.pgvector ? ", pgvector" : ""})`,
    persist: async () => {},
    close: async () => { await pool.end(); },
  };
}

export async function createStore(cfg: HarnessConfig, logger: LoggerPort, clock?: ClockPort): Promise<HarnessStore> {
  return cfg.store === "postgres" ? createPgStore(cfg, logger) : createMemoryStore(cfg, logger, clock);
}
