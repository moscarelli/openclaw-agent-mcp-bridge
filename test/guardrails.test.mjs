import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeIdentifier, projectStatus } from "../src/index.mjs";

test("package remains an experimental private preview", () => {
  assert.equal(projectStatus.stable, false);
  assert.equal(projectStatus.distribution, "private");
});

test("safe identifiers accept session syntax and reject shell/path input", () => {
  assert.equal(assertSafeIdentifier("agent:main:session-1"), "agent:main:session-1");
  for (const value of ["", "../secret", "x y", "x;whoami", "C:\\Users\\name"]) {
    assert.throws(() => assertSafeIdentifier(value));
  }
});
