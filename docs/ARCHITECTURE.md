# Architecture

```text
MCP-compatible IDE
        |
    MCP stdio
        |
openclaw-agent-mcp-bridge
        |
 documented local OpenClaw interfaces
        |
 OpenClaw Gateway and session store
```

The IDE owns repository coding. The bridge provides bounded OpenClaw agent and session access. It must not create an IDE -> OpenClaw -> same IDE recursion loop.

Tools by phase:

1. `openclaw_agents_list` — read-only, bounded metadata. (Phase 1)
2. `openclaw_sessions_list` — read-only, bounded metadata. (Phase 1)
3. `openclaw_session_get` — read-only metadata by key. (Phase 1)
4. `openclaw_session_messages_list` — read-only, **metadata-only** session
   message history, Gateway-mandatory, paginated via an opaque cursor. (Phase 2,
   implemented)
5. `openclaw_agent_turn` — mutating; **implemented as an experimental local
   capability (Phase 3A.2), disabled by default, not stable, not for remote
   use**. Sends a caller-supplied instruction to an explicitly allowlisted real
   `{ agentId, sessionKey }` on a **local/loopback** Gateway and returns the
   agent's textual response via the specialized `openclaw agent` CLI (E1
   transport: prompt in a temporary `--message-file`, direct argv spawn, no
   shell). Registered only when
   `OPENCLAW_MCP_BRIDGE_EXPERIMENTAL_LOCAL_CLI_TRANSPORT=1` **and** the exact
   `agentId`/`sessionKey` are configured **and** loopback is proven
   **fail-closed** by a read-only read of the OpenClaw **local configuration**
   (`config get gateway --json`): the effective Gateway must be `mode: local`
   (or unset → local) with a loopback bind (or unset → loopback) and no
   `gateway.remote.url`; remote/LAN/wildcard/malformed/unset-failure → disabled.
   The bridge does **not** use `OPENCLAW_GATEWAY_URL` to force loopback — in
   OpenClaw 2026.9.3 a URL override requires explicit credentials (config
   credentials are not reused), which the bridge neither accepts nor transports;
   if `OPENCLAW_GATEWAY_URL` is present in the bridge environment the tool is
   disabled, and the child processes never receive `OPENCLAW_GATEWAY_URL`/
   `OPENCLAW_GATEWAY_PORT` or any credential (they use the OpenClaw local
   config/auth). Before every turn the bridge runs a mandatory read-only preflight
   (`sessions.resolve { key, agentId, allowMissing: true }`, reusing the Phase 2
   closed validation) because `openclaw agent --session-key` can otherwise
   create/target a new session for a missing key; missing/ambiguous → `not_found`,
   malformed resolve → `internal`, unavailable Gateway → `gateway_required`, all
   before any dispatch. Only child `exitCode === 0` can yield `completed`/`failed`;
   recognized top-level statuses are `ok`/`completed` → `completed` and `error`
   → `failed`; every other status (incl. `timeout`/`in_flight`), non-zero exit,
   malformed stdout, or local termination → `unknown`. Known residual risks
   (owner-approved for local experimental use only): the `sessionKey` may appear
   in the OS process list and the prompt is written to a temporary plaintext file
   with best-effort deletion (no secure erase). Cancellation on Windows is
   unproven, so cancellation/timeout return `unknown` in this version (abort gate
   deferred). This tool is **synchronous/diagnostic**: it keeps the MCP call open
   until the model finishes, which increases Kiro's consumption.
6. `openclaw_agent_dispatch` — mutating; **experimental, disabled-by-default,
   local-only asynchronous/economical dispatch (Phase 3A.2)**. Same
   flag/allowlist/loopback gate, same preflights, secure temp-file, env
   allowlist, sanitized logging and **the same mutating semaphore** as
   `openclaw_agent_turn` (so a turn and a dispatch are mutually exclusive →
   `busy`). It starts the official `openclaw agent` command in the background and
   returns `{ status: "started", jobId, source: "openclaw" }` **at the child
   `spawn` event, without waiting for the model**. It is **fire-and-forget**: the
   textual response is **never** returned by the MCP tool, is **not persisted**
   (no result spool), and there is **no supported mechanism to automatically
   retrieve or display** it. `started` proves only that the official process was
   created — **not** that the Gateway accepted the turn (hence `started`, not
   `accepted`) and **not** that the work completed or succeeded. Because the
   outcome is not delivered, `openclaw_agent_dispatch` must be used **only** when
   the work has an expected, externally verifiable effect; when the textual
   response is needed, use `openclaw_agent_turn`. `jobId` is an opaque, random,
   local-only correlation (no `agentId`/`sessionKey`/PID/path/content), kept for
   operational correlation and experimental-contract stability even though there
   is no later lookup. The MCP AbortSignal is not observed after return:
   cancelling/closing the MCP call after `started` does not abort the child.
   **Surviving a full shutdown of the MCP process is not guaranteed in this MVP**
   (child started `detached`+`unref`). After spawn, stdout/stderr are drained,
   counted, and discarded; the prompt tempfile is cleaned up and the semaphore
   released on child termination. No retry and no interval polling.

> **Phase 3A.3 (TUI-delivery wrapper) and the PostToolUse hook prototype —
> ARCHIVED, not delivered, not supported.** A deterministic Kiro CLI shell
> wrapper was specified to deliver the dispatch response to the Kiro TUI, and a
> PostToolUse command hook was prototyped to inject the result automatically.
> Neither was delivered: gate G1 could not be confirmed (the required Kiro side
> channel was not available in the tested environment). There is therefore **no
> automatic delivery of the dispatch result to Kiro**, and no supported way to
> read it back.

The synthetic wake-up (`openclaw_agent_wake_test`) is **not** a public release
tool — it is a live test / validation artifact only (see
`docs/PHASE3_PLAN.md` §5M.1). Phase 3B defers remote, secure transport, durable
idempotency/audit, streaming, model selection, and administration.

The official `openclaw mcp serve` remains configured separately for routed channel conversations. This bridge only fills the internal-agent/session gap.

Phase 2 exposes exactly four read-only tools (`openclaw_agents_list`,
`openclaw_sessions_list`, `openclaw_session_get`, and the implemented
`openclaw_session_messages_list`), Gateway-only and metadata-only, with no
mutating tool by default. The two mutating tools (`openclaw_agent_turn` and
`openclaw_agent_dispatch`, Phase 3A.2) are implemented as an **experimental,
disabled-by-default, local-only** capability; without their full configuration
`tools/list` returns exactly the four read-only tools. Phase 3A.1/3A.2 and 3B require separate authorization gates and PRs. The "isolation" gate above refers
to Phase 3 mutating-tool controls; it is **not** a claim that Phase 2 provides
cross-agent/session/client history isolation. Under the approved authorization
model (B, same trust domain), the Gateway provides no such isolation for an
`operator.read` caller and the bridge claims none; Phase 2 is supported only for
local, trusted, single-operator MCP stdio use. See `docs/THREAT_MODEL.md` and
`docs/PHASE2_AUTHORIZATION_DECISION.md`.
