# Release policy

The project starts as **Experimental Community Preview** and private.

It may become public only after all gates pass:

- Threat model reviewed against the implemented surface.
- Unit, integration, negative-security, timeout, cancellation, and Windows tests pass.
- A clean-machine package installation is verified.
- Secret and personal-data scans pass across working tree, Git history, package contents, logs, and fixtures.
- No hardcoded user, drive, repository, token, account, host, or session identifiers exist.
- OpenClaw compatibility range is documented and tested.
- Mutating tools are opt-in and visibly distinct.
- README, license, third-party notices, support status, and unofficial disclaimer are complete.
- One private release candidate is exercised from Kiro IDE end to end.
- Repository owner explicitly approves public visibility and announcement.
- The controls in `REPOSITORY_SECURITY_STANDARD.md` are satisfied or explicitly marked not applicable with evidence.

A stable release additionally requires repeated end-to-end validation and no open release-blocking security issue. Version `1.0.0` must not be used before these gates pass.

Phase 2 note: the metadata-only history tool (`openclaw_session_messages_list`) keeps the surface at exactly four read-only tools with no mutating tool. Its side-effect posture ("no observable write confirmed by static analysis on OpenClaw 2026.9.3", not absolutely side-effect-free) is bounded to that version and must be re-validated when the OpenClaw compatibility range changes.
