// Criação do servidor MCP e registro das tools (PHASE1_PLAN §3).
// O SDK fornece o transporte newline-delimited JSON-RPC, o handshake
// (initialize/protocolVersion/notifications/initialized), ping e
// notifications/cancelled (via AbortSignal em `extra`).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildTools } from "./tools.mjs";

export const SERVER_NAME = "openclaw-agent-mcp-bridge";
export const SERVER_VERSION = "0.0.0";

export function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // A quinta ferramenta (openclaw_agent_turn) só é registrada quando a
  // configuração experimental local completa e válida está presente.
  for (const tool of buildTools()) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }

  return server;
}
