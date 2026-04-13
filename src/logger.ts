import pino from "pino";

const DEFAULT_LEVEL = "info";

/** Levels supported by pino; unknown `LOG_LEVEL` falls back to default. */
const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

function resolveLevel(): string {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_LEVEL;
  }
  return LEVELS.has(raw) ? raw : DEFAULT_LEVEL;
}

/** Root logger: stderr only (stdout reserved for MCP stdio JSON-RPC). */
export const logger = pino(
  {
    level: resolveLevel(),
    base: null,
  },
  pino.destination({ fd: 2, sync: true }),
);
