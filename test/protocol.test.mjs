import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../src/server/server.mjs";
import { fakeEntry } from "./helpers/fixture.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { setTestChildEnv } from "../src/openclaw/runner.mjs";

async function connectClient() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

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

// Extrai a categoria de erro do content textual de um resultado isError.
function errorCategory(result) {
  const text = result.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text).error;
}

test("initialize negotiates and exposes server info", async () => {
  const { client } = await connectClient();
  const info = client.getServerVersion();
  assert.equal(info?.name, SERVER_NAME);
});

test("ping round-trips", async () => {
  const { client } = await connectClient();
  await client.ping();
});

test("tools/list returns the read-only tools with schemas", async () => {
  const { client } = await connectClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  // Fase 2 adiciona a 4a tool read-only (metadata-only). As 3 da Fase 1
  // permanecem inalteradas.
  assert.deepEqual(names, [
    "openclaw_agents_list",
    "openclaw_session_get",
    "openclaw_session_messages_list",
    "openclaw_sessions_list",
  ]);
  for (const tool of tools) {
    assert.ok(tool.inputSchema, `${tool.name} has inputSchema`);
    assert.ok(tool.outputSchema, `${tool.name} has outputSchema`);
  }
  assert.ok(!names.includes("openclaw_agent_turn"));
});

test("tools/call returns structuredContent matching the output schema", async () => {
  useFake({ FAKE_SESSION_TOTAL: "3" });
  try {
    const { client } = await connectClient();
    const result = await client.callTool({ name: "openclaw_agents_list", arguments: { limit: 100 } });
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.count, 2);
    assert.ok(Array.isArray(result.content));
  } finally {
    clearFake();
  }
});

test("business error is isError with NO structuredContent", async () => {
  useFake();
  try {
    const { client } = await connectClient();
    // agentId+allAgents: válido no schema Zod, inválido na regra de negócio.
    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { agentId: "main", allAgents: true },
    });
    assert.equal(result.isError, true);
    // Não deve retornar structuredContent incompatível com o outputSchema.
    assert.equal(result.structuredContent, undefined);
    assert.equal(errorCategory(result), "invalid_argument");
  } finally {
    clearFake();
  }
});

test("session_get without gateway returns gateway_required (isError, no structuredContent)", async () => {
  useFake({ FAKE_MODE: "gateway_down" });
  try {
    const { client } = await connectClient();
    const result = await client.callTool({
      name: "openclaw_session_get",
      arguments: { sessionKey: "agent:main:synthetic-1" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(errorCategory(result), "gateway_required");
  } finally {
    clearFake();
  }
});

function resultText(result) {
  return result.content?.find((c) => c.type === "text")?.text ?? "";
}

test("unknown input properties are rejected (strict schema)", async () => {
  useFake({ FAKE_SESSION_TOTAL: "3" });
  try {
    const { client } = await connectClient();
    // Propriedade extra desconhecida deve ser rejeitada pelo schema strict.
    const result = await client.callTool({
      name: "openclaw_agents_list",
      arguments: { limit: 10, unexpectedField: "x" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(resultText(result), /unrecognized|unexpectedField|validation/i);
  } finally {
    clearFake();
  }
});

test("unknown property on sessions_list is rejected", async () => {
  useFake({ FAKE_SESSION_TOTAL: "3" });
  try {
    const { client } = await connectClient();
    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { limit: 10, bogus: true },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(resultText(result), /unrecognized|bogus|validation/i);
  } finally {
    clearFake();
  }
});
