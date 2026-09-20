// Fonte de dados de openclaw_sessions_list e openclaw_session_get
// (PHASE1_PLAN §4.2, §4.3).
//
// sessions_list: RPC do Gateway preferencial (pagina por offset, retorna
//   nextOffset → traduzido para nextCursor opaco); fallback CLI limitado, SEM
//   paginação (nextCursor omitido, source "cli").
// session_get: EXCLUSIVAMENTE via Gateway. Varredura por offset até achar a
//   chave, esgotar o conjunto, ou atingir SESSION_SCAN_MAX. Sem Gateway →
//   gateway_required. Nunca conclui not_found por listagem CLI limitada.

import { runOpenclaw } from "./runner.mjs";
import { resolveOpenclawEntry } from "./locator.mjs";
import { gatewayCall } from "./gateway-rpc.mjs";
import { buildSessionsPage } from "./normalize.mjs";
import { encodeCursor, decodeCursor } from "./cursor.mjs";
import { deriveAgentIdFromKey } from "../lib/validate.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import { SESSION_PAGE_SIZE, SESSION_SCAN_MAX, CLI_SESSIONS_TIMEOUT_MS } from "../lib/limits.mjs";

// Monta os params do RPC sessions.list a partir dos filtros do bridge.
function rpcParams({ agentId, allAgents, activeMinutes, limit, offset }) {
  const params = {};
  if (allAgents) params.allAgents = true;
  else if (agentId !== undefined) params.agentId = agentId;
  // Control UI usa configuredAgentsOnly por padrão para não trazer stores órfãos.
  params.configuredAgentsOnly = true;
  if (activeMinutes !== undefined) params.activeMinutes = activeMinutes;
  if (limit !== undefined) params.limit = limit;
  if (offset !== undefined) params.offset = offset;
  return params;
}

// Monta os args da CLI `sessions --json` (fallback, sem offset/cursor).
// A CLI exige um seletor explícito quando há múltiplos agentes configurados:
// sem --agent nem --all-agents ela recusa a execução. Portanto, quando nenhum
// agentId é informado, usamos --all-agents como default agregado limitado
// (coerente com o modo agregado do RPC).
function cliArgs({ agentId, allAgents, activeMinutes, limit }) {
  const args = ["sessions", "--json"];
  if (agentId !== undefined) {
    args.push("--agent", agentId);
  } else {
    // allAgents explícito OU default sem seletor → agrega todos os agentes.
    args.push("--all-agents");
  }
  if (activeMinutes !== undefined) args.push("--active", String(activeMinutes));
  if (limit !== undefined) args.push("--limit", String(limit));
  return args;
}

async function cliSessions(filters, { signal } = {}) {
  const entry = resolveOpenclawEntry();
  const result = await runOpenclaw(entry, cliArgs(filters), {
    signal,
    timeoutMs: CLI_SESSIONS_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new ToolError(ERROR_CATEGORIES.CLI_UNAVAILABLE, "sessions returned a non-zero exit");
  }
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "sessions returned invalid JSON");
  }
}

/**
 * openclaw_sessions_list. Tenta Gateway; em indisponibilidade, cai para CLI.
 */
export async function listSessions(filters, { signal } = {}) {
  const { agentId, allAgents, activeMinutes, limit, cursor } = filters;

  // O escopo que valida o cursor são os filtros da consulta (sem o próprio cursor).
  const scope = { agentId, allAgents, activeMinutes, limit };

  // Offset atual: 0, ou o embutido no cursor (validado contra o escopo atual).
  const offset = cursor !== undefined ? decodeCursor(cursor, scope) : 0;

  // Caminho preferencial: RPC do Gateway (paginação por offset).
  try {
    const parsed = await gatewayCall("sessions.list", rpcParams({ ...scope, offset }), {
      signal,
      unavailableCategory: ERROR_CATEGORIES.GATEWAY_UNAVAILABLE,
    });
    const page = buildSessionsPage(parsed, { limit });
    const response = {
      sessions: page.sessions,
      count: page.count,
      hasMore: page.hasMore,
      source: "gateway",
    };
    if (page.totalCount !== undefined) response.totalCount = page.totalCount;
    if (page.limitApplied !== undefined) response.limitApplied = page.limitApplied;
    // nextOffset → nextCursor opaco, vinculado ao escopo.
    if (page.hasMore && page.nextOffset !== undefined) {
      response.nextCursor = encodeCursor(page.nextOffset, scope);
    }
    return response;
  } catch (err) {
    if (!(err instanceof ToolError) || err.category !== ERROR_CATEGORIES.GATEWAY_UNAVAILABLE) {
      throw err;
    }
    // Se o cliente pediu paginação (cursor) mas o Gateway caiu, não há como
    // honrar o offset via CLI de forma confiável.
    if (cursor !== undefined) {
      throw new ToolError(
        ERROR_CATEGORIES.GATEWAY_UNAVAILABLE,
        "Pagination requires the Gateway, which is unavailable",
      );
    }
  }

  // Fallback: CLI limitada, sem paginação (nextCursor omitido).
  const parsed = await cliSessions({ agentId, allAgents, activeMinutes, limit }, { signal });
  const page = buildSessionsPage(parsed, { limit });
  const response = {
    sessions: page.sessions,
    count: page.count,
    hasMore: page.hasMore,
    source: "cli",
  };
  if (page.totalCount !== undefined) response.totalCount = page.totalCount;
  if (page.limitApplied !== undefined) response.limitApplied = page.limitApplied;
  return response;
}

/**
 * openclaw_session_get. Exige Gateway. Varre por offset até encontrar a chave.
 */
export async function getSession({ sessionKey, agentId }, { signal } = {}) {
  // Escopo prévio: agentId explícito ou derivado da chave prefixada.
  const scopedAgentId = agentId ?? deriveAgentIdFromKey(sessionKey);
  const useAllAgents = scopedAgentId === undefined;

  let offset = 0;
  let scanned = 0;

  // Loop de varredura por offset.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let parsed;
    try {
      parsed = await gatewayCall(
        "sessions.list",
        rpcParams({
          agentId: scopedAgentId,
          allAgents: useAllAgents,
          limit: SESSION_PAGE_SIZE,
          offset,
        }),
        { signal, unavailableCategory: ERROR_CATEGORIES.GATEWAY_REQUIRED },
      );
    } catch (err) {
      // Sem Gateway → gateway_required (nunca cai para CLI, nunca not_found).
      throw err;
    }

    const page = buildSessionsPage(parsed);
    for (const session of page.sessions) {
      if (session.key === sessionKey) {
        const out = { key: session.key, source: "gateway" };
        if (session.agentId !== undefined) out.agentId = session.agentId;
        else if (scopedAgentId !== undefined) out.agentId = scopedAgentId;
        if (session.model !== undefined) out.model = session.model;
        return out;
      }
    }

    scanned += page.sessions.length;

    // Fim do conjunto: not_found conclusivo.
    const nextOffset = page.nextOffset;
    const more = page.hasMore && nextOffset !== undefined && page.sessions.length > 0;
    if (!more) {
      throw new ToolError(ERROR_CATEGORIES.NOT_FOUND, "Session not found");
    }

    // Teto de varredura: resposta inconclusiva (não é falso negativo).
    if (scanned >= SESSION_SCAN_MAX) {
      throw new ToolError(ERROR_CATEGORIES.SCAN_INCOMPLETE, "Scan limit reached before conclusion");
    }

    offset = nextOffset;
  }
}
