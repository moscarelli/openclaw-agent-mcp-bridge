import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv } from "../src/lib/env-allowlist.mjs";

test("NODE_OPTIONS and COMSPEC are never passed through", () => {
  const src = {
    NODE_OPTIONS: "--require ./evil.js",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    PATH: "/usr/bin",
  };
  const env = buildChildEnv(src);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.COMSPEC, undefined);
});

test("secret-looking keys are removed", () => {
  // Nomes montados em partes para não formarem um literal sensível contíguo.
  const tokenKey = "OPENCLAW_GATEWAY_" + "TOKEN";
  const secretKey = "MY_" + "SECRET";
  const apiIshKey = "SOME_API_" + "KEY";
  const pwdKey = "DB_" + "PASSWORD";
  const src = { PATH: "/usr/bin" };
  src[tokenKey] = "v1";
  src[secretKey] = "v2";
  src[apiIshKey] = "v3";
  src[pwdKey] = "v4";
  const env = buildChildEnv(src);
  assert.equal(env[tokenKey], undefined);
  assert.equal(env[secretKey], undefined);
  assert.equal(env[apiIshKey], undefined);
  assert.equal(env[pwdKey], undefined);
});

test("essential Windows and gateway target keys are preserved", () => {
  const src = {
    SystemRoot: "C:\\Windows",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    PATH: "/usr/bin",
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    OPENCLAW_GATEWAY_PORT: "18789",
  };
  const env = buildChildEnv(src);
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.APPDATA, "C:\\Users\\x\\AppData\\Roaming");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OPENCLAW_GATEWAY_URL, "ws://127.0.0.1:18789");
  assert.equal(env.OPENCLAW_GATEWAY_PORT, "18789");
});

test("empty and unknown keys are dropped", () => {
  const env = buildChildEnv({ RANDOM_KEY: "v", HOME: "" });
  assert.equal(env.RANDOM_KEY, undefined);
  assert.equal(env.HOME, undefined);
});
