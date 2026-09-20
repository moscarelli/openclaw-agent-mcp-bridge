import assert from "node:assert/strict";
import test from "node:test";
import { classifyResolveResponse } from "../src/openclaw/messages.mjs";

// Validação FECHADA da resposta de sessions.resolve (forma positiva confirmada
// no OpenClaw 2026.9.3: { ok: true, key, agentId } | { ok: false } |
// { ok: false, candidates }). Só o booleano `ok` é lido.

test("valid success { ok: true, ... } → exists", () => {
  assert.equal(classifyResolveResponse({ ok: true, key: "agent:main:s1", agentId: "main" }), "exists");
});

test("missing { ok: false } → not_found", () => {
  assert.equal(classifyResolveResponse({ ok: false }), "not_found");
});

test("ambiguous { ok: false, candidates } → not_found (candidates never read)", () => {
  let candidatesRead = false;
  const resolved = {
    ok: false,
    get candidates() {
      candidatesRead = true;
      return ["agent:main:a", "agent:main:b"];
    },
  };
  assert.equal(classifyResolveResponse(resolved), "not_found");
  assert.equal(candidatesRead, false, "candidates getter must not be invoked");
});

test("empty object {} → malformed", () => {
  assert.equal(classifyResolveResponse({}), "malformed");
});

test("array [] → malformed (never exists)", () => {
  assert.equal(classifyResolveResponse([]), "malformed");
  assert.equal(classifyResolveResponse([{ ok: true }]), "malformed");
});

test("null → malformed", () => {
  assert.equal(classifyResolveResponse(null), "malformed");
});

test("undefined / primitives → malformed", () => {
  assert.equal(classifyResolveResponse(undefined), "malformed");
  assert.equal(classifyResolveResponse("ok"), "malformed");
  assert.equal(classifyResolveResponse(1), "malformed");
  assert.equal(classifyResolveResponse(true), "malformed");
});

test("{ ok: \"true\" } (wrong type) → malformed (never exists)", () => {
  assert.equal(classifyResolveResponse({ ok: "true", key: "agent:main:s1" }), "malformed");
});

test("{ ok: 1 } / { ok: null } (wrong type) → malformed", () => {
  assert.equal(classifyResolveResponse({ ok: 1 }), "malformed");
  assert.equal(classifyResolveResponse({ ok: null }), "malformed");
});

test("hostile getters on UNUSED fields are never invoked; only `ok` is read", () => {
  let touched = [];
  const resolved = {
    ok: true,
    get key() {
      touched.push("key");
      throw new Error("key getter must not be accessed");
    },
    get agentId() {
      touched.push("agentId");
      throw new Error("agentId getter must not be accessed");
    },
    get path() {
      touched.push("path");
      throw new Error("path getter must not be accessed");
    },
    get secret() {
      touched.push("secret");
      throw new Error("secret getter must not be accessed");
    },
  };
  assert.equal(classifyResolveResponse(resolved), "exists");
  assert.deepEqual(touched, [], "no unused field getter should be accessed");
});

test("success with secret-looking fields classifies as exists without copying them", () => {
  const resolved = {
    ok: true,
    key: "agent:main:s1",
    secret: "synthetic-should-not-leak",
    token: "synthetic-not-a-real-value",
  };
  // A classificação não retorna nem copia nenhum campo; devolve só o veredito.
  assert.equal(classifyResolveResponse(resolved), "exists");
});
