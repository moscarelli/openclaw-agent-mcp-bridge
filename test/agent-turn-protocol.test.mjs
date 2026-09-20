import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server/server.mjs";
import { fakeEntry } from "./helpers/fixture.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { setTestAgentTurnChildEnv } from "../src/openclaw/agent-turn.mjs";
import { setTestChildEnv } from "../src/openclaw/runner.mjs";

const AGENT = "main";
const SESSION = "agent:main:synthetic-1";
const READ_ONLY = [
  "openclaw_agents_list",
  "openclaw_session_get",
  "openclaw_session_messages_list",
  "openclaw_sessions_list",
];

async function connect() {
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client };
}

function fullConfig(childEnv = {}) {
  process.env.OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT = "1";
  process.env.OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID = AGENT;
  process.env.OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY = SESSION;
  // No OPENCLAW_GATEWAY_URL: loopback is proven by the read-only local-config
  // preflight, and a URL override would disable the tool.
  delete process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_MCP_BRIDGE_ENTRY = fakeEntry;
  setTestAgentTurnChildEnv(childEnv);
  // Preflight children (config-get loopback proof + sessions.resolve) run
  // through the runner; default to a loopback config + "found" resolve.
  setTestChildEnv({ FAKE_GW_CONFIG: "local_loopback", ...childEnv });
  resetEntryCache();
}

function clearAll() {
  delete process.env.OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT;
  delete process.env.OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID;
  delete process.env.OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_MCP_BRIDGE_ENTRY;
  setTestAgentTurnChildEnv(null);
  setTestChildEnv(null);
  resetEntryCache();
}

test.afterEach(clearAll);

function errorCategory(result) {
  const text = result.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text).error;
}

test("without the flag, tools/list returns exactly four read-only tools", async () => {
  clearAll();
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), READ_ONLY);
});

test("with incomplete config (flag only), tools/list returns exactly four", async () => {
  clearAll();
  process.env.OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT = "1";
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 4);
  assert.ok(!tools.some((t) => t.name === "openclaw_agent_turn"));
});

test("with full loopback config, tools/list returns the read-only tools plus the two mutating tools", async () => {
  fullConfig();
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...READ_ONLY, "openclaw_agent_turn", "openclaw_agent_dispatch"].sort(),
  );
});

test("any OPENCLAW_GATEWAY_URL override keeps the tool absent (four tools)", async () => {
  // A URL override would require explicit credentials, so its mere presence
  // disables the experimental tool (registration is config-gated).
  fullConfig();
  process.env.OPENCLAW_GATEWAY_URL = "ws://192.168.1.10:7000";
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 4);
});

test("even a loopback OPENCLAW_GATEWAY_URL override keeps the tool absent", async () => {
  fullConfig();
  process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:7000";
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 4);
});

test("agent_turn completes with a synthetic response via MCP", async () => {
  fullConfig({ FAKE_AGENT_MODE: "completed" });
  const { client } = await connect();
  const res = await client.callTool({
    name: "openclaw_agent_turn",
    arguments: { agentId: AGENT, sessionKey: SESSION, instruction: "synthetic instruction" },
  });
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.status, "completed");
  assert.equal(res.structuredContent.response, "synthetic reply one");
});

test("strict schema rejects unknown fields (model override)", async () => {
  fullConfig({ FAKE_AGENT_MODE: "completed" });
  const { client } = await connect();
  const res = await client.callTool({
    name: "openclaw_agent_turn",
    arguments: { agentId: AGENT, sessionKey: SESSION, instruction: "x", model: "override" },
  });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent, undefined);
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  assert.match(text, /unrecognized|validation|invalid/i);
});

test("wrong destination returns permission_denied", async () => {
  fullConfig({ FAKE_AGENT_MODE: "completed" });
  const { client } = await connect();
  const res = await client.callTool({
    name: "openclaw_agent_turn",
    arguments: { agentId: "other", sessionKey: SESSION, instruction: "x" },
  });
  assert.equal(res.isError, true);
  assert.equal(errorCategory(res), "permission_denied");
});

test("slash command returns invalid_argument", async () => {
  fullConfig({ FAKE_AGENT_MODE: "completed" });
  const { client } = await connect();
  const res = await client.callTool({
    name: "openclaw_agent_turn",
    arguments: { agentId: AGENT, sessionKey: SESSION, instruction: "/reset" },
  });
  assert.equal(res.isError, true);
  assert.equal(errorCategory(res), "invalid_argument");
});

test("failed maps to a failed status result (no content), server stays usable", async () => {
  fullConfig({ FAKE_AGENT_MODE: "failed" });
  const { client } = await connect();
  const res = await client.callTool({
    name: "openclaw_agent_turn",
    arguments: { agentId: AGENT, sessionKey: SESSION, instruction: "x" },
  });
  assert.equal(res.structuredContent.status, "failed");
  assert.equal(res.structuredContent.response, undefined);
  // Server still responds afterward.
  await client.ping();
});

test("read-only tools are unchanged and still work with config enabled", async () => {
  fullConfig({ FAKE_AGENT_MODE: "completed" });
  const { client } = await connect();
  const res = await client.callTool({ name: "openclaw_agents_list", arguments: {} });
  assert.equal(res.structuredContent.count, 2);
});

test("agent_dispatch returns started + jobId via MCP without waiting for the model", async () => {
  fullConfig({ FAKE_AGENT_MODE: "dispatch_slow", FAKE_AGENT_SLEEP_MS: "300" });
  const { client } = await connect();
  const res = await client.callTool({
    name: "openclaw_agent_dispatch",
    arguments: { agentId: AGENT, sessionKey: SESSION, instruction: "synthetic async instruction" },
  });
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.status, "started");
  assert.equal(res.structuredContent.source, "openclaw");
  assert.equal(typeof res.structuredContent.jobId, "string");
  // Never returns the model response nor the "accepted" wording.
  assert.equal(res.structuredContent.response, undefined);
  assert.ok(!JSON.stringify(res.structuredContent).includes("accepted"));
  // Let the detached child settle before the test ends.
  await new Promise((r) => setTimeout(r, 1500));
});

test("agent_dispatch strict schema rejects unknown fields (timeoutMs/model)", async () => {
  fullConfig({ FAKE_AGENT_MODE: "dispatch_slow" });
  const { client } = await connect();
  const res = await client.callTool({
    name: "openclaw_agent_dispatch",
    arguments: { agentId: AGENT, sessionKey: SESSION, instruction: "x", timeoutMs: 5000 },
  });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent, undefined);
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  assert.match(text, /unrecognized|validation|invalid/i);
});
