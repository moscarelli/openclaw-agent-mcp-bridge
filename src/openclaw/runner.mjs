// Execução sem shell do entrypoint OpenClaw (PHASE1_PLAN §5, §8).
// spawn(process.execPath, [entryJs, ...args]) — nunca cmd.exe, nunca shell.
// Timeout, maxBuffer, cancelamento e término seguro do processo filho.
//
// SEGURANÇA DE TÉRMINO (crítico): terminamos SOMENTE pelo handle do próprio
// ChildProcess (child.kill(...)). NÃO usamos `taskkill` nem `/T`: matar a
// árvore de um PID que já saiu (e cujo PID pode ter sido reutilizado pelo
// shell/test runner/servidor) derrubaria o processo errado. Também NUNCA
// usamos `child.killed` como prova de saída — ele só indica que um sinal foi
// entregue. A prova de término é `childExited`/`exitCode`/`signalCode`. O grace
// timer é sempre cancelado quando o filho emite exit/close.

import { spawn } from "node:child_process";
import { buildChildEnv } from "../lib/env-allowlist.mjs";
import { childProcessSemaphore } from "../lib/concurrency.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import { DEFAULT_CALL_TIMEOUT_MS, CLI_MAX_BUFFER_BYTES, KILL_GRACE_MS } from "../lib/limits.mjs";

// Injeção de env EXCLUSIVA para testes. Produção nunca a usa.
let testChildEnv = null;

/** Test-only: define entradas extras de env para o processo filho. */
export function setTestChildEnv(extra) {
  testChildEnv = extra && typeof extra === "object" ? { ...extra } : null;
}

function composeEnv(optionEnv) {
  const base = optionEnv ?? buildChildEnv();
  if (testChildEnv) return { ...base, ...testChildEnv };
  return base;
}

/**
 * Force-kill APENAS pelo handle do próprio ChildProcess (nunca taskkill, nunca
 * árvore, nunca PID solto que possa ter sido reutilizado). Só age se o filho
 * ainda não terminou, comprovado por `hasExited` (childExited/exitCode/
 * signalCode) — NUNCA por child.killed, que apenas indica que um sinal foi
 * entregue, não que o processo saiu.
 */
function forceKillExact(child, hasExited) {
  if (hasExited()) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* noop: o filho pode ter saído entre a checagem e o envio */
  }
}

/**
 * Executa `node <entryJs> <args...>` capturando stdout/stderr com limites.
 *
 * @param {string} entryJs caminho validado do entrypoint OpenClaw
 * @param {string[]} args argumentos (array; nunca string concatenada)
 * @param {object} options { timeoutMs, signal, env }
 * @returns {Promise<{ stdout: string, exitCode: number|null }>}
 */
export async function runOpenclaw(entryJs, args, options = {}) {
  if (!Array.isArray(args)) {
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "args must be an array");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const externalSignal = options.signal;

  const release = await childProcessSemaphore.acquire();

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let childExited = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    let timedOut = false;
    let tooLarge = false;
    let terminating = false;

    // Timers próprios do escopo, sempre cancelados no cleanup.
    let overallTimer = null;
    let graceTimer = null;
    let settleFallbackTimer = null;

    let child;
    try {
      child = spawn(process.execPath, [entryJs, ...args], {
        shell: false,
        windowsHide: true,
        env: composeEnv(options.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      release();
      rejectPromise(
        new ToolError(ERROR_CATEGORIES.CLI_UNAVAILABLE, `Failed to spawn OpenClaw: ${err?.code ?? "error"}`),
      );
      return;
    }

    const clearAllTimers = () => {
      if (overallTimer) clearTimeout(overallTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      overallTimer = graceTimer = settleFallbackTimer = null;
    };

    // Resolve/rejeita a Promise UMA vez. NUNCA encerra o processo atual
    // (servidor MCP / test runner / shell): apenas assenta esta chamada.
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
      release();
      fn();
    };

    const rejectWith = (category, message) => finish(() => rejectPromise(new ToolError(category, message)));

    // "Terminou de verdade" = emitiu exit/close, OU o handle reporta exitCode/
    // signalCode não-nulos. NUNCA usamos child.killed (que só indica sinal
    // entregue, não saída efetiva).
    const hasExited = () => childExited || child.exitCode !== null || child.signalCode !== null;

    // Sequência de término, apenas pelo handle do ChildProcess:
    //   POSIX:   SIGTERM → aguarda grace → SIGKILL (se ainda não saiu);
    //   Windows: SIGKILL direto no handle (não há SIGTERM real; o handle
    //            encerra somente este processo, sem árvore).
    // O grace timer é cancelado assim que o filho emite exit/close.
    const beginTermination = () => {
      if (terminating || hasExited()) return;
      terminating = true;

      // Settle garantido caso 'close' nunca venha (pipes presos) — armado para
      // ambas as plataformas antes de qualquer kill.
      settleFallbackTimer = setTimeout(() => {
        if (settled) return;
        if (tooLarge) return rejectWith(ERROR_CATEGORIES.OUTPUT_TOO_LARGE, "Output exceeded limit");
        if (externalSignal && externalSignal.aborted) {
          return rejectWith(ERROR_CATEGORIES.TIMEOUT, "OpenClaw call cancelled");
        }
        return rejectWith(ERROR_CATEGORIES.TIMEOUT, "OpenClaw call timed out");
      }, KILL_GRACE_MS + 1500);
      if (typeof settleFallbackTimer.unref === "function") settleFallbackTimer.unref();

      if (process.platform === "win32") {
        // Windows não tem SIGTERM cooperativo; encerra o handle diretamente
        // (SIGKILL no ChildProcess mata só este processo, sem árvore).
        forceKillExact(child, hasExited);
        return;
      }

      // POSIX: tenta SIGTERM primeiro (encerramento gracioso), depois SIGKILL.
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
      graceTimer = setTimeout(() => {
        graceTimer = null;
        // Reavalia por exitCode/signalCode/childExited (nunca child.killed).
        forceKillExact(child, hasExited);
      }, KILL_GRACE_MS);
      if (typeof graceTimer.unref === "function") graceTimer.unref();
    };

    overallTimer = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, timeoutMs);
    if (typeof overallTimer.unref === "function") overallTimer.unref();

    const onAbort = () => {
      beginTermination();
    };
    if (externalSignal) {
      if (externalSignal.aborted) onAbort();
      else externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    // 'exit' vem antes de 'close'. Registramos que o filho terminou para
    // cancelar imediatamente o grace timer e impedir qualquer force-kill de
    // um PID que a partir daqui pode ser reutilizado.
    child.on("exit", () => {
      childExited = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    });

    child.on("error", (err) => {
      childExited = true;
      rejectWith(ERROR_CATEGORIES.CLI_UNAVAILABLE, `Failed to spawn OpenClaw: ${err?.code ?? "error"}`);
    });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > CLI_MAX_BUFFER_BYTES) {
        tooLarge = true;
        beginTermination();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > CLI_MAX_BUFFER_BYTES) {
        tooLarge = true;
        beginTermination();
      }
    });

    child.on("close", (code) => {
      childExited = true;
      if (tooLarge) return rejectWith(ERROR_CATEGORIES.OUTPUT_TOO_LARGE, "Output exceeded limit");
      if (timedOut) return rejectWith(ERROR_CATEGORIES.TIMEOUT, "OpenClaw call timed out");
      if (externalSignal && externalSignal.aborted) {
        return rejectWith(ERROR_CATEGORIES.TIMEOUT, "OpenClaw call cancelled");
      }
      finish(() =>
        resolvePromise({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          exitCode: code,
        }),
      );
    });
  });
}
