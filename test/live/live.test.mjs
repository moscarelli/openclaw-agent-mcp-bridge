// Testes de integração REAIS com o OpenClaw instalado (PHASE1_PLAN §10.5).
// SKIP por padrão. Habilite com OPENCLAW_MCP_BRIDGE_LIVE=1.
//
// Cenários separados e verificáveis (ver docs/LIVE_VALIDATION.md):
//   - agents_list: agentes reais, sem paths/segredos.
//   - sessions_list (Gateway ATIVO): exige source === "gateway".
//   - sessions_list paginação: exercita nextCursor quando há mais de uma página.
//   - session_get: usa uma sessionKey real fornecida SÓ por env local.
//   - fallback CLI: rodar em execução SEPARADA com o Gateway indisponível.
//   - session_get gateway_required: rodar SEPARADO com o Gateway parado.
//
// Gates de ambiente (o operador liga o que se aplica ao cenário):
//   OPENCLAW_MCP_BRIDGE_LIVE=1                 habilita a suíte live
//   OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_UP=1      Gateway está em execução
//   OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_DOWN=1    Gateway está parado
//   OPENCLAW_MCP_BRIDGE_LIVE_SESSION_KEY=...   chave real p/ session_get
//
// Nunca imprime nem persiste sessões reais: as asserções olham apenas forma,
// contagem e ausência de vazamento; não serializam nem logam conteúdo.

import assert from "node:assert/strict";
import test from "node:test";

const LIVE = process.env.OPENCLAW_MCP_BRIDGE_LIVE === "1";
const skip = LIVE ? false : "set OPENCLAW_MCP_BRIDGE_LIVE=1 to run live tests";

const GATEWAY_UP = process.env.OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_UP === "1";
const GATEWAY_DOWN = process.env.OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_DOWN === "1";
const REAL_SESSION_KEY = process.env.OPENCLAW_MCP_BRIDGE_LIVE_SESSION_KEY;
// Agente para escopar as consultas ao Gateway. Consultas por agente evitam
// stores agregados que possam estar indisponíveis nesta máquina; o padrão é
// "main" e pode ser sobrescrito por env.
const LIVE_AGENT = process.env.OPENCLAW_MCP_BRIDGE_LIVE_AGENT || "main";

// Padrões de vazamento (caminho de diretório de usuário).
const WIN_USER = /[A-Za-z]:\\Users\\/i;
const NIX_USER = /\/(home|Users)\/[^/]+\//i;

function assertNoLeak(value) {
  const serialized = JSON.stringify(value);
  assert.ok(!WIN_USER.test(serialized), "no windows user path");
  assert.ok(!NIX_USER.test(serialized), "no unix user path");
}

test("live: agents_list returns real agents without paths or secrets", { skip }, async () => {
  const { listAgents } = await import("../../src/openclaw/agents.mjs");
  const result = await listAgents({ limit: 100 });
  assert.ok(Array.isArray(result.agents));
  assertNoLeak(result);
  for (const agent of result.agents) {
    assert.ok(typeof agent.id === "string");
    assert.deepEqual(Object.keys(agent).sort(), agent.model ? ["id", "model"] : ["id"]);
  }
});

test("live: sessions_list requires source gateway when the Gateway is up", { skip }, async (t) => {
  if (!GATEWAY_UP) {
    t.skip("set OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_UP=1 with the Gateway running");
    return;
  }
  const { listSessions } = await import("../../src/openclaw/sessions.mjs");
  // Consulta escopada por agente: o caminho do Gateway deve ser usado.
  const result = await listSessions({ agentId: LIVE_AGENT, limit: 10 });
  assert.equal(result.source, "gateway");
  assert.ok(Array.isArray(result.sessions));
  for (const s of result.sessions) {
    assert.ok(typeof s.key === "string");
    assert.equal("path" in s, false);
  }
  assertNoLeak(result.sessions.map((s) => ({ ...s, key: "[key]", model: s.model ? "[model]" : undefined })));
});

test("live: sessions_list paginates via nextCursor when there is more than one page", { skip }, async (t) => {
  if (!GATEWAY_UP) {
    t.skip("set OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_UP=1 with the Gateway running");
    return;
  }
  const { listSessions } = await import("../../src/openclaw/sessions.mjs");
  const filters = { agentId: LIVE_AGENT, limit: 1 };
  const first = await listSessions(filters);
  assert.equal(first.source, "gateway");
  if (!first.hasMore || !first.nextCursor) {
    t.skip("not enough sessions to paginate");
    return;
  }
  const second = await listSessions({ ...filters, cursor: first.nextCursor });
  assert.equal(second.source, "gateway");
  assert.ok(Array.isArray(second.sessions));
  // A segunda página não deve repetir a chave da primeira (avançou o offset).
  if (first.sessions.length && second.sessions.length) {
    assert.notEqual(first.sessions[0].key, second.sessions[0].key);
  }
});

test("live: session_get returns metadata for a real key provided via env", { skip }, async (t) => {
  if (!GATEWAY_UP || !REAL_SESSION_KEY) {
    t.skip("set OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_UP=1 and OPENCLAW_MCP_BRIDGE_LIVE_SESSION_KEY=<key>");
    return;
  }
  const { getSession } = await import("../../src/openclaw/sessions.mjs");
  const result = await getSession({ sessionKey: REAL_SESSION_KEY });
  assert.equal(result.source, "gateway");
  assert.equal(result.key, REAL_SESSION_KEY);
  // Só metadados; nunca transcrição/conteúdo.
  const allowed = new Set(["agentId", "key", "model", "source"]);
  for (const k of Object.keys(result)) assert.ok(allowed.has(k), `unexpected field ${k}`);
});

test("live: fallback CLI is used when the Gateway is unavailable", { skip }, async (t) => {
  if (!GATEWAY_DOWN) {
    t.skip("run separately with OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_DOWN=1 and the Gateway stopped");
    return;
  }
  const { listSessions } = await import("../../src/openclaw/sessions.mjs");
  const result = await listSessions({ allAgents: true, limit: 25 });
  assert.equal(result.source, "cli");
  assert.equal(result.nextCursor, undefined);
  for (const s of result.sessions) assert.equal("path" in s, false);
});

test("live: session_get returns gateway_required when the Gateway is stopped", { skip }, async (t) => {
  if (!GATEWAY_DOWN) {
    t.skip("run separately with OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_DOWN=1 and the Gateway stopped");
    return;
  }
  const { getSession } = await import("../../src/openclaw/sessions.mjs");
  const { isToolError, ERROR_CATEGORIES } = await import("../../src/lib/errors.mjs");
  await assert.rejects(
    () => getSession({ sessionKey: "agent:main:does-not-exist" }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
});
