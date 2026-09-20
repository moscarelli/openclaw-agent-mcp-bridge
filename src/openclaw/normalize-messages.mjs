// Normalização metadata-only por ALLOWLIST DE CAMPOS (PHASE2_PLAN §7.1, §8).
//
// Objetos de saída são CONSTRUÍDOS campo a campo. NUNCA fazemos spread, clone,
// passthrough ou "clonar e remover". Campos desconhecidos/sensíveis simplesmente
// não são lidos, então não vazam.
//
// Metadados permitidos por mensagem NESTA versão inicial: { role, timestamp? }.
//
// DECISÃO sobre `messageId` (PHASE2_PLAN §5.4, opção A — omitir): não existe,
// na OpenClaw 2026.9.3, uma fonte de id de mensagem estável, opaca e confirmada
// como segura. `idempotencyKey` NÃO pode servir de `messageId`. Como copiar uma
// string arbitrária recebida do Gateway é proibido, `messageId` é **omitido**
// por completo nesta versão. Uma futura promoção exige fonte confirmada +
// allowlist de formato + limite rígido, em plano/branch/PR separados.
//
// PROIBIDO ler/retornar/registrar/decidir com base em: content, contentPreview,
// contentLength, omitted, provenance, senderSession, senderLabel, idempotencyKey,
// messageId, __openclaw, attachments, URLs, paths, tool payloads/results,
// mensagens brutas, ou qualquer objeto desconhecido. O campo `content` NUNCA é
// lido — nem para calcular tamanho, classificar, inferir ou fazer fallback.

// Faixa epoch (ms) aceitável para timestamps: de 0 até ~ano 2100. Fora disso,
// não-inteiro-seguro, ou negativo → omitido (nunca adivinhado).
const TIMESTAMP_MIN_MS = 0;
const TIMESTAMP_MAX_MS = 4102444800000; // 2100-01-01T00:00:00Z

// Conjunto fechado de roles reconhecidas (PHASE2_PLAN §8).
const KNOWN_ROLES = new Set(["user", "assistant", "system", "tool"]);

// Allowlist fechada de unavailableReason (PHASE2_PLAN §16). O detalhe original
// do Gateway é DESCARTADO, nunca retornado/registrado.
const UNAVAILABLE_REASONS = new Set([
  "not_found",
  "content_unavailable",
  "content_expired",
  "unsupported",
  "unknown",
]);

/**
 * Mapeia uma role bruta para o conjunto permitido. Role desconhecida (ou
 * ausente/não-string) → "unknown". O valor bruto nunca é retornado verbatim.
 */
export function mapRole(rawRole) {
  if (typeof rawRole === "string" && KNOWN_ROLES.has(rawRole)) return rawRole;
  return "unknown";
}

/**
 * Mapeia um unavailableReason bruto para a allowlist fechada. Qualquer valor
 * fora da allowlist (ou ausente) → "unknown". Detalhe original descartado.
 */
export function mapUnavailableReason(rawReason) {
  if (typeof rawReason === "string" && UNAVAILABLE_REASONS.has(rawReason)) return rawReason;
  return "unknown";
}

// Lê `timestamp` SOMENTE se for um inteiro SEGURO, não negativo e dentro de uma
// faixa epoch (ms) aceitável. Ausente/malformado/fora de faixa → omitido
// (nunca adivinhado). Lê o valor uma única vez (defende contra getters hostis).
function readTimestamp(raw) {
  const value = raw.timestamp;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= TIMESTAMP_MIN_MS &&
    value <= TIMESTAMP_MAX_MS
  ) {
    return value;
  }
  return undefined;
}

/**
 * Constrói um item de mensagem metadata-only a partir de uma entrada bruta,
 * lendo APENAS os campos allowlistados. `content` e `messageId` nunca são
 * lidos/retornados nesta versão (ver decisão no cabeçalho).
 *
 * @returns {{ role: string, timestamp?: number }}
 */
export function buildMessage(raw) {
  // Uma entrada não-objeto vira uma entrada sem metadados extras (role unknown).
  if (!raw || typeof raw !== "object") {
    return { role: "unknown" };
  }
  const message = { role: mapRole(raw.role) };
  const timestamp = readTimestamp(raw);
  if (timestamp !== undefined) message.timestamp = timestamp;
  return message;
}

/**
 * Extrai a lista bruta de mensagens de uma resposta de chat.history.
 * A chave conhecida é `messages`.
 */
export function extractMessagesArray(parsed) {
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
    return parsed.messages;
  }
  return [];
}

// Lê inteiro >= 0 (ou undefined).
function asNonNegInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Constrói a página de histórico metadata-only a partir da resposta bruta do
 * chat.history. Lê apenas: messages[] (allowlist por item) e os metadados de
 * paginação conhecidos (hasMore, nextOffset, totalMessages).
 *
 * NÃO retém nenhuma referência à resposta bruta. NÃO lê `content`.
 *
 * @returns {{ messages: Array, count: number, hasMore: boolean,
 *   nextOffset?: number, totalMessages?: number }}
 */
export function buildMessagesPage(parsed) {
  const rawList = extractMessagesArray(parsed);
  const messages = [];
  for (const raw of rawList) {
    messages.push(buildMessage(raw));
  }
  const page = { messages, count: messages.length };

  const hasMore = asBoolean(parsed?.hasMore);
  page.hasMore = hasMore ?? false;

  const nextOffset = asNonNegInteger(parsed?.nextOffset);
  if (nextOffset !== undefined) page.nextOffset = nextOffset;

  const totalMessages = asNonNegInteger(parsed?.totalMessages);
  if (totalMessages !== undefined) page.totalMessages = totalMessages;

  return page;
}
