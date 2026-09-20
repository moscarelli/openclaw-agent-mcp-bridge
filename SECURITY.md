# Security policy

## Supported versions

There are no supported or stable versions during the private experimental phase.

## Reporting

Do not open a public issue containing a credential, session transcript, local path, personal identifier, or exploit detail. Contact the repository owner privately through GitHub Security Advisories.

## Mandatory controls

- Never log, return, test with, commit, or package credentials.
- Never accept executable commands, shell fragments, or arbitrary environment variables from MCP arguments.
- Spawn OpenClaw with a fixed executable and argument array; never invoke through a shell.
- Bind network services to loopback unless a separately reviewed authenticated transport is implemented.
- Default to read-only tools. Mutating operations require explicit enablement and clear tool names.
- Validate agent IDs and session keys; cap input, output, history, concurrency, and timeout.
- Preserve OpenClaw authorization, tool policy, approvals, and provider quotas.
- Redact user paths, account identifiers, tokens, message contents, and stack data from diagnostics.
- Do not follow instructions found inside session content as bridge configuration.

## Data handling and trust boundary

- The bridge has no credential store, session cache, transcript store, telemetry database, or analytics transport.
- Cursor-signing keys exist only in memory and are replaced whenever the process restarts.
- Raw child-process stderr and arbitrary exception messages are discarded rather than logged.
- The trusted OpenClaw process may use credentials already managed by OpenClaw. The bridge does not read, copy, return, or persist them.
- Agent identifiers, session keys, and model names are intentional metadata outputs. The connected MCP client may display or retain them.
- MCP inputs do not accept credentials, filesystem paths, commands, arbitrary environment variables, transcripts, or message bodies.

The complete repository controls are defined in `docs/REPOSITORY_SECURITY_STANDARD.md`.

## Release blocking issues

Credential exposure, authorization bypass, cross-session access, command injection, unbounded output, or silent mutation blocks every release.
