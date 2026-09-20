// Definição das ferramentas MCP da Fase 1 (read-only) (PHASE1_PLAN §3, §4).
// Schemas Zod (inputSchema/outputSchema como ZodRawShape), handlers que
// retornam structuredContent compatível + content textual, e mapeamento de
// ToolError para isError: true.

import { z } from "zod";
import { listAgents } from "../openclaw/agents.mjs";
import { listSessions, getSession } from "../openclaw/sessions.mjs";
import { listSessionMessages } from "../openclaw/messages.mjs";
import {
  validateAgentsListArgs,
  validateSessionsListArgs,
  validateSessionGetArgs,
} from "../lib/validate.mjs";
import { validateMessagesListArgs } from "../lib/validate-messages.mjs";
import { runAgentTurn } from "../openclaw/agent-turn.mjs";
import { runAgentDispatch } from "../openclaw/agent-dispatch.mjs";
import { resolveAgentTurnConfig } from "../openclaw/agent-turn-config.mjs";
import { AGENT_TURN_TIMEOUT_MIN_MS, AGENT_TURN_TIMEOUT_MAX_MS } from "../lib/limits.mjs";
import { ToolError, ERROR_CATEGORIES, isToolError, categoryMessage } from "../lib/errors.mjs";
import {
  AGENTS_LIMIT_MIN,
  AGENTS_LIMIT_MAX,
  SESSIONS_LIMIT_MIN,
  SESSIONS_LIMIT_MAX,
  ACTIVE_MINUTES_MIN,
  ACTIVE_MINUTES_MAX,
  MESSAGES_LIMIT_MIN,
  MESSAGES_LIMIT_MAX,
  MAX_OUTPUT_ITEMS,
  RESULT_MAX_BYTES,
} from "../lib/limits.mjs";
import { logger } from "../lib/logger.mjs";

// ---- Schemas de saída (ZodRawShape) ----

const agentShape = {
  id: z.string(),
  model: z.string().optional(),
};

const sessionShape = {
  agentId: z.string().optional(),
  key: z.string(),
  model: z.string().optional(),
};

// Metadata-only por mensagem (PHASE2_PLAN §7.1): SOMENTE role e timestamp?.
// `messageId` é OMITIDO nesta versão inicial (fonte estável/opaca não confirmada
// na 2026.9.3; ver normalize-messages.mjs). Sem content/contentPreview/
// contentLength/omitted/provenance/etc.
const messageShape = {
  role: z.enum(["user", "assistant", "system", "tool", "unknown"]),
  timestamp: z.number().int().optional(),
};

// ---- Helpers de resultado MCP ----

function textContent(obj) {
  return [{ type: "text", text: JSON.stringify(obj, null, 2) }];
}

// Nome da chave de lista (agents/sessions/messages) presente no payload.
function listKey(payload) {
  if (Array.isArray(payload.sessions)) return "sessions";
  if (Array.isArray(payload.agents)) return "agents";
  if (Array.isArray(payload.messages)) return "messages";
  return undefined;
}

function serializedBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/**
 * Constrói um resultado de sucesso garantindo o teto RESULT_MAX_BYTES de forma
 * adaptativa: aplica o teto de itens, e enquanto o payload serializado exceder
 * o limite, reduz a lista pela metade e recalcula o tamanho. Se não houver
 * lista para truncar e ainda assim exceder, lança output_too_large.
 * Exportado para testes.
 */
export function successResult(structured) {
  let payload = structured;
  const key = listKey(payload);

  // Teto de itens.
  if (key && payload[key].length > MAX_OUTPUT_ITEMS) {
    payload = { ...payload, [key]: payload[key].slice(0, MAX_OUTPUT_ITEMS), truncated: true };
  }

  // Truncamento adaptativo por tamanho, recalculando após cada corte.
  if (serializedBytes(payload) > RESULT_MAX_BYTES) {
    if (!key || payload[key].length === 0) {
      // Sem lista para reduzir: não há como caber no teto.
      throw new ToolError(ERROR_CATEGORIES.OUTPUT_TOO_LARGE, "Result exceeds the size limit");
    }
    let items = payload[key];
    while (items.length > 1 && serializedBytes({ ...payload, [key]: items, truncated: true }) > RESULT_MAX_BYTES) {
      // Reduz pela metade (arredonda para baixo), mantendo ao menos 1 item para
      // decidir se um único item já estoura o teto.
      const nextLen = Math.max(1, Math.floor(items.length / 2));
      items = items.slice(0, nextLen);
    }
    payload = { ...payload, [key]: items, truncated: true };
    // Se nem um único item cabe, não há resultado representável dentro do teto.
    if (serializedBytes(payload) > RESULT_MAX_BYTES) {
      throw new ToolError(ERROR_CATEGORIES.OUTPUT_TOO_LARGE, "Result exceeds the size limit even when truncated");
    }
  }

  return { content: textContent(payload), structuredContent: payload };
}

/**
 * Resultado de erro de ferramenta: isError:true, SEM structuredContent (para
 * não retornar um objeto incompatível com o outputSchema de sucesso). A
 * categoria/mensagem vai apenas no content textual.
 */
function errorResult(category, message) {
  const body = { error: category, message: message ?? categoryMessage(category) };
  return { content: textContent(body), isError: true };
}

/**
 * Envolve um handler: valida, executa, e mapeia ToolError → isError.
 * Nunca vaza stack traces nem detalhes internos ao cliente.
 */
function wrap(name, fn) {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      if (isToolError(err)) {
        return errorResult(err.category, categoryMessage(err.category));
      }
      // Never log arbitrary exception messages: dependencies may include local
      // paths, identifiers, command output, or credential-shaped values.
      logger.error("unexpected tool error", { tool: name });
      return errorResult(ERROR_CATEGORIES.INTERNAL);
    }
  };
}

// ---- Definições das tools ----

export const tools = [
  {
    name: "openclaw_agents_list",
    config: {
      title: "List OpenClaw agents",
      description:
        "Read-only. Lists configured OpenClaw agents with bounded metadata (id and model only). No credentials, paths, or routing bindings.",
      inputSchema: z.strictObject({
        limit: z.number().int().min(AGENTS_LIMIT_MIN).max(AGENTS_LIMIT_MAX).optional(),
      }),
      outputSchema: {
        agents: z.array(z.object(agentShape)),
        count: z.number().int(),
        truncated: z.boolean().optional(),
      },
    },
    handler: wrap("openclaw_agents_list", async (args, extra) => {
      const { limit } = validateAgentsListArgs(args ?? {});
      const result = await listAgents({ limit }, { signal: extra?.signal });
      return successResult(result);
    }),
  },
  {
    name: "openclaw_sessions_list",
    config: {
      title: "List OpenClaw sessions",
      description:
        "Read-only. Lists stored session metadata (agentId, key, model). Prefers the Gateway with offset pagination via an opaque cursor; falls back to a limited CLI listing without pagination when the Gateway is unavailable.",
      inputSchema: z.strictObject({
        agentId: z.string().optional(),
        allAgents: z.boolean().optional(),
        activeMinutes: z.number().int().min(ACTIVE_MINUTES_MIN).max(ACTIVE_MINUTES_MAX).optional(),
        limit: z.number().int().min(SESSIONS_LIMIT_MIN).max(SESSIONS_LIMIT_MAX).optional(),
        cursor: z.string().optional(),
      }),
      outputSchema: {
        sessions: z.array(z.object(sessionShape)),
        count: z.number().int(),
        totalCount: z.number().int().optional(),
        hasMore: z.boolean(),
        nextCursor: z.string().optional(),
        limitApplied: z.number().int().optional(),
        source: z.enum(["gateway", "cli"]),
        truncated: z.boolean().optional(),
      },
    },
    handler: wrap("openclaw_sessions_list", async (args, extra) => {
      const filters = validateSessionsListArgs(args ?? {});
      const result = await listSessions(filters, { signal: extra?.signal });
      return successResult(result);
    }),
  },
  {
    name: "openclaw_session_get",
    config: {
      title: "Get OpenClaw session metadata",
      description:
        "Read-only. Returns metadata for a single session by key (agentId, key, model). Requires a running Gateway; returns gateway_required when unavailable. Never returns transcript or message content.",
      inputSchema: z.strictObject({
        sessionKey: z.string(),
        agentId: z.string().optional(),
      }),
      outputSchema: {
        agentId: z.string().optional(),
        key: z.string(),
        model: z.string().optional(),
        source: z.literal("gateway"),
      },
    },
    handler: wrap("openclaw_session_get", async (args, extra) => {
      const parsed = validateSessionGetArgs(args ?? {});
      const result = await getSession(parsed, { signal: extra?.signal });
      return { content: textContent(result), structuredContent: result };
    }),
  },
  {
    name: "openclaw_session_messages_list",
    config: {
      title: "List OpenClaw session message history (metadata-only)",
      description:
        "Read-only, metadata-only. Lists a session's message history metadata (role and optional timestamp) via the Gateway. Never returns message content, previews, sizes, message ids, attachments, or internal objects. Requires a running Gateway; returns gateway_required when unavailable, not_found when the session is conclusively absent. Shared trust domain (no cross-agent/session isolation); local, single-operator, MCP stdio only.",
      inputSchema: z.strictObject({
        sessionKey: z.string(),
        agentId: z.string().optional(),
        limit: z.number().int().min(MESSAGES_LIMIT_MIN).max(MESSAGES_LIMIT_MAX).optional(),
        cursor: z.string().optional(),
      }),
      outputSchema: {
        messages: z.array(z.object(messageShape)),
        count: z.number().int(),
        totalMessages: z.number().int().optional(),
        hasMore: z.boolean(),
        nextCursor: z.string().optional(),
        source: z.literal("gateway"),
        truncated: z.boolean().optional(),
      },
    },
    handler: wrap("openclaw_session_messages_list", async (args, extra) => {
      const parsed = validateMessagesListArgs(args ?? {});
      const result = await listSessionMessages(parsed, { signal: extra?.signal });
      return successResult(result);
    }),
  },
];

// ---- Fase 3A.2: ferramenta mutante experimental (condicional) ----
//
// `openclaw_agent_turn` só é registrada quando a configuração experimental
// local completa e válida está presente (ver agent-turn-config.mjs). Sem ela,
// tools/list mantém exatamente as quatro ferramentas read-only.

const agentTurnTool = {
  name: "openclaw_agent_turn",
  config: {
    title: "Run one local OpenClaw agent turn (experimental, synchronous/diagnostic)",
    description:
      "EXPERIMENTAL, disabled by default, local/loopback single-user only; not stable and not for remote use. SYNCHRONOUS/DIAGNOSTIC: this tool keeps the MCP call open until the model finishes and returns the agent's full textual response, which increases Kiro's consumption. This is the only current tool that returns the textual response directly to the MCP client. Sends a caller-supplied instruction to the pre-configured, allowlisted real agent/session on a local Gateway via the specialized `openclaw agent` command. Requires a successful existing-session preflight before dispatch; the specialized CLI transport does not provide an atomic no-creation guarantee. Known residual risks: the sessionKey may appear in the OS process list and the prompt is written to a temporary plaintext file with best-effort deletion (no secure erase). No model/provider/tool/cwd/channel/account/delivery override.",
    inputSchema: z.strictObject({
      agentId: z.string(),
      sessionKey: z.string(),
      instruction: z.string(),
      timeoutMs: z.number().int().min(AGENT_TURN_TIMEOUT_MIN_MS).max(AGENT_TURN_TIMEOUT_MAX_MS).optional(),
    }),
    outputSchema: {
      status: z.enum(["completed", "failed", "cancelled", "timeout", "unknown"]),
      response: z.string().optional(),
      truncated: z.boolean().optional(),
      source: z.literal("gateway"),
    },
  },
  handler: wrap("openclaw_agent_turn", async (args, extra) => {
    const result = await runAgentTurn(args ?? {}, { signal: extra?.signal });
    return { content: textContent(result), structuredContent: result };
  }),
};

// `openclaw_agent_dispatch`: dispatch ASSÍNCRONO econômico, fire-and-forget.
// Inicia o comando oficial `openclaw agent` em background e RETORNA assim que o
// processo filho é criado (evento `spawn`), sem esperar o modelo terminar. A
// resposta textual NUNCA volta ao cliente MCP, NÃO é persistida e NÃO há
// mecanismo público suportado para recuperá-la ou exibi-la automaticamente.
// `status: "started"` comprova apenas que o processo oficial foi criado, NÃO que
// o Gateway aceitou o turno nem que o trabalho concluiu. Use `openclaw_agent_turn`
// quando a resposta textual for necessária; use o dispatch apenas quando houver
// efeito externo esperado e verificável. Registrada sob a MESMA configuração
// experimental local do turn.
const agentDispatchTool = {
  name: "openclaw_agent_dispatch",
  config: {
    title: "Dispatch one local OpenClaw agent turn asynchronously (experimental)",
    description:
      "EXPERIMENTAL, disabled by default, local/loopback single-operator only; not stable and not for remote use. ASYNCHRONOUS, FIRE-AND-FORGET: starts the official `openclaw agent` command in the background and returns as soon as the child process has been created (the spawn event), WITHOUT waiting for the model to finish. It does NOT return the textual response and offers NO supported way to automatically retrieve or display it; the response is not persisted. `status: \"started\"` proves only that the official process was created, NOT that the Gateway accepted the turn or that the work completed. Use openclaw_agent_turn when the textual response is needed; use dispatch only when the work has an expected, externally verifiable effect (for example, controlled changes in a repository). Same preflights, allowlist, secure tempfile, semaphore and sanitization as the synchronous tool. No retry. Surviving a full shutdown of the MCP process is not guaranteed in this MVP. Known residual risks: the sessionKey may appear in the OS process list and the prompt is written to a temporary plaintext file with best-effort deletion (no secure erase). No model/provider/tool/cwd/channel/account/delivery override.",
    inputSchema: z.strictObject({
      agentId: z.string(),
      sessionKey: z.string(),
      instruction: z.string(),
    }),
    outputSchema: {
      status: z.literal("started"),
      jobId: z.string(),
      source: z.literal("openclaw"),
    },
  },
  handler: wrap("openclaw_agent_dispatch", async (args, extra) => {
    const result = await runAgentDispatch(args ?? {}, { signal: extra?.signal });
    return { content: textContent(result), structuredContent: result };
  }),
};

/**
 * Retorna a lista de tools a registrar, incluindo as ferramentas MUTANTES
 * experimentais (turn síncrono/diagnóstico + dispatch assíncrono) SOMENTE
 * quando a configuração experimental completa e válida está presente.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildTools(env = process.env) {
  const config = resolveAgentTurnConfig(env);
  if (config.enabled) {
    return [...tools, agentTurnTool, agentDispatchTool];
  }
  return tools;
}
