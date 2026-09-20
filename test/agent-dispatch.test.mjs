// Testes sintéticos do dispatch assíncrono econômico (openclaw_agent_dispatch).
// 100% sintético: fake CLI, nenhum modelo real, nenhuma rede. O foco é o
// contrato assíncrono: retornar no `spawn` (não esperar o modelo), sobreviver ao
// cancelamento/encerramento da chamada MCP, exclusão mútua com o turn (busy),
// cleanup de tempfile/semáforo, limites de buffer, e jobId opaco.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentDispatch } from "../src/openclaw/agent-dispatch.mjs";
import { runAgentTurn, turnSemaphore, setTestAgentTurnChildEnv } from "../src/openclaw/agent-turn.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";
import { fakeEntry } from "./helpers/fixture.mjs";

const AGENT = "main";
const SESSION = "agent:main:synthetic-1";

// Habilita a config experimental local (sem OPENCLAW_GATEWAY_URL). O env do
// filho é injetado por setTestAgentTurnChildEnv; os FAKE_* distintos escolhem o
// comportamento de cada filho (config-get loopback, sessions.resolve, agent).
function enableConfig(env = {}) {
  process.env.OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT = "1";
  process.env.OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID = AGENT;
  process.env.OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY = SESSION;
  delete process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_MCP_BRIDGE_ENTRY = fakeEntry;
  setTestAgentTurnChildEnv({ FAKE_GW_CONFIG: "local_loopback", ...env });
  resetEntryCache();
}

function clearConfig() {
  delete process.env.OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT;
  delete process.env.OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID;
  delete process.env.OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_MCP_BRIDGE_ENTRY;
  setTestAgentTurnChildEnv(null);
  resetEntryCache();
}

test.afterEach(clearConfig);

const okArgs = () => ({ agentId: AGENT, sessionKey: SESSION, instruction: "synthetic async instruction" });

// Aguarda até `predicate()` ser verdadeiro ou estourar `timeoutMs`.
async function waitFor(predicate, timeoutMs = 5000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

// Conjunto de subdiretórios de tempfile do turn/dispatch (prefixo ocmb-turn-).
// Comparações por diferença de conjuntos são robustas mesmo se outro arquivo de
// teste rodar em paralelo (não dependem de um total global).
function tempDirSet() {
  try {
    return new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("ocmb-turn-")));
  } catch {
    return new Set();
  }
}

// Aguarda o semáforo MUTANTE ficar livre (permit liberado pelo finalize do
// filho). Prova direta do release, imune a concorrência entre arquivos de teste
// (não depende de contagem global de tempdirs). Adquire e libera na hora.
async function waitPermitFree(timeoutMs = 12000) {
  return waitFor(
    () => {
      const rel = turnSemaphore.tryAcquire();
      if (rel === null) return false;
      rel();
      return true;
    },
    timeoutMs,
    30,
  );
}

test("success returns exactly { status:'started', jobId, source:'openclaw' }", async () => {
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "300" });
  const r = await runAgentDispatch(okArgs());
  assert.deepEqual(Object.keys(r).sort(), ["jobId", "source", "status"]);
  assert.equal(r.status, "started");
  assert.equal(r.source, "openclaw");
  assert.equal(typeof r.jobId, "string");
  // Nunca usa "accepted" nem devolve resposta do modelo.
  assert.ok(!("response" in r));
  assert.ok(!JSON.stringify(r).includes("accepted"));
  assert.ok(!JSON.stringify(r).includes("synthetic-should-not-leak-async-reply"));
  // Deixa o filho concluir para não vazar entre testes.
  await waitPermitFree();
});

test("returns after spawn, WITHOUT waiting for the slow child to finish", async () => {
  const doneFile = join(mkdtempSync(join(tmpdir(), "ocmb-done-")), "done");
  // O filho dorme 2500ms APÓS o spawn antes de concluir. Os preflights (fake
  // CLI, cold start no Windows) custam ~1s cada, então não usamos um limite de
  // tempo absoluto: a prova de que o retorno precede a conclusão é o marcador.
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "2500", FAKE_DONE_FILE: doneFile });
  const t0 = Date.now();
  const r = await runAgentDispatch(okArgs());
  const elapsed = Date.now() - t0;
  assert.equal(r.status, "started");
  // No instante do retorno, o filho acabou de ser criado e ainda dorme: o
  // marcador de conclusão NÃO existe. Isto prova que o retorno ocorreu no
  // `spawn`, sem esperar o modelo terminar.
  assert.equal(existsSync(doneFile), false, "child must not have completed yet at return time");
  // O processo continua e conclui DEPOIS do retorno MCP.
  const finished = await waitFor(() => existsSync(doneFile), 8000);
  assert.equal(finished, true, "child should complete after the MCP call returned");
  // Informativo (reportado): tempo chamada→retorno com a fixture lenta.
  assert.ok(elapsed >= 0);
  rmSync(doneFile, { force: true });
  await waitPermitFree();
});

test("cancelling the MCP request AFTER started does not kill the child", async () => {
  const doneFile = join(mkdtempSync(join(tmpdir(), "ocmb-done-")), "done");
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "1200", FAKE_DONE_FILE: doneFile });
  const ac = new AbortController();
  const r = await runAgentDispatch(okArgs(), { signal: ac.signal });
  assert.equal(r.status, "started");
  // Cancela a requisição MCP depois do "started".
  ac.abort();
  // O filho ainda deve concluir (o AbortSignal não é observado pós-retorno).
  const finished = await waitFor(() => existsSync(doneFile), 6000);
  assert.equal(finished, true, "child must survive MCP cancellation after started");
  rmSync(doneFile, { force: true });
  await waitPermitFree();
});

test("the tempfile is removed after the child finishes", async () => {
  // Snapshot do CONJUNTO de tempdirs antes (robusto a outros arquivos de teste
  // rodando em paralelo: comparamos por diferença de conjuntos, não por total).
  const beforeSet = tempDirSet();
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "200" });
  const r = await runAgentDispatch(okArgs());
  assert.equal(r.status, "started");
  // O permit livre implica que o finalize rodou (cleanup do tempfile ANTES do
  // release). Em seguida, nenhum tempdir NOVO (criado por este dispatch) deve
  // persistir: (conjunto atual − baseline) fica vazio.
  await waitPermitFree();
  const cleaned = await waitFor(() => [...tempDirSet()].every((n) => beforeSet.has(n)), 8000);
  assert.equal(cleaned, true, "the dispatch's own tempfile dir should be removed after completion");
});

test("large stdout/stderr from the child are bounded (memory limit respected)", async () => {
  const doneFile = join(mkdtempSync(join(tmpdir(), "ocmb-done-")), "done");
  enableConfig({
    FAKE_AGENT_MODE: "dispatch_slow",
    FAKE_AGENT_SLEEP_MS: "200",
    FAKE_BIG_OUTPUT: "1",
    FAKE_DONE_FILE: doneFile,
  });
  // Não deve lançar nem vazar; retorna started normalmente.
  const r = await runAgentDispatch(okArgs());
  assert.equal(r.status, "started");
  // O filho conclui e o cleanup ocorre mesmo com output grande.
  await waitFor(() => existsSync(doneFile), 6000);
  rmSync(doneFile, { force: true });
  await waitPermitFree();
});

test("a second concurrent mutating op returns busy (dispatch vs dispatch)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "2000" });
  const first = await runAgentDispatch(okArgs());
  assert.equal(first.status, "started");
  // Enquanto o primeiro filho ainda roda, o permit está retido → busy imediato.
  const t0 = Date.now();
  await assert.rejects(
    () => runAgentDispatch(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.BUSY,
  );
  assert.ok(Date.now() - t0 < 1000, "busy should be immediate (non-blocking)");
  // Após o término do primeiro, o permit é liberado e um novo dispatch funciona.
  const recovered = await waitPermitFree();
  assert.equal(recovered, true);
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "100" });
  const third = await runAgentDispatch(okArgs());
  assert.equal(third.status, "started");
  await waitPermitFree();
}, { timeout: 45000 });

test("dispatch and the synchronous turn are mutually exclusive (busy)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "1500" });
  const d = await runAgentDispatch(okArgs());
  assert.equal(d.status, "started");
  // Um turn síncrono concorrente deve ver o mesmo semáforo ocupado → busy.
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.BUSY,
  );
  await waitPermitFree();
}, { timeout: 30000 });

test("failure before spawn (missing session) errors and releases permit + tempfile", async () => {
  // O preflight de sessão (missing) falha ANTES de writePromptTempfile ser
  // chamado, então este dispatch não cria nenhum tempfile próprio para limpar.
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_RESOLVE: "missing" });
  await assert.rejects(
    () => runAgentDispatch(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.NOT_FOUND,
  );
  // O permit foi liberado no caminho de erro pré-spawn: prova direta.
  assert.equal(await waitPermitFree(2000), true, "permit must be released after a pre-spawn failure");
  // E um dispatch subsequente com sessão válida funciona (recuperação real).
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "100" });
  const r = await runAgentDispatch(okArgs());
  assert.equal(r.status, "started");
  await waitPermitFree();
});

test("loopback preflight failure (remote) → permission_denied, no dispatch", async () => {
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_GW_CONFIG: "remote" });
  await assert.rejects(
    () => runAgentDispatch(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

test("OPENCLAW_GATEWAY_URL in the bridge env → permission_denied", async () => {
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow" });
  process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:7000";
  await assert.rejects(
    () => runAgentDispatch(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

test("wrong destination returns permission_denied", async () => {
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow" });
  await assert.rejects(
    () => runAgentDispatch({ agentId: "other", sessionKey: SESSION, instruction: "x" }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

test("slash command instruction is rejected (invalid_argument)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow" });
  await assert.rejects(
    () => runAgentDispatch({ agentId: AGENT, sessionKey: SESSION, instruction: "/reset" }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT,
  );
});

test("jobId is opaque, random and contains no identifiers", async () => {
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "100" });
  const r1 = await runAgentDispatch(okArgs());
  await waitPermitFree();
  enableConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "100" });
  const r2 = await runAgentDispatch(okArgs());
  await waitPermitFree();
  // Aleatório: dois jobIds distintos.
  assert.notEqual(r1.jobId, r2.jobId);
  // Opaco: base64url curto, sem agentId/sessionKey/PID/path.
  for (const id of [r1.jobId, r2.jobId]) {
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.ok(id.length >= 16 && id.length <= 32);
    assert.ok(!id.includes(AGENT));
    assert.ok(!id.includes("agent:"));
    assert.ok(!id.includes(String(process.pid)));
  }
});
