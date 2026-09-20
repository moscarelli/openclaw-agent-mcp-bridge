import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server/server.mjs";
import { fakeEntry } from "./helpers/fixture.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { setTestChildEnv } from "../src/openclaw/runner.mjs";

// Marcadores hostis sintéticos que a fake CLI injeta no conteúdo/campos brutos.
// NENHUM pode aparecer em qualquer saída observável.
const HOSTILE_MARKERS = [
  "IGNORE_PREVIOUS_INSTRUCTIONS",
  "should-not-leak",
  "synthetic-idem",
  "synthetic-provenance",
  "synthetic-internal",
  "synthetic-sender",
  "synthetic-session-id",
  "model-secret",
];

function useFake(childEnv = {}) {
  process.env.OPENCLAW_MCP_BRIDGE_ENTRY = fakeEntry;
  setTestChildEnv(childEnv);
  resetEntryCache();
}

function clearFake() {
  delete process.env.OPENCLAW_MCP_BRIDGE_ENTRY;
  setTestChildEnv(null);
  resetEntryCache();
}

async function connectClient() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

// Captura tudo que for escrito em stdout/stderr durante uma seção.
function captureStdio(run) {
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const grab = (orig) => (chunk, enc, cb) => {
    try {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    } catch {
      /* noop */
    }
    return orig(chunk, enc, cb);
  };
  process.stdout.write = grab(origOut);
  process.stderr.write = grab(origErr);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    })
    .then((result) => ({ result, captured: chunks.join("") }));
}

function assertNoHostile(text, where) {
  for (const marker of HOSTILE_MARKERS) {
    assert.ok(!text.includes(marker), `hostile marker "${marker}" leaked into ${where}`);
  }
}

test.afterEach(clearFake);

test("hostile content never appears in the MCP result or structuredContent", async () => {
  useFake({ FAKE_MESSAGE_TOTAL: "5", OPENCLAW_MCP_BRIDGE_LOG_LEVEL: "debug" });
  const { client } = await connectClient();
  const result = await client.callTool({
    name: "openclaw_session_messages_list",
    arguments: { sessionKey: "agent:main:synthetic-1", limit: 50 },
  });
  assert.equal(result.isError, undefined);
  assertNoHostile(JSON.stringify(result), "MCP result");
});

test("hostile content never appears in stdout/stderr/logs during a call (log debug)", async () => {
  useFake({ FAKE_MESSAGE_TOTAL: "5", OPENCLAW_MCP_BRIDGE_LOG_LEVEL: "debug" });
  const { client } = await connectClient();
  const { captured } = await captureStdio(() =>
    client.callTool({
      name: "openclaw_session_messages_list",
      arguments: { sessionKey: "agent:main:synthetic-1", limit: 50 },
    }),
  );
  assertNoHostile(captured, "stdout/stderr");
});

test("hostile content absent even on huge message (whole-response truncation)", async () => {
  useFake({ FAKE_CHAT_MODE: "huge_message", OPENCLAW_MCP_BRIDGE_LOG_LEVEL: "debug" });
  const { client } = await connectClient();
  const { result, captured } = await captureStdio(() =>
    client.callTool({
      name: "openclaw_session_messages_list",
      arguments: { sessionKey: "agent:main:synthetic-1", limit: 50 },
    }),
  );
  // Não deve vazar conteúdo, e a resposta não deve conter o texto gigante.
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("xxxxxxxxxx"), "huge content must not appear");
  assertNoHostile(captured, "stdout/stderr");
});

test("error path (gateway down) leaks no hostile content and no sessionKey", async () => {
  useFake({ FAKE_MODE: "gateway_down", OPENCLAW_MCP_BRIDGE_LOG_LEVEL: "debug" });
  const { client } = await connectClient();
  const { result, captured } = await captureStdio(() =>
    client.callTool({
      name: "openclaw_session_messages_list",
      arguments: { sessionKey: "agent:main:synthetic-secret-key", limit: 50 },
    }),
  );
  assert.equal(result.isError, true);
  assertNoHostile(captured, "stdout/stderr on error");
  // O sessionKey não deve aparecer em logs/erros.
  assert.ok(!captured.includes("synthetic-secret-key"), "sessionKey must not leak to logs");
  assert.ok(!JSON.stringify(result).includes("synthetic-secret-key"), "sessionKey must not leak to error result");
});

test("nextCursor never leaks sessionKey/agentId/fingerprint", async () => {
  useFake({ FAKE_MESSAGE_TOTAL: "250" });
  const { client } = await connectClient();
  const result = await client.callTool({
    name: "openclaw_session_messages_list",
    arguments: { sessionKey: "agent:main:synthetic-1", agentId: "main", limit: 100 },
  });
  const cursor = result.structuredContent?.nextCursor;
  assert.ok(typeof cursor === "string");
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  assert.ok(!decoded.includes("agent:main:synthetic-1"));
  assert.ok(!decoded.includes("\"main\""));
  assert.ok(!decoded.includes("sessionKey"));
});
