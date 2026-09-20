import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAgentTurnResponse,
  parseAndNormalize,
  truncateUtf8,
} from "../src/openclaw/agent-turn-normalize.mjs";
import { AGENT_TURN_RESPONSE_MAX_BYTES } from "../src/lib/limits.mjs";

test("completed with one text payload", () => {
  const r = normalizeAgentTurnResponse({ status: "ok", result: { payloads: [{ text: "hello" }] } });
  assert.deepEqual(r, { status: "completed", response: "hello", source: "gateway" });
});

test("completed with multiple payloads joins with blank line and ignores media", () => {
  const r = normalizeAgentTurnResponse({
    status: "ok",
    result: {
      payloads: [{ text: "A" }, { text: "B" }, { mediaUrl: "https://x.invalid/should-not-leak" }],
    },
  });
  assert.equal(r.status, "completed");
  assert.equal(r.response, "A\n\nB");
  assert.ok(!JSON.stringify(r).includes("should-not-leak"));
});

test("completed with no text payloads (valid empty array) returns empty response", () => {
  const r = normalizeAgentTurnResponse({ status: "ok", result: { payloads: [] } });
  assert.deepEqual(r, { status: "completed", response: "", source: "gateway" });
});

test("'completed' status is also accepted as success (CLI equivalence)", () => {
  const r = normalizeAgentTurnResponse({ status: "completed", result: { payloads: [{ text: "hi" }] } });
  assert.deepEqual(r, { status: "completed", response: "hi", source: "gateway" });
});

test("'error' status maps to failed (no content)", () => {
  const r = normalizeAgentTurnResponse({ status: "error", result: { payloads: [{ text: "leak?" }] } });
  assert.deepEqual(r, { status: "failed", source: "gateway" });
});

test("unproven aliases (success/failed/partial_failed) map to unknown", () => {
  for (const s of ["success", "failed", "partial_failed", "cancelled", "aborted"]) {
    assert.deepEqual(
      normalizeAgentTurnResponse({ status: s, result: { payloads: [{ text: "x" }] } }),
      { status: "unknown", source: "gateway" },
    );
  }
});

test("'timeout' and 'in_flight' statuses map to unknown", () => {
  assert.deepEqual(normalizeAgentTurnResponse({ status: "timeout" }), { status: "unknown", source: "gateway" });
  assert.deepEqual(normalizeAgentTurnResponse({ status: "in_flight" }), { status: "unknown", source: "gateway" });
});

test("success status with invalid result shape maps to unknown, never completed-empty", () => {
  assert.deepEqual(normalizeAgentTurnResponse({ status: "ok" }), { status: "unknown", source: "gateway" });
  assert.deepEqual(normalizeAgentTurnResponse({ status: "ok", result: null }), { status: "unknown", source: "gateway" });
  assert.deepEqual(normalizeAgentTurnResponse({ status: "ok", result: { payloads: "x" } }), { status: "unknown", source: "gateway" });
  assert.deepEqual(normalizeAgentTurnResponse({ status: "ok", result: { payloads: [42] } }), { status: "unknown", source: "gateway" });
  assert.deepEqual(normalizeAgentTurnResponse({ status: "ok", result: { payloads: [{ text: 5 }] } }), { status: "unknown", source: "gateway" });
});

test("media-only payload yields empty response, no urls", () => {
  const r = normalizeAgentTurnResponse({
    status: "ok",
    result: { payloads: [{ mediaUrls: ["https://x.invalid/should-not-leak"] }] },
  });
  assert.equal(r.status, "completed");
  assert.equal(r.response, "");
  assert.ok(!JSON.stringify(r).includes("should-not-leak"));
});

test("error status carries no content", () => {
  const r = normalizeAgentTurnResponse({
    status: "error",
    result: { payloads: [{ text: "error detail should not leak" }] },
    summary: "s",
    stopReason: "x",
  });
  assert.deepEqual(r, { status: "failed", source: "gateway" });
});

test("unknown status maps to unknown with no content", () => {
  const r = normalizeAgentTurnResponse({ status: "some_new_status", result: { payloads: [{ text: "x" }] } });
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("non-object / missing status maps to unknown", () => {
  assert.deepEqual(normalizeAgentTurnResponse(null), { status: "unknown", source: "gateway" });
  assert.deepEqual(normalizeAgentTurnResponse([]), { status: "unknown", source: "gateway" });
  assert.deepEqual(normalizeAgentTurnResponse({ result: {} }), { status: "unknown", source: "gateway" });
});

test("malformed stdout parses to unknown", () => {
  assert.deepEqual(parseAndNormalize("{ not json "), { status: "unknown", source: "gateway" });
  assert.deepEqual(parseAndNormalize(""), { status: "unknown", source: "gateway" });
});

test("oversize response is UTF-8-safe truncated with truncated:true", () => {
  const big = "x".repeat(AGENT_TURN_RESPONSE_MAX_BYTES + 1000);
  const r = normalizeAgentTurnResponse({ status: "ok", result: { payloads: [{ text: big }] } });
  assert.equal(r.status, "completed");
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.response, "utf8") <= AGENT_TURN_RESPONSE_MAX_BYTES);
});

test("truncateUtf8 never splits a multi-byte sequence", () => {
  // "é" is 2 bytes in UTF-8; fill just past a small cap on a boundary.
  const text = "é".repeat(100);
  const { text: out, truncated } = truncateUtf8(text, 5); // 5 bytes = 2 full "é" + 1 dangling byte
  assert.equal(truncated, true);
  // Result must be valid UTF-8 (no U+FFFD replacement char at the end).
  assert.ok(!out.endsWith("\uFFFD"));
  assert.ok(Buffer.byteLength(out, "utf8") <= 5);
});

test("payloads must be an array; non-array yields unknown (not completed-empty)", () => {
  const r = normalizeAgentTurnResponse({ status: "ok", result: { payloads: "nope" } });
  assert.deepEqual(r, { status: "unknown", source: "gateway" });
});

test("never forwards runId/sessionKey/summary/model even on success", () => {
  const r = normalizeAgentTurnResponse({
    status: "ok",
    runId: "synthetic-run",
    sessionKey: "agent:main:synthetic",
    summary: "synthetic-summary",
    model: "synthetic/model",
    result: { payloads: [{ text: "hi" }] },
  });
  const keys = Object.keys(r).sort();
  assert.deepEqual(keys, ["response", "source", "status"]);
});
