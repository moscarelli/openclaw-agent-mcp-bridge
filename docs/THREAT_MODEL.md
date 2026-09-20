# Threat model

## Protected assets

Provider credentials, Gateway authorization, private session content, local filesystem paths, repository code, agent policy, and user identity.

## Trust boundaries

- MCP client to bridge.
- Bridge to the OpenClaw Gateway (Gateway-mandatory; no CLI/SQLite/JSONL/direct
  file access).
- Session content returned to an external model.
- Local process environment and filesystem.

The bridge and the OpenClaw `operator.read` credential share **one trust
domain** (Phase 2 authorization decision B, owner-approved). The Gateway does
**not** isolate history between agents, sessions, or clients that share that
credential and scope, and the bridge does **not** add such isolation. Phase 2 is
therefore supported **only** for local, trusted, single-operator use over MCP
stdio, with no network listener created by the bridge and no remote or
multi-user exposure.

## Authorization and session boundary

To avoid overclaiming, these concepts are kept distinct:

- **Identifier validation and routing** — the bridge validates `sessionKey`
  shape and routes the request; this is input hygiene, not authorization.
- **Authentication and scope** — performed by the **Gateway**, which requires
  the `operator.read` scope for `chat.history`/session reads. The bridge does
  not authenticate callers itself.
- **No ownership isolation for history** — under model B the Gateway does not
  enforce per-agent/session/client ownership on history for an `operator.read`
  caller; the bridge inherits this boundary and claims no isolation the Gateway
  does not provide.
- **`sessions.resolve` resolves existence/routing only** — it is **not** an
  authorization or ownership check and must never be described as one.
- **`sessionKey` is a sensitive identifier and a potential access capability** —
  never logged, never in errors, never embedded in cursors, never persisted,
  never sent to telemetry, never printed in tests or reports, and never
  discovered via `sessions.list` or `allAgents`.
- **Read/mutate separation** — the four read-only tools are metadata-only and
  the default surface has **no mutating tool**; static analysis of OpenClaw
  2026.9.3 found no observable write on the Gateway `chat.history` read path (see
  `docs/PHASE2_SIDE_EFFECT_DECISION.md`). The two mutating tools are opt-in and
  disabled by default (below).

## Phase 3A.2 mutating tools (implemented; experimental; opt-in)

Phase 3A.2 is **implemented** as an **experimental, local/loopback,
single-operator/trusted-host, disabled-by-default** capability. Two mutating
tools exist and are registered **only** under the full local configuration:
`openclaw_agent_turn` (synchronous/diagnostic; returns the textual response) and
`openclaw_agent_dispatch` (asynchronous, fire-and-forget; returns only
`{ status: "started", jobId, source }`).

Threats and mitigations on this implemented surface:

- **argv / process-list exposure** — the specialized `openclaw agent` CLI is
  invoked with the instruction in a temporary `--message-file`, so the
  **instruction is not in argv**; only the **`sessionKey`** may appear
  temporarily in the OS process list. Credentials are never in argv (auth stays
  inside the CLI's local configuration).
- **prompt at rest** — the prompt is written to a short-lived, user-private
  plaintext temporary file with **best-effort deletion (not a secure erase)**;
  it may survive a crash. This is accepted only for the trusted-host,
  single-operator experimental mode.
- **TOCTOU between preflight and dispatch** — a mandatory read-only
  `sessions.resolve` preflight runs before dispatch, but the specialized CLI
  transport provides **no atomic no-creation guarantee**: a preflight-then-spawn
  window exists and the session could change in between.
- **wrong-destination mutation** — mitigated by a local allowlist, required
  `agentId`+`sessionKey` binding validation, no implicit `main`, and no
  enumeration/auto-selection.
- **`openclaw_agent_dispatch` is fire-and-forget** — it returns at spawn and
  does **not** wait for, return, or persist the model's response. `started`
  proves only that the official process was created, **not** completion or
  success. There is **no supported automatic channel** that returns the dispatch
  text to Kiro; the response is not stored (data minimization — no result
  spool). Because the outcome is not delivered, dispatch should be used **only**
  when the work produces an **externally verifiable effect**, which the operator
  must confirm independently.
- **no survival guarantee** — a dispatched child is started detached, but
  survival after an abrupt shutdown of the MCP process is **not guaranteed** in
  this MVP.
- **content disclosure (turn only)** — `openclaw_agent_turn` returns the textual
  response to the MCP client by design, but it is capped, UTF-8-safe-truncated,
  and never logged.

## Principal threats

- Command injection through tool arguments.
- Prompt injection contained in stored messages.
- Cross-agent or cross-session data disclosure (inherent to the shared trust
  domain; mitigated by deployment restriction and non-enumeration, not by an
  isolation claim).
- Accidental mutation through a read-looking tool.
- Infinite delegation loops and quota exhaustion.
- Secrets or personal paths in logs, fixtures, errors, packages, or commits.
- Confused-deputy approval or user impersonation.

## Required mitigations

Fixed process invocation without a shell; strict schemas; allowlists; size, time, and concurrency limits; read/mutate separation; identifier validation and routing (not an isolation claim — authentication and scope are enforced by the Gateway; under model B the Gateway provides no per-history ownership isolation); redaction; synthetic tests; no ambient credential export; and auditable terminal receipts for agent turns.
