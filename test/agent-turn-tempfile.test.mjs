import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { writePromptTempfile } from "../src/openclaw/prompt-tempfile.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";
import { AGENT_TURN_INSTRUCTION_MAX_BYTES } from "../src/lib/limits.mjs";

test("writes a synthetic prompt to a restricted temp file and reads back", async () => {
  const instruction = "synthetic prompt content";
  const handle = await writePromptTempfile(instruction);
  try {
    assert.ok(typeof handle.path === "string" && handle.path.length > 0);
    assert.ok(existsSync(handle.path));
    assert.equal(readFileSync(handle.path, "utf8"), instruction);
  } finally {
    const status = await handle.cleanup();
    assert.equal(status, "ok");
  }
  // After cleanup the file must be gone.
  assert.ok(!existsSync(handle.path));
});

test("cleanup is idempotent and removes the exclusive directory", async () => {
  const handle = await writePromptTempfile("synthetic");
  const first = await handle.cleanup();
  const second = await handle.cleanup();
  assert.equal(first, "ok");
  assert.equal(second, "ok"); // idempotent, no throw
  assert.ok(!existsSync(handle.path));
});

test("rejects instruction above the byte limit before writing", async () => {
  const big = "x".repeat(AGENT_TURN_INSTRUCTION_MAX_BYTES + 1);
  await assert.rejects(
    () => writePromptTempfile(big),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INVALID_ARGUMENT,
  );
});

test("writes exactly at the byte limit", async () => {
  const atLimit = "y".repeat(AGENT_TURN_INSTRUCTION_MAX_BYTES);
  const handle = await writePromptTempfile(atLimit);
  try {
    assert.equal(Buffer.byteLength(readFileSync(handle.path), "utf8"), AGENT_TURN_INSTRUCTION_MAX_BYTES);
  } finally {
    await handle.cleanup();
  }
});

test("multi-byte UTF-8 content round-trips", async () => {
  const instruction = "acentuação ção — 日本語 — emoji 🙂";
  const handle = await writePromptTempfile(instruction);
  try {
    assert.equal(readFileSync(handle.path, "utf8"), instruction);
  } finally {
    await handle.cleanup();
  }
});

test("temp path never contains the instruction text", async () => {
  const instruction = "SECRET_SYNTHETIC_MARKER_12345";
  const handle = await writePromptTempfile(instruction);
  try {
    assert.ok(!handle.path.includes(instruction));
  } finally {
    await handle.cleanup();
  }
});

test("injected realpath failure after mkdtemp fails closed and cleans the created dir", async () => {
  // No residual ocmb-turn-* directory should remain. We can't easily read the
  // created dir name (never exposed), so assert the error and that the temp
  // root has no leftover directory created during this call window.
  const { tmpdir } = await import("node:os");
  const { readdirSync } = await import("node:fs");
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("ocmb-turn-")));
  await assert.rejects(
    () => writePromptTempfile("synthetic", { failRealpath: true }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("ocmb-turn-"));
  const leaked = after.filter((n) => !before.has(n));
  assert.deepEqual(leaked, [], `no residual temp dir; leaked=${leaked.join(",")}`);
});

test("injected close failure before spawn is a pre-dispatch error and cleans up", async () => {
  const { tmpdir } = await import("node:os");
  const { readdirSync } = await import("node:fs");
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("ocmb-turn-")));
  await assert.rejects(
    () => writePromptTempfile("synthetic", { failClose: true }),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.INTERNAL,
  );
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("ocmb-turn-"));
  const leaked = after.filter((n) => !before.has(n));
  assert.deepEqual(leaked, [], `no residual temp dir; leaked=${leaked.join(",")}`);
});

test("no residual temp dir after a normal successful write+cleanup", async () => {
  const { tmpdir } = await import("node:os");
  const { readdirSync } = await import("node:fs");
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("ocmb-turn-")));
  const handle = await writePromptTempfile("synthetic");
  await handle.cleanup();
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("ocmb-turn-"));
  const leaked = after.filter((n) => !before.has(n));
  assert.deepEqual(leaked, [], `no residual temp dir; leaked=${leaked.join(",")}`);
});
