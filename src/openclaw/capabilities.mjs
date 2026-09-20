// Detecção de versão/capacidades do OpenClaw (PHASE1_PLAN §9).
// Best-effort: nunca falha a operação principal se a versão não puder ser lida.

import { runOpenclaw } from "./runner.mjs";
import { resolveOpenclawEntry } from "./locator.mjs";
import { logger } from "../lib/logger.mjs";

let cached;

export async function detectVersion({ signal } = {}) {
  if (cached !== undefined) return cached;
  try {
    const entry = resolveOpenclawEntry();
    const result = await runOpenclaw(entry, ["--version"], { timeoutMs: 5000, signal });
    const text = result.stdout.trim();
    const match = text.match(/\d+\.\d+\.\d+/);
    cached = match ? match[0] : text.slice(0, 32) || null;
  } catch (err) {
    logger.debug("version detection failed", { category: err?.category });
    cached = null;
  }
  return cached;
}

export function resetVersionCache() {
  cached = undefined;
}
