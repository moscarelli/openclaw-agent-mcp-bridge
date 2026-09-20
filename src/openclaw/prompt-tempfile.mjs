// Arquivo temporário seguro para o prompt do turn (Fase 3A.2, P3A2-T4a).
//
// O comando especializado `openclaw agent --message-file <path>` lê o prompt de
// um arquivo, mantendo a instrução FORA do argv. Este módulo cria esse arquivo
// com o máximo de restrições disponíveis e o remove best-effort.
//
// RISCO RESIDUAL (aprovado pelo proprietário, apenas local/experimental,
// single-operator, trusted-host):
//   - o prompt permanece em disco em PLAINTEXT durante TODO o turno (até o
//     cleanup após o término da CLI). `delete` NÃO é secure erase;
//     SSD/journaling/backup podem preservar vestígios; um crash pode deixar o
//     arquivo. Prompts com segredos NÃO devem ser enviados por este modo.
//   - SUBSTITUIÇÃO DO ARQUIVO (TOCTOU de reabertura): após o close, a CLI
//     REABRE o arquivo pelo PATH. Não há proteção ATÔMICA contra a substituição
//     do arquivo, entre o nosso close e a reabertura pela CLI, por outro
//     processo com a MESMA identidade de usuário. Isso é aceito como parte do
//     domínio trusted-host/single-operator; um host não confiável está fora de
//     escopo.
//
// Regras de segurança (defesa em profundidade, NÃO garantias absolutas):
//   - subdiretório exclusivo dentro do temp root do sistema (nunca workspace/
//     repo/CWD); nome aleatório imprevisível;
//   - o parent do subdiretório é validado como o temp root resolvido;
//   - criação exclusiva do arquivo com flag "wx" (falha se já existir);
//   - mode 0o600 onde suportado;
//   - `O_NOFOLLOW` reduz o risco de symlink SOMENTE nas plataformas que o
//     suportam; NÃO alegamos proteção absoluta contra symlink/reparse point no
//     Windows;
//   - `fstat` confirma que o DESCRITOR ORIGINALMENTE CRIADO é um arquivo
//     regular — isso valida o descritor no momento da criação, não protege a
//     REABERTURA posterior por path (ver TOCTOU acima);
//   - escreve somente após validar o limite em bytes UTF-8;
//   - flush (`fsync`) BEST-EFFORT (falha ignorada) e close antes do spawn;
//   - o path é retornado INTERNAMENTE ao chamador (para montar --message-file),
//     mas NUNCA é exposto ao cliente MCP, logado, nem incluído em erro MCP;
//   - cleanup remove o arquivo exato e depois o diretório exato, ambos
//     validados como internos ao subdiretório criado; sem remoção recursiva
//     ampla, sem glob, nunca remove o temp root;
//   - falha de cleanup não sobrescreve o resultado principal; só um código
//     sanitizado é reportado ao chamador.

import { open, mkdtemp, realpath, lstat, rm, rmdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { ToolError, ERROR_CATEGORIES } from "../lib/errors.mjs";
import { AGENT_TURN_INSTRUCTION_MAX_BYTES } from "../lib/limits.mjs";

// Prefixo do subdiretório exclusivo criado no temp root.
const DIR_PREFIX = "ocmb-turn-";

// O_NOFOLLOW só existe em alguns SOs; combinamos com "wx" (O_CREAT|O_EXCL).
const O_NOFOLLOW = typeof FS.O_NOFOLLOW === "number" ? FS.O_NOFOLLOW : 0;
const WX_FLAGS = FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | O_NOFOLLOW;

const WINDOWS = process.platform === "win32";

function internalError(message) {
  return new ToolError(ERROR_CATEGORIES.INTERNAL, message);
}

/**
 * Comparação de contenção de path SEGURA e portátil. Confirma que `child` está
 * estritamente dentro de `parent` usando `path.relative` (não prefix simples,
 * que falharia em `/a/bc` vs `/a/b`). No Windows, a comparação é
 * case-insensitive. Retorna false para qualquer caminho externo, travessia
 * (`..`) ou path absoluto resultante.
 */
function isStrictlyInside(parent, child) {
  if (typeof parent !== "string" || typeof child !== "string") return false;
  const p = WINDOWS ? parent.toLowerCase() : parent;
  const c = WINDOWS ? child.toLowerCase() : child;
  const rel = relative(p, c);
  // rel vazio = mesmo path (não estritamente dentro); ".." = fora; absoluto =
  // drives/roots diferentes (Windows) → fora.
  if (rel.length === 0) return false;
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Cria o arquivo temporário e escreve `instruction`. Retorna um handle:
 *   { path, cleanup }
 * `path` é usado internamente para montar o argv (`--message-file`); NUNCA deve
 * ser logado, retornado ao cliente, nem incluído em erro MCP.
 *
 * Valida o limite de bytes UTF-8 ANTES de qualquer escrita. Em qualquer falha,
 * faz cleanup do que já criou e lança ToolError(INTERNAL) sem vazar o path.
 *
 * @param {string} instruction texto do prompt (já validado como não vazio)
 * @returns {Promise<{ path: string, cleanup: () => Promise<"ok"|"failed"> }>}
 */
export async function writePromptTempfile(instruction, hooks = {}) {
  if (typeof instruction !== "string") {
    throw internalError("prompt must be a string");
  }
  const bytes = Buffer.from(instruction, "utf8");
  if (bytes.byteLength > AGENT_TURN_INSTRUCTION_MAX_BYTES) {
    // Defesa em profundidade: a validação de input já rejeita antes, mas nunca
    // escrevemos acima do teto.
    throw new ToolError(ERROR_CATEGORIES.INVALID_ARGUMENT, "instruction exceeds the byte limit");
  }

  // Temp root resolvido (realpath) para comparações confiáveis.
  let tempRoot;
  try {
    tempRoot = await realpath(tmpdir());
  } catch {
    throw internalError("temporary directory unavailable");
  }

  // Subdiretório exclusivo com nome aleatório imprevisível. Guardamos o path
  // ORIGINAL criado por mkdtemp para poder limpá-lo mesmo que o realpath falhe.
  let createdDir;
  try {
    createdDir = await mkdtemp(join(tempRoot, DIR_PREFIX));
  } catch {
    throw internalError("could not create a temporary directory");
  }

  // Resolve o realpath do diretório criado. Se falhar (injeção de teste ou
  // condição real), fazemos cleanup SEGURO do diretório ORIGINALMENTE criado —
  // cujo path conhecemos e cujo parent é o tempRoot — e abortamos fail-closed.
  let dir;
  try {
    dir = hooks.failRealpath ? await Promise.reject(new Error("injected realpath failure")) : await realpath(createdDir);
  } catch {
    // O createdDir foi retornado por mkdtemp dentro do tempRoot; removê-lo é
    // seguro (não é um realpath duvidoso de origem externa).
    if (isStrictlyInside(tempRoot, createdDir)) {
      await rmdir(createdDir).catch(() => {});
    }
    throw internalError("could not resolve the temporary directory");
  }

  // O parent do subdiretório resolvido DEVE ser o temp root resolvido.
  // Identidade duvidosa → fail-closed: NÃO removemos um realpath que falhou na
  // validação de escopo (poderia ser externo). Só removemos o createdDir que
  // sabemos estar dentro do tempRoot.
  if (dirname(dir) !== tempRoot || !isStrictlyInside(tempRoot, dir)) {
    if (isStrictlyInside(tempRoot, createdDir)) {
      await rmdir(createdDir).catch(() => {});
    }
    throw internalError("temporary directory parent mismatch");
  }

  const fileName = `prompt-${randomBytes(16).toString("hex")}.txt`;
  const filePath = join(dir, fileName);

  const cleanup = makeCleanup(dir, filePath);

  let handle;
  try {
    // Criação exclusiva; falha se já existir; não segue symlink onde suportado.
    handle = await open(filePath, WX_FLAGS, 0o600);
  } catch (err) {
    await cleanup();
    // EEXIST (colisão) e ELOOP (symlink) e qualquer outro → internal, sem path.
    throw internalError(`could not create the temporary file: ${err?.code ?? "error"}`);
  }

  try {
    // Valida que o descritor aberto é um arquivo regular (não symlink/pipe).
    const st = await handle.stat();
    if (!st.isFile()) throw new Error("not a regular file");

    await handle.writeFile(bytes);
    // fsync é BEST-EFFORT: nem todo sistema de arquivos o suporta; sua falha é
    // ignorada intencionalmente (não compromete a correção do turno).
    await handle.sync().catch(() => {});
  } catch (err) {
    await handle.close().catch(() => {});
    await cleanup();
    throw internalError(`could not write the temporary file: ${err?.code ?? "error"}`);
  }

  // Fecha ANTES do spawn para que a CLI possa ler o arquivo. Uma falha aqui é
  // um erro PRÉ-DISPATCH: fazemos cleanup e NÃO executamos a CLI (lança
  // internal), em vez de ignorar silenciosamente.
  try {
    if (hooks.failClose) throw new Error("injected close failure");
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {}); // garante liberação do fd em caso de injeção
    await cleanup();
    throw internalError(`could not close the temporary file before dispatch: ${err?.code ?? "error"}`);
  }

  return { path: filePath, cleanup };
}

/**
 * Constrói a função de cleanup idempotente para o arquivo e o diretório
 * exatos criados. Remove primeiro o arquivo, depois o diretório, ambos
 * validados como internos ao subdiretório. Nunca recursivo amplo, nunca glob,
 * nunca o temp root. Retorna "ok" | "failed" (nunca lança, nunca vaza path).
 */
function makeCleanup(dir, filePath) {
  let done = false;
  return async () => {
    if (done) return "ok";
    done = true;
    let status = "ok";

    // Validação de contenção defensiva (fail-closed): o arquivo deve estar
    // estritamente dentro do dir (comparação segura, case-insensitive no
    // Windows, via path.relative — nunca prefix simples) e o dir deve ter o
    // prefixo esperado. Identidade duvidosa → não remove nada.
    try {
      if (!isStrictlyInside(dir, filePath) || basename(dir).indexOf(DIR_PREFIX) !== 0) {
        return "failed";
      }
    } catch {
      return "failed";
    }

    // Remove o arquivo exato (sem recursão, sem force sobre desconhecido).
    try {
      // lstat evita seguir symlink na verificação; rm remove o próprio entry.
      await lstat(filePath).then(
        () => rm(filePath, { force: false, recursive: false }),
        () => {}, // já ausente
      );
    } catch {
      status = "failed";
    }

    // Remove o diretório exclusivo exato (deve estar vazio agora).
    try {
      await rmdir(dir);
    } catch {
      status = "failed";
    }

    return status;
  };
}
