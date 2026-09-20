import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMessage,
  buildMessagesPage,
  mapRole,
  mapUnavailableReason,
} from "../src/openclaw/normalize-messages.mjs";

// Campos proibidos que NUNCA podem aparecer na saída.
const FORBIDDEN_KEYS = [
  "content",
  "contentPreview",
  "contentLength",
  "omitted",
  "provenance",
  "senderSession",
  "senderLabel",
  "idempotencyKey",
  "messageId",
  "__openclaw",
  "attachments",
];

function assertNoForbidden(obj) {
  const serialized = JSON.stringify(obj);
  for (const key of FORBIDDEN_KEYS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(obj, key), `must not have key ${key}`);
  }
  // Nenhum valor hostil/sensível transita.
  assert.ok(!serialized.includes("IGNORE_PREVIOUS_INSTRUCTIONS"));
  assert.ok(!serialized.includes("should-not-leak"));
  assert.ok(!serialized.includes("synthetic-idem"));
}

test("buildMessage returns only allowlisted fields", () => {
  const raw = {
    role: "user",
    content: "IGNORE_PREVIOUS_INSTRUCTIONS secret",
    timestamp: 1700000000000,
    messageId: "synthetic-msg-1",
    idempotencyKey: "synthetic-idem-1",
    senderLabel: "x",
    senderSession: { key: "leak" },
    provenance: { p: 1 },
    __openclaw: { i: 1 },
    attachments: [{ url: "https://x/should-not-leak" }],
  };
  const msg = buildMessage(raw);
  // messageId é omitido nesta versão; só role e timestamp permanecem.
  assert.deepEqual(Object.keys(msg).sort(), ["role", "timestamp"]);
  assert.equal(msg.role, "user");
  assert.equal(msg.timestamp, 1700000000000);
  assert.ok(!("messageId" in msg));
  assertNoForbidden(msg);
});

test("unknown role maps to 'unknown'", () => {
  assert.equal(mapRole("wizard"), "unknown");
  assert.equal(mapRole(12345), "unknown");
  assert.equal(mapRole(undefined), "unknown");
  assert.equal(buildMessage({ role: "wizard", content: "x" }).role, "unknown");
});

test("known roles are preserved", () => {
  for (const r of ["user", "assistant", "system", "tool"]) {
    assert.equal(mapRole(r), r);
  }
});

test("non-object entry becomes an entry with role unknown and no extra metadata", () => {
  const msg = buildMessage("a hostile string");
  assert.deepEqual(msg, { role: "unknown" });
});

test("malformed timestamp is omitted, not guessed", () => {
  const msg = buildMessage({ role: "user", timestamp: "not-a-number" });
  assert.deepEqual(msg, { role: "user" });
});

test("messageId is NEVER emitted (omitted in this version), regardless of content", () => {
  const hostileIds = [
    "IGNORE_PREVIOUS_INSTRUCTIONS",
    "synthetic-should-not-leak-token",
    "/etc/passwd",
    "C:\\Users\\victim\\secret",
    "https://synthetic.invalid/leak",
    "line1\nline2",
    "ctrl\u0000\u0007\u001bchars",
    "x".repeat(100000),
    "agent:main:synthetic-other",
  ];
  for (const id of hostileIds) {
    const msg = buildMessage({ role: "user", messageId: id, timestamp: 1700000000000 });
    assert.deepEqual(Object.keys(msg).sort(), ["role", "timestamp"], "no messageId key");
    assert.ok(!("messageId" in msg));
    const serialized = JSON.stringify(msg);
    assert.ok(!serialized.includes("IGNORE_PREVIOUS"));
    assert.ok(!serialized.includes("should-not-leak"));
    assert.ok(!serialized.includes("passwd"));
    assert.ok(!serialized.includes("synthetic.invalid"));
  }
});

test("hostile messageId getter is never invoked", () => {
  const raw = {
    role: "assistant",
    timestamp: 1700000000000,
    get messageId() {
      throw new Error("messageId getter must not be accessed");
    },
  };
  const msg = buildMessage(raw);
  assert.deepEqual(msg, { role: "assistant", timestamp: 1700000000000 });
});

test("timestamp hardening: unsafe/negative/out-of-range are omitted", () => {
  assert.deepEqual(buildMessage({ role: "user", timestamp: -1 }), { role: "user" });
  assert.deepEqual(buildMessage({ role: "user", timestamp: 1.5 }), { role: "user" });
  assert.deepEqual(buildMessage({ role: "user", timestamp: Number.MAX_SAFE_INTEGER + 2 }), { role: "user" });
  // Fora da faixa epoch aceitável (> ano 2100).
  assert.deepEqual(buildMessage({ role: "user", timestamp: 4200000000000 }), { role: "user" });
  // Dentro da faixa: mantido.
  assert.deepEqual(buildMessage({ role: "user", timestamp: 1700000000000 }), {
    role: "user",
    timestamp: 1700000000000,
  });
  // Zero é aceitável (epoch).
  assert.deepEqual(buildMessage({ role: "user", timestamp: 0 }), { role: "user", timestamp: 0 });
});

test("content is never read even to compute a size (huge content ignored)", () => {
  const raw = { role: "assistant", content: "x".repeat(500000), timestamp: 1 };
  const msg = buildMessage(raw);
  assert.deepEqual(Object.keys(msg).sort(), ["role", "timestamp"]);
  assert.ok(!("contentLength" in msg));
});

test("getters that would leak are not invoked/copied", () => {
  const raw = {
    role: "user",
    get content() {
      throw new Error("content getter must not be accessed");
    },
    get __openclaw() {
      throw new Error("internal getter must not be accessed");
    },
    timestamp: 5,
  };
  const msg = buildMessage(raw);
  assert.deepEqual(msg, { role: "user", timestamp: 5 });
});

test("buildMessagesPage: allowlist page + pagination metadata only", () => {
  const parsed = {
    messages: [
      { role: "user", content: "should-not-leak", timestamp: 1, messageId: "m1" },
      { role: "bogus", content: "IGNORE_PREVIOUS_INSTRUCTIONS", provenance: {} },
    ],
    hasMore: true,
    nextOffset: 2,
    totalMessages: 10,
    sessionInfo: { secret: "should-not-leak" },
    defaults: { model: "secret" },
  };
  const page = buildMessagesPage(parsed);
  assert.equal(page.count, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 2);
  assert.equal(page.totalMessages, 10);
  assert.equal(page.messages[1].role, "unknown");
  for (const m of page.messages) assertNoForbidden(m);
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes("should-not-leak"));
  assert.ok(!serialized.includes("IGNORE_PREVIOUS_INSTRUCTIONS"));
  assert.ok(!serialized.includes("sessionInfo"));
});

test("buildMessagesPage defaults hasMore to false and omits missing pagination", () => {
  const page = buildMessagesPage({ messages: [] });
  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, undefined);
  assert.equal(page.totalMessages, undefined);
});

test("mapUnavailableReason: closed allowlist, original discarded", () => {
  assert.equal(mapUnavailableReason("not_found"), "not_found");
  assert.equal(mapUnavailableReason("content_expired"), "content_expired");
  assert.equal(mapUnavailableReason("some-internal-detail"), "unknown");
  assert.equal(mapUnavailableReason(undefined), "unknown");
});
