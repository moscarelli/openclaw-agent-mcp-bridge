// Cursores de paginação opacos com HMAC (PHASE1_PLAN §4.2, decisão aprovada).
//
// - Chave HMAC ALEATÓRIA gerada APENAS EM MEMÓRIA a cada início do processo.
//   Cursores emitidos antes de um reinício não validam mais → invalid_argument.
// - O cursor encapsula { v (versão do formato), offset, scope (filtros) }.
// - Ao consumir, valida assinatura, versão, e que o escopo embutido COINCIDE
//   com os filtros da chamada atual (impede reutilização em outro escopo).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";

const CURSOR_VERSION = 1;

// Chave apenas em memória; nova a cada processo.
const HMAC_KEY = randomBytes(32);

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}

function b64urlDecodeToString(str) {
  return Buffer.from(str, "base64url").toString("utf8");
}

function sign(payloadB64) {
  return createHmac("sha256", HMAC_KEY).update(payloadB64).digest();
}

/**
 * Helper keyed-HMAC estreito para reutilizar a MESMA chave efêmera do processo
 * (sem criar uma segunda chave) com SEPARAÇÃO DE DOMÍNIO. Usado pela Fase 2
 * (history-cursor) para computar um fingerprint não reversível. A chave nunca
 * sai deste módulo: só o digest é retornado.
 *
 * A separação de domínio é responsabilidade do chamador (incluir um `domain`
 * fixo dentro de `message`). Não altera o comportamento do cursor da Fase 1.
 *
 * @param {string|Buffer} message conteúdo canônico a assinar
 * @returns {Buffer} digest HMAC-SHA256
 */
export function keyedHmacWithEphemeralKey(message) {
  return createHmac("sha256", HMAC_KEY).update(message).digest();
}

/**
 * Normaliza o escopo (filtros) para uma forma canônica estável, de modo que a
 * comparação independa da ordem/ausência de chaves.
 */
export function canonicalScope(scope = {}) {
  return {
    agentId: scope.agentId ?? null,
    allAgents: Boolean(scope.allAgents),
    activeMinutes: scope.activeMinutes ?? null,
    limit: scope.limit ?? null,
  };
}

function scopeEquals(a, b) {
  const ca = canonicalScope(a);
  const cb = canonicalScope(b);
  return (
    ca.agentId === cb.agentId &&
    ca.allAgents === cb.allAgents &&
    ca.activeMinutes === cb.activeMinutes &&
    ca.limit === cb.limit
  );
}

/**
 * Cria um cursor opaco para o próximo offset dentro de um escopo.
 */
export function encodeCursor(offset, scope) {
  const payload = {
    v: CURSOR_VERSION,
    offset: Number.isInteger(offset) ? offset : 0,
    scope: canonicalScope(scope),
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(sign(payloadB64));
  return `${payloadB64}.${sig}`;
}

/**
 * Decodifica e valida um cursor contra o escopo atual.
 * Lança ToolError(invalid_argument) para qualquer inconsistência:
 * formato inválido, assinatura inválida (incl. cursores de antes do reinício),
 * versão desconhecida, ou escopo divergente.
 *
 * @returns {number} offset validado
 */
export function decodeCursor(cursor, currentScope) {
  if (typeof cursor !== "string" || !cursor.includes(".")) {
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "Malformed cursor");
  }
  const [payloadB64, sigB64] = cursor.split(".", 2);
  if (!payloadB64 || !sigB64) {
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "Malformed cursor");
  }

  // Verificação de assinatura em tempo constante.
  const expected = sign(payloadB64);
  let provided;
  try {
    provided = Buffer.from(sigB64, "base64url");
  } catch {
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "Malformed cursor signature");
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    // Também cobre cursores emitidos antes de um reinício (chave diferente).
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "Invalid or expired cursor");
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch {
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "Malformed cursor payload");
  }

  if (payload.v !== CURSOR_VERSION) {
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "Unsupported cursor version");
  }
  if (!Number.isInteger(payload.offset) || payload.offset < 0) {
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "Invalid cursor offset");
  }
  if (!scopeEquals(payload.scope, currentScope)) {
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "Cursor scope does not match request");
  }

  return payload.offset;
}
