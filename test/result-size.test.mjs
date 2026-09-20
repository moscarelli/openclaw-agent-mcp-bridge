import assert from "node:assert/strict";
import test from "node:test";
import { successResult } from "../src/server/tools.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";
import { RESULT_MAX_BYTES } from "../src/lib/limits.mjs";

function bytes(result) {
  return Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8");
}

test("small result passes through untruncated", () => {
  const result = successResult({ agents: [{ id: "main" }], count: 1 });
  assert.equal(result.structuredContent.count, 1);
  assert.equal(result.structuredContent.truncated, undefined);
});

test("few items with large strings are adaptively truncated within the byte cap", () => {
  // 4 sessões, cada uma com um "model" enorme (~100 KiB) → excede 256 KiB.
  const big = "m".repeat(100 * 1024);
  const sessions = Array.from({ length: 4 }, (_, i) => ({
    agentId: "main",
    key: `agent:main:s${i}`,
    model: big,
  }));
  const result = successResult({ sessions, count: 4, hasMore: false, source: "gateway" });
  assert.equal(result.structuredContent.truncated, true);
  assert.ok(result.structuredContent.sessions.length < 4);
  assert.ok(bytes(result) <= RESULT_MAX_BYTES, `payload ${bytes(result)} <= ${RESULT_MAX_BYTES}`);
});

test("a single oversized item cannot fit and raises output_too_large", () => {
  const huge = "x".repeat(RESULT_MAX_BYTES + 1024);
  const sessions = [{ agentId: "main", key: "agent:main:s0", model: huge }];
  try {
    successResult({ sessions, count: 1, hasMore: false, source: "gateway" });
    assert.fail("should have thrown output_too_large");
  } catch (err) {
    assert.ok(isToolError(err));
    assert.equal(err.category, ERROR_CATEGORIES.OUTPUT_TOO_LARGE);
  }
});
