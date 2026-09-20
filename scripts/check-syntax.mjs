#!/usr/bin/env node
// Verifica a sintaxe (node --check) de todos os módulos .mjs do projeto.
// Substitui o `node --check src/index.mjs` fixo por uma varredura recursiva
// de src/ e scripts/, para que novos módulos sejam checados automaticamente.

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const roots = ["src", "scripts"];

async function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collect(full)));
    } else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))) {
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const r of roots) {
  files.push(...(await collect(join(root, r))));
}

let failed = 0;
for (const file of files) {
  try {
    await execFileAsync(process.execPath, ["--check", file]);
  } catch (error) {
    failed += 1;
    process.stderr.write(`syntax check failed: ${relative(root, file)}\n`);
    process.stderr.write(`${error.stderr ?? error.message}\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`\n${failed} file(s) failed the syntax check.\n`);
  process.exit(1);
}

process.stdout.write(`syntax check passed for ${files.length} file(s).\n`);
