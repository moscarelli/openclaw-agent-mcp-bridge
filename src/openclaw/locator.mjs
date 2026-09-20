// Descoberta segura do entrypoint JavaScript do OpenClaw (PHASE1_PLAN §5).
// Nunca executa openclaw.cmd (exigiria shell). Resolve o arquivo JS real
// (.mjs/.cjs/.js) e valida que ele pertence ao pacote OpenClaw esperado antes
// de aceitá-lo. O shim npm real desta plataforma aponta para openclaw.mjs.

import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { delimiter } from "node:path";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";

// Extensões de entrypoint JavaScript aceitas.
const JS_EXTENSIONS = [".mjs", ".cjs", ".js"];

function hasJsExtension(p) {
  return JS_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext));
}

// Nomes de pacote aceitos como "o pacote OpenClaw esperado".
const EXPECTED_PACKAGE_NAMES = new Set(["openclaw", "@openclaw/cli", "@openclaw/openclaw"]);

let cachedEntry;

function cliUnavailable(message) {
  return new ToolError(ERROR_CATEGORIES.CLI_UNAVAILABLE, message);
}

/**
 * Sobe a árvore de diretórios a partir de `startDir` até achar um package.json.
 * Retorna { dir, pkg } ou undefined.
 */
function findOwningPackage(startDir) {
  let dir = startDir;
  // Limite defensivo de profundidade.
  for (let i = 0; i < 64; i += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        return { dir, pkg };
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Coleta os caminhos de arquivo declarados no campo `bin` do package.json,
 * resolvidos contra o diretório do pacote.
 */
function binTargets(pkg, pkgDir) {
  const targets = [];
  const bin = pkg.bin;
  if (typeof bin === "string") {
    targets.push(resolve(pkgDir, bin));
  } else if (bin && typeof bin === "object") {
    for (const value of Object.values(bin)) {
      if (typeof value === "string") targets.push(resolve(pkgDir, value));
    }
  }
  return targets;
}

/**
 * Valida que `candidateJsPath` é um arquivo legível que pertence ao pacote
 * OpenClaw esperado. Lança ToolError(cli_unavailable) se qualquer verificação
 * falhar. Retorna o caminho canônico (realpath).
 */
export function validateEntrypoint(candidateJsPath) {
  if (typeof candidateJsPath !== "string" || candidateJsPath.length === 0) {
    throw cliUnavailable("Empty entrypoint path");
  }
  let real;
  try {
    const st = statSync(candidateJsPath);
    if (!st.isFile()) throw new Error("not a file");
    real = realpathSync(candidateJsPath);
  } catch {
    throw cliUnavailable("Entrypoint is not a readable file");
  }

  const owning = findOwningPackage(dirname(real));
  if (!owning) {
    throw cliUnavailable("Entrypoint has no owning package.json");
  }

  const { dir: pkgDir, pkg } = owning;
  if (!pkg.name || !EXPECTED_PACKAGE_NAMES.has(pkg.name)) {
    throw cliUnavailable("Entrypoint does not belong to an expected OpenClaw package");
  }

  // O caminho real deve estar dentro do diretório do pacote (sem travessia).
  const realPkgDir = realpathSync(pkgDir);
  const prefix = realPkgDir.endsWith(sep) ? realPkgDir : realPkgDir + sep;
  if (real !== realPkgDir && !real.startsWith(prefix)) {
    throw cliUnavailable("Entrypoint resolves outside the package directory");
  }

  // O bin do package.json deve apontar para este arquivo.
  const targets = binTargets(pkg, pkgDir).map((t) => {
    try {
      return realpathSync(t);
    } catch {
      return t;
    }
  });
  if (!targets.includes(real)) {
    throw cliUnavailable("Entrypoint is not the declared bin of the package");
  }

  return real;
}

/**
 * Extrai o caminho do entrypoint JS alvo a partir de um shim npm (.cmd) no
 * Windows, sem executá-lo. O shim npm real aponta para algo como:
 *   ... "%_prog%"  "%dp0%\node_modules\openclaw\openclaw.mjs" %*
 * onde %dp0% (ou %~dp0) é o diretório do shim. Também cobre variantes que
 * usam %~dp0 diretamente. Aceita .mjs/.cjs/.js.
 * Retorna o caminho absoluto resolvido ou undefined.
 */
export function extractJsFromShim(shimPath) {
  let content;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  const shimDir = dirname(shimPath);
  // Captura tokens terminando em .mjs/.cjs/.js, possivelmente com prefixo
  // %dp0% ou %~dp0 e barras de qualquer estilo.
  const matches = content.match(/[^\s"']*\.(?:mjs|cjs|js)\b/gi);
  if (!matches) return undefined;
  for (const raw of matches) {
    // Remove aspas e o prefixo de diretório do shim (%dp0% / %~dp0), com ou
    // sem barra invertida seguinte.
    const candidate = raw
      .replace(/^"+|"+$/g, "")
      .replace(/%~?dp0%?[\\/]?/gi, "");
    if (candidate.length === 0) continue;
    const resolved = resolve(shimDir, candidate);
    if (existsSync(resolved) && hasJsExtension(resolved)) return resolved;
  }
  return undefined;
}

function findOnPath(binName) {
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".ps1", ""] : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, binName + ext);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

/**
 * Resolve o entrypoint JS do OpenClaw, validado, com cache.
 * Precedência: env explícito → shim no PATH.
 */
export function resolveOpenclawEntry({ force = false } = {}) {
  if (cachedEntry && !force) return cachedEntry;

  // (a) Env de operador com caminho absoluto do .js.
  const explicit = process.env.OPENCLAW_MCP_BRIDGE_ENTRY;
  if (explicit) {
    cachedEntry = validateEntrypoint(explicit);
    return cachedEntry;
  }

  // (c) Shim no PATH → extrai o entrypoint JS alvo (não executa o shim).
  const shim = findOnPath("openclaw");
  if (shim) {
    // Se o próprio "openclaw" no PATH já for um entrypoint JS, valida direto.
    if (hasJsExtension(shim)) {
      cachedEntry = validateEntrypoint(shim);
      return cachedEntry;
    }
    const fromShim = extractJsFromShim(shim);
    if (fromShim) {
      cachedEntry = validateEntrypoint(fromShim);
      return cachedEntry;
    }
  }

  throw cliUnavailable("Could not resolve the OpenClaw JS entrypoint");
}

// Exposto para testes.
export function resetEntryCache() {
  cachedEntry = undefined;
}
