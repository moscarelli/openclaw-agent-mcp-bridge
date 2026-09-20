#!/usr/bin/env node
// Entrypoint do servidor MCP stdio (PHASE1_PLAN §2, §3.1).
// Conecta o McpServer ao StdioServerTransport. stdout é reservado ao protocolo
// JSON-RPC; diagnósticos vão para stderr (logger).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.mjs";
import { logger } from "../lib/logger.mjs";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("openclaw-agent-mcp-bridge connected over stdio");
}

main().catch(() => {
  // Startup exceptions may contain local paths or dependency-provided details.
  // Keep diagnostics generic at this trust boundary.
  logger.error("fatal startup error");
  process.exit(1);
});
