// Preflight de existência/roteamento da sessão (Fase 3A.2), compartilhado entre
// o turn síncrono (`openclaw_agent_turn`) e o dispatch assíncrono
// (`openclaw_agent_dispatch`).
//
// Executa `sessions.resolve { key, agentId, allowMissing: true }` via
// `runOpenclaw` com um env EXPLÍCITO (sem OPENCLAW_GATEWAY_URL/credenciais) e
// classifica a resposta com a validação FECHADA da Fase 2
// (`classifyResolveResponse`). Não altera o caminho read-only da Fase 2 (usa a
// função pura reexportada).
//
// Lança ToolError: NOT_FOUND (ausente/ambígua), GATEWAY_REQUIRED
// (indisponível/timeout/exit não-zero/JSON vazio), INTERNAL (shape malformado).
// Nunca lê/expõe candidates/key/path.

import { runOpenclaw } from "./runner.mjs";
import { classifyResolveResponse } from "./messages.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import { GATEWAY_RPC_TIMEOUT_MS } from "../lib/limits.mjs";

/**
 * @param {{ sessionKey: string, agentId?: string, signal?: AbortSignal,
 *   entry: string, env: NodeJS.ProcessEnv }} params
 */
export async function preflightSessionExists({ sessionKey, agentId, signal, entry, env }) {
  const params = { key: sessionKey, allowMissing: true };
  if (agentId !== undefined) params.agentId = agentId;

  let result;
  try {
    result = await runOpenclaw(
      entry,
      ["gateway", "call", "sessions.resolve", "--params", JSON.stringify(params), "--json"],
      { signal, timeoutMs: GATEWAY_RPC_TIMEOUT_MS, env },
    );
  } catch {
    // Timeout / CLI indisponível / spawn falho → Gateway indisponível.
    throw new ToolError(ERROR_CATEGORIES.GATEWAY_REQUIRED, "Gateway call failed");
  }

  if (result.exitCode !== 0) {
    throw new ToolError(ERROR_CATEGORIES.GATEWAY_REQUIRED, "Gateway RPC returned a non-zero exit");
  }
  const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (text.length === 0) {
    throw new ToolError(ERROR_CATEGORIES.GATEWAY_REQUIRED, "Gateway RPC returned no output");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "Malformed resolve response");
  }

  const classification = classifyResolveResponse(parsed);
  if (classification === "malformed") {
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "Malformed resolve response");
  }
  if (classification === "not_found") {
    throw new ToolError(ERROR_CATEGORIES.NOT_FOUND, "Session not found");
  }
  // "exists" → nada além do booleano `ok` é lido.
}
