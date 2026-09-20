import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTurn, setTestAgentTurnChildEnv } from "../src/openclaw/agent-turn.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";
import { assertLocalLoopbackGateway } from "../src/openclaw/agent-turn-loopback.mjs";
import { fakeEntry } from "./helpers/fixture.mjs";

const AGENT = "main";
const SESSION = "agent:main:synthetic-1";

// Loopback is proven by a read-only local-config preflight, NOT by
// OPENCLAW_GATEWAY_URL (which would require credentials). The tool is enabled
// WITHOUT setting OPENCLAW_GATEWAY_URL.
//
// All Phase 3A.2 children (config-get loopback proof, sessions.resolve, and the
// agent turn) share one stripped child env built by the service and injected in
// tests via setTestAgentTurnChildEnv. Distinct FAKE_* keys select each child's
// behavior: FAKE_GW_CONFIG (config get), FAKE_RESOLVE (sessions.resolve),
// FAKE_AGENT_MODE (agent). Defaults: loopback config + "found" resolve.
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

const okArgs = () => ({ agentId: AGENT, sessionKey: SESSION, instruction: "synthetic instruction" });

test("completed returns the textual response", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed" });
  const r = await runAgentTurn(okArgs());
  assert.equal(r.status, "completed");
  assert.equal(r.response, "synthetic reply one");
  assert.equal(r.source, "gateway");
  // Never leaks summary/runId.
  assert.ok(!JSON.stringify(r).includes("summary"));
});

test("completed_multi joins payload texts and drops media", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed_multi" });
  const r = await runAgentTurn(okArgs());
  assert.equal(r.status, "completed");
  assert.equal(r.response, "synthetic part A\n\nsynthetic part B");
  assert.ok(!JSON.stringify(r).includes("should-not-leak"));
});

test("completed_empty yields empty response", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed_empty" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "completed", response: "", source: "gateway" });
});

test("oversize response is truncated", async () => {
  enableConfig({ FAKE_AGENT_MODE: "oversize" });
  const r = await runAgentTurn(okArgs());
  assert.equal(r.status, "completed");
  assert.equal(r.truncated, true);
});

test("failed terminal status carries no content", async () => {
  enableConfig({ FAKE_AGENT_MODE: "failed" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "failed", source: "gateway" });
});

test("unknown status maps to unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "unknown_status" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("malformed stdout maps to unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "malformed" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("huge stdout (post-dispatch) maps to unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "huge_stdout" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("stderr containing a synthetic marker never leaks; still completes", async () => {
  enableConfig({ FAKE_AGENT_MODE: "stderr_secret" });
  const r = await runAgentTurn(okArgs());
  assert.equal(r.status, "completed");
  // stderr is never forwarded to the result.
  assert.ok(!JSON.stringify(r).includes("should-not-leak"));
  assert.equal(r.response, "ok after stderr");
});

test("exit 1 before dispatch maps to unknown (no stdout)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "exit1_pre" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("exit 1 possibly post-dispatch maps to unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "exit1_post" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("service strips any non-allowlisted response fields (echo mode)", async () => {
  // Even if the CLI returns extra fields (__echo), the normalizer forwards only
  // status/response/source. This proves no arbitrary Gateway object is repassed.
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_AGENT_ECHO: "1" });
  const r = await runAgentTurn(okArgs());
  assert.equal(r.status, "completed");
  assert.ok(!("__echo" in r));
  assert.ok(!JSON.stringify(r).includes("argv"));
  assert.deepEqual(Object.keys(r).sort(), ["response", "source", "status"]);
});

// permission_denied: wrong destination
test("mismatched agentId returns permission_denied", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed" });
  await assert.rejects(
    () => runAgentTurn({ agentId: "other", sessionKey: SESSION, instruction: "x" }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

test("mismatched sessionKey returns permission_denied", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed" });
  await assert.rejects(
    () => runAgentTurn({ agentId: AGENT, sessionKey: "agent:main:other", instruction: "x" }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

// invalid_argument cases
test("slash command instruction is rejected", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed" });
  for (const instr of ["/new", "  /reset now", "/compact", "/unknowncmd"]) {
    await assert.rejects(
      () => runAgentTurn({ agentId: AGENT, sessionKey: SESSION, instruction: instr }),
      (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT,
    );
  }
});

test("empty/whitespace instruction is rejected", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed" });
  await assert.rejects(
    () => runAgentTurn({ agentId: AGENT, sessionKey: SESSION, instruction: "   " }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT,
  );
});

// ---- Loopback preflight (config get gateway) ----

test("loopback preflight: remote config → permission_denied (no dispatch)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_GW_CONFIG: "remote" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

test("loopback preflight: LAN bind → permission_denied", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_GW_CONFIG: "bind_lan" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

test("loopback preflight: wildcard bind → permission_denied", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_GW_CONFIG: "bind_wildcard" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

// Falha operacional/inconclusiva do preflight local (não comprova destino
// não-loopback) → gateway_required, NUNCA permission_denied.
test("loopback preflight: malformed config → gateway_required (operational, not permission_denied)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_GW_CONFIG: "malformed" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
});

test("loopback preflight: config get failure (exit 1) → gateway_required (operational, not permission_denied)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_GW_CONFIG: "get_failure" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
});

// ---- Preflight local: as DUAS situações da correção ----
// (a) timeout/falha operacional do `config get gateway --json` → gateway_required
//     (NUNCA permission_denied); (b) config VÁLIDA que prova destino
//     não-loopback (remote) → permission_denied. Testadas direto na função para
//     serem determinísticas e não depender do teto de 45s.

test("assertLocalLoopbackGateway: config-get timeout/hang → gateway_required (not permission_denied)", async () => {
  process.env.OPENCLAW_MCP_BRIDGE_ENTRY = fakeEntry;
  resetEntryCache();
  const ac = new AbortController();
  // Aborta rápido para simular timeout operacional do preflight sem esperar 45s;
  // o runner rejeita e o preflight deve mapear para gateway_required.
  const timer = setTimeout(() => ac.abort(), 150);
  try {
    await assert.rejects(
      () => assertLocalLoopbackGateway({ signal: ac.signal, env: { FAKE_GW_CONFIG: "hang" } }),
      (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
    );
  } finally {
    clearTimeout(timer);
    delete process.env.OPENCLAW_MCP_BRIDGE_ENTRY;
    resetEntryCache();
  }
});

test("assertLocalLoopbackGateway: valid remote config (mode remote) → permission_denied", async () => {
  process.env.OPENCLAW_MCP_BRIDGE_ENTRY = fakeEntry;
  resetEntryCache();
  try {
    await assert.rejects(
      () => assertLocalLoopbackGateway({ env: { FAKE_GW_CONFIG: "remote" } }),
      (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
    );
  } finally {
    delete process.env.OPENCLAW_MCP_BRIDGE_ENTRY;
    resetEntryCache();
  }
});

test("loopback preflight: unset subtree (null) → accepted (defaults are local loopback)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_GW_CONFIG: "defaults_null" });
  const r = await runAgentTurn(okArgs());
  assert.equal(r.status, "completed");
});

test("OPENCLAW_GATEWAY_URL in the bridge env → permission_denied at handler", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed" });
  process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:7000";
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.PERMISSION_DENIED,
  );
});

// ---- Preflight (sessions.resolve) ----

test("preflight: missing session → not_found (no dispatch)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_RESOLVE: "missing" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.NOT_FOUND,
  );
});

test("preflight: ambiguous resolve → not_found, no candidate leak", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_RESOLVE: "ambiguous" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.NOT_FOUND,
  );
});

test("preflight: malformed resolve → internal", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_RESOLVE: "empty" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
});

test("preflight: gateway down → gateway_required", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed", FAKE_MODE: "gateway_down" });
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
});

// ---- Exit code gating ----

test("valid success JSON but exit 1 → unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "ok_exit1" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("status completed but exit 1 → unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed_exit1" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("status error but exit 1 → unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "failed_exit1" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

// ---- Closed status set ----

test("status timeout is not claimed this version → unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "timeout_status" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("status in_flight → unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "in_flight_status" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("success status with invalid result shape → unknown (not completed-empty)", async () => {
  enableConfig({ FAKE_AGENT_MODE: "bad_result_shape" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("success status with wrong-typed payload text → unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "bad_payload_text" });
  const r = await runAgentTurn(okArgs());
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("cancellation before dispatch returns unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "completed" });
  const ac = new AbortController();
  ac.abort();
  const r = await runAgentTurn(okArgs(), { signal: ac.signal });
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("cancellation during a slow run returns unknown and survives", async () => {
  enableConfig({ FAKE_AGENT_MODE: "slow" });
  const ac = new AbortController();
  const p = runAgentTurn(okArgs(), { signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  const r = await p;
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("timeout (slow child) returns unknown", async () => {
  enableConfig({ FAKE_AGENT_MODE: "slow" });
  const r = await runAgentTurn({ ...okArgs(), timeoutMs: 1000 });
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("second concurrent turn returns busy IMMEDIATELY (non-blocking) and recovers", async () => {
  enableConfig({ FAKE_AGENT_MODE: "slow" });
  const ac = new AbortController();
  const first = runAgentTurn({ ...okArgs(), timeoutMs: 60000 }, { signal: ac.signal });
  // Let the first call acquire the permit and pass the preflight.
  await new Promise((r) => setTimeout(r, 200));
  // Second call must reject busy essentially immediately (no 5s wait).
  const t0 = Date.now();
  await assert.rejects(
    () => runAgentTurn(okArgs()),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.BUSY,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `busy should be immediate, took ${elapsed}ms`);
  // Cancel the first so it settles (unknown) and releases the permit.
  ac.abort();
  const r1 = await first;
  assert.equal(r1.status, "unknown");
  // Recovery: after the permit is released, a subsequent turn can acquire again.
  enableConfig({ FAKE_AGENT_MODE: "completed" });
  const r2 = await runAgentTurn(okArgs());
  assert.equal(r2.status, "completed");
}, { timeout: 20000 });
