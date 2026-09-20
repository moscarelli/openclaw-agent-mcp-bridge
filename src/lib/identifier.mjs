// Validação de identificadores por allowlist (regex). Fonte canônica.
// Aceita chaves de sessão como "agent:main:session-1" e rejeita entrada de
// shell/path. Mantém o mesmo contrato já coberto por test/guardrails.test.mjs.

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export function assertSafeIdentifier(value, label = "identifier") {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
