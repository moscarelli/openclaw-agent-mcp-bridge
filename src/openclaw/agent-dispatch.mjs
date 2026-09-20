// Serviço de openclaw_agent_dispatch (Fase 3A.2 — dispatch ASSÍNCRONO econômico,
// experimental, local/loopback single-operator).
//
// OBJETIVO (correção do objetivo central da 3A.2): iniciar trabalho no OpenClaw
// e DEVOLVER ao cliente MCP assim que o processo filho oficial (`openclaw agent`)
// tiver sido CRIADO com sucesso — SEM esperar o modelo terminar. É
// fire-and-forget: a resposta textual do modelo NÃO volta ao cliente MCP, NÃO é
// persistida em disco e NÃO há mecanismo público suportado para recuperá-la ou
// exibi-la automaticamente. `started` comprova apenas que o processo oficial foi
// criado (não conclusão nem sucesso do trabalho). Use `openclaw_agent_turn`
// quando a resposta textual for necessária; use o dispatch apenas quando o
// trabalho produzir um efeito externo verificável.
//
// Diferença essencial vs. `openclaw_agent_turn` (síncrono/diagnóstico): o turn
// mantém a chamada MCP aberta até o término do modelo (consome mais); o dispatch
// fecha a chamada MCP no evento `spawn`.
//
// Fluxo: valida → adquire o MESMO semáforo mutante do turn (max 1) → preflights
// (loopback local read-only + sessions.resolve existente) → tempfile seguro →
// spawn `openclaw agent` DESACOPLADO → resolve { status: "started", jobId } no
// evento `spawn` → o filho segue independente; ao terminar, apaga o tempfile,
// libera o semáforo e loga um evento sanitizado.
//
// GARANTIAS E LIMITES (§ do brief):
//   - retorno APÓS `spawn`, nunca antes (2);
//   - o processo continua após o retorno MCP (3);
//   - o AbortSignal do MCP NÃO é observado após o retorno; cancelar/encerrar a
//     chamada MCP após "started" não aborta o trabalho (4);
//   - sem retry automático (5);
//   - a saída final do modelo NUNCA é retornada/notificada/adicionada (6);
//   - stdout/stderr do filho são drenados e descartados, sem leitura,
//     acumulação, log ou persistência (7);
//   - ao terminar: apaga tempfile, libera semáforo, loga evento sanitizado (8);
//   - falha ANTES de `spawn` → erro sanitizado + cleanup completo (9);
//   - falha DEPOIS de "started" → não altera o resultado MCP; só loga (10);
//   - `jobId` é correlação local opaca e aleatória, sem agentId/sessionKey/PID/
//     path/conteúdo (11). Mantido no contrato para correlação operacional
//     futura, mesmo sem consulta posterior;
//   - MINIMIZAÇÃO DE DADOS: sem persistência da resposta, sem spool, sem
//     polling, sem DB, sem callback de rede e sem hook/entrega automática. A
//     saída do filho é apenas drenada e descartada.
//
// SOBREVIVÊNCIA A ENCERRAMENTO DO PROCESSO MCP: não é garantida neste MVP. O
// filho é iniciado com `detached: true` e `unref()` (não prende o event loop do
// pai e ganha seu próprio grupo de processo onde suportado), mas um encerramento
// abrupto do processo do bridge pode ainda afetar o filho dependendo do SO.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { turnSemaphore, composeChildEnv, timeoutMsToCliSeconds } from "./agent-turn.mjs";
import { resolveOpenclawEntry } from "./locator.mjs";
import { writePromptTempfile } from "./prompt-tempfile.mjs";
import { assertLocalLoopbackGateway } from "./agent-turn-loopback.mjs";
import { preflightSessionExists } from "./agent-turn-preflight.mjs";
import { validateAgentTurnArgs } from "../lib/validate-agent-turn.mjs";
import { resolveAgentTurnConfig, hasGatewayUrlOverride } from "./agent-turn-config.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import { logAgentTurnEvent } from "../lib/agent-turn-log.mjs";

// jobId opaco: 128 bits aleatórios em base64url. Correlação puramente local;
// não contém (nem deriva) agentId, sessionKey, PID, path ou conteúdo.
function newJobId() {
  return randomBytes(16).toString("base64url");
}

/**
 * Spawn DESACOPLADO do comando especializado, resolvendo assim que o filho for
 * criado (evento `spawn`). Após a criação, o filho é observado APENAS para
 * cleanup/log; a Promise retornada NÃO espera o término do modelo e o
 * AbortSignal do MCP não é observado aqui (o dispatch é fire-and-forget).
 *
 * MINIMIZAÇÃO DE DADOS: o dispatch é fire-and-forget e NÃO há mecanismo público
 * suportado para consumir o resultado. Portanto a resposta textual do modelo
 * NÃO é lida, normalizada, retornada nem persistida em disco. stdout/stderr são
 * apenas DRENADOS e DESCARTADOS, sem leitura, acumulação, log ou persistência.
 *
 * @param {string} entryJs entrypoint validado
 * @param {string[]} args argv exato
 * @param {{ jobId: string, agentId: string, sessionKey: string,
 *   started: number, cleanup: (() => Promise<"ok"|"failed">) | null,
 *   release: () => void }} lifecycle
 * @returns {Promise<{ kind: "started" } | { kind: "spawn_error" }>}
 */
function spawnDetached(entryJs, args, lifecycle) {
  return new Promise((resolvePromise) => {
    const { jobId, agentId, sessionKey, started, cleanup, release } = lifecycle;

    let settled = false;
    let finalized = false;

    // Cleanup PÓS-TÉRMINO idempotente: apaga o tempfile, libera o semáforo e
    // loga um evento sanitizado. Não persiste nem lê a resposta do modelo.
    // NUNCA loga instruction/response/sessionKey/path/stderr.
    const finalize = async (event, detail) => {
      if (finalized) return;
      finalized = true;
      let cleanupFailed = false;
      if (cleanup) {
        const status = await cleanup();
        if (status !== "ok") cleanupFailed = true;
      }
      release();
      logAgentTurnEvent(event, {
        agentId,
        sessionKey,
        jobId,
        started,
        detail: cleanupFailed ? `${detail}_cleanup_failed`.slice(0, 32) : detail,
      });
    };

    let child;
    try {
      child = spawn(process.execPath, [entryJs, ...args], {
        shell: false,
        windowsHide: true,
        detached: true, // grupo de processo próprio onde suportado
        env: composeChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Falha SÍNCRONA de spawn (antes do evento `spawn`): erro pré-dispatch.
      resolvePromise({ kind: "spawn_error" });
      // cleanup/release é feito pelo chamador no caminho de erro pré-spawn.
      return;
    }

    // stdout/stderr são drenados e descartados, sem leitura, acumulação, log ou
    // persistência. `resume()` mantém os pipes fluindo (evita backpressure).
    child.stdout.resume();
    child.stderr.resume();

    // Erro do filho:
    //   - antes de `spawn`  → spawn_error pré-dispatch (chamador faz cleanup);
    //   - depois de `spawn` → só cleanup/log; o resultado MCP já foi "started".
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolvePromise({ kind: "spawn_error" });
        return;
      }
      finalize("agent_dispatch_failed", "spawn_error");
    });

    // Evento `spawn`: o processo filho foi CRIADO com sucesso. Este é o único
    // ponto onde a Promise ligada ao MCP resolve com "started". Desacopla o
    // filho do event loop do pai; a partir daqui a chamada MCP pode encerrar
    // sem afetar o trabalho.
    child.on("spawn", () => {
      if (settled) return;
      settled = true;
      try {
        child.unref();
      } catch {
        /* noop */
      }
      resolvePromise({ kind: "started" });
    });

    // Término do filho (independente da chamada MCP). Só cleanup + log.
    child.on("close", () => {
      if (!settled) {
        // 'close' sem 'spawn' (extremamente raro): trata como falha de criação.
        settled = true;
        resolvePromise({ kind: "spawn_error" });
        return;
      }
      finalize("agent_dispatch_complete", "closed");
    });
  });
}

/**
 * Ponto de entrada do serviço de dispatch assíncrono.
 *
 * @param {object} args argumentos crus do cliente (agentId, sessionKey,
 *   instruction — schema estrito na tool)
 * @param {{ signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [ctx]
 * @returns {Promise<{ status: "started", jobId: string, source: "openclaw" }>}
 */
export async function runAgentDispatch(args, ctx = {}) {
  const env = ctx.env ?? process.env;
  const signal = ctx.signal;

  // Defesa em profundidade: revalida a config experimental (a tool só é
  // registrada quando habilitada).
  const config = resolveAgentTurnConfig(env);
  if (!config.enabled) {
    throw new ToolError(ERROR_CATEGORIES.PERMISSION_DENIED, "Permission denied.");
  }

  // Validação de input + binding de destino (mesmas regras do turn; timeoutMs
  // não faz parte do schema do dispatch, então o default é aplicado).
  const { agentId, sessionKey, instruction, timeoutMs } = validateAgentTurnArgs(args, config);

  // OPENCLAW_GATEWAY_URL no ambiente do bridge → recusa (não usável sem
  // credenciais e nunca repassado ao filho).
  if (hasGatewayUrlOverride(env)) {
    throw new ToolError(ERROR_CATEGORIES.PERMISSION_DENIED, "Permission denied.");
  }

  const entry = resolveOpenclawEntry();
  const started = Date.now();
  const jobId = newJobId();

  // Cancelamento antes de adquirir o permit: nada foi iniciado.
  if (signal && signal.aborted) {
    throw new ToolError(ERROR_CATEGORIES.BUSY, "Request cancelled before dispatch");
  }

  // MESMO semáforo mutante do turn (max 1), aquisição NÃO-BLOQUEANTE: se já há
  // um turn OU dispatch em andamento → busy imediato.
  const release = turnSemaphore.tryAcquire();
  if (release === null) {
    logAgentTurnEvent("agent_dispatch_busy", { agentId, sessionKey, jobId, started });
    throw new ToolError(ERROR_CATEGORIES.BUSY, "A mutating operation is already in progress");
  }

  // Estado de posse do permit/tempfile. Enquanto os preflights rodam, uma falha
  // libera o permit AQUI (pré-spawn). Após um "started", a posse é TRANSFERIDA
  // ao ciclo de vida do filho (finalize) e NÃO liberamos aqui.
  let ownsPermit = true;
  let cleanup = null;

  const preSpawnCleanup = async () => {
    if (cleanup) {
      const status = await cleanup();
      if (status !== "ok") {
        logAgentTurnEvent("agent_dispatch_cleanup_failed", { jobId, started });
      }
      cleanup = null;
    }
    if (ownsPermit) {
      release();
      ownsPermit = false;
    }
  };

  try {
    // Env dos filhos: allowlist SEM alvo de Gateway (sem OPENCLAW_GATEWAY_URL/
    // PORT, sem credenciais).
    const childEnv = composeChildEnv();

    // PREFLIGHT 1 — loopback local (read-only, fail-closed). permission_denied
    // só quando a config prova destino não-loopback; gateway_required para
    // falha operacional/inconclusiva.
    await assertLocalLoopbackGateway({ signal, env: childEnv });

    // PREFLIGHT 2 — existência/roteamento da sessão (read-only), reutilizando a
    // validação FECHADA da Fase 2. O comando `openclaw agent` pode criar/rotear
    // uma sessão inexistente; por isso o preflight é obrigatório ANTES do
    // tempfile e do spawn.
    await preflightSessionExists({ sessionKey, agentId, signal, entry, env: childEnv });

    // Cancelamento entre o preflight e o spawn → pré-dispatch (nada iniciado).
    if (signal && signal.aborted) {
      throw new ToolError(ERROR_CATEGORIES.BUSY, "Request cancelled before dispatch");
    }

    // Tempfile seguro criado SOMENTE após os preflights.
    const handle = await writePromptTempfile(instruction);
    cleanup = handle.cleanup;

    // argv EXATO (idêntico ao turn): sem --message/--local/--deliver/model/
    // provider/thinking/channel/to/reply*/account/cwd.
    const cliSeconds = timeoutMsToCliSeconds(timeoutMs);
    const spawnArgs = [
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

    // Spawn desacoplado. A partir do evento `spawn`, o ciclo de vida do filho
    // passa a ser dono do tempfile e do permit (finalize os libera ao terminar).
    const outcome = await spawnDetached(entry, spawnArgs, {
      jobId,
      agentId,
      sessionKey,
      started,
      cleanup: handle.cleanup,
      release,
    });

    if (outcome.kind === "started") {
      // Posse transferida ao filho: NÃO liberamos permit/tempfile aqui.
      ownsPermit = false;
      cleanup = null;
      logAgentTurnEvent("agent_dispatch_started", { agentId, sessionKey, jobId, started });
      return { status: "started", jobId, source: "openclaw" };
    }

    // spawn_error ANTES do evento `spawn`: erro pré-dispatch, cleanup completo.
    await preSpawnCleanup();
    logAgentTurnEvent("agent_dispatch_spawn_error", { agentId, sessionKey, jobId, started });
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "Failed to start the dispatch");
  } catch (err) {
    // Qualquer erro pré-spawn (preflights, tempfile, cancelamento, spawn_error):
    // cleanup completo do que foi adquirido. Após um "started" bem-sucedido este
    // catch não é alcançado (retornamos antes).
    await preSpawnCleanup();
    throw err;
  }
}

// Exposto para testes de ciclo de vida/jobId.
export const __testing = { newJobId };
