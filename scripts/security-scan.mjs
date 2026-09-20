#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist"]);
const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".zip", ".gz", ".tgz", ".pdf"]);

// Patterns are assembled so this scanner does not flag its own source literals.
const slash = String.fromCharCode(47);
const backslash = String.fromCharCode(92);
const colon = String.fromCharCode(58);
const patterns = [
  ["private key", new RegExp("-{5}BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-{5}")],
  ["Windows user path", new RegExp("[A-Za-z]" + colon + backslash + backslash + "Users" + backslash + backslash + "[^" + backslash + backslash + "\\r\\n]+", "i")],
  ["Unix user path", new RegExp(slash + "(?:Users|home)" + slash + "[^" + slash + "\\s]+" + slash, "i")],
  ["AWS access key", new RegExp("AK" + "IA[0-9A-Z]{16}")],
  ["Google API key", new RegExp("AI" + "za[0-9A-Za-z_-]{30,}")],
  ["GitHub token", new RegExp("gh" + "[pousr]_[A-Za-z0-9_]{20,}")],
  ["OpenAI-like key", new RegExp("s" + "k-[A-Za-z0-9_-]{20,}")],
  ["assigned secret", new RegExp("(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|credential)\\s*[:=]\\s*[\\\"'][^\\\"'\\s]{8,}[\\\"']", "i")],
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && !binaryExtensions.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}

const findings = [];
for (const file of await walk(root)) {
  const content = await readFile(file, "utf8").catch(() => null);
  if (content === null || content.includes("\u0000")) continue;
  for (const [label, pattern] of patterns) {
    if (pattern.test(content)) findings.push(`${relative(root, file)}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error("Security scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Security scan passed.");
