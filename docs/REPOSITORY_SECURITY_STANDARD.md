# Repository security standard

## Purpose

This document defines the minimum security, privacy, governance, and release
controls for this repository. It is also the policy baseline for a future agent
that creates or validates GitHub repositories. A repository must not be reported
as compliant unless every applicable control has machine-verifiable evidence.

## Identity and attribution

- Public GitHub usernames, repository ownership, CODEOWNERS entries, and GitHub
  `users.noreply.github.com` commit addresses are attribution, not secrets.
- Personal email addresses, local account names, workstation names, and personal
  filesystem paths must not appear in source, tests, fixtures, logs, packages, or
  release artifacts.
- Existing Git history is rewritten only for an exposed secret, legally required
  removal, or material private data. Rewriting solely to hide public attribution
  is not a security control and requires explicit owner approval.
- Future commits must use a GitHub-provided noreply address or an approved
  organization identity.

## Secrets and credentials

- Secrets must never be committed, embedded in fixtures, placed in command-line
  arguments, returned by tools, or written to logs.
- Runtime credentials remain owned by the upstream component that needs them.
  This bridge may invoke OpenClaw with a minimal allowlisted environment, but it
  must not read, copy, cache, transform, return, or persist OpenClaw credentials.
- CI credentials must use GitHub-provided identities or repository secrets with
  least privilege. Long-lived personal tokens are prohibited when OIDC or the
  scoped `GITHUB_TOKEN` is sufficient.
- A detected real credential is a release blocker. Revoke or rotate it before
  removing it from the tree and, when necessary, history.

## Data handling and privacy

- The bridge has no credential store, transcript store, session cache, analytics
  transport, or telemetry database.
- Cursor signing keys exist only in process memory and rotate on restart.
- Raw subprocess stderr, stack traces, arbitrary exception messages, transcripts,
  and message bodies must not be logged.
- Agent IDs, session keys, and model names are intentional metadata outputs. MCP
  clients may retain them in their own logs or chat history; operators must treat
  those records as sensitive metadata.
- Logs use only bounded, bridge-defined fields and must pass the redaction layer.

## Code and process controls

- Tools are read-only by default. Mutation requires a separate, explicit tool,
  authorization analysis, tests, and release review.
- Inputs use strict schemas and reject paths, commands, shell fragments, unknown
  fields, credential material, and arbitrary environment variables.
- Child processes use a fixed executable and argument array with `shell: false`,
  bounded output, timeout, cancellation, concurrency limits, and exact-process
  cleanup.
- Network listeners bind to loopback unless authenticated remote transport has a
  reviewed threat model.
- Dependencies are exact-version pinned and reviewed before update.

## Required automated checks

Every pull request and protected-branch push must pass:

1. syntax, unit, integration, negative-security, timeout, and cancellation tests;
2. production dependency audit at high severity;
3. repository secret, personal-data, and local-path scan;
4. package allowlist inspection using `npm pack --dry-run`;
5. CodeQL analysis for JavaScript/TypeScript when the repository is public or
   GitHub Code Security is licensed;
6. dependency review for pull requests under the same availability condition.

While a private repository does not have these licensed GitHub features, their
workflows remain explicitly skipped and CI must still enforce the test suite,
`npm audit`, the repository scanner, and package-manifest inspection. A skipped
licensed feature must be reported as `not_applicable`, never as `pass`.

Dependabot must monitor npm and GitHub Actions dependencies.

## GitHub repository settings

The repository owner must enable and periodically verify:

- secret scanning and push protection;
- a ruleset or branch protection for the default branch;
- pull requests required before merge;
- required status checks for CI, CodeQL, dependency review, and package audit;
- stale approvals dismissed after new commits;
- code-owner review where supported and appropriate;
- automatic deletion of merged branches remains disabled unless protected
  long-lived branches can be enforced by GitHub rulesets;
- `main`, `develop`, `release`, and `release/*` are long-lived branches and must
  never be deleted by automation; cleanup of other merged branches is manual;
- private visibility while the project remains an experimental preview.

These settings cannot be guaranteed by committed workflow files alone. The future
repository-validation agent must inspect them through the GitHub API and report
`unknown` rather than `pass` when permissions are insufficient.

## Package and release controls

- `package.json` remains `private: true` during the experimental phase.
- The npm `files` field is an allowlist. Tests, fixtures, local configuration,
  planning documents, `.env` files, and diagnostic output are excluded.
- CI inspects the exact dry-run manifest before release.
- Preview releases must use an explicit prerelease version and tag; `latest` and
  version `1.0.0` are prohibited until stable-release gates pass.
- A release requires a clean-machine installation, live MCP validation, audit,
  package scan, and explicit repository-owner approval.

## Future repository agent contract

The future agent may create or validate repositories only with explicit owner
authorization. It must:

- default new repositories to private;
- create policy, SECURITY, CODEOWNERS, Dependabot, CI, CodeQL, and dependency
  review configuration from reviewed templates;
- never collect, print, persist, or transmit tokens and personal data;
- use GitHub APIs with least privilege and never bypass branch protection;
- distinguish local checks, GitHub API checks, and unverified assumptions;
- produce an evidence report with `pass`, `fail`, `not_applicable`, or `unknown`;
- require human approval before changing visibility, publishing a package,
  rewriting history, deleting data, or weakening a security control;
- remain idempotent and preserve unrelated repository configuration.
- never delete `main`, `develop`, `release`, or `release/*`; branch deletion must
  use an explicit allowlist/denylist check and require human approval.

## Release blockers

Any credential exposure, authorization bypass, cross-session disclosure, command
injection, unbounded output, silent mutation, package-content mismatch, missing
required check, or unresolved high-severity vulnerability blocks release.
