// Configuração local experimental da Fase 3A.2 (openclaw_agent_turn).
//
// A ferramenta mutante só é registrada quando TODAS estas condições valem:
//   - OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT === "1" (exato);
//   - OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID presente e válido;
//   - OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY presente e válido;
//   - NÃO há OPENCLAW_GATEWAY_URL definido no ambiente do bridge (ver abaixo).
// Além disso, um preflight de configuração LOCAL (read-only, sem credenciais)
// deve comprovar loopback ANTES do dispatch — ver `assertLocalLoopbackGateway`.
//
// Nada disto é retornado ao cliente, logado, nem incluído em erros.
//
// POR QUE NÃO USAR OPENCLAW_GATEWAY_URL (correção do bloqueio E2E):
// No OpenClaw 2026.9.3, um URL override (env OPENCLAW_GATEWAY_URL / --url) EXIGE
// credenciais explícitas — a config local NÃO é reutilizada nesse caminho
// (`dist/client-bootstrap-*.mjs` → `ensureExplicitGatewayAuth` lança
// "gateway url override requires explicit credentials"). Como o bridge NÃO
// aceita nem transporta credenciais, forçar loopback via OPENCLAW_GATEWAY_URL
// quebra a autenticação. Portanto: o bridge NUNCA define OPENCLAW_GATEWAY_URL
// para o filho; se o operador o tiver definido no ambiente do bridge, a
// capacidade mutante é DESABILITADA (não tentamos usá-lo). O Gateway local é
// selecionado pela configuração local do OpenClaw, e comprovamos loopback por
// uma leitura read-only e fail-closed da própria configuração.

import { assertSafeIdentifier } from "../lib/identifier.mjs";

const FLAG_ENV = "OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT";
const AGENT_ID_ENV = "OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID";
const SESSION_KEY_ENV = "OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY";
const GATEWAY_URL_ENV = "OPENCLAW_GATEWAY_URL";

/**
 * Detecta a presença (não vazia) de OPENCLAW_GATEWAY_URL no ambiente do bridge.
 * Se estiver presente, a capacidade mutante é desabilitada: não podemos usá-lo
 * (exigiria credenciais) e não o repassamos ao filho.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function hasGatewayUrlOverride(env = process.env) {
  const raw = env[GATEWAY_URL_ENV];
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * Validação SÍNCRONA da configuração de habilitação (sem I/O). Retorna:
 *   { enabled: false }                     — não registrar a ferramenta
 *   { enabled: true, agentId, sessionKey } — candidata (o loopback ainda será
 *                                            comprovado por preflight read-only)
 *
 * NÃO prova loopback aqui (isso exige uma leitura read-only da config local,
 * feita por `assertLocalLoopbackGateway`). Desabilita se OPENCLAW_GATEWAY_URL
 * estiver definido no ambiente do bridge.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveAgentTurnConfig(env = process.env) {
  // Flag deve ser exatamente "1".
  if (env[FLAG_ENV] !== "1") return { enabled: false };

  // Se OPENCLAW_GATEWAY_URL estiver definido no ambiente do bridge, desabilita:
  // não podemos usá-lo sem credenciais e não o repassamos ao filho.
  if (hasGatewayUrlOverride(env)) return { enabled: false };

  const rawAgentId = env[AGENT_ID_ENV];
  const rawSessionKey = env[SESSION_KEY_ENV];

  // Ambos devem estar simultaneamente presentes e não vazios.
  if (typeof rawAgentId !== "string" || rawAgentId.length === 0) return { enabled: false };
  if (typeof rawSessionKey !== "string" || rawSessionKey.length === 0) return { enabled: false };

  // Ambos devem ser identificadores seguros (mesma allowlist das demais tools).
  let agentId;
  let sessionKey;
  try {
    agentId = assertSafeIdentifier(rawAgentId, "agentId");
    sessionKey = assertSafeIdentifier(rawSessionKey, "sessionKey");
  } catch {
    return { enabled: false };
  }

  // O destino nunca faz fallback para main implicitamente. Se o operador
  // configurou "main" explicitamente, é permitido; a decisão é dele.
  return { enabled: true, agentId, sessionKey };
}

// Exposto para documentação/erros internos (nunca ao cliente).
export const AGENT_TURN_ENV = Object.freeze({
  flag: FLAG_ENV,
  agentId: AGENT_ID_ENV,
  sessionKey: SESSION_KEY_ENV,
  gatewayUrl: GATEWAY_URL_ENV,
});
