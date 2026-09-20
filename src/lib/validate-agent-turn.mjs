// Validação de argumentos de openclaw_agent_turn (Fase 3A.2).
//
// Regras (§4 do brief):
//   - agentId, sessionKey, instruction obrigatórios e não vazios;
//   - instruction UTF-8 válida após serialização, não whitespace-only, dentro
//     do teto de bytes;
//   - timeoutMs inteiro dentro de faixa rígida (default aplicado se ausente);
//   - agentId e sessionKey devem corresponder EXATAMENTE à configuração;
//   - o vínculo agentId↔sessionKey é validado (sem normalização silenciosa);
//   - divergência de destino → permission_denied (sem revelar campo/allowlist);
//   - slash commands (incl. /new, /reset, /compact e desconhecidos) bloqueados;
//   - nenhum override de model/provider/tool/cwd/channel/account/delivery
//     (garantido pelo z.strictObject na tool + ausência desses campos aqui).

import { ToolError, ERROR_CATEGORIES } from "./errors.mjs";
import { assertSafeIdentifier } from "./identifier.mjs";
import { deriveAgentIdFromKey } from "./validate.mjs";
import {
  AGENT_TURN_INSTRUCTION_MAX_BYTES,
  AGENT_TURN_TIMEOUT_MIN_MS,
  AGENT_TURN_TIMEOUT_MAX_MS,
  AGENT_TURN_TIMEOUT_DEFAULT_MS,
} from "./limits.mjs";

function invalid(message) {
  return new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, message);
}

// permission_denied genérico: NUNCA revela qual campo divergiu nem a allowlist.
function permissionDenied() {
  return new ToolError(ERROR_CATEGORIES.PERMISSION_DENIED, "Permission denied.");
}

// Detecta instrução iniciada por slash command. Bloqueia `/qualquercoisa`
// (incluindo /new, /reset, /compact e comandos desconhecidos). Considera espaço
// inicial. NÃO normaliza a instrução.
function isSlashCommand(instruction) {
  return /^\s*\//.test(instruction);
}

function validateInstruction(raw) {
  if (typeof raw !== "string") throw invalid("instruction is required");
  // Não whitespace-only.
  if (raw.trim().length === 0) throw invalid("instruction must not be empty");
  // UTF-8 válida após serialização: rejeita surrogates isolados (que produzem
  // U+FFFD ao serializar em UTF-8 e indicam entrada malformada).
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.toString("utf8") !== raw) throw invalid("instruction must be valid UTF-8");
  if (bytes.byteLength > AGENT_TURN_INSTRUCTION_MAX_BYTES) {
    throw invalid("instruction exceeds the byte limit");
  }
  // Slash commands bloqueados (controle de sessão, não turno de conversa).
  if (isSlashCommand(raw)) throw invalid("slash commands are not allowed");
  return raw;
}

function validateTimeoutMs(value) {
  if (value === undefined) return AGENT_TURN_TIMEOUT_DEFAULT_MS;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid("timeoutMs must be an integer");
  }
  if (value < AGENT_TURN_TIMEOUT_MIN_MS || value > AGENT_TURN_TIMEOUT_MAX_MS) {
    throw invalid("timeoutMs is out of range");
  }
  return value;
}

/**
 * Valida os argumentos e confirma o destino contra a configuração.
 *
 * @param {object} args argumentos crus do cliente
 * @param {{ agentId: string, sessionKey: string }} config destino autorizado
 * @returns {{ agentId, sessionKey, instruction, timeoutMs }}
 */
export function validateAgentTurnArgs(args, config) {
  const input = args ?? {};

  // Formato base (o z.strictObject da tool já rejeita chaves desconhecidas; aqui
  // reforçamos tipos/obrigatoriedade e nunca normalizamos identificadores).
  if (typeof input.agentId !== "string" || input.agentId.length === 0) {
    throw invalid("agentId is required");
  }
  if (typeof input.sessionKey !== "string" || input.sessionKey.length === 0) {
    throw invalid("sessionKey is required");
  }

  // Identificadores seguros (sem normalização silenciosa: comparação exata).
  let agentId;
  let sessionKey;
  try {
    agentId = assertSafeIdentifier(input.agentId, "agentId");
    sessionKey = assertSafeIdentifier(input.sessionKey, "sessionKey");
  } catch {
    throw invalid("identifier is invalid");
  }

  const instruction = validateInstruction(input.instruction);
  const timeoutMs = validateTimeoutMs(input.timeoutMs);

  // Destino deve corresponder EXATAMENTE à configuração. Divergência de agentId
  // OU sessionKey → permission_denied genérico (não revela qual).
  if (agentId !== config.agentId || sessionKey !== config.sessionKey) {
    throw permissionDenied();
  }

  // Vínculo agentId↔sessionKey: quando a sessionKey é prefixada "agent:<id>:...",
  // o id derivado deve bater com o agentId. Divergência → permission_denied.
  const derived = deriveAgentIdFromKey(sessionKey);
  if (derived !== undefined && derived !== agentId) {
    throw permissionDenied();
  }

  return { agentId, sessionKey, instruction, timeoutMs };
}
