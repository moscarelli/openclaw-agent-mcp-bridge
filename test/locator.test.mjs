import assert from "node:assert/strict";
import test from "node:test";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateEntrypoint, extractJsFromShim } from "../src/openclaw/locator.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";
import { fakeEntry, shimCmd, shimTargetEntry } from "./helpers/fixture.mjs";

test("accepts an .mjs entrypoint that belongs to the expected OpenClaw package", () => {
  const resolved = validateEntrypoint(fakeEntry);
  assert.ok(resolved.endsWith("openclaw.mjs"));
});

test("rejects a JS file outside any expected package", () => {
  const notOpenclaw = fileURLToPath(new URL("../normalize.test.mjs", import.meta.url));
  assert.throws(
    () => validateEntrypoint(notOpenclaw),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.CLI_UNAVAILABLE,
  );
});

test("rejects a non-existent file", () => {
  assert.throws(
    () => validateEntrypoint("/synthetic/does/not/exist.js"),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.CLI_UNAVAILABLE,
  );
});

test("extractJsFromShim resolves the real npm .cmd shim pointing to openclaw.mjs", () => {
  const extracted = extractJsFromShim(shimCmd);
  assert.ok(extracted, "should extract a target from the shim");
  assert.equal(realpathSync(extracted), realpathSync(shimTargetEntry));
  assert.ok(extracted.endsWith("openclaw.mjs"));
});

test("the shim target validates as an expected OpenClaw entrypoint", () => {
  const extracted = extractJsFromShim(shimCmd);
  const validated = validateEntrypoint(extracted);
  assert.ok(validated.endsWith("openclaw.mjs"));
});
