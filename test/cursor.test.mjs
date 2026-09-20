import assert from "node:assert/strict";
import test from "node:test";
import { encodeCursor, decodeCursor, canonicalScope } from "../src/openclaw/cursor.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";

const scope = { agentId: "main", allAgents: false, activeMinutes: undefined, limit: 100 };

test("cursor round-trips the offset within the same scope", () => {
  const cursor = encodeCursor(200, scope);
  assert.equal(decodeCursor(cursor, scope), 200);
});

test("cursor rejects a mismatched scope as invalid_argument", () => {
  const cursor = encodeCursor(200, scope);
  const otherScope = { ...scope, agentId: "work" };
  try {
    decodeCursor(cursor, otherScope);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(isToolError(err));
    assert.equal(err.category, ERROR_CATEGORIES.INVALID_ARGUMENT);
  }
});

test("cursor rejects a tampered signature", () => {
  const cursor = encodeCursor(10, scope);
  const [payload] = cursor.split(".");
  const tampered = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  assert.throws(() => decodeCursor(tampered, scope), (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT);
});

test("cursor rejects malformed input", () => {
  assert.throws(() => decodeCursor("not-a-cursor", scope), (err) => isToolError(err));
  assert.throws(() => decodeCursor("", scope), (err) => isToolError(err));
});

test("canonicalScope normalizes absent filters", () => {
  assert.deepEqual(canonicalScope({}), {
    agentId: null,
    allAgents: false,
    activeMinutes: null,
    limit: null,
  });
});
