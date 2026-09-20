import assert from "node:assert/strict";
import test from "node:test";
import { encodeHistoryCursor, decodeHistoryCursor } from "../src/openclaw/history-cursor.mjs";
import { encodeCursor, decodeCursor } from "../src/openclaw/cursor.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";

// Escopos 100% sintéticos.
const scopeA = { sessionKey: "agent:main:synthetic-1", agentId: "main", limit: 50 };
const scopeNoAgent = { sessionKey: "agent:main:synthetic-1", agentId: null, limit: 50 };

function decodePayload(cursor) {
  // O cursor da Fase 2 é um único token Base64URL (sem ponto).
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

function isInvalidArg(err) {
  return isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT;
}

test("round-trip: decode returns the encoded offset for the same scope", () => {
  const cursor = encodeHistoryCursor(100, scopeA);
  assert.equal(decodeHistoryCursor(cursor, scopeA), 100);
});

test("payload contains ONLY version, offset, scopeFingerprint", () => {
  const cursor = encodeHistoryCursor(50, scopeA);
  const payload = decodePayload(cursor);
  assert.deepEqual(Object.keys(payload).sort(), ["offset", "scopeFingerprint", "version"]);
});

test("decoded payload reveals no sessionKey / agentId / raw filters", () => {
  const cursor = encodeHistoryCursor(10, scopeA);
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  assert.ok(!raw.includes("agent:main:synthetic-1"), "no sessionKey");
  assert.ok(!raw.includes("\"agentId\""), "no agentId key");
  assert.ok(!raw.includes("\"main\""), "no agentId value");
  assert.ok(!raw.includes("\"limit\""), "no limit filter");
  assert.ok(!raw.includes("\"sessionKey\""), "no sessionKey field");
});

test("fingerprint is a keyed HMAC (base64url of 32 bytes)", () => {
  const payload = decodePayload(encodeHistoryCursor(0, scopeA));
  const fp = Buffer.from(payload.scopeFingerprint, "base64url");
  assert.equal(fp.length, 32); // SHA-256
});

test("altering offset (keeping the original fingerprint) → invalid_argument", () => {
  // O offset agora participa do HMAC. Adulterar o offset mantendo o fingerprint
  // original deve invalidar o cursor.
  const cursor = encodeHistoryCursor(100, scopeA);
  const payload = decodePayload(cursor);
  payload.offset = 999; // fingerprint permanece o do offset 100
  const tampered = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.throws(() => decodeHistoryCursor(tampered, scopeA), isInvalidArg);
});

test("a cursor for a different offset in the same scope has a different fingerprint", () => {
  const fp100 = decodePayload(encodeHistoryCursor(100, scopeA)).scopeFingerprint;
  const fp200 = decodePayload(encodeHistoryCursor(200, scopeA)).scopeFingerprint;
  assert.notEqual(fp100, fp200);
});

test("altering scopeFingerprint invalidates the cursor", () => {
  const cursor = encodeHistoryCursor(100, scopeA);
  const payload = decodePayload(cursor);
  const fp = Buffer.from(payload.scopeFingerprint, "base64url");
  fp[0] = fp[0] ^ 0xff; // flip
  payload.scopeFingerprint = fp.toString("base64url");
  const tampered = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.throws(() => decodeHistoryCursor(tampered, scopeA), isInvalidArg);
});

test("reuse with a different sessionKey → invalid_argument", () => {
  const cursor = encodeHistoryCursor(50, scopeA);
  const other = { sessionKey: "agent:main:synthetic-2", agentId: "main", limit: 50 };
  assert.throws(() => decodeHistoryCursor(cursor, other), isInvalidArg);
});

test("reuse with a different agentId → invalid_argument", () => {
  const cursor = encodeHistoryCursor(50, scopeA);
  const other = { sessionKey: "agent:main:synthetic-1", agentId: "work", limit: 50 };
  assert.throws(() => decodeHistoryCursor(cursor, other), isInvalidArg);
});

test("reuse with a different limit → invalid_argument", () => {
  const cursor = encodeHistoryCursor(50, scopeA);
  const other = { sessionKey: "agent:main:synthetic-1", agentId: "main", limit: 100 };
  assert.throws(() => decodeHistoryCursor(cursor, other), isInvalidArg);
});

test("agentId null vs a concrete agentId are distinct scopes", () => {
  const cursor = encodeHistoryCursor(50, scopeNoAgent);
  assert.throws(() => decodeHistoryCursor(cursor, scopeA), isInvalidArg);
  assert.equal(decodeHistoryCursor(cursor, scopeNoAgent), 50);
});

test("a Phase 1 cursor is rejected by Phase 2", () => {
  const phase1 = encodeCursor(100, { agentId: "main", limit: 50 });
  assert.throws(() => decodeHistoryCursor(phase1, scopeA), isInvalidArg);
});

test("a Phase 2 cursor is rejected by Phase 1", () => {
  const phase2 = encodeHistoryCursor(100, scopeA);
  assert.throws(
    () => decodeCursor(phase2, { agentId: "main", limit: 50 }),
    isInvalidArg,
  );
});

test("malformed cursor → invalid_argument", () => {
  assert.throws(() => decodeHistoryCursor("!!!not-base64!!!", scopeA), isInvalidArg);
  assert.throws(() => decodeHistoryCursor("", scopeA), isInvalidArg);
});

test("non-canonical / non-base64url envelopes are rejected", () => {
  const valid = encodeHistoryCursor(0, scopeA);
  // whitespace
  assert.throws(() => decodeHistoryCursor(" " + valid, scopeA), isInvalidArg);
  assert.throws(() => decodeHistoryCursor(valid + "\n", scopeA), isInvalidArg);
  // standard base64 padding / chars
  const stdB64 = Buffer.from(Buffer.from(valid, "base64url")).toString("base64"); // may contain +/=
  if (stdB64 !== valid) {
    assert.throws(() => decodeHistoryCursor(stdB64, scopeA), isInvalidArg);
  }
  // trailing '=' padding is not canonical here
  assert.throws(() => decodeHistoryCursor(valid + "=", scopeA), isInvalidArg);
});

test("over-length cursor is rejected before large allocation", () => {
  const huge = "A".repeat(100000);
  assert.throws(() => decodeHistoryCursor(huge, scopeA), isInvalidArg);
});

test("fingerprint of wrong length is rejected", () => {
  const cursor = encodeHistoryCursor(0, scopeA);
  const payload = decodePayload(cursor);
  payload.scopeFingerprint = payload.scopeFingerprint.slice(0, 10); // too short
  const bad = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.throws(() => decodeHistoryCursor(bad, scopeA), isInvalidArg);
});

test("non-canonical fingerprint (padding) is rejected", () => {
  const cursor = encodeHistoryCursor(0, scopeA);
  const payload = decodePayload(cursor);
  // 43 chars é o comprimento esperado; injeta padding para quebrar canonicidade
  // mantendo o comprimento exigido não é possível, então testamos comprimento
  // exato + caractere inválido.
  payload.scopeFingerprint = payload.scopeFingerprint.slice(0, 42) + "=";
  const bad = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.throws(() => decodeHistoryCursor(bad, scopeA), isInvalidArg);
});

test("cursor with unexpected extra fields → invalid_argument", () => {
  const payload = { version: 1, offset: 0, scopeFingerprint: "AAAA", extra: "x" };
  const bad = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.throws(() => decodeHistoryCursor(bad, scopeA), isInvalidArg);
});

test("errors contain no sessionKey/agentId/fingerprint", () => {
  const cursor = encodeHistoryCursor(50, scopeA);
  const other = { sessionKey: "agent:main:synthetic-2", agentId: "work", limit: 100 };
  try {
    decodeHistoryCursor(cursor, other);
    assert.fail("should have thrown");
  } catch (err) {
    const msg = String(err.message);
    assert.ok(!msg.includes("synthetic-2"));
    assert.ok(!msg.includes("work"));
    const payload = decodePayload(cursor);
    assert.ok(!msg.includes(payload.scopeFingerprint));
  }
});
