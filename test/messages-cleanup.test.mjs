import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fakeEntry } from "./helpers/fixture.mjs";
import { setTestChildEnv } from "../src/openclaw/runner.mjs";
import { listSessionMessages } from "../src/openclaw/messages.mjs";
import { resetEntryCache } from "../src/openclaw/locator.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";

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

test.afterEach(clearFake);

const KEY = "agent:main:synthetic-1";
const REPEAT = 20;

// A cancelação exercita EXATAMENTE o mesmo caminho de término/cleanup do
// runner que o timeout (beginTermination → SIGTERM/grace/SIGKILL → settle),
// e é rápida (aborta em ~30ms), então é a sonda de intermitência principal.
test(`cancellation is deterministic across ${REPEAT} repetitions; parent survives`, async () => {
  const parentPid = process.pid;
  useFake({ FAKE_MODE: "slow" });
  for (let i = 0; i < REPEAT; i += 1) {
    const controller = new AbortController();
    const p = listSessionMessages({ sessionKey: KEY, limit: 50 }, { signal: controller.signal });
    delay(30).then(() => controller.abort());
    await assert.rejects(
      p,
      (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
      `iteration ${i}`,
    );
  }
  assert.equal(process.pid, parentPid, "parent process still alive");
});

test("timeout path resolves to gateway_required (single slow case)", async () => {
  useFake({ FAKE_MODE: "slow" });
  await assert.rejects(
    () => listSessionMessages({ sessionKey: KEY, limit: 50 }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.GATEWAY_REQUIRED,
  );
});

test(`successful calls remain stable across ${REPEAT} repetitions (no intermittency)`, async () => {
  useFake({ FAKE_MESSAGE_TOTAL: "3" });
  for (let i = 0; i < REPEAT; i += 1) {
    const result = await listSessionMessages({ sessionKey: KEY, limit: 50 });
    assert.equal(result.count, 3, `iteration ${i}`);
    assert.equal(result.source, "gateway");
  }
});
