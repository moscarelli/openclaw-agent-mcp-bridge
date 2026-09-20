import assert from "node:assert/strict";
import test from "node:test";
import { validateMessagesListArgs } from "../src/lib/validate-messages.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";

function isInvalidArg(err) {
  return isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT;
}

test("valid input: sessionKey only → default limit", () => {
  const out = validateMessagesListArgs({ sessionKey: "agent:main:synthetic-1" });
  assert.equal(out.sessionKey, "agent:main:synthetic-1");
  assert.equal(out.limit, 50);
  assert.equal(out.agentId, undefined);
  assert.equal(out.cursor, undefined);
});

test("valid input: agentId, limit, cursor", () => {
  const out = validateMessagesListArgs({
    sessionKey: "agent:main:synthetic-1",
    agentId: "main",
    limit: 10,
    cursor: "abc",
  });
  assert.equal(out.agentId, "main");
  assert.equal(out.limit, 10);
  assert.equal(out.cursor, "abc");
});

test("missing sessionKey → invalid_argument", () => {
  assert.throws(() => validateMessagesListArgs({}), isInvalidArg);
  assert.throws(() => validateMessagesListArgs({ sessionKey: "" }), isInvalidArg);
});

test("wrong type sessionKey → invalid_argument", () => {
  assert.throws(() => validateMessagesListArgs({ sessionKey: 123 }), isInvalidArg);
});

test("limit below/above range → invalid_argument", () => {
  assert.throws(() => validateMessagesListArgs({ sessionKey: "agent:main:s1", limit: 0 }), isInvalidArg);
  assert.throws(() => validateMessagesListArgs({ sessionKey: "agent:main:s1", limit: 201 }), isInvalidArg);
});

test("limit non-integer → invalid_argument", () => {
  assert.throws(() => validateMessagesListArgs({ sessionKey: "agent:main:s1", limit: 1.5 }), isInvalidArg);
});

test("hostile identifiers rejected (shell/path/url)", () => {
  const hostile = ["a; rm -rf /", "../etc/passwd", "http://x/y", "a b c", "a|b", "$(x)"];
  for (const s of hostile) {
    assert.throws(() => validateMessagesListArgs({ sessionKey: s }), isInvalidArg, `sessionKey ${s}`);
  }
});

test("hostile agentId rejected", () => {
  assert.throws(
    () => validateMessagesListArgs({ sessionKey: "agent:main:s1", agentId: "../x" }),
    isInvalidArg,
  );
});

test("empty cursor string → invalid_argument", () => {
  assert.throws(
    () => validateMessagesListArgs({ sessionKey: "agent:main:s1", cursor: "" }),
    isInvalidArg,
  );
});

test("error messages never echo the received value", () => {
  try {
    validateMessagesListArgs({ sessionKey: "a; rm -rf /" });
    assert.fail("should throw");
  } catch (err) {
    assert.ok(!String(err.message).includes("rm -rf"));
  }
});
