import assert from "node:assert/strict";
import test from "node:test";
import { buildBoundedMessagesResult } from "../src/openclaw/messages.mjs";
import { decodeHistoryCursor } from "../src/openclaw/history-cursor.mjs";
import { MESSAGES_LIMIT_MAX, RESULT_MAX_BYTES } from "../src/lib/limits.mjs";

const scope = { sessionKey: "agent:main:synthetic-1", agentId: "main", limit: 200 };

function makeMsgs(n, startTs = 1700000000000) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: i % 2 === 0 ? "user" : "assistant", timestamp: startTs + i });
  }
  return out;
}

test("a full max page (200 metadata-only messages) fits under the byte cap without truncation", () => {
  const page = { messages: makeMsgs(MESSAGES_LIMIT_MAX), count: MESSAGES_LIMIT_MAX, hasMore: false };
  const result = buildBoundedMessagesResult({ page, offset: 0, scope, maxBytes: RESULT_MAX_BYTES });
  assert.equal(result.truncated, undefined, "must not truncate a normal max page");
  assert.equal(result.count, MESSAGES_LIMIT_MAX);
  assert.equal(result.messages.length, MESSAGES_LIMIT_MAX);
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(bytes < RESULT_MAX_BYTES, `serialized ${bytes} must be under ${RESULT_MAX_BYTES}`);
});

test("under forced truncation: count reflects returned items and no item is skipped", () => {
  // maxBytes minúsculo força o truncamento de forma determinística.
  const page = { messages: makeMsgs(200), count: 200, hasMore: true, nextOffset: 200, totalMessages: 5000 };
  const offset = 0;
  const result = buildBoundedMessagesResult({ page, offset, scope, maxBytes: 400 });

  assert.equal(result.truncated, true, "should be truncated under a tiny cap");
  // count reflete a lista realmente retornada.
  assert.equal(result.count, result.messages.length);
  assert.ok(result.count < 200, "fewer items returned than the full page");
  // hasMore coerente.
  assert.equal(result.hasMore, true);
  // nextCursor aponta para o 1o item NÃO retornado (offset + count) — sem pular.
  assert.ok(typeof result.nextCursor === "string");
  const nextOffset = decodeHistoryCursor(result.nextCursor, scope);
  assert.equal(nextOffset, offset + result.count, "cursor must point to the first non-returned item");
});

test("truncation with a non-zero starting offset repoints the cursor correctly", () => {
  const page = { messages: makeMsgs(100), count: 100, hasMore: true, nextOffset: 300, totalMessages: 5000 };
  const offset = 200; // esta página começa no item 200
  const result = buildBoundedMessagesResult({ page, offset, scope, maxBytes: 400 });
  assert.equal(result.truncated, true);
  const nextOffset = decodeHistoryCursor(result.nextCursor, scope);
  // Deve apontar para o 1o não retornado nesta página: 200 + count.
  assert.equal(nextOffset, offset + result.count);
  // E esse ponto deve estar ANTES do nextOffset original do Gateway (300),
  // provando que não pulamos itens.
  assert.ok(nextOffset <= 300);
});

test("no truncation path preserves the Gateway nextOffset when hasMore", () => {
  const page = { messages: makeMsgs(50), count: 50, hasMore: true, nextOffset: 50, totalMessages: 500 };
  const result = buildBoundedMessagesResult({ page, offset: 0, scope, maxBytes: RESULT_MAX_BYTES });
  assert.equal(result.truncated, undefined);
  assert.equal(result.hasMore, true);
  const nextOffset = decodeHistoryCursor(result.nextCursor, scope);
  assert.equal(nextOffset, 50);
});

test("no nextCursor when hasMore is false and not truncated", () => {
  const page = { messages: makeMsgs(3), count: 3, hasMore: false };
  const result = buildBoundedMessagesResult({ page, offset: 0, scope, maxBytes: RESULT_MAX_BYTES });
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, undefined);
});

test("the truncated cursor validates and round-trips within the same scope", () => {
  const page = { messages: makeMsgs(200), count: 200, hasMore: true, nextOffset: 200 };
  const result = buildBoundedMessagesResult({ page, offset: 0, scope, maxBytes: 400 });
  // Reusar o cursor no MESMO escopo decodifica o offset esperado.
  assert.equal(decodeHistoryCursor(result.nextCursor, scope), result.count);
  // Em escopo divergente, é rejeitado.
  const other = { sessionKey: "agent:main:synthetic-2", agentId: "main", limit: 200 };
  assert.throws(() => decodeHistoryCursor(result.nextCursor, other));
});
