// Logger em stderr, redigido (PHASE1_PLAN §7.2).
// stdout é reservado para o transporte MCP (JSON-RPC); todo log vai para stderr.
// Nível controlável por OPENCLAW_MCP_BRIDGE_LOG_LEVEL (error|warn|info|debug|silent).

import { redactValue } from "./redact.mjs";

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function currentLevel() {
  const raw = (process.env.OPENCLAW_MCP_BRIDGE_LOG_LEVEL ?? "warn").toLowerCase();
  return LEVELS[raw] ?? LEVELS.warn;
}

function emit(level, message, details) {
  if (LEVELS[level] > currentLevel()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    message: typeof message === "string" ? message : String(message),
  };
  if (details !== undefined) {
    record.details = redactValue(details);
  }
  const safe = redactValue(record);
  process.stderr.write(`${JSON.stringify(safe)}\n`);
}

export const logger = {
  error: (message, details) => emit("error", message, details),
  warn: (message, details) => emit("warn", message, details),
  info: (message, details) => emit("info", message, details),
  debug: (message, details) => emit("debug", message, details),
};
