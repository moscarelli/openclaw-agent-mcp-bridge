// Validação de argumentos das tools (PHASE1_PLAN §4).
// Complementa os schemas Zod com regras de negócio: mutualidade
// agentId/allAgents, faixas, e validação de identificadores por allowlist.

import { assertSafeIdentifier } from "./identifier.mjs";
import { ToolError, ERROR_CATEGORIES } from "./errors.mjs";
import {
  AGENTS_LIMIT_MIN,
  AGENTS_LIMIT_MAX,
  AGENTS_LIMIT_DEFAULT,
  SESSIONS_LIMIT_MIN,
  SESSIONS_LIMIT_MAX,
  SESSIONS_LIMIT_DEFAULT,
  ACTIVE_MINUTES_MIN,
  ACTIVE_MINUTES_MAX,
} from "./limits.mjs";

function invalid(message) {
  return new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, message);
}

function validateInteger(value, { min, max, fallback, name }) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(`${name} must be an integer`);
  }
  if (value < min || value > max) {
    throw invalid(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function safeIdentifier(value, name) {
  if (value === undefined) return undefined;
  try {
    return assertSafeIdentifier(value, name);
  } catch {
    throw invalid(`${name} is invalid`);
  }
}

export function validateAgentsListArgs(args = {}) {
  const limit = validateInteger(args.limit, {
    min: AGENTS_LIMIT_MIN,
    max: AGENTS_LIMIT_MAX,
    fallback: AGENTS_LIMIT_DEFAULT,
    name: "limit",
  });
  return { limit };
}

export function validateSessionsListArgs(args = {}) {
  const agentId = safeIdentifier(args.agentId, "agentId");
  const allAgents = args.allAgents === undefined ? false : Boolean(args.allAgents);
  if (agentId !== undefined && allAgents) {
    throw invalid("agentId and allAgents are mutually exclusive");
  }
  const activeMinutes = validateInteger(args.activeMinutes, {
    min: ACTIVE_MINUTES_MIN,
    max: ACTIVE_MINUTES_MAX,
    fallback: undefined,
    name: "activeMinutes",
  });
  const limit = validateInteger(args.limit, {
    min: SESSIONS_LIMIT_MIN,
    max: SESSIONS_LIMIT_MAX,
    fallback: SESSIONS_LIMIT_DEFAULT,
    name: "limit",
  });
  const cursor = args.cursor === undefined ? undefined : String(args.cursor);
  return { agentId, allAgents, activeMinutes, limit, cursor };
}

export function validateSessionGetArgs(args = {}) {
  if (typeof args.sessionKey !== "string" || args.sessionKey.length === 0) {
    throw invalid("sessionKey is required");
  }
  const sessionKey = safeIdentifier(args.sessionKey, "sessionKey");
  const agentId = safeIdentifier(args.agentId, "agentId");
  return { sessionKey, agentId };
}

/**
 * Deriva o agentId de uma chave prefixada "agent:<id>:...".
 * Retorna undefined quando a chave não é prefixada.
 */
export function deriveAgentIdFromKey(sessionKey) {
  if (typeof sessionKey !== "string") return undefined;
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent" && parts[1].length > 0) {
    return parts[1];
  }
  return undefined;
}
