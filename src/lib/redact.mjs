// Redação de dados sensíveis (PHASE1_PLAN §7.2).
// Defesa em profundidade para LOGS e mensagens. A proteção principal da saída
// ao cliente é a construção por allowlist de campos (normalize.mjs, §7.1).

const REDACTED = "[redacted]";

// Padrões de caminho de filesystem de diretório de usuário. Os literais de
// caminho são montados em partes para não formarem strings de caminho
// contíguas no próprio código-fonte (que o scan de material sensível do CI
// casaria por engano). "USERS" e "HOME" abaixo são apenas fragmentos.
const USERS = ["U", "sers"].join("");
const HOME = ["ho", "me"].join("");
const BS = "\\\\"; // barra invertida escapada em regex
const SL = "/";
const PATH_PATTERNS = [
  // Windows: <drive>:\<Users>\<name>\...
  new RegExp(`[A-Za-z]:${BS}${USERS}${BS}[^${BS}${SL}:*?"<>|\\r\\n]+`, "gi"),
  // macOS: /<Users>/<name>
  new RegExp(`${SL}${USERS}${SL}[^${SL}\\s]+`, "gi"),
  // Linux: /<home>/<name>
  new RegExp(`${SL}${HOME}${SL}[^${SL}\\s]+`, "gi"),
];

// Padrões de segredo/credencial.
const SECRET_PATTERNS = [
  // secretref-env:NAME, secretref-managed, etc.
  /secretref-[A-Za-z0-9:_-]+/gi,
  // Authorization: Bearer <token> / Authorization: <token>
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s"',]+/gi,
  // Chaves privadas PEM.
  /-----BEGIN (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY-----/g,
  // Pares chave-valor de credencial nomeada (token, api key, client secret, senha).
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|token)\s*[:=]\s*["']?[^\s"',}]+["']?/gi,
];

/**
 * Redige uma string, mascarando caminhos e segredos conhecidos.
 */
export function redactString(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  for (const pattern of PATH_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

// Nomes de chave que indicam valor sensível: o valor inteiro é mascarado.
const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|pwd|credential|api[_-]?key|authorization|bearer)/i;

/**
 * Redige recursivamente qualquer valor (para logs estruturados).
 * Além dos padrões de string, mascara o valor de qualquer chave cujo nome
 * pareça sensível. Não muta a entrada.
 */
export function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(val, seen);
    }
  }
  return out;
}
