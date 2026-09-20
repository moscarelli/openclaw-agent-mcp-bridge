// Serviço de histórico da Fase 2 (PHASE2_PLAN §5.1, §7.1, §12–§17).
//
// Gateway-only: usa EXCLUSIVAMENTE o RPC `chat.history`. Sem fallback de CLI,
// sem SQLite/JSONL/arquivos, sem enumeração, sem allAgents. Metadata-only: a
// resposta bruta pode conter `content`, mas a normalização por allowlist nunca
// o copia; a referência bruta é descartada imediatamente após normalizar (sem
// cache). Paginação por offset traduzida em cursor opaco dedicado (§13).
//
// Side-effect: a análise estática de 2026.9.3 não encontrou escrita observável
// no caminho de leitura do chat.history (docs/PHASE2_SIDE_EFFECT_DECISION.md).
// Documentamos como "no observable write confirmed by static analysis on
// OpenClaw 2026.9.3", NÃO como "absolutely side-effect-free".

import { gatewayCall } from "./gateway-rpc.mjs";
import { buildMessagesPage } from "./normalize-messages.mjs";
import { encodeHistoryCursor, decodeHistoryCursor } from "./history-cursor.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import {
  MESSAGES_LIMIT_MAX,
  MESSAGES_MAXCHARS_REQUEST,
  MESSAGES_MAXBYTES_REQUEST,
  CHAT_HISTORY_TIMEOUT_MS,
  RESULT_MAX_BYTES,
} from "../lib/limits.mjs";

/**
 * Monta os params do RPC chat.history. Nunca inclui allAgents. Envia maxChars
 * pequeno (apenas redução de exposição transitória) e um maxBytes-alvo; ambos
 * são limites de tamanho, não garantia de supressão de conteúdo (§5.3).
 */
function rpcParams({ sessionKey, agentId, limit, offset }) {
  const params = {
    sessionKey,
    limit,
    offset,
    maxChars: MESSAGES_MAXCHARS_REQUEST,
    maxBytes: MESSAGES_MAXBYTES_REQUEST,
  };
  // agentId é roteamento/validação, NÃO autorização (§9). Só é enviado quando
  // explicitamente informado pelo chamador.
  if (agentId !== undefined) params.agentId = agentId;
  return params;
}

/**
 * Pré-checagem de EXISTÊNCIA/ROTEAMENTO via `sessions.resolve` (PHASE2_PLAN §9,
 * §16). NÃO é autorização e NÃO enumera.
 *
 * Forma POSITIVA confirmada no OpenClaw 2026.9.3 (evidência no código instalado
 * e em docs/PHASE2_PLAN.md §16.1). Enviamos `allowMissing: true`, então o
 * handler responde, com o Gateway funcionando (exit 0, JSON):
 *   - encontrada:  { ok: true, key, agentId }        → discriminador: ok === true
 *   - ausente:     { ok: false }                      (sem `candidates`)
 *   - ambígua:     { ok: false, candidates: [...] }   (não lemos/expomos candidatos)
 * Sem `allowMissing`, uma sessão ausente viraria um erro RPC (exit não-zero),
 * indistinguível de Gateway indisponível — por isso `allowMissing: true` é
 * obrigatório aqui.
 *
 * Validação FECHADA: só `{ ok: true }` (booleano) conta como existência; só
 * `{ ok: false }` (booleano) conta como ausência/ambiguidade → not_found;
 * QUALQUER outra forma (não-objeto, array, null, `{}`, `ok` de tipo errado, ou
 * ausência de `ok`) é um shape que o handler oficial NUNCA produz → tratamos
 * como resposta malformada (`internal`), nunca como sessão encontrada. Nunca
 * copiamos campos desconhecidos nem lemos key/agentId/path/candidates.
 *
 * Um Gateway indisponível/timeout produz exit não-zero → gatewayCall lança
 * `gateway_required`. Nada de bruto (stderr/sessionKey) é exposto.
 *
 * @returns {true} se a sessão existe (nada além do booleano é lido)
 * @throws ToolError NOT_FOUND (ausente/ambígua) | GATEWAY_REQUIRED | INTERNAL
 */
export async function assertSessionExists({ sessionKey, agentId, signal }) {
  const params = { key: sessionKey, allowMissing: true };
  if (agentId !== undefined) params.agentId = agentId;

  let resolved;
  try {
    resolved = await gatewayCall("sessions.resolve", params, {
      signal,
      unavailableCategory: ERROR_CATEGORIES.GATEWAY_REQUIRED,
      timeoutMs: CHAT_HISTORY_TIMEOUT_MS,
      timeoutCeilingMs: CHAT_HISTORY_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof ToolError) throw err; // gateway_required / internal
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "Session resolve failed");
  }

  const classification = classifyResolveResponse(resolved);
  if (classification === "malformed") {
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "Malformed resolve response");
  }
  if (classification === "not_found") {
    // Ausente ou ambígua (Gateway funcionando): conclusivamente não é uma única
    // sessão acessível. `candidates` nunca é lido/exposto.
    throw new ToolError(ERROR_CATEGORIES.NOT_FOUND, "Session not found");
  }
  // "exists" → resolved.ok === true. Nada além do booleano é lido.
  return true;
}

/**
 * Classifica uma resposta de `sessions.resolve` de forma FECHADA, lendo APENAS
 * o discriminador booleano `ok`. Nunca lê/copia key/agentId/candidates/paths ou
 * qualquer outro campo (nem via getters, que não são acionados). Exportada para
 * testes.
 *
 * @param {unknown} resolved
 * @returns {"exists" | "not_found" | "malformed"}
 */
export function classifyResolveResponse(resolved) {
  const isPlainObject =
    resolved !== null && typeof resolved === "object" && !Array.isArray(resolved);
  if (!isPlainObject) return "malformed";
  // Lê SOMENTE `ok`. Se for um getter, ainda assim só esta propriedade é tocada.
  const ok = resolved.ok;
  if (ok === true) return "exists";
  if (ok === false) return "not_found";
  // Ausência de `ok` ou tipo errado → shape que o handler oficial nunca produz.
  return "malformed";
}

/**
 * listSessionMessages — leitura paginada, metadata-only, do histórico de uma
 * sessão via Gateway.
 *
 * @param {{ sessionKey: string, agentId?: string, limit: number, cursor?: string }} args
 *   (já validados por validate-messages.mjs)
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<object>} resposta metadata-only
 */
export async function listSessionMessages(args, { signal } = {}) {
  const { sessionKey, agentId, limit, cursor } = args;

  // Teto rígido defensivo sobre o limit (o validador já garante a faixa).
  const boundedLimit = Math.min(MESSAGES_LIMIT_MAX, typeof limit === "number" ? limit : MESSAGES_LIMIT_MAX);

  // Escopo que vincula o cursor: sessionKey + agentId + limit.
  const scope = { sessionKey, agentId: agentId ?? null, limit: boundedLimit };

  // Offset atual: 0, ou o embutido no cursor (validado contra o escopo atual).
  const offset = cursor !== undefined ? decodeHistoryCursor(cursor, scope) : 0;

  // Pré-checagem de existência (Gateway-only, sem enumeração): distingue
  // not_found (sessão conclusivamente ausente) de gateway_required (indisponível/
  // timeout). Lança NOT_FOUND/gateway_required/internal conforme o caso.
  await assertSessionExists({ sessionKey, agentId, signal });

  // Gateway obrigatório. Indisponível → gateway_required (nunca CLI, nunca
  // leitura direta). Timeout específico do chat.history (teto rígido; override
  // por ambiente só reduz). JSON inválido → internal.
  let parsed;
  try {
    parsed = await gatewayCall(
      "chat.history",
      rpcParams({ sessionKey, agentId, limit: boundedLimit, offset }),
      {
        signal,
        unavailableCategory: ERROR_CATEGORIES.GATEWAY_REQUIRED,
        timeoutMs: CHAT_HISTORY_TIMEOUT_MS,
        timeoutCeilingMs: CHAT_HISTORY_TIMEOUT_MS,
      },
    );
  } catch (err) {
    // ToolError já traz categoria estável e sanitizada; nunca repassa texto
    // bruto do Gateway. Qualquer outra coisa vira internal.
    if (err instanceof ToolError) throw err;
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "History read failed");
  }

  // Normaliza IMEDIATAMENTE por allowlist. A partir daqui, `parsed` (que pode
  // conter `content`) fica elegível para GC: nenhuma referência é retida, não
  // há cache, e nada bruto é retornado/registrado.
  const page = buildMessagesPage(parsed);
  parsed = undefined;

  // Reconciliação coerente de PAGINAÇÃO x TETO DE BYTES (PHASE2_PLAN §12).
  return buildBoundedMessagesResult({ page, offset, scope, maxBytes: RESULT_MAX_BYTES });
}

/**
 * Constrói a resposta metadata-only garantindo o teto de bytes SEM quebrar a
 * paginação. Uma página de 200 itens { role, timestamp? } (~48 bytes cada) cabe
 * folgadamente em 256 KiB, então o truncamento é um caminho DEFENSIVO. Se ele
 * ocorrer, o cursor é repontado para o PRIMEIRO item NÃO retornado
 * (offset + itens retornados), de modo que nenhuma mensagem seja pulada.
 *
 * Invariantes garantidas:
 *  - count === messages.length (sempre reflete a lista realmente retornada);
 *  - se truncado, hasMore === true e nextCursor aponta para offset+count;
 *  - nunca pula itens entre páginas.
 *
 * Exportado para testes (permite injetar um maxBytes pequeno para exercitar o
 * caminho de truncamento de forma determinística).
 *
 * @param {{ page: object, offset: number, scope: object, maxBytes: number }} p
 */
export function buildBoundedMessagesResult({ page, offset, scope, maxBytes }) {
  const totalMessages = page.totalMessages;
  const gatewayNextOffset = page.hasMore && page.nextOffset !== undefined ? page.nextOffset : undefined;

  const build = (msgs, more, nextOff, wasTruncated) => {
    const r = { messages: msgs, count: msgs.length, hasMore: more, source: "gateway" };
    if (totalMessages !== undefined) r.totalMessages = totalMessages;
    if (more && nextOff !== undefined) r.nextCursor = encodeHistoryCursor(nextOff, scope);
    if (wasTruncated) r.truncated = true;
    return r;
  };

  const size = (obj) => Buffer.byteLength(JSON.stringify(obj), "utf8");

  // Candidato sem truncamento.
  const full = build(page.messages, page.hasMore, gatewayNextOffset, false);
  if (size(full) <= maxBytes) return full;

  // Truncamento defensivo: corta trailing e reponta o cursor para offset+kept.
  let kept = page.messages.length;
  while (kept > 1) {
    const candidate = build(page.messages.slice(0, kept), true, offset + kept, true);
    if (size(candidate) <= maxBytes) break;
    kept = Math.max(1, Math.floor(kept / 2));
  }
  return build(page.messages.slice(0, kept), true, offset + kept, true);
}
