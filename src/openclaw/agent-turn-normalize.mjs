// Normalização da resposta do comando especializado `openclaw agent --json`
// (Fase 3A.2, P3A2-T0b). NUNCA repassa o objeto bruto do Gateway.
//
// Fonte autoritativa (R1, confirmada estaticamente na 2026.9.3 para o comando
// especializado `openclaw agent`): a resposta final do próprio `agent` traz
//   { status, result: { payloads: [{ text?, ... }] }, summary? }
// correlacionada ao mesmo request. Lemos SOMENTE `status` e `result.payloads[].text`.
//
// Estados alcançáveis nesta versão:
//   - "completed": estado terminal oficial de sucesso reconhecido;
//   - "failed": estado terminal oficial de falha reconhecido (SEM conteúdo);
//   - "unknown": qualquer outra coisa (status desconhecido, malformado, etc.).
// "cancelled"/"timeout" NÃO são alegados aqui (gate de abort Windows aberto);
// timeout/cancelamento local do processo resulta em "unknown" (no serviço).

import { AGENT_TURN_RESPONSE_MAX_BYTES } from "../lib/limits.mjs";

// Allowlist FECHADA de status terminais oficiais reconhecidos.
//
// Evidência estática (OpenClaw 2026.9.3): o `status` de topo da resposta do
// comando `openclaw agent` pertence a { "ok", "error", "timeout", "in_flight" }
// (ver `dist/agent-run-terminal-outcome-CgoAW2Q7.mjs` e o mapeamento em
// `dist/agent-via-gateway-*.mjs`, que trata `ok`/`completed` como sucesso,
// `timeout` como timeout e o resto como erro). Os rótulos `failed`,
// `partial_failed`, `cancelled`, `aborted` são valores de `reason` da
// classificação INTERNA (AGENT_RUN_TERMINAL_CLASSIFICATION), NÃO o `status` de
// topo; `success` não tem evidência. Por isso:
//   - Sucesso reconhecido: "ok" (e "completed", equivalência oficial da CLI).
//   - Falha reconhecida: "error".
//   - "timeout": NÃO alegado nesta versão (gate de abort/timeout aberto) → unknown.
//   - "in_flight" e qualquer outro status → unknown.
const SUCCESS_STATUSES = new Set(["ok", "completed"]);
const FAILURE_STATUSES = new Set(["error"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Trunca uma string em um boundary UTF-8 seguro para caber em `maxBytes`.
 * Retorna { text, truncated }.
 */
export function truncateUtf8(text, maxBytes = AGENT_TURN_RESPONSE_MAX_BYTES) {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  // Corta em maxBytes e recua até um boundary de caractere válido.
  let end = maxBytes;
  // Bytes de continuação UTF-8 têm a forma 10xxxxxx (0x80-0xBF). Recua enquanto
  // o próximo byte seria uma continuação (evita cortar no meio de um caractere).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  let sliced = buf.subarray(0, end).toString("utf8");
  // Remove um eventual U+FFFD final resultante de corte imperfeito.
  if (sliced.endsWith("\uFFFD")) sliced = sliced.slice(0, -1);
  return { text: sliced, truncated: true };
}

/**
 * Extrai e concatena determinísticamente os textos dos payloads de um `result`
 * de sucesso, validando a ESTRUTURA de forma fechada.
 * - `result` deve ser objeto; `result.payloads` deve ser array;
 * - cada item deve ser objeto; `text`, quando presente, deve ser string;
 * - um item com `text` de tipo errado é ESTRUTURALMENTE inválido;
 * - array válido e vazio → texto "" (sucesso com resposta vazia);
 * - usa somente `text`; ignora mídia e campos desconhecidos;
 * - preserva a ordem; junta textos não vazios com "\n\n".
 *
 * @returns {{ ok: true, text: string } | { ok: false }} `ok:false` quando o
 *   shape é inválido (→ o chamador mapeia para unknown, nunca completed vazio).
 */
function extractText(result) {
  if (!isPlainObject(result)) return { ok: false };
  const payloads = result.payloads;
  if (!Array.isArray(payloads)) return { ok: false };
  const parts = [];
  for (const item of payloads) {
    if (!isPlainObject(item)) return { ok: false }; // payload não-objeto → inválido
    if ("text" in item) {
      if (typeof item.text !== "string") return { ok: false }; // text tipo errado → inválido
      if (item.text.length > 0) parts.push(item.text);
    }
    // mídia (mediaUrls/mediaUrl) e campos desconhecidos são ignorados: não
    // buscamos URLs, não carregamos attachments, não renderizamos objetos.
  }
  return { ok: true, text: parts.join("\n\n") };
}

/**
 * Normaliza um objeto de resposta JÁ PARSEADO do stdout da CLI especializada.
 * Retorna o output MCP fechado. Nunca inclui runId/sessionKey/agentId/model/
 * provider/prompt/summary/stopReason/errors/media/paths/stdout bruto.
 *
 * @param {unknown} parsed objeto JSON parseado do stdout
 * @returns {{ status: string, response?: string, truncated?: boolean, source: "gateway" }}
 */
export function normalizeAgentTurnResponse(parsed) {
  if (!isPlainObject(parsed)) {
    return { status: "unknown", source: "gateway" };
  }
  const status = parsed.status;
  if (typeof status !== "string") {
    return { status: "unknown", source: "gateway" };
  }

  if (SUCCESS_STATUSES.has(status)) {
    const extracted = extractText(parsed.result);
    // Shape de sucesso inválido (result/payloads ausente, tipo errado, payload
    // estruturalmente inválido) → unknown, NUNCA completed vazio.
    if (!extracted.ok) return { status: "unknown", source: "gateway" };
    const { text, truncated } = truncateUtf8(extracted.text);
    const out = { status: "completed", response: text, source: "gateway" };
    if (truncated) out.truncated = true;
    return out;
  }

  if (FAILURE_STATUSES.has(status)) {
    // failed NUNCA carrega conteúdo do modelo/erro.
    return { status: "failed", source: "gateway" };
  }

  // Qualquer status não reconhecido → unknown (nunca assumido terminal).
  return { status: "unknown", source: "gateway" };
}

/**
 * Parseia o stdout da CLI e normaliza. stdout malformado → unknown (pós-dispatch
 * a incerteza é preservada; nunca internal/gateway_required aqui).
 *
 * @param {string} stdout
 */
export function parseAndNormalize(stdout) {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (text.length === 0) return { status: "unknown", source: "gateway" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unknown", source: "gateway" };
  }
  return normalizeAgentTurnResponse(parsed);
}
