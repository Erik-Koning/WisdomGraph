/**
 * config.ts — one place for every knob the test apps share.
 *
 * Everything comes from environment variables with sane defaults, plus the
 * editable `wisdom.config.json` next to this package for the categories and
 * default identity. The apps never read env themselves: they call
 * `loadConfig()` so a new knob is added once and every app gets it.
 *
 *   WISDOM_SUBJECT      subjectId (the advisor / user the graph belongs to)   default: config file
 *   WISDOM_CLIENT       clientId sub-scope, empty for none                    default: config file
 *   WISDOM_TENANT       tenantId, empty for none                              default: none
 *   WISDOM_STORE        memory | postgres                                     default: memory
 *   WISDOM_STORE_FILE   where the memory store is persisted as JSON           default: <repo>/.wisdom/store.json
 *   WISDOM_PG_URL       postgres connection string (WISDOM_STORE=postgres)    default: postgres://wg:wg@localhost:55432/wg
 *   WISDOM_PG_PGVECTOR  1 to enable the pgvector migration                    default: off
 *   WISDOM_MODEL        Anthropic model id for chat and extraction            default: claude-opus-5
 *   WISDOM_EFFORT       low | medium | high (output_config.effort)            default: medium
 *   WISDOM_OFFLINE      1 → no API calls: echo chat + heuristic extractor     default: off (on automatically when no credentials)
 *   WISDOM_LOG          debug | info | warn | error | silent                  default: warn
 *   WISDOM_CONFIG       path to a wisdom.config.json                          default: apps/shared/wisdom.config.json
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CategorySpec, DeepPartial, PolicyConfig } from "@mosphere/wisdom-graph";

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/shared/src → repo root. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const DEFAULT_CONFIG_PATH = resolve(HERE, "..", "wisdom.config.json");

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type Effort = "low" | "medium" | "high";

export interface HarnessConfig {
  subjectId: string;
  clientId: string | null;
  tenantId: string | null;
  sharedSubjectId: string | null;
  store: "memory" | "postgres";
  storeFile: string;
  pgUrl: string;
  pgvector: boolean;
  model: string;
  effort: Effort;
  offline: boolean;
  logLevel: LogLevel;
  configPath: string;
  categories: CategorySpec[];
  policy: DeepPartial<PolicyConfig>;
}

interface ConfigFile {
  subjectId?: string;
  clientId?: string | null;
  sharedSubjectId?: string | null;
  categories: CategorySpec[];
  policy?: DeepPartial<PolicyConfig>;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function flag(name: string): boolean {
  const v = env(name);
  return v !== undefined && !["0", "false", "no", "off"].includes(v.toLowerCase());
}

/** True when the Anthropic SDK has something to authenticate with. */
export function hasAnthropicCredentials(): boolean {
  return env("ANTHROPIC_API_KEY") !== undefined || env("ANTHROPIC_AUTH_TOKEN") !== undefined || env("ANTHROPIC_PROFILE") !== undefined
    || existsSync(resolve(process.env["HOME"] ?? "", ".config", "anthropic"));
}

export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const configPath = overrides.configPath ?? env("WISDOM_CONFIG") ?? DEFAULT_CONFIG_PATH;
  const file = JSON.parse(readFileSync(configPath, "utf8")) as ConfigFile;
  if (!Array.isArray(file.categories) || file.categories.length === 0) {
    throw new Error(`${configPath}: "categories" must be a non-empty array`);
  }
  const offlineEnv = env("WISDOM_OFFLINE");
  const offline = offlineEnv !== undefined ? flag("WISDOM_OFFLINE") : !hasAnthropicCredentials();
  const effort = (env("WISDOM_EFFORT") ?? "medium") as Effort;
  const logLevel = (env("WISDOM_LOG") ?? "warn") as LogLevel;
  const store = (env("WISDOM_STORE") ?? "memory") as HarnessConfig["store"];
  if (store !== "memory" && store !== "postgres") throw new Error(`WISDOM_STORE must be memory or postgres, got ${store}`);
  const clientEnv = env("WISDOM_CLIENT");
  return {
    subjectId: env("WISDOM_SUBJECT") ?? file.subjectId ?? "erik",
    clientId: clientEnv !== undefined ? clientEnv : (file.clientId ?? null),
    tenantId: env("WISDOM_TENANT") ?? null,
    sharedSubjectId: file.sharedSubjectId ?? null,
    store,
    storeFile: resolve(REPO_ROOT, env("WISDOM_STORE_FILE") ?? ".wisdom/store.json"),
    pgUrl: env("WISDOM_PG_URL") ?? "postgres://wg:wg@localhost:55432/wg",
    pgvector: flag("WISDOM_PG_PGVECTOR"),
    model: env("WISDOM_MODEL") ?? "claude-opus-5",
    effort,
    offline,
    logLevel,
    configPath,
    categories: file.categories,
    policy: file.policy ?? {},
    ...overrides,
  };
}
