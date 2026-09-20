// Allowlist de ambiente para o processo filho (PHASE1_PLAN §6).
// O filho recebe um env montado explicitamente, nunca process.env inteiro.
// NODE_OPTIONS e COMSPEC são removidos por completo. Credenciais nunca passam
// por env: a autenticação do Gateway vem da configuração local da CLI.

// Chaves essenciais do Windows para o Node/OpenClaw funcionarem.
const WINDOWS_KEYS = [
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
];

// Chaves multiplataforma. PATH tem variações de capitalização no Windows.
const CROSS_PLATFORM_KEYS = ["PATH", "Path", "HOME", "LANG", "LC_ALL", "TZ"];

// Chaves OpenClaw não secretas permitidas (apenas o alvo do Gateway).
const OPENCLAW_KEYS = ["OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_PORT"];

// Chaves explicitamente proibidas, mesmo que apareçam nas listas acima.
const DENIED_KEYS = new Set(["NODE_OPTIONS", "COMSPEC"]);

// Nomes que parecem segredo — sempre removidos.
const SECRET_NAME_PATTERN = /(_TOKEN|_SECRET|_KEY|_PASSWORD|_PASSWD|_PWD|_CREDENTIAL|_CREDENTIALS)$/i;

const ALLOWED = new Set([...WINDOWS_KEYS, ...CROSS_PLATFORM_KEYS, ...OPENCLAW_KEYS]);

function isAllowedName(key) {
  if (DENIED_KEYS.has(key)) return false;
  if (SECRET_NAME_PATTERN.test(key)) return false;
  return true;
}

/**
 * Constrói o env do processo filho a partir de uma fonte (default: process.env).
 * Só repassa chaves da allowlist fixa, nunca as proibidas nem nomes que parecem
 * segredo. Não há passthrough configurável em produção.
 */
export function buildChildEnv(source = process.env) {
  const out = {};
  for (const key of ALLOWED) {
    if (!isAllowedName(key)) continue;
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

// Exportado para testes.
export const allowlist = Object.freeze({
  windows: WINDOWS_KEYS,
  crossPlatform: CROSS_PLATFORM_KEYS,
  openclaw: OPENCLAW_KEYS,
  denied: [...DENIED_KEYS],
});
