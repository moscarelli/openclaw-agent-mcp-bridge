// Wrapper do RPC do Gateway via `openclaw gateway call <method>` (PHASE1_PLAN §5).
//
// Autenticação: NÃO é feita pelo bridge. Nenhum token/senha é passado na linha
// de comando (as flags --token-file/--password-file não existem) nem por env.
// A CLI resolve a autenticação a partir da sua CONFIGURAÇÃO LOCAL
// (openclaw.json / SecretRefs / estado do dispositivo). O bridge apenas define
// o alvo do Gateway via OPENCLAW_GATEWAY_URL/PORT quando o operador os fornece
// (repassados pela allowlist de env).

import { runOpenclaw } from "./runner.mjs";
import { resolveOpenclawEntry } from "./locator.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import {
  GATEWAY_RPC_TIMEOUT_MS,
  GATEWAY_RPC_EXTENDED_TIMEOUT_MAX_MS,
} from "../lib/limits.mjs";

/**
 * Executa `gateway call <method> --params '<json>' --json` e devolve o objeto
 * parseado. Distingue "gateway indisponível" de "resposta inválida".
 *
 * @param {string} method ex.: "sessions.list"
 * @param {object} params objeto de parâmetros do RPC
 * @param {object} options { signal, unavailableCategory, timeoutMs, timeoutCeilingMs }
 *   - `timeoutMs` é um teto controlado INTERNAMENTE pelo chamador (código do
 *     bridge), NUNCA vindo de um argumento MCP. O runner ainda aplica seus
 *     próprios tetos rígidos; o override por ambiente só REDUZ o default. Se
 *     omitido, usa GATEWAY_RPC_TIMEOUT_MS. `timeoutCeilingMs` é exclusivamente
 *     interno, nunca vem de argumento MCP, e não pode ultrapassar
 *     GATEWAY_RPC_EXTENDED_TIMEOUT_MAX_MS.
 */
export async function gatewayCall(method, params = {}, options = {}) {
  const entry = resolveOpenclawEntry();
  const unavailable = options.unavailableCategory ?? ERROR_CATEGORIES.GATEWAY_UNAVAILABLE;

  const requestedCeiling = options.timeoutCeilingMs;
  const ceiling =
    Number.isInteger(requestedCeiling) && requestedCeiling > 0
      ? Math.min(requestedCeiling, GATEWAY_RPC_EXTENDED_TIMEOUT_MAX_MS)
      : GATEWAY_RPC_TIMEOUT_MS;
  const requested = options.timeoutMs;
  const effectiveTimeout =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, ceiling)
      : Math.min(GATEWAY_RPC_TIMEOUT_MS, ceiling);

  const args = ["gateway", "call", method, "--params", JSON.stringify(params ?? {}), "--json"];

  let result;
  try {
    result = await runOpenclaw(entry, args, {
      timeoutMs: effectiveTimeout,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof ToolError) {
      // Timeout/spawn falho ao alcançar o Gateway → indisponível para o chamador.
      if (err.category === ERROR_CATEGORIES.TIMEOUT || err.category === ERROR_CATEGORIES.CLI_UNAVAILABLE) {
        throw new ToolError(unavailable, "Gateway call failed");
      }
      throw err;
    }
    throw new ToolError(unavailable, "Gateway call failed");
  }

  if (result.exitCode !== 0) {
    // Código diferente de zero: Gateway inacessível/erro RPC.
    throw new ToolError(unavailable, "Gateway RPC returned a non-zero exit");
  }

  const text = result.stdout.trim();
  if (text.length === 0) {
    throw new ToolError(unavailable, "Gateway RPC returned no output");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "Gateway RPC returned invalid JSON");
  }
}
