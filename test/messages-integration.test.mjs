import assert from "node:assert/strict";
import test from "node:test";
import { fakeEntry } from "./helpers/fixture.mjs";
import { setTestChildEnv } from "../src/openclaw/runner.mjs";
import { listSessionMessages } from "../src/openclaw/messages.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";
import {
  CHAT_HISTORY_TIMEOUT_MS,
  GATEWAY_RPC_EXTENDED_TIMEOUT_MAX_MS,
  GATEWAY_RPC_TIMEOUT_MS,
} from "../src/lib/limits.mjs";

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

const KEY = "agent:main:synthetic-1";

test("first page: metadata-only, source gateway, hostile content absent", async () => {
  useFakeEntry({ FAKE_MESSAGE_TOTAL: "3" });
  const result = await listSessionMessages({ sessionKey: KEY, limit: 50 });
  assert.equal(result.source, "gateway");
  assert.equal(result.count, 3);
  assert.equal(result.hasMore, false);
  for (const m of result.messages) {
    assert.deepEqual(
      Object.keys(m).filter((k) => !["role", "timestamp"].includes(k)),
      [],
    );
    assert.ok(!("messageId" in m));
  }
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("IGNORE_PREVIOUS_INSTRUCTIONS"));
  assert.ok(!serialized.includes("should-not-leak"));
  assert.ok(!serialized.includes("synthetic-idem"));
  assert.ok(!serialized.includes("provenance"));
  assert.ok(!serialized.includes("__openclaw"));
});

test("pagination: nextCursor advances to the next page", async () => {
  useFakeEntry({ FAKE_MESSAGE_TOTAL: "250" });
  const first = await listSessionMessages({ sessionKey: KEY, limit: 100 });
  assert.equal(first.hasMore, true);
  assert.ok(typeof first.nextCursor === "string");
  const second = await listSessionMessages({ sessionKey: KEY, limit: 100, cursor: first.nextCursor });
  assert.equal(second.source, "gateway");
  // messageId é omitido; provamos o avanço do offset pelo timestamp sintético
  // da fixture (1700000000000 + i), i.e. o item 100 abre a segunda página.
  assert.equal(second.messages[0].timestamp, 1700000000000 + 100);
});

test("no nextCursor when there are no more pages", async () => {
  useFakeEntry({ FAKE_MESSAGE_TOTAL: "3" });
  const result = await listSessionMessages({ sessionKey: KEY, limit: 100 });
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, undefined);
});

test("cursor reused in a different scope → invalid_argument", async () => {
  useFakeEntry({ FAKE_MESSAGE_TOTAL: "250" });
  const first = await listSessionMessages({ sessionKey: KEY, limit: 100 });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: "agent:main:synthetic-2", limit: 100, cursor: first.nextCursor }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT,
  );
});

test("conclusively nonexistent session (gateway up) → not_found", async () => {
  useFakeEntry({ FAKE_RESOLVE: "missing" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.NOT_FOUND,
  );
});

test("ambiguous session resolve (gateway up) → not_found (no candidate leak)", async () => {
  useFakeEntry({ FAKE_RESOLVE: "ambiguous" });
  try {
    await listSessionMessages({ sessionKey: KEY, limit: 50 });
    assert.fail("should reject");
  } catch (err) {
    assert.ok(isToolError(err) && err.category === ERROR_CATEGORIES.NOT_FOUND);
    assert.ok(!String(err.message).includes("synthetic-a"));
    assert.ok(!String(err.message).includes("candidates"));
  }
});

test("gateway unavailable → gateway_required (no CLI fallback)", async () => {
  useFakeEntry({ FAKE_MODE: "gateway_down" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
});

test("timeout during resolve/history → gateway_required (sanitized)", async () => {
  useFakeEntry({ FAKE_MODE: "slow" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) =>
      isToolError(err) &&
      err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED &&
      !String(err.message).includes(KEY),
  );
});

test("unknown method (resolve unsupported) → gateway_required, sanitized", async () => {
  // FAKE_UNKNOWN_METHOD faz o fake sair não-zero para sessions.resolve,
  // simulando método desconhecido/indisponível (o bridge não distingue de down).
  useFakeEntry({ FAKE_UNKNOWN_METHOD: "1" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) =>
      isToolError(err) &&
      err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED &&
      !String(err.message).includes(KEY),
  );
});

test("malformed gateway response → internal (not a leak)", async () => {
  // resolve encontra (default); chat.history retorna JSON malformado → internal.
  useFakeEntry({ FAKE_CHAT_MODE: "malformed" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
});

test("raw gateway error containing sessionKey/path/secret is never surfaced", async () => {
  useFakeEntry({ FAKE_RESOLVE_ERROR: "1" });
  try {
    await listSessionMessages({ sessionKey: KEY, limit: 50 });
    assert.fail("should reject");
  } catch (err) {
    assert.ok(isToolError(err));
    const msg = String(err.message);
    assert.ok(!msg.includes(KEY), "sessionKey must not leak");
    assert.ok(!msg.includes("/synthetic"), "path must not leak");
    assert.ok(!msg.includes("should-not-leak"), "secret must not leak");
  }
});

// --- sessions.resolve: validação FECHADA da forma positiva confirmada ---

test("resolve valid success ({ok:true,...}) proceeds; sensitive resolve fields never leak", async () => {
  useFakeEntry({ FAKE_RESOLVE: "found", FAKE_MESSAGE_TOTAL: "3" });
  const result = await listSessionMessages({ sessionKey: KEY, agentId: "main", limit: 50 });
  assert.equal(result.source, "gateway");
  assert.equal(result.count, 3);
  const serialized = JSON.stringify(result);
  // key/canonicalKey/path/secret do resolve NUNCA aparecem na resposta.
  assert.ok(!serialized.includes("canonicalKey"));
  assert.ok(!serialized.includes("/synthetic"));
  assert.ok(!serialized.includes("should-not-leak"));
});

test("resolve missing ({ok:false}) → not_found", async () => {
  useFakeEntry({ FAKE_RESOLVE: "missing" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.NOT_FOUND,
  );
});

test("resolve ambiguous ({ok:false,candidates}) → not_found without reading candidates", async () => {
  useFakeEntry({ FAKE_RESOLVE: "ambiguous" });
  try {
    await listSessionMessages({ sessionKey: KEY, limit: 50 });
    assert.fail("should reject");
  } catch (err) {
    assert.ok(isToolError(err) && err.category === ERROR_CATEGORIES.NOT_FOUND);
    assert.ok(!String(err.message).includes("synthetic-a"));
    assert.ok(!String(err.message).includes("synthetic-b"));
  }
});

test("resolve empty object {} → internal (unexpected shape, not 'found')", async () => {
  useFakeEntry({ FAKE_RESOLVE: "empty" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
});

test("resolve array [] → internal (never treated as found)", async () => {
  useFakeEntry({ FAKE_RESOLVE: "array" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
});

test("resolve null → internal", async () => {
  useFakeEntry({ FAKE_RESOLVE: "null" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
});

test("resolve { ok: \"true\" } (wrong type) → internal (never found)", async () => {
  useFakeEntry({ FAKE_RESOLVE: "ok_string" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
});

test("resolve malformed JSON → internal", async () => {
  useFakeEntry({ FAKE_RESOLVE: "malformed_json" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
});

test("unknown roles normalize to 'unknown'; no content leaks", async () => {
  useFakeEntry({ FAKE_CHAT_MODE: "unknown_roles" });
  const result = await listSessionMessages({ sessionKey: KEY, limit: 50 });
  for (const m of result.messages) {
    assert.equal(m.role, "unknown");
  }
  assert.ok(!JSON.stringify(result).includes("IGNORE_PREVIOUS_INSTRUCTIONS"));
});

test("no credential flags are passed to the gateway call", async () => {
  useFakeEntry({ FAKE_MESSAGE_TOTAL: "3", FAKE_FAIL_IF_CRED: "1" });
  // Se qualquer flag de credencial for passada, o fake sai não-zero →
  // gateway_required; sucesso confirma ausência de credenciais.
  const result = await listSessionMessages({ sessionKey: KEY, limit: 50 });
  assert.equal(result.source, "gateway");
});

test("timeout on a slow gateway → gateway_required, no output", async () => {
  useFakeEntry({ FAKE_MODE: "slow" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
});

test("cancellation via AbortSignal rejects only this call", async () => {
  useFakeEntry({ FAKE_MODE: "slow" });
  const controller = new AbortController();
  const p = listSessionMessages({ sessionKey: KEY, limit: 50 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(p, (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED);
});

test("CHAT_HISTORY_TIMEOUT_MS uses a bounded extended ceiling without changing Phase 1", () => {
  assert.equal(GATEWAY_RPC_TIMEOUT_MS, 10000, "Phase 1 gateway default must remain 10s");
  assert.ok(
    CHAT_HISTORY_TIMEOUT_MS <= GATEWAY_RPC_EXTENDED_TIMEOUT_MAX_MS,
    "chat.history timeout must not exceed the extended ceiling",
  );
  assert.ok(CHAT_HISTORY_TIMEOUT_MS >= 1000, "must respect the minimum floor");
});

test("the specific CHAT_HISTORY_TIMEOUT_MS is applied (bounded wall-clock)", async () => {
  useFakeEntry({ FAKE_MODE: "slow" });
  const start = Date.now();
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
  const elapsed = Date.now() - start;
  // Teto rígido é 20s; inclui folga para término do processo filho.
  // Prova que um timeout específico é realmente aplicado (não pendura).
  assert.ok(elapsed < 25000, `timed out in ${elapsed}ms (should be near the 20s ceiling)`);
});

test("cancellation is independent of the timeout (aborts well before the ceiling)", async () => {
  useFakeEntry({ FAKE_MODE: "slow" });
  const controller = new AbortController();
  const start = Date.now();
  const p = listSessionMessages({ sessionKey: KEY, limit: 50 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(p, (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `cancel resolved in ${elapsed}ms, independent of the 20s timeout`);
});
