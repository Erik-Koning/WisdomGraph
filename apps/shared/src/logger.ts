/**
 * logger.ts — a pino-shaped LoggerPort that writes to STDERR.
 *
 * Stderr, never stdout: the MCP server speaks JSON-RPC on stdout and the chat
 * REPL owns it for the conversation, so a stray log line on stdout would
 * corrupt one and clutter the other. One JSON-ish line per entry keeps the
 * library's structured fields (op, eventId, status, …) greppable.
 */
import type { LoggerPort } from "@mosphere/wisdom-graph";
import type { LogLevel } from "./config";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger(level: LogLevel): LoggerPort & { level: LogLevel } {
  const min = RANK[level];
  const write = (lvl: Exclude<LogLevel, "silent">, obj: object, msg?: string): void => {
    if (RANK[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg ?? ""} ${JSON.stringify(obj)}`;
    process.stderr.write(line + "\n");
  };
  return {
    level,
    debug: (obj, msg) => write("debug", obj, msg),
    info: (obj, msg) => write("info", obj, msg),
    warn: (obj, msg) => write("warn", obj, msg),
    error: (obj, msg) => write("error", obj, msg),
  };
}
