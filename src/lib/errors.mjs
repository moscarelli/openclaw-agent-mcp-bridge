// Erros normalizados (PHASE1_PLAN §3.4, §7.2).
// Categorias estáveis, sem stack traces nem paths na mensagem ao cliente.

export const ERROR_CATEGORIES = Object.freeze({
  INVALID_ARGUMENT: "invalid_argument",
  NOT_FOUND: "not_found",
  SCAN_INCOMPLETE: "scan_incomplete",
  TIMEOUT: "timeout",
  OUTPUT_TOO_LARGE: "output_too_large",
  GATEWAY_UNAVAILABLE: "gateway_unavailable",
  GATEWAY_REQUIRED: "gateway_required",
  CLI_UNAVAILABLE: "cli_unavailable",
  BUSY: "busy",
  // Fase 3A.2: destino não autorizado (mutating turn). Mensagem sanitizada;
  // nunca revela allowlist, sessionKey configurada, nem qual campo divergiu.
  PERMISSION_DENIED: "permission_denied",
  INTERNAL: "internal",
});

const KNOWN = new Set(Object.values(ERROR_CATEGORIES));

/**
 * Erro de execução de ferramenta. Vira `isError: true` no resultado MCP
 * (não um erro de protocolo JSON-RPC).
 */
export class ToolError extends Error {
  constructor(category, message) {
    const safeCategory = KNOWN.has(category) ? category : ERROR_CATEGORIES.INTERNAL;
    super(message ?? safeCategory);
    this.name = "ToolError";
    this.category = safeCategory;
  }
}

export function isToolError(value) {
  return value instanceof ToolError;
}

/**
 * Mensagem curta e genérica por categoria, sem vazar detalhes internos.
 */
export function categoryMessage(category) {
  switch (category) {
    case ERROR_CATEGORIES.INVALID_ARGUMENT:
      return "Invalid argument.";
    case ERROR_CATEGORIES.NOT_FOUND:
      return "Not found.";
    case ERROR_CATEGORIES.SCAN_INCOMPLETE:
      return "Scan incomplete: result is inconclusive within the scan limit.";
    case ERROR_CATEGORIES.TIMEOUT:
      return "Operation timed out.";
    case ERROR_CATEGORIES.OUTPUT_TOO_LARGE:
      return "Output too large.";
    case ERROR_CATEGORIES.GATEWAY_UNAVAILABLE:
      return "OpenClaw Gateway is unavailable.";
    case ERROR_CATEGORIES.GATEWAY_REQUIRED:
      return "This operation requires a running OpenClaw Gateway.";
    case ERROR_CATEGORIES.CLI_UNAVAILABLE:
      return "OpenClaw CLI entrypoint could not be resolved.";
    case ERROR_CATEGORIES.BUSY:
      return "Bridge is busy; too many concurrent operations.";
    case ERROR_CATEGORIES.PERMISSION_DENIED:
      return "Permission denied.";
    default:
      return "Internal error.";
  }
}
