# Agent Harness Tool-Home Auth Plan

> Status: Partially superseded
> Last Updated: 2026-02-08
> Purpose: Run agent jobs with **zero secrets** in agent env or agent-accessible files by separating tool homes from auth storage and tightening sandboxing.
>
> **Note**: The agent CLI credential aspects of this plan (Phase 5: writing
> `$HOME/.eve/credentials.json` with a scoped token) are now handled by
> `docs/plans/unified-permissions-plan.md` (Phases 4-5). The sandbox
> tightening, tool-home separation, and per-job home directory aspects
> remain valid and complementary.

## Dependencies
- `docs/ideas/agent-harness-secret-hardening.md`
- `packages/shared/src/harnesses/config.ts`
- `apps/worker/src/invoke/invoke.service.ts`
- `packages/eve-agent-cli/src/index.ts`
- `packages/cli/src/lib/config.ts`

## Goals
- **Zero secrets in agent process env.**
- **Zero secrets in any file the agent tools can read** (including `$HOME` and workspace).
- Keep agents using standard CLIs (`gh`, `eve`, `git`) where possible.
- Support per-job provider setup (cc-mirror) without touching the host’s global config.

## Non-goals
- Replacing harnesses or changing LLM providers.
- Introducing a full broker layer (unless required to meet “zero secrets”).
- Changing workspace sandbox policies beyond what’s required to block secret access.

## Core Design

### Two Directories, Two Trust Zones
We split “tool home” from “auth store”:

- `EVE_JOB_USER_HOME` (tool home): non-secret config only.
- `EVE_JOB_AUTH_HOME` (auth store): secrets only; **must not be readable by agent tools**.

`HOME` is set to `EVE_JOB_USER_HOME` for the harness process, but **no secrets live there**.

### Layout (per job)

```
/var/lib/eve/agent-homes/<attempt_id>/
  home/                      # EVE_JOB_USER_HOME (non-secret)
  auth/                      # EVE_JOB_AUTH_HOME (secret-only)
    cc-mirror/<variant>/...  # provider configs with API keys
    code/auth.json           # Codex/Code auth
```

### Sandbox Guarantees
- Tool/file access allowlist must **exclude** `EVE_JOB_AUTH_HOME`.
- If a harness/tool can read outside the workspace (e.g., `CODEX_HOME`), tighten sandboxing or interpose a wrapper so the agent cannot read auth files.
- Paths like `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are **path pointers only** (not secrets) and can be exposed to the harness.

### Provider Auth Strategy
- **mclaude / zai**: create a per-job cc-mirror variant in `EVE_JOB_AUTH_HOME`:
  - `cc-mirror quick --provider zai|mirror --name <variant> --api-key <key> --root <auth>/cc-mirror --bin-dir <auth>/bin`
  - Invoke the wrapper from `<auth>/bin/<variant>` so it uses the temp config.
  - **Do not** use the host’s global `mclaude` / `zai` wrappers.
- **code / codex**: write `auth.json` into `EVE_JOB_AUTH_HOME` and set `CODEX_HOME` to that path.
- If a provider requires an API key at runtime and cannot be set up via cc-mirror, we may need a lightweight proxy to avoid exposing secrets.

### CLI Auth (gh/eve)
- Tokens cannot live in `$HOME` or env for agent jobs under the zero-secrets rule.
- Options:
  - A credential proxy/wrapper that injects tokens **outside** agent control.
  - Capability-scoped tokens injected at execution time (not stored/readable by tools).

## Implementation Plan

### Phase 0: Audit
- Inventory current secret injection paths (env, files, configs).
- Verify which tools can read outside the workspace.

### Phase 1: Job Home + Auth Home
- Create per-attempt `home/` and `auth/` with `0700` perms.
- Set `EVE_JOB_USER_HOME` + `HOME` to `home/`.
- Set `EVE_JOB_AUTH_HOME` to `auth/`.

### Phase 2: cc-mirror Per-Job Setup
- Use `cc-mirror quick` into `EVE_JOB_AUTH_HOME` with `--root` and `--bin-dir`.
- Choose a per-job variant name (e.g., `zai-job-<attempt_id>`).
- Pass provider API key only to cc-mirror setup; **do not export to harness env**.
- Invoke the generated wrapper from the auth bin dir.

### Phase 3: Codex/Code Auth
- Write `auth.json` into `EVE_JOB_AUTH_HOME/code` (or `codex`).
- Set `CODEX_HOME` to that auth path.
- If tool sandbox can still read it, harden sandbox or wrap execution.

### Phase 4: Env Sanitization
- Strip all secret env values before launching the harness.
- Only pass non-secret path pointers and flags.

### Phase 5: CLI Auth Broker (gh/eve)
- Implement a wrapper/proxy for token injection or disable CLI auth for agent jobs until available.

## Tests
- Unit: harness config resolution honors `EVE_JOB_AUTH_HOME`.
- Integration: run agent job with relocated `HOME` and confirm success without secret env vars.
- Security: agent tool cannot read any file under `EVE_JOB_AUTH_HOME`.
- Regression: cc-mirror per-job variant works for `zai` and `mclaude` without touching host config.

## Risks / Open Questions
- `code` sandbox currently reads `CODEX_HOME` outside workspace → may need stronger sandbox or wrapper.
- Some provider CLIs may ignore custom config dirs; ensure per-job wrapper is used.
- cc-mirror writes API keys into config files; those files must remain unreadable to agent tools.

## Notes (Validation)
- Global `mclaude` wrapper hardcodes config dir; per-job cc-mirror variant is required.
- Temp cc-mirror `zai-test` variant works with relocated `HOME` and a temp root.
