# openclaw-agent-mcp-bridge

`openclaw-agent-mcp-bridge` connects MCP-compatible development tools to a local
OpenClaw installation. It provides a small, bounded interface for inspecting
agents and sessions and, when explicitly enabled, for requesting controlled work
from a preconfigured OpenClaw agent.

It is designed for local use, personal automation, and experimenting with
workflows between your IDE and OpenClaw.

## Status

- Experimental Community Preview.
- Validated with OpenClaw 2026.9.3.
- Read-only by default.
- Mutating tools are disabled by default.
- Not yet a stable release; interfaces may change.

## Why this project

OpenClaw's official `openclaw mcp serve` focuses on routed channel
conversations. This bridge fills a different gap: it lets an MCP-compatible IDE
or client inspect your local OpenClaw **agents and sessions** as bounded
metadata, and — only when you opt in — hand a single, well-scoped instruction to
a specific local agent. The goal is a minimal, predictable surface you can wire
into your own tools.

## What it provides

- Four read-only, metadata-only tools for agents and sessions.
- Two optional, opt-in tools for requesting work from a preconfigured agent.
- Strict input validation, bounded output, and sanitized logging.
- A local-only design: the bridge speaks MCP over stdio and opens no network
  listener.

## How it works

The bridge runs as an MCP stdio server. Your MCP client launches it, and it
talks to your local OpenClaw installation through documented interfaces:

```
MCP client  ──stdio──►  openclaw-agent-mcp-bridge  ──►  local OpenClaw (Gateway / CLI)
```

Read-only history is served through the OpenClaw Gateway. The optional mutating
tools invoke the official `openclaw agent` command for a single turn against a
preconfigured, local, loopback agent.

## Requirements

- Node.js >= 22
- OpenClaw installed, with a local Gateway available
- An MCP-compatible client

## Quick start

1. Install dependencies from the lockfile:

   ```
   npm ci
   ```

2. Run the server:

   ```
   node src/server/main.mjs
   ```

3. Register it in your MCP client (placeholders shown — use your own absolute
   path):

   ```json
   {
     "command": "node",
     "args": ["<ABSOLUTE_PATH_TO_REPOSITORY>/src/server/main.mjs"]
   }
   ```

The bridge communicates over MCP stdio and does not open a network listener.
With no extra configuration, only the four read-only tools are available.

## Available tools

### Read-only (available by default)

- `openclaw_agents_list` — list configured agents (id and model only).
- `openclaw_sessions_list` — list session metadata (agentId, key, model).
- `openclaw_session_get` — get metadata for a single session by key.
- `openclaw_session_messages_list` — list a session's message-history metadata.
  It returns only `role` and an optional `timestamp` — **never message
  content**, previews, sizes, or attachments — paginated via an opaque cursor
  (Gateway-mandatory).

### Experimental and opt-in

These two tools are disabled by default and are only registered when the full
local configuration is present:

- `openclaw_agent_turn` — synchronous. Keeps the MCP call open until the model
  finishes and returns the textual response to the client. Use it when the
  client needs the response.
- `openclaw_agent_dispatch` — asynchronous, fire-and-forget. Returns only
  `{ status: "started", jobId, source }` when the official process is started.
  It does **not** return or persist the textual response and has no automatic
  retrieval mechanism. Use it only for work whose effect is externally
  verifiable.

`openclaw_session_messages_list` returns metadata only; it does not return the
textual response produced by `openclaw_agent_dispatch`.

## Choosing turn vs dispatch

- Choose `openclaw_agent_turn` when you need the model's textual answer back in
  the client. It is synchronous and keeps the MCP call open until completion.
- Choose `openclaw_agent_dispatch` when the useful outcome is an external,
  verifiable effect (for example, controlled changes in a repository) rather
  than a textual reply. It returns immediately at process start and does not
  deliver the response.

## Security model

- Local MCP stdio only; the bridge creates no network listener.
- Read-only by default; mutating tools require explicit opt-in and an explicit,
  preconfigured destination on a local/loopback Gateway.
- Strict input schemas; bounded output; sanitized logging.
- No credential storage: OpenClaw remains responsible for authentication, tool
  policy, approvals, and provider quotas.
- The optional tools write the caller's prompt to a short-lived, user-private
  temporary file with best-effort cleanup.
- A target `sessionKey` may appear briefly in the OS process list while a turn
  runs.
- `openclaw_agent_dispatch` does not persist the response.

See [`SECURITY.md`](SECURITY.md) and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
for details.

## Current limitations

- Validated only against OpenClaw 2026.9.3.
- Mutating use is local/loopback/single-operator only.
- No remote or multi-user support.
- `openclaw_agent_dispatch` does not return a textual result.
- Cancellation and survival after an abrupt shutdown have documented
  limitations.
- Not a stable release.

## Compatibility

Validated against OpenClaw 2026.9.3 on Node.js 22+. Behavior may differ on other
OpenClaw versions and should be re-validated when you upgrade.

## Development and validation

Common commands:

```
npm ci                 # install from the lockfile
npm run check          # syntax check + test suite
npm run security:scan  # secret / personal-data scan
npm run package:inspect
```

Live, read-only validation against a local Gateway is documented in
[`docs/LIVE_VALIDATION.md`](docs/LIVE_VALIDATION.md). Release gates are described
in [`docs/RELEASE_POLICY.md`](docs/RELEASE_POLICY.md), and the repository
security baseline in
[`docs/REPOSITORY_SECURITY_STANDARD.md`](docs/REPOSITORY_SECURITY_STANDARD.md).
Architecture and the tool surface are described in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Roadmap

- A per-message `messageId` in `openclaw_session_messages_list` (deferred until a
  stable, opaque source id is available).
- Optional message content/preview in history reads (deferred).
- A stable or remote-capable agent turn (deferred; requires additional transport,
  cancellation, and audit work).

These items are not implemented in the current phase.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) and
keep changes within the project's read-only-by-default, opt-in-mutation design.

## Security reporting

Please report security concerns privately as described in
[`SECURITY.md`](SECURITY.md). Do not include credentials, session keys, local
paths, or message content in a report.

## License and trademark notice

This is an independent, unofficial project. It is not affiliated with, endorsed
by, or sponsored by the OpenClaw Foundation, AWS/Kiro, Anthropic, or OpenAI.
Product names and trademarks belong to their respective owners and are used only
to describe interoperability. OpenClaw and Kiro must be obtained and licensed
separately.

The bridge is distributed under the MIT License. See [`LICENSE`](LICENSE).
