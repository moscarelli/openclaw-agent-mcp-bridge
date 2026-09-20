// Fonte de dados de openclaw_agents_list (PHASE1_PLAN §4.1).
// `openclaw agents list --json` NÃO aceita --limit: o limite é aplicado após
// parsing/normalização (buildAgentsList).

import { runOpenclaw } from "./runner.mjs";
import { resolveOpenclawEntry } from "./locator.mjs";
import { buildAgentsList } from "./normalize.mjs";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import { CLI_AGENTS_TIMEOUT_MS } from "../lib/limits.mjs";

export async function listAgents({ limit }, { signal } = {}) {
  const entry = resolveOpenclawEntry();
  const result = await runOpenclaw(entry, ["agents", "list", "--json"], {
    signal,
    timeoutMs: CLI_AGENTS_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    throw new ToolError(ERROR_CATEGORIES.CLI_UNAVAILABLE, "agents list returned a non-zero exit");
  }

  const text = result.stdout.trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError(ERROR_CATEGORIES.INTERNAL, "agents list returned invalid JSON");
  }

  // Limite aplicado APÓS parsing/normalização.
  return buildAgentsList(parsed, limit);
}
