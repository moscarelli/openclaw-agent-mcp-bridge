// Preflight de LOOPBACK LOCAL (read-only, sem credenciais) para a Fase 3A.2.
//
// Correção do bloqueio E2E: NÃO usamos OPENCLAW_GATEWAY_URL (exigiria
// credenciais na 2026.9.3). Em vez disso, comprovamos por LEITURA read-only da
// configuração LOCAL do OpenClaw que o Gateway efetivo é local em loopback,
// deixando a CLI usar sua autenticação/config local normalmente.
//
// Interface oficial usada: `openclaw config get gateway --json`
// (evidência: `dist/config-cli-*.mjs` runConfigGet — lê o snapshot local com
// `observe:false`, sem conectar ao Gateway e sem parede de auth, e devolve o
// subárvore `gateway` REDIGIDA — `redactConfigObject`, sem segredos).
//
// Semântica confirmada (evidência: `dist/connection-details-*.mjs`):
//   - `isRemoteMode` ⇔ `gateway.mode === "remote"` (ausente/default = local);
//   - `bindMode = gateway.bind ?? "loopback"` (ausente/default = loopback);
//   - `gateway.remote.url` só é usado quando `mode === "remote"`.
//
// FAIL-CLOSED. Aceita SOMENTE quando, lendo apenas campos não sensíveis:
//   - `gateway.mode` é "local" ou ausente (→ local); NUNCA "remote";
//   - `gateway.bind` é "loopback" ou ausente (→ loopback); NUNCA "all"/"lan"/
//     wildcard/host não-loopback;
//   - não há `gateway.remote.url` presente.
// Distinção de recusa (fail-closed em ambos os casos):
//   - `permission_denied` SOMENTE quando a config é válida e COMPROVA um destino
//     não-loopback: `mode === "remote"`, `bind` não-loopback, ou `remote.url`
//     presente;
//   - `gateway_required` para QUALQUER falha operacional/inconclusiva: timeout,
//     CLI indisponível/spawn falho, exit não-zero, stdout vazio, JSON malformado,
//     `{ ok: false }`, ou shape inesperado (não comprova nada).
// NUNCA lê token/password/secret (o subárvore já vem redigido de qualquer forma).

import { runOpenclaw } from "./runner.mjs";
import { resolveOpenclawEntry } from "./locator.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import { AGENT_TURN_LOOPBACK_PREFLIGHT_TIMEOUT_MS } from "../lib/limits.mjs";

// Binds que representam loopback. Qualquer outro valor (all/lan/public/host) é
// tratado como não-loopback → recusa.
const LOOPBACK_BINDS = new Set(["loopback", "local", "localhost", "127.0.0.1", "::1"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Recusa por CONFIG VÁLIDA que comprova destino não-loopback (remote/bind
// não-loopback/remote.url). Sanitizada; nunca revela URL/host/config.
function denied() {
  return new ToolError(ERROR_CATEGORIES.PERMISSION_DENIED, "Local loopback Gateway not proven");
}

// Recusa por FALHA OPERACIONAL/INCONCLUSIVA (timeout, CLI indisponível, exit
// não-zero, stdout vazio, JSON malformado, {ok:false}, shape inesperado). Não
// comprova destino não-loopback → o preflight não confirmou um Gateway local.
function gatewayRequired() {
  return new ToolError(ERROR_CATEGORIES.GATEWAY_REQUIRED, "This operation requires a running OpenClaw Gateway.");
}

/**
 * Classifica o subárvore `gateway` (já redigido) da config local.
 * @param {unknown} gw valor retornado por `config get gateway --json`
 * @returns {"loopback" | "not_loopback" | "malformed"}
 */
export function classifyGatewayConfig(gw) {
  // `config get` pode devolver `null` quando o caminho existe mas está unset:
  // nesse caso os defaults (mode=local, bind=loopback) aplicam → loopback.
  if (gw === null) return "loopback";
  if (!isPlainObject(gw)) return "malformed";

  // mode: só string; "remote" recusa; "local" aceita; ausente → default local.
  const mode = gw.mode;
  if (mode !== undefined) {
    if (typeof mode !== "string") return "malformed";
    if (mode === "remote") return "not_loopback";
    if (mode !== "local") return "malformed"; // valor inesperado → fail-closed
  }

  // remote.url: se presente e não vazio, é seleção de remote → recusa.
  const remote = gw.remote;
  if (remote !== undefined) {
    if (!isPlainObject(remote)) return "malformed";
    const url = remote.url;
    if (typeof url === "string" && url.trim().length > 0) return "not_loopback";
    if (url !== undefined && typeof url !== "string") return "malformed";
  }

  // bind: ausente → default loopback; string em LOOPBACK_BINDS aceita; qualquer
  // outra string (all/lan/wildcard/host) recusa; tipo errado → malformado.
  const bind = gw.bind;
  if (bind !== undefined) {
    if (typeof bind !== "string") return "malformed";
    if (!LOOPBACK_BINDS.has(bind.trim().toLowerCase())) return "not_loopback";
  }

  return "loopback";
}

/**
 * Executa o preflight read-only e comprova loopback local, fail-closed.
 * Lança ToolError(PERMISSION_DENIED) se não puder comprovar. NUNCA passa
 * OPENCLAW_GATEWAY_URL nem credenciais ao filho (o runner usa a allowlist de
 * env; OPENCLAW_GATEWAY_URL não é removido da allowlist aqui — ver nota).
 *
 * @param {{ signal?: AbortSignal }} [ctx]
 */
export async function assertLocalLoopbackGateway(ctx = {}) {
  const entry = resolveOpenclawEntry();

  let result;
  try {
    result = await runOpenclaw(entry, ["config", "get", "gateway", "--json"], {
      signal: ctx.signal,
      // Timeout próprio de 45s (não o GATEWAY_RPC_TIMEOUT_MS de 10s): acomoda o
      // startup frio da CLI e evita falsos negativos operacionais.
      timeoutMs: AGENT_TURN_LOOPBACK_PREFLIGHT_TIMEOUT_MS,
      // Env explícito (sem OPENCLAW_GATEWAY_URL/credenciais) para que a leitura
      // reflita a config LOCAL. Fornecido pelo chamador (agent-turn.mjs).
      ...(ctx.env ? { env: ctx.env } : {}),
    });
  } catch {
    // Timeout, CLI indisponível, spawn falho → falha operacional.
    throw gatewayRequired();
  }

  // Exit não-zero (ex.: caminho desconhecido) → falha operacional.
  if (result.exitCode !== 0) throw gatewayRequired();

  const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (text.length === 0) throw gatewayRequired();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw gatewayRequired(); // JSON malformado → falha operacional
  }

  // Uma falha estruturada de `config get --json` vem como { ok: false, ... }.
  if (isPlainObject(parsed) && parsed.ok === false) throw gatewayRequired();

  const classification = classifyGatewayConfig(parsed);
  // `permission_denied` SOMENTE para config válida que comprova não-loopback
  // (remote/bind não-loopback/remote.url). Shape "malformed" é inconclusivo →
  // falha operacional (`gateway_required`).
  if (classification === "not_loopback") throw denied();
  if (classification !== "loopback") throw gatewayRequired();
  // Comprovado: nada é retornado/logado.
}
