# Live validation (manual)

> These procedures are for the repository owner/operator to run against a real
> OpenClaw installation and a real Kiro IDE. They are not part of CI. Do not
> commit any real output, tokens, session keys, or personal paths produced by
> these steps.

Baseline: OpenClaw **2026.9.3**, Node **22+**.

## Prerequisites

- OpenClaw installed and resolvable, so the bridge can locate its JS entrypoint.
  If auto-resolution from the `openclaw` shim does not work, set
  `OPENCLAW_MCP_BRIDGE_ENTRY` to the absolute path of the OpenClaw CLI
  JavaScript entrypoint (the file the shim runs with Node).
- For Gateway-backed scenarios: a running Gateway with `gateway.mode=local` and
  authentication configured **locally in the CLI**. The bridge never passes
  credentials on the command line or via environment; it relies on the CLI's own
  local configuration to authenticate `openclaw gateway call`.

## 1. OpenClaw integration tests (§10.5)

Environment gates (turn on what applies to the scenario):

- `OPENCLAW_MCP_BRIDGE_LIVE=1` — enables the live suite.
- `OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_UP=1` — the Gateway is running.
- `OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_DOWN=1` — the Gateway is stopped.
- `OPENCLAW_MCP_BRIDGE_LIVE_SESSION_KEY=<key>` — a real session key for
  `session_get` (never printed or persisted by the tests).
- `OPENCLAW_MCP_BRIDGE_LIVE_AGENT=<id>` — agent used to scope Gateway queries
  (default `main`). Agent-scoped queries avoid aggregate session stores that may
  be unavailable on a given machine.

Gateway-up run:

```pwsh
$env:OPENCLAW_MCP_BRIDGE_LIVE = "1"
$env:OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_UP = "1"
# optional: $env:OPENCLAW_MCP_BRIDGE_LIVE_SESSION_KEY = "<real-key>"
npm test
```

Expected: `agents_list`, `sessions_list` (source must be `gateway`), and
pagination via `nextCursor` pass. `session_get` passes when a real key is
provided; otherwise it is skipped. Gateway-down scenarios are skipped in this
run.

Gateway-down run (no need to stop the real service):

You can simulate an unavailable Gateway without stopping the running service by
pointing the bridge at an unused loopback port. `OPENCLAW_GATEWAY_PORT` is passed
to the child through the environment allowlist, so the CLI's `gateway call`
targets a dead port and fails, exercising the same code path as a stopped
Gateway. Port `65534` was confirmed to work for this on this machine.

Run only the two gateway-down tests in isolation:

```pwsh
$env:OPENCLAW_MCP_BRIDGE_LIVE = "1"
$env:OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_DOWN = "1"
$env:OPENCLAW_GATEWAY_PORT = "65534"
node --test --test-name-pattern="fallback CLI|gateway_required" test/live/live.test.mjs
```

Expected summary: `# tests 2`, `# pass 2`, `# fail 0`. Specifically:
`fallback CLI is used` returns `source: "cli"`, and `session_get` surfaces
`gateway_required` (it never falls back to the CLI and never concludes
`not_found` from a limited listing). The process must return to the shell
normally after the run.

Alternatively, stop the Gateway with your normal service command and run the
same tests without `OPENCLAW_GATEWAY_PORT`.

Clean up afterwards:

```pwsh
Remove-Item Env:\OPENCLAW_MCP_BRIDGE_LIVE -ErrorAction SilentlyContinue
Remove-Item Env:\OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_UP -ErrorAction SilentlyContinue
Remove-Item Env:\OPENCLAW_MCP_BRIDGE_LIVE_GATEWAY_DOWN -ErrorAction SilentlyContinue
Remove-Item Env:\OPENCLAW_MCP_BRIDGE_LIVE_SESSION_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\OPENCLAW_GATEWAY_PORT -ErrorAction SilentlyContinue
```

## 2. Kiro IDE end-to-end (§10.6)

Register the bridge as an MCP server in Kiro. Use `node` as the command and the
absolute path to `src/server/main.mjs`. Do not put tokens or personal paths in a
versioned example.

```json
{
  "mcpServers": {
    "openclaw-agent-bridge": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/src/server/main.mjs"],
      "disabled": false
    }
  }
}
```

MCP stdio smoke (NOT a Kiro IDE test): launches `node src/server/main.mjs` and
drives it as a generic MCP stdio client. It exercises the same stdio transport a
client would use, but it does **not** validate anything about the Kiro IDE
itself:

```pwsh
node scripts/mcp-stdio-smoke.mjs
```

Expected (real OpenClaw): initialize + serverInfo, ping, `tools/list` with the
four read-only tools (no mutating tool), and a real `openclaw_agents_list` call
returning structured content — all PASS. The synthetic `messages_list` check is
skipped unless the synthetic fake is enabled.

Fully synthetic smoke (no real OpenClaw, no real session): sets
`SMOKE_USE_FAKE=1` to point the bridge at the synthetic fake CLI and exercise the
new history tool deterministically, metadata-only, with no real data:

```pwsh
$env:SMOKE_USE_FAKE = "1"
node scripts/mcp-stdio-smoke.mjs
Remove-Item Env:\SMOKE_USE_FAKE -ErrorAction SilentlyContinue
```

Expected: initialize, ping, `tools/list` with exactly the four tools, no
mutating/forbidden tool, `agents_list` structured, `openclaw_session_messages_list`
metadata-only with no content leak, cancellation does not crash the client, and
the server stays connected after cancellation — all PASS.

> Automated coverage (unit, integration with a synthetic fake Gateway,
> whole-process content-leak, and the synthetic stdio smoke) is in place for the
> four metadata-only tools. The real end-to-end validation **inside the Kiro
> IDE** is still **pending** and must be performed manually with the checklist
> below. The Kiro IDE validation does **not** replace the automated suite,
> security scan, package inspection, gateway-down test, or cancellation/timeout
> stress tests.

Manual checklist in Kiro (record only pass/fail, counts, and field names — never
paste real keys, cursors, models, content, or identifiers):

1. Kiro connects to the server and completes `initialize`; `ping` works.
2. `tools/list` shows exactly **four** tools: `openclaw_agents_list`,
   `openclaw_sessions_list`, `openclaw_session_get`,
   `openclaw_session_messages_list`. No mutating tool appears (no
   `openclaw_agent_turn`, `messages_send`, `openclaw_session_message_get`,
   attachment or content-preview tools).
3. Calling `openclaw_agents_list` returns a structured result rendered in Kiro.
4. Calling `openclaw_sessions_list` returns session metadata; when the Gateway is
   up, a follow-up call with the returned `nextCursor` advances the page.
5. Calling `openclaw_session_get` with a known key returns its metadata; with an
   unknown key it reports `not_found`; with the Gateway stopped it reports
   `gateway_required`.
6. Calling `openclaw_session_messages_list` (see the synthetic-session procedure
   below) returns **only** metadata fields per message (`role` and optional
   `timestamp`) and never `messageId`, `content`, `contentPreview`,
   `contentLength`, per-message `omitted`, `provenance`, `senderSession`,
   `senderLabel`, `idempotencyKey`, `__openclaw` objects, attachments, URLs,
   paths, or raw Gateway messages. (`messageId` is omitted in this version.)
7. Pagination uses an opaque cursor; a tampered cursor, a cursor reused under a
   different scope, and a cursor from a previous process each return
   `invalid_argument`; the cursor reveals no `sessionKey`/`agentId`/filters.
8. With the Gateway stopped, `openclaw_session_messages_list` returns
   `gateway_required`; there is no CLI fallback.
9. Cancelling a call from Kiro terminates only the child operation; the MCP
   server stays connected and a subsequent call still works.
10. No agent is woken, no message is sent, and no content appears in the UI,
    logs, terminal, or report. Synthetic before/after state stays identical.

### Synthetic-session procedure for step 6 (documented — NOT executed here)

Validating `openclaw_session_messages_list` against real data would require a
real session; **do not use a real session**. Instead, prepare (but do not run
without separate owner authorization, because creating and removing a synthetic
agent/session are **mutations**):

1. Create an obviously **synthetic** agent and session with non-personal names.
2. Post one or two synthetic, non-sensitive messages to that synthetic session.
3. Capture before/after only: an allowlist of non-sensitive metadata, existence
   of synthetic artifacts, any necessary local hashes, timestamps of the
   synthetic artifact, and the synthetic agent's activity status.
4. Run `openclaw_session_messages_list` against the synthetic `sessionKey` with
   the smallest `limit`.
5. Verify metadata-only output (step 6) and that no agent was woken and no
   message was sent.
6. Remove the synthetic artifacts **only with authorization**; confirm the
   before/after synthetic state is otherwise unchanged.
7. Never print the `sessionKey`, full cursors, model, or any content.

Known OpenClaw 2026.9.3 limitation observed on Windows: after the synthetic
session was deleted successfully, `openclaw agents delete <synthetic-id>
--force --json` failed with the sanitized CLI error `cleanup path identity
exceeds the safe integer range`. Do not bypass this failure by recursively
deleting agent directories. Record the residual synthetic agent and resolve it
through a separately reviewed OpenClaw cleanup fix or a later supported CLI
version. This limitation affects test-artifact cleanup, not the bridge's
metadata-only read path.

The two-step history read starts a separate OpenClaw CLI process for
`sessions.resolve` and `chat.history`. On the validated Windows host, cold
startup occasionally exceeded the original 10-second per-process ceiling. The
Phase 2 path therefore uses a dedicated **20-second ceiling per RPC**; Phase 1
Gateway calls remain capped at 10 seconds. This is not a combined 20-second
budget, and cancellation still terminates the individual child operation.

This exercises the Release Policy gate that requires the bridge to be driven from
Kiro IDE end to end. Note: the side-effect result is bounded to OpenClaw
**2026.9.3** and must be re-validated when OpenClaw is upgraded.

## Phase 3A.2 — experimental `openclaw_agent_turn` (local, owner-run)

> NOT part of CI. Consumes real model quota. Follow the mandatory call order and
> the four-call budget in `docs/PHASE3_LOCAL_MVP_VALIDATION.md`. Never commit any
> real output, session key, or prompt/response.

Preconditions (all required, or the tool stays absent from `tools/list`):

- `OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT=1`;
- `OPENCLAW_MCP_BRIDGE_AGENT_TURN_AGENT_ID` and
  `OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY` set to the exact authorized pair;
- a **local, loopback-bound OpenClaw Gateway** proven read-only, without
  credentials, by `openclaw config get gateway --json` (no connection, no auth
  wall): the effective config must be `mode: local` (or unset → local) with a
  loopback bind (or unset → loopback) and no `gateway.remote.url`. This is
  **required** (fail-closed): remote/LAN/wildcard/malformed/unset-failure keeps
  the tool disabled. The bridge does **not** set `OPENCLAW_GATEWAY_URL` — in
  OpenClaw 2026.9.3 a URL override requires explicit credentials (config
  credentials are not reused), which the bridge neither accepts nor transports.
  If `OPENCLAW_GATEWAY_URL` is present in the bridge environment the tool is
  **disabled**, and the child never receives `OPENCLAW_GATEWAY_URL`/
  `OPENCLAW_GATEWAY_PORT` or any credential.

The session named by `OPENCLAW_MCP_BRIDGE_AGENT_TURN_SESSION_KEY` must already
exist: each turn runs a mandatory read-only `sessions.resolve` preflight and
returns `not_found` for a missing/ambiguous session (the specialized command
could otherwise create/target a new session).

Checklist before the first real call:

- fake-Gateway tests green (`node --test`), tool inventory correct (four without
  the config, five only with the flag + exact pair + a proven local loopback
  Gateway; presence of `OPENCLAW_GATEWAY_URL` in the bridge env disables it);
- confirm the effective Gateway is local loopback via the read-only
  `openclaw config get gateway --json` preflight; a remote/LAN/wildcard/malformed
  configuration must keep the tool disabled;
- confirm no secret other than the (sensitive) session key can reach argv; the
  instruction goes through a temporary `--message-file`, never argv;
- use a sufficiently high `timeoutMs`; **do not** manually cancel the call; if it
  hangs or the connection drops, treat the result as `unknown` and verify the
  session before retrying.

Two-call functional test (real): one short instruction, then a continuity call
on the same session key. Expected `status: "completed"` with a textual
`response`. Cancellation/abort behavior is **not** validated here — that remains
the separate, deferred abort gate (P3A2-T4b); this version returns `unknown` for
any local timeout/cancellation.
