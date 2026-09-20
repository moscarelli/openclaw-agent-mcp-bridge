// Logging sanitizado do turn (Fase 3A.2, §11).
//
// NUNCA loga: instruction, response, sessionKey, agentId bruto, temp path, argv,
// stdout, stderr, runId, credenciais, modelo/provider.
//
// Loga apenas: event code, status/resultado sanitizado, duração aproximada,
// fingerprint HMAC não reversível (do par agentId+sessionKey, com chave efêmera
// de processo e separação de domínio), e código de falha de cleanup. Sem
// persistência de audit log novo.

import { createHmac, randomBytes } from "node:crypto";
import { logger } from "./logger.mjs";

// Chave efêmera em memória, recriada a cada processo. Não persistida. Torna o
// fingerprint não correlacionável entre execuções do bridge.
const EPHEMERAL_KEY = randomBytes(32);

// Separação de domínio: o rótulo garante que o fingerprint do turn não colida
// com fingerprints de outros subsistemas usando a mesma chave.
const DOMAIN = "phase3a2-agent-turn:v1";

/**
 * Fingerprint HMAC não reversível de um par de identificadores. Retorna um
 * prefixo base64url curto (não o valor bruto). Nunca reversível ao id.
 */
function fingerprint(agentId, sessionKey) {
  const h = createHmac("sha256", EPHEMERAL_KEY);
  h.update(DOMAIN);
  h.update("\x00");
  h.update(String(agentId ?? ""));
  h.update("\x00");
  h.update(String(sessionKey ?? ""));
  return h.digest("base64url").slice(0, 16);
}

/**
 * Emite um evento de turn sanitizado. `details` pode conter agentId/sessionKey
 * apenas para derivar o fingerprint — os valores brutos NUNCA são logados.
 *
 * @param {string} event código estável do evento
 * @param {{ agentId?: string, sessionKey?: string, started?: number,
 *   status?: string, truncated?: boolean, detail?: string, jobId?: string }}
 *   [details]
 */
export function logAgentTurnEvent(event, details = {}) {
  const record = { event };
  if (details.agentId !== undefined || details.sessionKey !== undefined) {
    record.fp = fingerprint(details.agentId, details.sessionKey);
  }
  // jobId é uma correlação local OPACA e aleatória (sem agentId/sessionKey/PID/
  // path/conteúdo), gerada pelo dispatch. É seguro logá-la para correlacionar
  // "started" com "complete/failed" da MESMA execução.
  if (typeof details.jobId === "string" && details.jobId.length <= 64) {
    record.jobId = details.jobId;
  }
  if (typeof details.started === "number") {
    record.durationMs = Math.max(0, Date.now() - details.started);
  }
  if (typeof details.status === "string") record.status = details.status;
  if (typeof details.truncated === "boolean") record.truncated = details.truncated;
  // `detail` é um código curto e fechado (ex.: "spawn_error", "local_terminated",
  // "timeout"), nunca conteúdo. Só aceitamos strings curtas do próprio código.
  if (typeof details.detail === "string" && details.detail.length <= 32) {
    record.detail = details.detail;
  }
  // logger aplica redactValue por cima (defesa em profundidade).
  logger.info("agent_turn", record);
}
