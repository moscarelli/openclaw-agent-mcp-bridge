// Normalização por ALLOWLIST DE CAMPOS (PHASE1_PLAN §7.1).
// As respostas são construídas campo a campo a partir do JSON de origem.
// NUNCA copiamos o objeto do OpenClaw e removemos campos depois: campos
// desconhecidos/sensíveis simplesmente não são lidos, então não vazam.

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asInteger(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function asBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Constrói um item de agente lendo apenas { id, model }.
 */
export function buildAgent(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const id = asString(raw.id) ?? asString(raw.agentId) ?? asString(raw.name);
  if (id === undefined) return undefined;
  const agent = { id };
  const model = asString(raw.model);
  if (model !== undefined) agent.model = model;
  return agent;
}

/**
 * Extrai a lista bruta de agentes de formatos conhecidos da CLI.
 * `agents list --json` pode retornar um array direto ou { agents: [...] }.
 */
export function extractAgentsArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.agents)) return parsed.agents;
  return [];
}

/**
 * Constrói a resposta de agents_list: só campos allowlistados.
 * O limite é aplicado APÓS parsing/normalização (agents list não aceita --limit).
 */
export function buildAgentsList(parsed, limit) {
  const rawList = extractAgentsArray(parsed);
  const agents = [];
  for (const raw of rawList) {
    const agent = buildAgent(raw);
    if (agent) agents.push(agent);
    if (agents.length >= limit) break;
  }
  return { agents, count: agents.length };
}

/**
 * Constrói um item de sessão lendo apenas { agentId, key, model }.
 * path/stores[].path e qualquer outro campo nunca são lidos.
 */
export function buildSession(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const key = asString(raw.key) ?? asString(raw.sessionKey);
  if (key === undefined) return undefined;
  const session = { key };
  const agentId = asString(raw.agentId);
  if (agentId !== undefined) session.agentId = agentId;
  const model = asString(raw.model);
  if (model !== undefined) session.model = model;
  return session;
}

/**
 * Extrai a lista bruta de sessões (RPC e CLI usam a chave `sessions`).
 */
export function extractSessionsArray(parsed) {
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.sessions)) return parsed.sessions;
  if (Array.isArray(parsed)) return parsed;
  return [];
}

/**
 * Constrói a resposta de sessions_list a partir de uma página do RPC/CLI.
 * Lê apenas metadados de paginação conhecidos.
 *
 * @returns objeto com { sessions, count, totalCount?, hasMore, limitApplied?, nextOffset? }
 */
export function buildSessionsPage(parsed, { limit } = {}) {
  const rawList = extractSessionsArray(parsed);
  const sessions = [];
  for (const raw of rawList) {
    const session = buildSession(raw);
    if (session) sessions.push(session);
    if (limit !== undefined && sessions.length >= limit) break;
  }
  const page = { sessions, count: sessions.length };

  const totalCount = asInteger(parsed?.totalCount);
  if (totalCount !== undefined) page.totalCount = totalCount;

  const limitApplied = asInteger(parsed?.limitApplied);
  if (limitApplied !== undefined) page.limitApplied = limitApplied;

  const hasMore = asBoolean(parsed?.hasMore);
  page.hasMore = hasMore ?? false;

  const nextOffset = asInteger(parsed?.nextOffset);
  if (nextOffset !== undefined) page.nextOffset = nextOffset;

  return page;
}
