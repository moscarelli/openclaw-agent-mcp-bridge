#!/usr/bin/env node
// Smoke test de MCP stdio (NÃO é validação da IDE Kiro): lança o servidor real
// por stdio (command: node, args: [src/server/main.mjs]) e o exercita como um
// cliente MCP stdio genérico: initialize → ping → tools/list → tools/call.
//
// Isto verifica o mesmo transporte stdio que um cliente usaria, mas NÃO valida
// nada sobre a IDE Kiro em si. O teste real ponta-a-ponta no Kiro IDE continua
// PENDENTE e deve ser feito manualmente (ver docs/LIVE_VALIDATION.md).
//
// Uso: node scripts/mcp-stdio-smoke.mjs
// Requer OpenClaw instalado para a chamada de agents_list retornar dados reais.
// Não imprime conteúdo de sessão; só forma e contagens.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/server/main.mjs", import.meta.url));

// Fake OpenClaw sintético: quando SMOKE_USE_FAKE=1, aponta o bridge para a fake
// CLI de teste (100% sintética) para exercitar a nova tool de histórico de
// forma determinística e SEM tocar em sessões reais. O smoke NÃO é o teste
// real da IDE Kiro.
const useFake = process.env.SMOKE_USE_FAKE === "1";
const fakeEntry = fileURLToPath(new URL("../test/fixtures/openclaw-pkg/openclaw.mjs", import.meta.url));

const EXPECTED_FOUR = [
  "openclaw_agents_list",
  "openclaw_session_get",
  "openclaw_session_messages_list",
  "openclaw_sessions_list",
];

function log(step, ok, detail = "") {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}\n`);
}

async function main() {
  const childEnv = { ...process.env };
  if (useFake) childEnv.OPENCLAW_MCP_BRIDGE_ENTRY = fakeEntry;
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainPath], env: childEnv });
  const client = new Client({ name: "mcp-stdio-smoke", version: "0.0.0" });

  let failures = 0;
  await client.connect(transport);
  const info = client.getServerVersion();
  const okInit = info?.name === "openclaw-agent-mcp-bridge";
  log("initialize + serverInfo", okInit, info?.name ?? "no serverInfo");
  if (!okInit) failures += 1;

  await client.ping();
  log("ping", true);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const okTools = JSON.stringify(names) === JSON.stringify(EXPECTED_FOUR);
  log("tools/list has exactly the 4 read-only tools", okTools, names.join(","));
  if (!okTools) failures += 1;
  const forbidden = ["openclaw_agent_turn", "messages_send", "openclaw_session_message_get"];
  const noMutating = forbidden.every((f) => !names.includes(f));
  log("no mutating/forbidden tool exposed", noMutating);
  if (!noMutating) failures += 1;

  // Chamada de agents_list (usa o OpenClaw instalado, ou a fake se SMOKE_USE_FAKE=1).
  try {
    const result = await client.callTool({ name: "openclaw_agents_list", arguments: { limit: 100 } });
    const okCall = result.isError !== true && result.structuredContent && Array.isArray(result.structuredContent.agents);
    log("tools/call openclaw_agents_list returns structuredContent", Boolean(okCall),
      okCall ? `count=${result.structuredContent.count}` : "no structured result");
    if (!okCall) failures += 1;
  } catch (err) {
    log("tools/call openclaw_agents_list", false, err?.message ?? "error");
    failures += 1;
  }

  // Chamada SINTÉTICA da nova tool de histórico. Só é determinística com a fake
  // CLI (SMOKE_USE_FAKE=1); com o OpenClaw real usaríamos uma sessão real, o
  // que este smoke NÃO faz. Verifica apenas forma/metadata-only e ausência de
  // conteúdo — nunca imprime conteúdo.
  if (useFake) {
    try {
      const result = await client.callTool({
        name: "openclaw_session_messages_list",
        arguments: { sessionKey: "agent:main:synthetic-1", limit: 50 },
      });
      const sc = result.structuredContent;
      const metadataOnly =
        result.isError !== true &&
        sc &&
        Array.isArray(sc.messages) &&
        sc.source === "gateway" &&
        sc.messages.every((m) => Object.keys(m).every((k) => ["role", "timestamp"].includes(k)));
      const noContentLeak = !JSON.stringify(result).includes("IGNORE_PREVIOUS_INSTRUCTIONS");
      log("tools/call openclaw_session_messages_list is metadata-only", Boolean(metadataOnly),
        metadataOnly ? `count=${sc.count}` : "unexpected shape");
      log("no message content leaks in messages_list result", noContentLeak);
      if (!metadataOnly) failures += 1;
      if (!noContentLeak) failures += 1;
    } catch (err) {
      log("tools/call openclaw_session_messages_list", false, err?.message ?? "error");
      failures += 1;
    }
  } else {
    log("openclaw_session_messages_list synthetic call (skipped: set SMOKE_USE_FAKE=1)", true);
  }

  // Cancelamento: dispara uma chamada e aborta; o servidor deve continuar vivo
  // e uma chamada posterior deve funcionar. Com a fake, um modo lento seria
  // necessário; sem forwarding de FAKE_*, validamos o cancelamento no nível de
  // protocolo (AbortController) e a sobrevivência do servidor via chamada
  // subsequente.
  try {
    const ac = new AbortController();
    const pending = client
      .callTool({ name: "openclaw_agents_list", arguments: { limit: 100 } }, undefined, { signal: ac.signal })
      .catch(() => "cancelled-or-done");
    ac.abort();
    await pending;
    log("cancellation did not crash the client", true);
  } catch (err) {
    log("cancellation handling", false, err?.message ?? "error");
    failures += 1;
  }

  // Chamada posterior ao cancelamento: o servidor MCP deve seguir conectado.
  try {
    await client.ping();
    const { tools: after } = await client.listTools();
    const okAfter = after.length === 4;
    log("server still connected after cancellation (ping + tools/list)", okAfter, `tools=${after.length}`);
    if (!okAfter) failures += 1;
  } catch (err) {
    log("post-cancellation call", false, err?.message ?? "error");
    failures += 1;
  }

  await client.close();
  process.stdout.write(`\nSMOKE RESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`FAIL  smoke crashed — ${err?.message ?? err}\n`);
  process.exit(1);
});
