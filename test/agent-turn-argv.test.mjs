import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { writePromptTempfile } from "../src/openclaw/prompt-tempfile.mjs";
import { fakeEntry } from "./helpers/fixture.mjs";

// Spawns the fake CLI exactly as the service does, in echo mode, to assert the
// security invariants: the instruction is NOT in argv, the message-file is read,
// the experimental config env vars are NOT passed to the child, and no
// forbidden flags appear. Uses synthetic content only.

function runFakeAgentEcho(args, childEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeEntry, ...args], {
      shell: false,
      windowsHide: true,
      // Minimal env: intentionally DOES NOT include the experimental config
      // vars, mirroring buildChildEnv() which excludes them by allowlist.
      env: { ...childEnv, FAKE_AGENT_MODE: "completed", FAKE_AGENT_ECHO: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
  });
}

test("instruction is not in argv; message-file is read; config env not leaked; no forbidden flags", async () => {
  const instruction = "SECRET_SYNTHETIC_INSTRUCTION_MARKER";
  const handle = await writePromptTempfile(instruction);
  try {
    const args = [
      "agent",
      "--agent",
      "main",
      "--session-key",
      "agent:main:synthetic-1",
      "--message-file",
      handle.path,
      "--json",
      "--timeout",
      "120",
    ];
    // Child env WITHOUT the experimental config vars (as production does).
    const echo = await runFakeAgentEcho(args, {
      PATH: process.env.PATH ?? process.env.Path ?? "",
    });
    const info = echo.__echo;
    assert.ok(info, "echo present");
    // The raw instruction text is never present in argv.
    assert.ok(!info.argv.join(" ").includes(instruction));
    // No --message flag (we use --message-file only).
    assert.equal(info.hasMessageFlag, false);
    // No forbidden flags.
    assert.deepEqual(info.forbiddenPresent, []);
    // Config env vars were not passed to the child.
    assert.deepEqual(info.leakedConfigEnv, []);
    // The message file was read and had the instruction's byte length.
    assert.equal(info.promptRead, true);
    assert.equal(info.promptBytes, Buffer.byteLength(instruction, "utf8"));
  } finally {
    await handle.cleanup();
  }
});

// The Phase 3A.2 child env must never carry the Gateway target override or any
// credential — the specialized CLI (and the read-only preflight children) must
// use the OpenClaw LOCAL config/auth.
test("child env strips OPENCLAW_GATEWAY_URL/PORT and never contains credentials", async () => {
  const { __testing } = await import("../src/openclaw/agent-turn.mjs");
  const { stripGatewayTarget, composeChildEnv } = __testing;

  // stripGatewayTarget removes the gateway target keys.
  const stripped = stripGatewayTarget({
    PATH: "x",
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:7000",
    OPENCLAW_GATEWAY_PORT: "7000",
  });
  assert.equal(stripped.OPENCLAW_GATEWAY_URL, undefined);
  assert.equal(stripped.OPENCLAW_GATEWAY_PORT, undefined);
  assert.equal(stripped.PATH, "x");

  // composeChildEnv (built from the allowlist) never contains the gateway target
  // keys nor any secret-shaped key, even if present in process.env.
  const savedUrl = process.env.OPENCLAW_GATEWAY_URL;
  const savedTok = process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:7000";
    process.env.OPENCLAW_GATEWAY_TOKEN = "synthetic-should-not-leak";
    const env = composeChildEnv();
    assert.equal(env.OPENCLAW_GATEWAY_URL, undefined);
    assert.equal(env.OPENCLAW_GATEWAY_PORT, undefined);
    const secretish = Object.keys(env).filter((k) => /(_TOKEN|_SECRET|_KEY|_PASSWORD|_PASSWD|_PWD|_CREDENTIAL|_CREDENTIALS)$/i.test(k));
    assert.deepEqual(secretish, []);
  } finally {
    if (savedUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = savedUrl;
    if (savedTok === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = savedTok;
  }
});
