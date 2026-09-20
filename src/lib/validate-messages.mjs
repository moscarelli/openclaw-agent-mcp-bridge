// Validação de argumentos de openclaw_session_messages_list (PHASE2_PLAN §7.1).
// Complementa o schema Zod estrito com regras de negócio: sessionKey
// obrigatório e válido por allowlist, agentId opcional por allowlist, limit na
// faixa do plano. sessionKey/agentId servem para validação e ROTEAMENTO, nunca
// como prova de ownership (modelo B, §9). Nenhuma mensagem de erro ecoa valores
// recebidos.

import { assertSafeIdentifier } from "./identifier.mjs";
import { ToolError, ERROR_CATEGORIES } from "./errors.mjs";
import {
  MESSAGES_LIMIT_MIN,
  MESSAGES_LIMIT_MAX,
  MESSAGES_LIMIT_DEFAULT,
} from "./limits.mjs";

function invalid(message) {
  return new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, message);
}

function safeIdentifier(value, name) {
  try {
    return assertSafeIdentifier(value, name);
  } catch {
    // Mensagem genérica: nunca ecoa o valor recebido.
    throw invalid(`${name} is invalid`);
  }
}

/**
 * Valida e normaliza os argumentos de messages_list.
 * @returns {{ sessionKey: string, agentId?: string, limit: number, cursor?: string }}
 */
export function validateMessagesListArgs(args = {}) {
  if (typeof args.sessionKey !== "string" || args.sessionKey.length === 0) {
    throw invalid("sessionKey is required");
  }
  const sessionKey = safeIdentifier(args.sessionKey, "sessionKey");

  let agentId;
  if (args.agentId !== undefined) {
    if (typeof args.agentId !== "string" || args.agentId.length === 0) {
      throw invalid("agentId is invalid");
    }
    agentId = safeIdentifier(args.agentId, "agentId");
  }

  let limit = MESSAGES_LIMIT_DEFAULT;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit)) {
      throw invalid("limit must be an integer");
    }
    if (args.limit < MESSAGES_LIMIT_MIN || args.limit > MESSAGES_LIMIT_MAX) {
      throw invalid(`limit must be between ${MESSAGES_LIMIT_MIN} and ${MESSAGES_LIMIT_MAX}`);
    }
    limit = args.limit;
  }

  let cursor;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== "string" || args.cursor.length === 0) {
      throw invalid("cursor is invalid");
    }
    cursor = args.cursor;
  }

  const out = { sessionKey, limit };
  if (agentId !== undefined) out.agentId = agentId;
  if (cursor !== undefined) out.cursor = cursor;
  return out;
}
