// Valores objetivos de limites (PHASE1_PLAN §8).
// Constantes fixas; um teto rígido nunca é excedido. Onde um override por env
// de operador é permitido, ele só reduz o valor, nunca aumenta acima do teto.

function clampFromEnv(envName, defaultValue, min, max) {
  const raw = process.env[envName];
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) return defaultValue;
  // Só permite reduzir (nunca acima do default/teto) e respeita o mínimo.
  return Math.min(defaultValue, Math.max(min, Math.min(parsed, max)));
}

// Timeouts por comando. A CLI real do OpenClaw pode ser lenta: medido ~21s
// para `agents list --json` nesta plataforma, então um teto único de 15s
// inviabilizaria a ferramenta. Cada comando tem seu próprio teto rígido; o
// override por env só REDUZ (nunca acima do teto).
//
// `agents list`: teto 45s (carrega registro de plugins/config).
export const CLI_AGENTS_TIMEOUT_MS = clampFromEnv("OPENCLAW_MCP_BRIDGE_AGENTS_TIMEOUT_MS", 45000, 1000, 45000);

// `sessions --json` (fallback CLI): teto 30s.
export const CLI_SESSIONS_TIMEOUT_MS = clampFromEnv("OPENCLAW_MCP_BRIDGE_SESSIONS_TIMEOUT_MS", 30000, 1000, 30000);

// RPC `gateway call` (default documentado da CLI é 10s): teto 10s.
export const GATEWAY_RPC_TIMEOUT_MS = clampFromEnv("OPENCLAW_MCP_BRIDGE_GATEWAY_TIMEOUT_MS", 10000, 1000, 10000);

// Teto absoluto para fluxos Gateway explicitamente autorizados a usar um
// orçamento maior. O default da Fase 1 continua em 10s.
export const GATEWAY_RPC_EXTENDED_TIMEOUT_MAX_MS = 20000;

// Fallback genérico para chamadas sem timeout específico (ex.: --version).
export const DEFAULT_CALL_TIMEOUT_MS = clampFromEnv("OPENCLAW_MCP_BRIDGE_CALL_TIMEOUT_MS", 15000, 1000, 45000);

// Teto de stdout/stderr do processo filho; excedeu → output_too_large.
export const CLI_MAX_BUFFER_BYTES = 1048576; // 1 MiB

// Máx. de itens em qualquer lista retornada.
export const MAX_OUTPUT_ITEMS = 500;

// Teto do payload serializado ao cliente; excedeu → truncar com truncated: true.
export const RESULT_MAX_BYTES = 262144; // 256 KiB

// Semáforo de processos filhos simultâneos.
export const MAX_CONCURRENT_CHILDREN = clampFromEnv("OPENCLAW_MCP_BRIDGE_MAX_CHILDREN", 2, 1, 2);

// Espera máx. no semáforo; excedeu → busy.
export const CONCURRENCY_ACQUIRE_TIMEOUT_MS = 5000;

// Tamanho de página (offset step) na varredura RPC de session_get.
export const SESSION_PAGE_SIZE = 100;

// Teto de sessões varridas por offset em session_get antes de scan_incomplete.
export const SESSION_SCAN_MAX = 5000;

// Espera após kill antes do término forçado da árvore.
export const KILL_GRACE_MS = 2000;

// Limites de faixa para argumentos das tools.
export const AGENTS_LIMIT_MIN = 1;
export const AGENTS_LIMIT_MAX = 100;
export const AGENTS_LIMIT_DEFAULT = 100;

export const SESSIONS_LIMIT_MIN = 1;
export const SESSIONS_LIMIT_MAX = 200;
export const SESSIONS_LIMIT_DEFAULT = 100;

// activeMinutes: inteiro entre 1 e 525600 (1 minuto a 1 ano).
export const ACTIVE_MINUTES_MIN = 1;
export const ACTIVE_MINUTES_MAX = 525600;

// ---- Fase 2: leitura de histórico (metadata-only) (PHASE2_PLAN §12) ----

// Faixa de page size para openclaw_session_messages_list.
export const MESSAGES_LIMIT_MIN = 1;
export const MESSAGES_LIMIT_MAX = 200;
export const MESSAGES_LIMIT_DEFAULT = 50;

// maxChars pequeno enviado ao chat.history APENAS para reduzir exposição
// transitória de conteúdo. NUNCA é garantia de supressão (§5.3) e o fragmento
// recebido NUNCA é usado para derivar tamanho ou metadado (§5.10).
export const MESSAGES_MAXCHARS_REQUEST = 1;

// maxBytes (alvo de bytes por página) enviado ao Gateway.
export const MESSAGES_MAXBYTES_REQUEST = 131072; // 128 KiB

// O fluxo de histórico executa `sessions.resolve` e `chat.history` em processos
// CLI sequenciais. Cada RPC recebe seu próprio orçamento de 20s para acomodar
// startup frio no Windows; não existe timeout combinado.
export const CHAT_HISTORY_TIMEOUT_MS = clampFromEnv(
  "OPENCLAW_MCP_BRIDGE_CHAT_HISTORY_TIMEOUT_MS",
  20000,
  1000,
  GATEWAY_RPC_EXTENDED_TIMEOUT_MAX_MS,
);

// ---- Fase 3A.2: MVP local experimental (openclaw_agent_turn) ----
// Limites conservadores e centralizados. Tetos rígidos; nunca aumentados.

// `instruction` (input MCP): teto de 32 KiB em bytes UTF-8. Rejeita acima disso
// com invalid_argument ANTES de qualquer spawn.
export const AGENT_TURN_INSTRUCTION_MAX_BYTES = 32768; // 32 KiB

// `response` textual devolvida ao Kiro: teto de 64 KiB em bytes UTF-8, e nunca
// acima do teto global RESULT_MAX_BYTES (256 KiB). Trunca em boundary UTF-8.
export const AGENT_TURN_RESPONSE_MAX_BYTES = Math.min(65536, RESULT_MAX_BYTES); // 64 KiB

// timeoutMs do turn: mínimo 1s, default 2min, teto rígido 10min. O override por
// env só REDUZ o default (nunca acima do teto).
export const AGENT_TURN_TIMEOUT_MIN_MS = 1000; // 1s
export const AGENT_TURN_TIMEOUT_MAX_MS = 600000; // 10min (teto rígido)
export const AGENT_TURN_TIMEOUT_DEFAULT_MS = clampFromEnv(
  "OPENCLAW_MCP_BRIDGE_AGENT_TURN_TIMEOUT_MS",
  120000, // 2min default
  AGENT_TURN_TIMEOUT_MIN_MS,
  AGENT_TURN_TIMEOUT_MAX_MS,
);

// Preflight local read-only `config get gateway --json`: teto próprio de 45s.
// NÃO usa GATEWAY_RPC_TIMEOUT_MS (10s), que é curto demais para o startup frio
// da CLI no Windows e provocaria falsos negativos operacionais. O override por
// env só REDUZ (nunca acima do teto de 45s).
export const AGENT_TURN_LOOPBACK_PREFLIGHT_TIMEOUT_MS = clampFromEnv(
  "OPENCLAW_MCP_BRIDGE_AGENT_TURN_LOOPBACK_TIMEOUT_MS",
  45000, // 45s default = teto rígido
  1000,
  45000,
);

// Margem técnica adicionada ao timeout do runner sobre o timeout passado à CLI
// (a CLI recebe timeout em segundos; o runner recebe um teto ligeiramente maior
// para observar o término da CLI antes de matar o filho). Teto rígido.
export const AGENT_TURN_RUNNER_MARGIN_MS = 10000; // 10s de margem técnica
