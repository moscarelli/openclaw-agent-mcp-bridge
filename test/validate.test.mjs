import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAgentsListArgs,
  validateSessionsListArgs,
  validateSessionGetArgs,
  deriveAgentIdFromKey,
} from "../src/lib/validate.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";

function assertInvalid(fn) {
  try {
    fn();
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(isToolError(err), `expected ToolError, got ${err}`);
    assert.equal(err.category, ERROR_CATEGORIES.INVALID_ARGUMENT);
  }
}

test("agents_list applies default and rejects out-of-range limit", () => {
  assert.deepEqual(validateAgentsListArgs({}), { limit: 100 });
  assert.deepEqual(validateAgentsListArgs({ limit: 10 }), { limit: 10 });
  assertInvalid(() => validateAgentsListArgs({ limit: 0 }));
  assertInvalid(() => validateAgentsListArgs({ limit: 101 }));
  assertInvalid(() => validateAgentsListArgs({ limit: 1.5 }));
});

test("sessions_list rejects agentId+allAgents together", () => {
  assertInvalid(() => validateSessionsListArgs({ agentId: "main", allAgents: true }));
});

test("sessions_list validates activeMinutes range 1..525600", () => {
  assert.equal(validateSessionsListArgs({ activeMinutes: 1 }).activeMinutes, 1);
  assert.equal(validateSessionsListArgs({ activeMinutes: 525600 }).activeMinutes, 525600);
  assertInvalid(() => validateSessionsListArgs({ activeMinutes: 0 }));
  assertInvalid(() => validateSessionsListArgs({ activeMinutes: 525601 }));
});

test("sessions_list rejects unsafe agentId", () => {
  assertInvalid(() => validateSessionsListArgs({ agentId: "../secret" }));
  assertInvalid(() => validateSessionsListArgs({ agentId: "x;whoami" }));
});

test("session_get requires a safe sessionKey", () => {
  assertInvalid(() => validateSessionGetArgs({}));
  assertInvalid(() => validateSessionGetArgs({ sessionKey: "C:\\Users\\name" }));
  const ok = validateSessionGetArgs({ sessionKey: "agent:main:synthetic-1" });
  assert.equal(ok.sessionKey, "agent:main:synthetic-1");
});

test("deriveAgentIdFromKey extracts prefixed agent id", () => {
  assert.equal(deriveAgentIdFromKey("agent:main:synthetic-1"), "main");
  assert.equal(deriveAgentIdFromKey("global"), undefined);
  assert.equal(deriveAgentIdFromKey("simple-key"), undefined);
});
