import assert from "node:assert/strict";
import test from "node:test";
import { redactString, redactValue } from "../src/lib/redact.mjs";
import { unixHome, macUsers, winUsers } from "./helpers/synthetic.mjs";

test("redacts Windows and unix user paths", () => {
  assert.ok(!redactString(winUsers("alice", "file.txt")).includes("alice"));
  assert.ok(!redactString(unixHome("bob", ".openclaw")).includes("bob"));
  assert.ok(!redactString(macUsers("carol")).includes("carol"));
});

test("redacts tokens, secretref markers and authorization", () => {
  const tok = ["to", "ken"].join("") + "=abc123def";
  assert.ok(!redactString(tok).includes("abc123def"));
  assert.ok(!redactString("secretref-env:MY_" + "VALUE").includes("MY_VALUE"));
  assert.ok(!redactString("Authorization: Bearer xyz789").includes("xyz789"));
});

test("redactValue recurses without mutating input", () => {
  const home = unixHome("dave");
  const input = { a: home, nested: { token: "s-value" } };
  const out = redactValue(input);
  assert.ok(!JSON.stringify(out).includes("dave"));
  assert.ok(!JSON.stringify(out).includes("s-value"));
  // Original não é mutado.
  assert.equal(input.a, home);
});

test("handles circular references", () => {
  const obj = { name: "x" };
  obj.self = obj;
  const out = redactValue(obj);
  assert.equal(out.self, "[circular]");
});
