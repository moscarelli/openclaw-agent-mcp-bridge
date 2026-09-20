import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server/server.mjs";
import { fakeEntry } from "./helpers/fixture.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { setTestChildEnv } from "../src/openclaw/runner.mjs";

const FOUR_TOOLS = [
  "openclaw_agents_list",
  "openclaw_session_get",
  "openclaw_session_messages_list",
  "openclaw_sessions_list",
];

const MUTATING_OR_FORBIDDEN = [
  "openclaw_agent_turn",
  "openclaw_agent_dispatch",
  "messages_send",
  "openclaw_session_message_get",
  "openclaw_session_attachments_list",
];

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

function resultText(result) {
  return result.content?.find((c) => c.type === "text")?.text ?? "";
}

function errorCategory(result) {
  return JSON.parse(resultText(result) || "{}").error;
}

test.afterEach(clearFake);

test("tools/list returns EXACTLY the four tools", async () => {
  const { client } = await connectClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, FOUR_TOOLS);
  for (const tool of tools) {
    assert.ok(tool.inputSchema, `${tool.name} has inputSchema`);
    assert.ok(tool.outputSchema, `${tool.name} has outputSchema`);
  }
});

test("inventory negative: no mutating/forbidden tool is exposed", async () => {
  const { client } = await connectClient();
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const forbidden of MUTATING_OR_FORBIDDEN) {
    assert.ok(!names.has(forbidden), `must not expose ${forbidden}`);
  }
  assert.equal(names.size, 4);
});

test("messages_list success returns metadata-only structuredContent", async () => {
  useFake({ FAKE_MESSAGE_TOTAL: "3" });
  const { client } = await connectClient();
  const result = await client.callTool({
    name: "openclaw_session_messages_list",
    arguments: { sessionKey: "agent:main:synthetic-1", limit: 50 },
  });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  assert.equal(result.structuredContent.source, "gateway");
  assert.equal(result.structuredContent.count, 3);
  for (const m of result.structuredContent.messages) {
    // messageId é omitido nesta versão; só role e timestamp são permitidos.
    const extra = Object.keys(m).filter((k) => !["role", "timestamp"].includes(k));
    assert.deepEqual(extra, []);
    assert.ok(!("messageId" in m));
  }
});

test("messages_list unknown property rejected (strict schema)", async () => {
  useFake({ FAKE_MESSAGE_TOTAL: "3" });
  const { client } = await connectClient();
  const result = await client.callTool({
    name: "openclaw_session_messages_list",
    arguments: { sessionKey: "agent:main:synthetic-1", mode: "content" },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(resultText(result), /unrecognized|mode|validation/i);
});

test("messages_list without gateway → gateway_required (isError, no structuredContent)", async () => {
  useFake({ FAKE_MODE: "gateway_down" });
  const { client } = await connectClient();
  const result = await client.callTool({
    name: "openclaw_session_messages_list",
    arguments: { sessionKey: "agent:main:synthetic-1" },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(errorCategory(result), "gateway_required");
});

test("messages_list invalid sessionKey → invalid_argument", async () => {
  useFake({ FAKE_MESSAGE_TOTAL: "3" });
  const { client } = await connectClient();
  const result = await client.callTool({
    name: "openclaw_session_messages_list",
    arguments: { sessionKey: "a; rm -rf /" },
  });
  assert.equal(result.isError, true);
  assert.equal(errorCategory(result), "invalid_argument");
  // Nunca ecoa o valor recebido.
  assert.ok(!resultText(result).includes("rm -rf"));
});

test("Phase 1 tools remain unchanged (schemas present)", async () => {
  const { client } = await connectClient();
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.ok(byName.openclaw_agents_list);
  assert.ok(byName.openclaw_sessions_list);
  assert.ok(byName.openclaw_session_get);
});
