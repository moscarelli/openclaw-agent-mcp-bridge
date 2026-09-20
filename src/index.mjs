// API pública do bridge, reexportada para consumo e testes.
// Mantém projectStatus e assertSafeIdentifier (contrato de guardrails.test.mjs).

export const projectStatus = Object.freeze({
  maturity: "experimental-community-preview",
  distribution: "private",
  stable: false,
});

export { assertSafeIdentifier } from "./lib/identifier.mjs";

// Módulos puros expostos para testes unitários.
export { buildChildEnv, allowlist as envAllowlist } from "./lib/env-allowlist.mjs";
export { redactString, redactValue } from "./lib/redact.mjs";
export {
  validateAgentsListArgs,
  validateSessionsListArgs,
  validateSessionGetArgs,
  deriveAgentIdFromKey,
} from "./lib/validate.mjs";
export { Semaphore } from "./lib/concurrency.mjs";
export { ToolError, ERROR_CATEGORIES, isToolError, categoryMessage } from "./lib/errors.mjs";
export {
  buildAgent,
  buildAgentsList,
  buildSession,
  buildSessionsPage,
  extractAgentsArray,
  extractSessionsArray,
} from "./openclaw/normalize.mjs";
export { encodeCursor, decodeCursor, canonicalScope } from "./openclaw/cursor.mjs";
export { validateEntrypoint, extractJsFromShim } from "./openclaw/locator.mjs";

// Fase 2 (metadata-only): funções puras expostas para testes.
export { encodeHistoryCursor, decodeHistoryCursor } from "./openclaw/history-cursor.mjs";
export { buildBoundedMessagesResult, classifyResolveResponse } from "./openclaw/messages.mjs";
export { validateMessagesListArgs } from "./lib/validate-messages.mjs";
export {
  buildMessage,
  buildMessagesPage,
  mapRole,
  mapUnavailableReason,
  extractMessagesArray,
} from "./openclaw/normalize-messages.mjs";
