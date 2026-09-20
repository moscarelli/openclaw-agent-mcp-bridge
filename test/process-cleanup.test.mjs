import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runOpenclaw, setTestChildEnv } from "../src/openclaw/runner.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";
import { fakeEntry } from "./helpers/fixture.mjs";

// Verifica que apenas o processo filho OpenClaw é terminado — nunca o processo
// pai (test runner). Registra PIDs de pai e filho e confirma que o pai
// sobrevive e o filho é encerrado.

function isAlive(pid) {
  try {
    process.kill(pid, 0); // sinal 0: só testa existência/permissão
    return true;
  } catch (err) {
    return err.code === "EPERM"; // existe mas sem permissão = vivo
  }
}

async function waitUntilDead(pid, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await delay(100);
  }
  return !isAlive(pid);
}

// Aguarda de forma DETERMINÍSTICA e BOUNDED até que o arquivo de PID exista e
// contenha um PID válido (a fixture só o escreve depois de nascer). Evita a
// corrida de ler o PID antes de a fixture o gravar. Não usa sleep fixo como
// garantia. Retorna o childPid ou lança se estourar o timeout.
async function waitForChildPid(pidFile, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(pidFile)) {
      const raw = readFileSync(pidFile, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await delay(25);
  }
  throw new Error(`child pid file not ready within ${timeoutMs}ms`);
}

test("timeout terminates only the child, never the parent process", async () => {
  const parentPid = process.pid;
  const dir = mkdtempSync(join(tmpdir(), "ocmcp-pid-"));
  const pidFile = join(dir, "child.pid");

  // A fake CLI (pid_sleep) escreve o PID em stdout; capturamos via um wrapper
  // que grava o PID em arquivo. Como o runner não expõe o filho, usamos o modo
  // pid_sleep e lemos o PID que ele imprime — mas o runner rejeita no timeout
  // sem devolver stdout. Então injetamos um arquivo de PID pela fake CLI.
  setTestChildEnv({ FAKE_MODE: "pid_sleep", FAKE_PID_FILE: pidFile });
  try {
    await assert.rejects(
      () => runOpenclaw(fakeEntry, ["sessions", "--json"], { timeoutMs: 400 }),
      (err) => isToolError(err) && err.category === ERROR_CATEGORIES.TIMEOUT,
    );

    // O pai (test runner) DEVE continuar vivo — o fato de o teste prosseguir já
    // é prova; ainda assim asseguramos explicitamente.
    assert.ok(isAlive(parentPid), "parent process must stay alive");

    // O filho deve ter sido encerrado (leitura determinística do PID).
    const childPid = await waitForChildPid(pidFile);
    assert.notEqual(childPid, parentPid, "child pid differs from parent");

    const dead = await waitUntilDead(childPid);
    assert.ok(dead, `child pid ${childPid} should be terminated`);
    assert.ok(isAlive(parentPid), "parent process still alive after child cleanup");
  } finally {
    setTestChildEnv(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child that ignores the first signal is still force-killed; parent survives", async () => {
  const parentPid = process.pid;
  const dir = mkdtempSync(join(tmpdir(), "ocmcp-pid-"));
  const pidFile = join(dir, "child.pid");

  // Filho resiste a SIGTERM/SIGINT/SIGHUP → só o SIGKILL (após grace) o encerra.
  setTestChildEnv({ FAKE_MODE: "resist_sigterm", FAKE_PID_FILE: pidFile });
  try {
    // Timeout curto dispara a terminação; grace + SIGKILL fecham o filho.
    await assert.rejects(
      () => runOpenclaw(fakeEntry, ["sessions", "--json"], { timeoutMs: 400 }),
      (err) => isToolError(err) && err.category === ERROR_CATEGORIES.TIMEOUT,
    );

    // (a) A Promise rejeitou (acima). (b) O filho realmente deixou de existir.
    const childPid = await waitForChildPid(pidFile);
    const dead = await waitUntilDead(childPid, 10000);
    assert.ok(dead, `resistant child pid ${childPid} should be force-killed`);

    // (c) O pai permanece vivo.
    assert.ok(isAlive(parentPid), "parent must stay alive after force-kill");
  } finally {
    setTestChildEnv(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abort via signal terminates only the child; parent survives", async () => {
  const parentPid = process.pid;
  const dir = mkdtempSync(join(tmpdir(), "ocmcp-pid-"));
  const pidFile = join(dir, "child.pid");
  const ac = new AbortController();

  setTestChildEnv({ FAKE_MODE: "pid_sleep", FAKE_PID_FILE: pidFile });
  try {
    const p = runOpenclaw(fakeEntry, ["sessions", "--json"], { signal: ac.signal, timeoutMs: 30000 });
    // Sincronização DETERMINÍSTICA: só aborta depois que a fixture confirmou o
    // nascimento gravando o PID (ready signal via arquivo, com timeout bounded).
    // Sem sleep fixo como garantia.
    const childPid = await waitForChildPid(pidFile);
    ac.abort();
    await assert.rejects(p, (err) => isToolError(err) && err.category === ERROR_CATEGORIES.TIMEOUT);

    // Só o filho morre; o pai (test runner) sobrevive.
    assert.ok(isAlive(parentPid), "parent must stay alive after abort");
    const dead = await waitUntilDead(childPid);
    assert.ok(dead, `child pid ${childPid} should be terminated after abort`);
    assert.ok(isAlive(parentPid), "parent still alive after child cleanup");
  } finally {
    setTestChildEnv(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
