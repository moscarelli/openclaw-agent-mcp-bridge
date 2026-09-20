// Serviço de openclaw_agent_turn (Fase 3A.2 — MVP local experimental).
//
// Fluxo: valida → adquire semáforo dedicado (max 1) → escreve prompt em arquivo
// temporário seguro → spawn do comando especializado `openclaw agent` → parse +
// normalização T0b → cleanup → resultado.
//
// Classificação pré/pós-dispatch (§7):
//   - antes do spawn: erros MCP (invalid_argument/permission_denied/busy/
//     internal); permission_denied também para Gateway comprovadamente
//     não-loopback;
//   - depois do spawn (o dispatch pode ter sido aceito): qualquer estado final
//     não comprovado → { status: "unknown", source: "gateway" }. NUNCA
//     gateway_required após o spawn.
//
// Cancelamento/timeout local resultam em "unknown" (o gate de abort Windows
// está aberto; não alegamos cancelled/timeout conclusivos). Sem retry automático.

import { spawn } from "node:child_process";
import { Semaphore } from "../lib/concurrency.mjs";
import { buildChildEnv } from "../lib/env-allowlist.mjs";
import { resolveOpenclawEntry } from "./locator.mjs";
import { writePromptTempfile } from "./prompt-tempfile.mjs";
import { parseAndNormalize } from "./agent-turn-normalize.mjs";
import { assertLocalLoopbackGateway } from "./agent-turn-loopback.mjs";
import { preflightSessionExists } from "./agent-turn-preflight.mjs";
import { validateAgentTurnArgs } from "../lib/validate-agent-turn.mjs";
import { resolveAgentTurnConfig, hasGatewayUrlOverride } from "./agent-turn-config.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import { logAgentTurnEvent } from "../lib/agent-turn-log.mjs";
import {
  AGENT_TURN_RUNNER_MARGIN_MS,
  AGENT_TURN_TIMEOUT_MAX_MS,
  CLI_MAX_BUFFER_BYTES,
  KILL_GRACE_MS,
} from "../lib/limits.mjs";

// Semáforo DEDICADO às ferramentas MUTANTES: no máximo uma operação mutante
// simultânea (turn síncrono OU dispatch assíncrono). Separado do
// childProcessSemaphore usado pelas leituras da Fase 1/2 (que não é bloqueado
// por este). Compartilhado com agent-dispatch.mjs para garantir exclusão mútua
// entre turn e dispatch. Segunda chamada mutante concorrente → busy.
export const turnSemaphore = new Semaphore(1);

// Injeção de env EXCLUSIVA para testes (mesma convenção do runner). Produção
// nunca a usa. As env vars de configuração NUNCA são repassadas ao filho.
let testChildEnv = null;
export function setTestAgentTurnChildEnv(extra) {
  testChildEnv = extra && typeof extra === "object" ? { ...extra } : null;
}

// Env dos processos filhos da Fase 3A.2. CRÍTICO: NUNCA repassa
// OPENCLAW_GATEWAY_URL nem OPENCLAW_GATEWAY_PORT — o override de URL exigiria
// credenciais explícitas (que o bridge não possui) e quebraria a autenticação
// local. Também não há token/password/secret (a allowlist já os exclui). A CLI
// filha usa a configuração e a autenticação LOCAIS do OpenClaw normalmente.
function stripGatewayTarget(env) {
  const out = { ...env };
  delete out.OPENCLAW_GATEWAY_URL;
  delete out.OPENCLAW_GATEWAY_PORT;
  return out;
}
export function composeChildEnv() {
  const base = stripGatewayTarget(buildChildEnv());
  return testChildEnv ? { ...base, ...testChildEnv } : base;
}

// Converte timeoutMs (ms) para segundos inteiros para a CLI, sem exceder o teto.
export function timeoutMsToCliSeconds(timeoutMs) {
  const capped = Math.min(timeoutMs, AGENT_TURN_TIMEOUT_MAX_MS);
  return Math.max(1, Math.floor(capped / 1000));
}

const unknownResult = () => ({ status: "unknown", source: "gateway" });

/**
 * Executa o comando especializado num processo filho próprio (spawn direto,
 * sem shell, argv array). NÃO usa o childProcessSemaphore. Termina apenas o
 * filho exato pelo handle (nunca taskkill/árvore/PID solto). Sempre resolve com
 * { stdout, exitCode } OU um sentinela de término local; nunca lança por
 * timeout/cancel — o serviço traduz para "unknown".
 *
 * @returns {Promise<{ kind: "closed", stdout: string, exitCode: number|null }
 *   | { kind: "local_terminated" } | { kind: "spawn_error" }>}
 */
function runSpecializedAgent(entryJs, args, { timeoutMs, signal }) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let childExited = false;
    let stdoutBytes = 0;
    const stdoutChunks = [];
    let tooLarge = false;
    let terminating = false;
    let localTerminated = false;

    let overallTimer = null;
    let graceTimer = null;
    let settleFallbackTimer = null;

    let child;
    try {
      child = spawn(process.execPath, [entryJs, ...args], {
        shell: false,
        windowsHide: true,
        env: composeChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolvePromise({ kind: "spawn_error" });
      return;
    }

    const clearAllTimers = () => {
      if (overallTimer) clearTimeout(overallTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      overallTimer = graceTimer = settleFallbackTimer = null;
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      if (signal) signal.removeEventListener("abort", onAbort);
      resolvePromise(value);
    };

    const hasExited = () => childExited || child.exitCode !== null || child.signalCode !== null;

    // Termina SOMENTE o filho exato pelo handle. Windows: SIGKILL direto no
    // handle (sem árvore). POSIX: SIGTERM → grace → SIGKILL. Nunca taskkill/-T.
    const beginTermination = () => {
      if (terminating || hasExited()) return;
      terminating = true;

      settleFallbackTimer = setTimeout(() => {
        // Se 'close' nunca vier (pipes presos), assenta como término local.
        finish({ kind: "local_terminated" });
      }, KILL_GRACE_MS + 1500);
      if (typeof settleFallbackTimer.unref === "function") settleFallbackTimer.unref();

      if (process.platform === "win32") {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!hasExited()) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* noop */
          }
        }
      }, KILL_GRACE_MS);
      if (typeof graceTimer.unref === "function") graceTimer.unref();
    };

    overallTimer = setTimeout(() => {
      localTerminated = true;
      beginTermination();
    }, timeoutMs);
    if (typeof overallTimer.unref === "function") overallTimer.unref();

    const onAbort = () => {
      localTerminated = true;
      beginTermination();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("exit", () => {
      childExited = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    });

    child.on("error", () => {
      childExited = true;
      finish({ kind: "spawn_error" });
    });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > CLI_MAX_BUFFER_BYTES) {
        tooLarge = true;
        // stdout gigante pós-dispatch: incerteza → término local → unknown.
        localTerminated = true;
        beginTermination();
        return;
      }
      stdoutChunks.push(chunk);
    });

    // stderr é lido e descartado (nunca logamos stderr bruto). Limitar leitura
    // evita backpressure.
    child.stderr.on("data", () => {});

    child.on("close", (code) => {
      childExited = true;
      if (tooLarge || localTerminated || (signal && signal.aborted)) {
        return finish({ kind: "local_terminated" });
      }
      finish({
        kind: "closed",
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

/**
 * Ponto de entrada do serviço. Recebe os args crus e o AbortSignal do MCP.
 * Retorna o output MCP fechado do turn.
 *
 * @param {object} args argumentos crus do cliente
 * @param {{ signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [ctx]
 */
export async function runAgentTurn(args, ctx = {}) {
  const env = ctx.env ?? process.env;
  const signal = ctx.signal;

  // A ferramenta só existe quando habilitada; ainda assim revalidamos a config
  // no handler (defesa em profundidade).
  const config = resolveAgentTurnConfig(env);
  if (!config.enabled) {
    // Não deveria ocorrer (tool não registrada), mas nunca vaza motivo.
    throw new ToolError(ERROR_CATEGORIES.PERMISSION_DENIED, "Permission denied.");
  }

  // Pré-dispatch: validação de input + binding de destino.
  const { agentId, sessionKey, instruction, timeoutMs } = validateAgentTurnArgs(args, config);

  // Pré-dispatch: se OPENCLAW_GATEWAY_URL estiver definido no ambiente do bridge,
  // recusa — não podemos usá-lo sem credenciais e não o repassamos ao filho.
  if (hasGatewayUrlOverride(env)) {
    throw new ToolError(ERROR_CATEGORIES.PERMISSION_DENIED, "Permission denied.");
  }

  // Pré-dispatch: resolve o entrypoint (cli_unavailable se falhar).
  const entry = resolveOpenclawEntry();

  const started = Date.now();

  // Cancelamento antes de adquirir o permit não consome permit.
  if (signal && signal.aborted) {
    logAgentTurnEvent("agent_turn_cancelled_pre_acquire", { agentId, sessionKey, started });
    return unknownResult();
  }

  // Semáforo dedicado (max 1), aquisição NÃO-BLOQUEANTE: se já houver um turn em
  // andamento, retorna `busy` IMEDIATAMENTE (sem enfileirar, sem esperar
  // timeout, sem waiter/permit residual). Não afeta o semáforo read-only.
  const release = turnSemaphore.tryAcquire();
  if (release === null) {
    logAgentTurnEvent("agent_turn_busy", { agentId, sessionKey, started });
    throw new ToolError(ERROR_CATEGORIES.BUSY, "A turn is already in progress");
  }
  let cleanup = null;
  try {
    // Cancelamento após adquirir: libera permit no finally, retorna unknown.
    if (signal && signal.aborted) {
      logAgentTurnEvent("agent_turn_cancelled_post_acquire", { agentId, sessionKey, started });
      return unknownResult();
    }

    // Env dos filhos: allowlist SEM o alvo de Gateway (sem OPENCLAW_GATEWAY_URL/
    // PORT, sem credenciais). Todos os processos filhos da 3A.2 usam este env.
    const childEnv = composeChildEnv();

    // PREFLIGHT 1 — LOOPBACK LOCAL (read-only, sem credenciais). Lê a config
    // LOCAL do OpenClaw (`config get gateway --json`) e comprova, fail-closed,
    // que o Gateway efetivo é local em loopback (mode local, bind loopback, sem
    // remote.url). Recusa caso contrário: `permission_denied` SOMENTE quando a
    // config prova destino não-loopback (remote/bind não-loopback/remote.url);
    // `gateway_required` para falha operacional/inconclusiva (timeout, exit
    // não-zero, JSON malformado, etc.). Executado IMEDIATAMENTE antes de
    // sessions.resolve/dispatch (§4).
    try {
      await assertLocalLoopbackGateway({ signal, env: childEnv });
    } catch (err) {
      if (signal && signal.aborted) {
        logAgentTurnEvent("agent_turn_cancelled_preflight", { agentId, sessionKey, started });
        return unknownResult();
      }
      throw err; // permission_denied ou gateway_required (pré-dispatch)
    }

    // PREFLIGHT 2 — EXISTÊNCIA/ROTEAMENTO da sessão (read-only), reutilizando a
    // validação FECHADA da Fase 2 (`classifyResolveResponse`) com
    // `sessions.resolve { key, agentId, allowMissing: true }`. Evidência
    // estática: o comando `openclaw agent` pode CRIAR/rotear para uma nova
    // sessão quando a chave não existe; por isso o preflight é obrigatório ANTES
    // de criar o arquivo temporário e de executar a CLI. Roda com o mesmo
    // `childEnv` (sem OPENCLAW_GATEWAY_URL/credenciais).
    //
    // ok:true → prossegue; ok:false → not_found; shape inesperado → internal;
    // Gateway indisponível/timeout → gateway_required. `candidates`/`key`/
    // `canonicalKey`/`path` nunca são lidos/expostos.
    try {
      await preflightSessionExists({ sessionKey, agentId, signal, entry, env: childEnv });
    } catch (err) {
      if (signal && signal.aborted) {
        logAgentTurnEvent("agent_turn_cancelled_preflight", { agentId, sessionKey, started });
        return unknownResult();
      }
      throw err; // not_found / gateway_required / internal (pré-dispatch)
    }

    // Cancelamento entre o preflight e o dispatch → unknown (nada foi despachado).
    if (signal && signal.aborted) {
      logAgentTurnEvent("agent_turn_cancelled_post_preflight", { agentId, sessionKey, started });
      return unknownResult();
    }

    // Escreve o prompt em arquivo temporário seguro (fora do argv).
    const handle = await writePromptTempfile(instruction);
    cleanup = handle.cleanup;

    // argv EXATO: sem --message, --local, --deliver, model, provider, thinking,
    // channel/to/replyTo/account, cwd. Somente os flags autorizados.
    const cliSeconds = timeoutMsToCliSeconds(timeoutMs);
    const args2 = [
      "agent",
      "--agent",
      agentId,
      "--session-key",
      sessionKey,
      "--message-file",
      handle.path,
      "--json",
      "--timeout",
      String(cliSeconds),
    ];

    // O runner interno usa um teto ligeiramente maior que o timeout da CLI
    // (margem técnica), sem exceder o teto rígido.
    const runnerTimeoutMs = Math.min(
      timeoutMs + AGENT_TURN_RUNNER_MARGIN_MS,
      AGENT_TURN_TIMEOUT_MAX_MS + AGENT_TURN_RUNNER_MARGIN_MS,
    );

    const outcome = await runSpecializedAgent(entry, args2, { timeoutMs: runnerTimeoutMs, signal });

    // Pós-dispatch: qualquer término local/spawn error/exit anormal → unknown.
    if (outcome.kind !== "closed") {
      logAgentTurnEvent("agent_turn_unknown", {
        agentId,
        sessionKey,
        started,
        detail: outcome.kind,
      });
      return unknownResult();
    }

    // EXIT CODE (pós-dispatch): somente exitCode === 0 pode virar completed/
    // failed. Qualquer código diferente de zero (ou nulo, indicando término por
    // sinal / fechamento anormal) → unknown, sem conteúdo. Nunca expõe o código
    // interno nem stderr bruto.
    if (outcome.exitCode !== 0) {
      logAgentTurnEvent("agent_turn_unknown", {
        agentId,
        sessionKey,
        started,
        detail: "nonzero_exit",
      });
      return unknownResult();
    }

    // Parse + normalização T0b. stdout malformado → unknown.
    const result = parseAndNormalize(outcome.stdout);
    logAgentTurnEvent("agent_turn_complete", {
      agentId,
      sessionKey,
      started,
      status: result.status,
      truncated: Boolean(result.truncated),
    });
    return result;
  } finally {
    // Cleanup best-effort do arquivo/dir temporário em TODOS os caminhos.
    if (cleanup) {
      const status = await cleanup();
      if (status !== "ok") {
        logAgentTurnEvent("agent_turn_cleanup_failed", { started });
      }
    }
    release();
  }
}

// Exposto para testes de concorrência/lifecycle e verificação do env do filho.
export const __testing = { turnSemaphore, timeoutMsToCliSeconds, composeChildEnv, stripGatewayTarget };
