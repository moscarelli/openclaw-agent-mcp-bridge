import assert from "node:assert/strict";
import test from "node:test";
import { fakeEntry } from "./helpers/fixture.mjs";
import { runOpenclaw, setTestChildEnv } from "../src/openclaw/runner.mjs";
import { listAgents } from "../src/openclaw/agents.mjs";
import { listSessions, getSession } from "../src/openclaw/sessions.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";

// Aponta o locator para a fake CLI e injeta as flags FAKE_* no env do filho
// via o ponto de injeção EXCLUSIVO de testes do runner (setTestChildEnv). Não
// há passthrough de env em produção.
function useFakeEntry(extraEnv = {}) {
  process.env.OPENCLAW_MCP_BRIDGE_ENTRY = fakeEntry;
  setTestChildEnv(extraEnv);
  resetEntryCache();
}

function clearFakeEnv() {
  delete process.env.OPENCLAW_MCP_BRIDGE_ENTRY;
  setTestChildEnv(null);
  resetEntryCache();
}

test.afterEach(clearFakeEnv);

test("agents_list returns only id/model (no paths/secrets)", async () => {
  useFakeEntry();
  const result = await listAgents({ limit: 100 });
  assert.equal(result.count, 2);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("/synthetic"));
  assert.ok(!serialized.includes("workspace"));
  assert.deepEqual(result.agents[0], { id: "main", model: "synthetic/model-1" });
});

test("agents_list applies limit after parsing", async () => {
  useFakeEntry();
  const result = await listAgents({ limit: 1 });
  assert.equal(result.count, 1);
});

test("sessions_list uses gateway and paginates via nextCursor", async () => {
  useFakeEntry({ FAKE_SESSION_TOTAL: "250" });
  const first = await listSessions({ allAgents: false, limit: 100 });
  assert.equal(first.source, "gateway");
  assert.equal(first.hasMore, true);
  assert.ok(typeof first.nextCursor === "string");
  // Nenhum path/secret vaza.
  assert.ok(!JSON.stringify(first).includes("/synthetic"));
  assert.ok(!JSON.stringify(first).includes("should-not-leak"));

  const second = await listSessions({ allAgents: false, limit: 100, cursor: first.nextCursor });
  assert.equal(second.source, "gateway");
  assert.equal(second.sessions[0].key, "agent:main:synthetic-100");
});

test("sessions_list rejects a cursor reused in a different scope", async () => {
  useFakeEntry({ FAKE_SESSION_TOTAL: "250" });
  const first = await listSessions({ allAgents: false, limit: 100 });
  await assert.rejects(
    () => listSessions({ agentId: "work", limit: 100, cursor: first.nextCursor }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT,
  );
});

test("sessions_list falls back to CLI when gateway is down (no cursor)", async () => {
  useFakeEntry({ FAKE_MODE: "gateway_down", FAKE_SESSION_TOTAL: "3" });
  const result = await listSessions({ allAgents: false, limit: 100 });
  assert.equal(result.source, "cli");
  assert.equal(result.nextCursor, undefined);
});

test("session_get finds a known key via gateway scan", async () => {
  useFakeEntry({ FAKE_SESSION_TOTAL: "250" });
  const result = await getSession({ sessionKey: "agent:main:synthetic-200" });
  assert.equal(result.source, "gateway");
  assert.equal(result.key, "agent:main:synthetic-200");
  assert.ok(!JSON.stringify(result).includes("/synthetic/home"));
});

test("session_get concludes not_found only after exhausting the set", async () => {
  useFakeEntry({ FAKE_SESSION_TOTAL: "10" });
  await assert.rejects(
    () => getSession({ sessionKey: "agent:main:synthetic-9999" }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.NOT_FOUND,
  );
});

test("session_get returns gateway_required when the gateway is down", async () => {
  useFakeEntry({ FAKE_MODE: "gateway_down" });
  await assert.rejects(
    () => getSession({ sessionKey: "agent:main:synthetic-1" }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
});

test("runner rejects with timeout on a slow child and leaves no output", async () => {
  useFakeEntry({ FAKE_MODE: "slow" });
  await assert.rejects(
    () => runOpenclaw(fakeEntry, ["sessions", "--json"], { timeoutMs: 200 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.TIMEOUT,
  );
});

test("runner rejects with output_too_large on huge output", async () => {
  useFakeEntry({ FAKE_MODE: "huge" });
  await assert.rejects(
    () => runOpenclaw(fakeEntry, ["agents", "list", "--json"], {}),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.OUTPUT_TOO_LARGE,
  );
});

test("malformed JSON becomes an internal error, not a leak", async () => {
  useFakeEntry({ FAKE_MODE: "malformed" });
  await assert.rejects(
    () => listAgents({ limit: 100 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
});

test("gateway call is issued without credential flags", async () => {
  useFakeEntry({ FAKE_SESSION_TOTAL: "3", FAKE_FAIL_IF_CRED: "1" });
  // Se qualquer flag de credencial for passada, o fake sai com código 3 →
  // gateway_unavailable; então um sucesso confirma a ausência de credenciais.
  const result = await listSessions({ allAgents: false, limit: 100 });
  assert.equal(result.source, "gateway");
});

test("child env excludes NODE_OPTIONS and secret-looking keys", async () => {
  // FAKE_ECHO_ENV é injetado só pelo canal de teste; NODE_OPTIONS e um token
  // ficam apenas no process.env do pai e NÃO devem chegar ao filho.
  useFakeEntry({ FAKE_ECHO_ENV: "1" });
  process.env.NODE_OPTIONS = "--require ./x.js";
  process.env.OPENCLAW_SNEAKY_TOKEN = "synthetic";
  const result = await runOpenclaw(fakeEntry, ["--echo"], {});
  const parsed = JSON.parse(result.stdout);
  assert.ok(!parsed.envKeys.includes("NODE_OPTIONS"));
  assert.ok(!parsed.envKeys.includes("OPENCLAW_SNEAKY_TOKEN"));
  assert.ok(parsed.envKeys.includes("FAKE_ECHO_ENV"));
  delete process.env.NODE_OPTIONS;
  delete process.env.OPENCLAW_SNEAKY_TOKEN;
});
