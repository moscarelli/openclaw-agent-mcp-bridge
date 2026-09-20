import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentTurnConfig, hasGatewayUrlOverride } from "../src/openclaw/agent-turn-config.mjs";
import { classifyGatewayConfig } from "../src/openclaw/agent-turn-loopback.mjs";

// Loopback is NO LONGER proven via OPENCLAW_GATEWAY_URL (that override would
// require explicit credentials in OpenClaw 2026.9.3 and break local auth).
// resolveAgentTurnConfig only validates flag + exact ids, and is DISABLED when
// OPENCLAW_GATEWAY_URL is present in the bridge env. The actual loopback proof
// is a read-only local-config preflight (classifyGatewayConfig / the loopback
// module), covered below and in the integration tests.
const base = {
  OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT: "1",
  OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID: "main",
  OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY: "agent:main:synthetic-1",
};

test("enabled with flag + exact ids and no gateway URL override", () => {
  const c = resolveAgentTurnConfig({ ...base });
  assert.deepEqual(c, { enabled: true, agentId: "main", sessionKey: "agent:main:synthetic-1" });
});

test("flag must be exactly '1'", () => {
  assert.equal(resolveAgentTurnConfig({ ...base, OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT: "true" }).enabled, false);
  assert.equal(resolveAgentTurnConfig({ ...base, OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT: "1 " }).enabled, false);
  assert.equal(resolveAgentTurnConfig({ ...base, OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT: "0" }).enabled, false);
  const noFlag = { ...base };
  delete noFlag.OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT;
  assert.equal(resolveAgentTurnConfig(noFlag).enabled, false);
});

test("both agentId and sessionKey must be present", () => {
  const noAgent = { ...base };
  delete noAgent.OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID;
  assert.equal(resolveAgentTurnConfig(noAgent).enabled, false);
  const noSession = { ...base };
  delete noSession.OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY;
  assert.equal(resolveAgentTurnConfig(noSession).enabled, false);
});

test("invalid identifiers disable the tool", () => {
  assert.equal(resolveAgentTurnConfig({ ...base, OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID: "bad id!" }).enabled, false);
  assert.equal(resolveAgentTurnConfig({ ...base, OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY: "a b" }).enabled, false);
});

test("OPENCLAW_GATEWAY_URL present in the bridge env DISABLES the tool", () => {
  // Any URL override (even a loopback one) disables: we cannot use it without
  // credentials and never forward it to the child.
  assert.equal(resolveAgentTurnConfig({ ...base, OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:7000" }).enabled, false);
  assert.equal(resolveAgentTurnConfig({ ...base, OPENCLAW_GATEWAY_URL: "wss://gateway.example.com" }).enabled, false);
  assert.equal(resolveAgentTurnConfig({ ...base, OPENCLAW_GATEWAY_URL: "ws://192.168.1.5:7000" }).enabled, false);
});

test("hasGatewayUrlOverride detects a non-empty URL", () => {
  assert.equal(hasGatewayUrlOverride({}), false);
  assert.equal(hasGatewayUrlOverride({ OPENCLAW_GATEWAY_URL: "" }), false);
  assert.equal(hasGatewayUrlOverride({ OPENCLAW_GATEWAY_URL: "  " }), false);
  assert.equal(hasGatewayUrlOverride({ OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:7000" }), true);
});

test("config values never appear on the returned object beyond agentId/sessionKey", () => {
  const c = resolveAgentTurnConfig({ ...base });
  assert.deepEqual(Object.keys(c).sort(), ["agentId", "enabled", "sessionKey"]);
});

// ---- Local-config loopback classification (read-only preflight) ----

test("classifyGatewayConfig: local + loopback → loopback", () => {
  assert.equal(classifyGatewayConfig({ mode: "local", bind: "loopback" }), "loopback");
});

test("classifyGatewayConfig: unset subtree (null) → loopback (defaults apply)", () => {
  assert.equal(classifyGatewayConfig(null), "loopback");
});

test("classifyGatewayConfig: mode local, bind absent → loopback (default bind)", () => {
  assert.equal(classifyGatewayConfig({ mode: "local" }), "loopback");
});

test("classifyGatewayConfig: empty object (all defaults) → loopback", () => {
  assert.equal(classifyGatewayConfig({}), "loopback");
});

test("classifyGatewayConfig: loopback bind aliases accepted", () => {
  for (const b of ["loopback", "local", "localhost", "127.0.0.1", "::1", "LOOPBACK"]) {
    assert.equal(classifyGatewayConfig({ mode: "local", bind: b }), "loopback", `bind=${b}`);
  }
});

test("classifyGatewayConfig: mode remote → not_loopback", () => {
  assert.equal(classifyGatewayConfig({ mode: "remote", remote: { url: "wss://x.invalid" } }), "not_loopback");
  assert.equal(classifyGatewayConfig({ mode: "remote" }), "not_loopback");
});

test("classifyGatewayConfig: remote.url present → not_loopback", () => {
  // Even if mode string were 'local', a present remote.url is a remote selection.
  assert.equal(classifyGatewayConfig({ mode: "local", remote: { url: "wss://x.invalid" } }), "not_loopback");
});

test("classifyGatewayConfig: LAN/wildcard bind → not_loopback", () => {
  assert.equal(classifyGatewayConfig({ mode: "local", bind: "lan" }), "not_loopback");
  assert.equal(classifyGatewayConfig({ mode: "local", bind: "all" }), "not_loopback");
  assert.equal(classifyGatewayConfig({ mode: "local", bind: "0.0.0.0" }), "not_loopback");
});

test("classifyGatewayConfig: malformed shapes → malformed (fail-closed)", () => {
  assert.equal(classifyGatewayConfig([]), "malformed");
  assert.equal(classifyGatewayConfig("x"), "malformed");
  assert.equal(classifyGatewayConfig({ mode: 12345 }), "malformed");
  assert.equal(classifyGatewayConfig({ mode: "weird" }), "malformed");
  assert.equal(classifyGatewayConfig({ mode: "local", bind: 5 }), "malformed");
  assert.equal(classifyGatewayConfig({ mode: "local", remote: "x" }), "malformed");
});
