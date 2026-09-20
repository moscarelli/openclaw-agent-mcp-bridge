// Codec DEDICADO do cursor de histórico da Fase 2 (PHASE2_PLAN §13).
//
// Diferente do cursor da Fase 1 (que assina um payload com os filtros legíveis
// embutidos), este cursor NUNCA carrega sessionKey/agentId/filtros. O payload
// serializado contém EXCLUSIVAMENTE:
//
//   { version, offset, scopeFingerprint }
//
// - `scopeFingerprint` é um HMAC keyed NÃO reversível que cobre canonicamente
//   o ESCOPO **e o offset** + um domínio fixo. Decodificar o Base64URL não
//   revela sessionKey/agentId. Como o offset entra no HMAC, adulterar o offset
//   (mantendo o fingerprint) invalida o cursor.
// - A chave HMAC é a MESMA chave efêmera em memória do processo (reusada via o
//   helper estreito de cursor.mjs), com separação de domínio pelo `domain`.
// - A validação recomputa o fingerprint esperado a partir dos argumentos da
//   chamada atual (escopo) + o offset embutido e compara em tempo constante.
//   Divergência de version/offset/escopo/limit/agentId/sessionKey, ou uso após
//   reinício → invalid_argument.
// - Formatos da Fase 1 e Fase 2 NÃO são intercambiáveis (shape + version +
//   domínio distintos; sem downgrade silencioso).

import { timingSafeEqual } from "node:crypto";
import { keyedHmacWithEphemeralKey } from "./cursor.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";

// Versão do FORMATO do cursor de histórico da Fase 2 (distinta da Fase 1).
const HISTORY_CURSOR_VERSION = 1;

// Domínio fixo coberto pelo HMAC — separa este fingerprint de qualquer outro
// uso da mesma chave efêmera.
const SCOPE_DOMAIN = "openclaw-session-history-v1";

// Limites rígidos de tamanho ANTES de qualquer alocação/decodificação grande.
// Um cursor legítimo é pequeno: payload JSON com version (1-2 dígitos), offset
// (<= ~16 dígitos) e um fingerprint SHA-256 em Base64URL (43 chars). O envelope
// externo é esse JSON re-codificado em Base64URL. 512 é folgado e seguro.
const MAX_CURSOR_CHARS = 512;
// O fingerprint interno (SHA-256 → 32 bytes → 43 chars Base64URL sem padding).
const FINGERPRINT_B64_LEN = 43;
const OFFSET_MAX = Number.MAX_SAFE_INTEGER;

// Base64URL canônico, SEM padding: apenas [A-Za-z0-9_-], sem '=' e sem
// whitespace. Usado para validar tanto o envelope quanto o fingerprint.
const BASE64URL_NOPAD_RE = /^[A-Za-z0-9_-]+$/;

function invalid(message) {
  return new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, message);
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Valida que `str` é Base64URL canônico sem padding e decodifica de forma
 * canônica: re-codificar o buffer decodificado deve reproduzir EXATAMENTE a
 * string original. Isso rejeita padding inesperado, caracteres não canônicos e
 * variações não canônicas do mesmo valor. Lança invalid_argument caso contrário.
 *
 * @param {string} str
 * @param {number} maxLen limite rígido de comprimento (antes de alocar)
 * @returns {Buffer}
 */
function decodeCanonicalBase64Url(str, maxLen) {
  if (typeof str !== "string" || str.length === 0 || str.length > maxLen) {
    throw invalid("Malformed cursor");
  }
  if (!BASE64URL_NOPAD_RE.test(str)) {
    // Cobre whitespace, padding '=', '+'/'/' (base64 padrão) e qualquer outro
    // caractere fora do alfabeto Base64URL.
    throw invalid("Malformed cursor");
  }
  let buf;
  try {
    buf = Buffer.from(str, "base64url");
  } catch {
    throw invalid("Malformed cursor");
  }
  if (buf.length === 0) {
    throw invalid("Malformed cursor");
  }
  // Canonicidade: a re-codificação deve bater byte a byte com a entrada.
  if (b64urlEncode(buf) !== str) {
    throw invalid("Malformed cursor");
  }
  return buf;
}

/**
 * Codificação canônica/estável do escopo lógico + offset. Ordem de chaves fixa
 * e JSON.stringify de um objeto com forma constante garantem que o mesmo par
 * (escopo, offset) sempre produza a mesma entrada de HMAC dentro do processo.
 *
 * IMPORTANTE: `content` e qualquer campo de mensagem NUNCA participam daqui.
 */
function canonicalEncode({ sessionKey, agentId, limit, offset }) {
  // Objeto com ordem de chaves fixa (não derivada de entrada do usuário),
  // exatamente como especificado na revisão.
  const canonical = {
    domain: SCOPE_DOMAIN,
    formatVersion: HISTORY_CURSOR_VERSION,
    offset,
    sessionKey,
    agentId: agentId ?? null,
    limit,
  };
  return JSON.stringify(canonical);
}

/**
 * Computa o fingerprint keyed-HMAC (não reversível) que cobre escopo + offset.
 * @returns {Buffer}
 */
function computeFingerprint(scope, offset) {
  return keyedHmacWithEphemeralKey(
    canonicalEncode({
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      limit: scope.limit,
      offset,
    }),
  );
}

/**
 * Cria um cursor de histórico opaco para um offset dentro de um escopo.
 * O payload serializado contém somente { version, offset, scopeFingerprint }.
 * O fingerprint cobre o offset, então o offset não pode ser adulterado.
 *
 * @param {number} offset inteiro seguro >= 0
 * @param {{ sessionKey: string, agentId?: string|null, limit: number }} scope
 * @returns {string} cursor Base64URL
 */
export function encodeHistoryCursor(offset, scope) {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const fingerprint = b64urlEncode(computeFingerprint(scope, safeOffset));
  const payload = {
    version: HISTORY_CURSOR_VERSION,
    offset: safeOffset,
    scopeFingerprint: fingerprint,
  };
  return b64urlEncode(JSON.stringify(payload));
}

/**
 * Decodifica e valida um cursor de histórico contra o escopo da chamada atual.
 * Lança ToolError(invalid_argument) para qualquer inconsistência:
 * formato inválido, Base64URL não canônico, versão desconhecida (inclui
 * cursores da Fase 1), offset inválido, ou fingerprint divergente (version/
 * offset/escopo/limit/agentId/sessionKey diferentes, ou cursor emitido antes de
 * um reinício do processo).
 *
 * Nenhuma mensagem de erro ou log inclui sessionKey, agentId, filtros ou o
 * fingerprint.
 *
 * @param {string} cursor
 * @param {{ sessionKey: string, agentId?: string|null, limit: number }} scope
 * @returns {number} offset validado
 */
export function decodeHistoryCursor(cursor, scope) {
  // Limite rígido de comprimento ANTES de decodificar (evita grandes alocações).
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS) {
    throw invalid("Malformed cursor");
  }
  // Um cursor da Fase 1 tem a forma "<payload>.<sig>" (contém ponto), que não é
  // Base64URL canônico; a validação abaixo o rejeita, mas checamos explícito
  // para evitar qualquer downgrade silencioso.
  if (cursor.includes(".")) {
    throw invalid("Invalid or expired cursor");
  }

  // Envelope externo: Base64URL canônico e pequeno.
  const envelope = decodeCanonicalBase64Url(cursor, MAX_CURSOR_CHARS);

  let payload;
  try {
    payload = JSON.parse(envelope.toString("utf8"));
  } catch {
    throw invalid("Malformed cursor");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid("Malformed cursor");
  }

  // Shape estrito: exatamente as três chaves esperadas, nada além disso.
  const keys = Object.keys(payload);
  if (
    keys.length !== 3 ||
    !keys.includes("version") ||
    !keys.includes("offset") ||
    !keys.includes("scopeFingerprint")
  ) {
    throw invalid("Malformed cursor");
  }

  if (payload.version !== HISTORY_CURSOR_VERSION) {
    // Também cobre qualquer cursor de outro formato/fase.
    throw invalid("Unsupported cursor version");
  }
  if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > OFFSET_MAX) {
    throw invalid("Invalid cursor offset");
  }
  if (
    typeof payload.scopeFingerprint !== "string" ||
    payload.scopeFingerprint.length !== FINGERPRINT_B64_LEN
  ) {
    throw invalid("Malformed cursor");
  }

  // Fingerprint interno: Base64URL canônico e de comprimento exato.
  const provided = decodeCanonicalBase64Url(payload.scopeFingerprint, FINGERPRINT_B64_LEN);

  // Recomputa o fingerprint esperado a partir do escopo atual + o offset
  // embutido e compara em tempo constante. Como o offset entra no HMAC, um
  // offset adulterado produz divergência. Comprimentos validados antes.
  const expected = computeFingerprint(scope, payload.offset);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    // Cobre: version/offset/escopo/limit/agentId/sessionKey divergentes E
    // cursor de antes do reinício (chave efêmera diferente). Nada é revelado.
    throw invalid("Invalid or expired cursor");
  }

  return payload.offset;
}

// Exposto para testes (verificar a forma do payload sem revelar segredo).
export { HISTORY_CURSOR_VERSION };
