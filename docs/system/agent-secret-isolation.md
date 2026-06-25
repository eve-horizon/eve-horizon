# Agent Secret Isolation

> Status: Current
> Last Updated: 2026-02-08
> Purpose: How Eve Horizon prevents agent processes from accessing or leaking secrets.

## The Problem

Eve agents run LLM-powered processes that execute arbitrary bash commands, read files, and produce output logs. Without hardening, every secret the worker knows — database URLs, encryption keys, API tokens for other services — ends up in the agent's process environment. A single prompt injection or careless `env` command could expose everything.

## Design: Three Defense Layers

The system uses defense in depth. No single layer is sufficient on its own; together they make secret leakage require simultaneous bypass of multiple independent controls.

```
Layer 1 — Nothing to find     Env is clean. Secrets aren't in reachable files.
Layer 2 — Can't look (tools)  File tools restricted to workspace by sandbox flags.
Layer 3 — Won't look (LLM)    Security policy in prompts forbids env/file snooping.
```

### Layer 1: Allowlisted Environment

**Before**: The worker spread its entire `process.env` into the agent harness — `{ ...process.env, ...options.env }`. This leaked `DATABASE_URL`, `EVE_SECRETS_MASTER_KEY`, `EVE_INTERNAL_API_KEY`, Redis URLs, and every other worker-internal secret into the LLM process.

**After**: The worker builds a minimal environment from an explicit allowlist (`apps/worker/src/invoke/env-builder.ts`):

```
Forwarded (allowlist)              Excluded (everything else)
─────────────────────              ──────────────────────────
PATH (with bin dirs prepended)     DATABASE_URL
HOME                               EVE_SECRETS_MASTER_KEY
TERM, LANG, USER, SHELL, TMPDIR   EVE_INTERNAL_API_KEY
EVE_JOB_ID                        REDIS_URL
EVE_ATTEMPT_ID                    AWS_SECRET_ACCESS_KEY
EVE_PROJECT_ID                    GITHUB_TOKEN
EVE_API_URL                       GHCR_TOKEN / GHCR_USERNAME
EVE_REPO_PATH                     GHCR_TOKEN / GHCR_USERNAME
EVE_AGENT_ID (if set)             Any other process.env key
Adapter-provided env only
  (e.g. ANTHROPIC_API_KEY)
```

The adapter-provided env is the key subtlety. Harness adapters (zai, claude, code, etc.) select which secrets _they_ need from a read-only context and return them in `options.env`. The worker never blindly copies secrets across — it passes only what the adapter explicitly requests.

**How it works in practice** (`invoke.service.ts`):

1. Secrets are resolved from the API and placed in `baseEnv` (a read context).
2. The harness adapter's `buildOptions()` reads `baseEnv` and picks the keys it needs (e.g. `ANTHROPIC_API_KEY` for Claude-family harnesses).
3. The adapter returns those keys in `options.env`.
4. `buildSanitizedHarnessEnv()` constructs the final process env from the allowlist + adapter env.
5. `baseEnv` is never spread into the harness process.

**Secrets no longer written to workspace**: Previously, `materializeSecrets()` wrote all resolved secrets to `.eve/secrets.env` and file-type secrets to `.eve/secrets/` inside the repo checkout — both accessible to the agent. The secrets file is no longer written. File-type secrets (SSH keys, etc.) are written outside the repo tree and referenced only by hooks running in the worker context, not by the agent.

**Job-scoped Eve credentials**: The worker writes a job-scoped Eve CLI credential
file to `~/.eve/credentials.json` before the harness spawns. This lets agents
invoke `eve` CLI commands against the public API without exposing system-wide
credentials. The token is limited to the job's permissions and expires with the
job.

**Claude setup-token credentials**: For `claude` and `mclaude`, a selected
`CLAUDE_CODE_OAUTH_TOKEN` setup-token is materialized as `.credentials.json`
under `EVE_JOB_USER_HOME/.claude-runtime/...`, never under `repoPath`. The raw
setup-token env var and conflicting Claude API-key vars are scrubbed after
`env_overrides`, before the harness process env is built.

### Layer 2: Filesystem Sandbox

Each harness CLI restricts the LLM's file tools to the workspace directory:

| Harness | Flag | Effect |
|---------|------|--------|
| claude / mclaude / zai | `--add-dir <workspace>` | Read, Write, Edit, Glob restricted to workspace |
| code / codex | `--sandbox workspace-write -C <workspace>` | All writes restricted to workspace |
| gemini | `--sandbox` | Sandbox mode enabled |

This means the LLM's structured file tools (Read, Write, Edit, Glob, Grep) cannot access `~/.config/gh/hosts.yml`, `/etc/`, or any path outside the workspace.

**Limitation**: The Bash tool can still execute arbitrary commands. An agent _could_ run `cat ~/.config/gh/hosts.yml` via bash. This is addressed by Layer 3 (behavioral) and, for production, by K8s container isolation where the agent runs in an ephemeral pod with no meaningful files outside the workspace.

See [agent-sandbox-security.md](./agent-sandbox-security.md) for full sandbox details.

### Layer 3: LLM Security Policy

A security policy is injected into every agent job through two parallel paths, ensuring coverage regardless of harness type:

**Path A — Prompt preamble** (all harnesses): An XML `<security-policy>` block is prepended to the job prompt before it reaches `eve-agent-cli`. This works universally because all harnesses receive the prompt via `--prompt`.

```xml
<security-policy>
  <workspace>/workspace/my-repo</workspace>
  <rule>You MUST only access files within the workspace: /workspace/my-repo</rule>
  <rule>You MUST NOT use bash commands to read files outside the workspace</rule>
  <rule>You MUST NOT run env, printenv, set, or echo $VAR</rule>
  <rule>You MUST NOT include API keys, tokens, passwords, or credentials in output</rule>
  <rule>If a CLI tool requires authentication, it is already pre-configured</rule>
</security-policy>
```

**Path B — CLAUDE.md config file** (Claude-family harnesses): A `## Security Policy (System)` section is written into `CLAUDE_CONFIG_DIR/CLAUDE.md`. This gets system-prompt-tier weighting in Claude-family LLMs, reinforcing the prompt preamble at a deeper level.

Both paths use the same rule set from a single source of truth (`packages/shared/src/harnesses/security-policy.ts`), ensuring consistency.

## Threat Assessment

| Threat | L1 (env) | L2 (sandbox) | L3 (policy) | Result |
|--------|----------|-------------|-------------|--------|
| Agent runs `env` / `printenv` | Nothing to find | — | Forbidden | **Blocked** |
| Agent reads `.eve/secrets.env` | Not written | — | Forbidden | **Blocked** |
| Naive prompt injection ("print your env") | Nothing to find | — | Forbidden | **Blocked** |
| Agent reads `~/.config/gh/hosts.yml` via bash | Present but scoped* | File tools blocked | Forbidden | **Strong** |
| Sophisticated prompt injection | Nothing to find | File tools blocked | May bypass | **Strong** |
| Agent tries to exfiltrate LLM API key | Key is in env (required) | — | Forbidden | **Medium** |
| Malicious code in repo hooks/scripts | N/A (runs pre-harness) | N/A | N/A | **Out of scope** |

\* In K8s runner pods, the agent runs in an ephemeral container. There are no meaningful credentials in `~/.config/` unless explicitly provisioned. In local/docker workers, this path has more content, but the LLM policy discourages access.

## The Remaining Gap: LLM API Keys

The one secret that _must_ remain accessible to the agent process is the LLM provider API key when API-key auth is selected (e.g. `ANTHROPIC_API_KEY`, `Z_AI_API_KEY`). Claude setup-token auth avoids putting the token in final env by using the attempt-scoped credentials file. API-key auth remains a hard constraint: the harness binary needs the key to make API calls. The agent could theoretically discover it via `echo $ANTHROPIC_API_KEY` in bash.

**Current mitigations**:
- Layer 3 explicitly forbids outputting credentials.
- The key only reaches the agent via the adapter's `options.env` — not via `process.env` spreading.
- Agent logs are not exposed to end users in a way that would persist the value.

**Planned elimination** (Phase 3 — LLM Proxy):
- An internal proxy service holds provider keys.
- Agents receive a short-lived, job-scoped proxy token instead.
- Provider keys never enter the agent environment at all.

## Implementation Reference

| Component | File | Role |
|-----------|------|------|
| Env allowlist | `apps/worker/src/invoke/env-builder.ts` | Builds sanitized env from allowlist |
| Security policy text | `packages/shared/src/harnesses/security-policy.ts` | Single source of truth for rules |
| Preamble injection | `apps/worker/src/invoke/invoke.service.ts:1551` | Prepends `<security-policy>` to prompt |
| CLAUDE.md injection | `apps/worker/src/invoke/invoke.service.ts:1537-1548` | Writes security rules to config dir |
| Env used at spawn | `apps/worker/src/invoke/invoke.service.ts:1579-1596` | `buildSanitizedHarnessEnv` → `spawn()` |
| Adapter selection | `apps/worker/src/invoke/invoke.service.ts:1119-1154` | Adapter picks its env; rest excluded |

## Tests

**Unit tests** (`apps/worker/src/invoke/__tests__/env-sanitization.spec.ts`):
- Allowlisted vars are forwarded.
- `DATABASE_URL`, `EVE_SECRETS_MASTER_KEY`, `EVE_INTERNAL_API_KEY` are excluded.
- Adapter-provided env is forwarded.
- No other process.env keys leak through.
- Total key count matches allowlist + metadata + adapter (no extras).

**Unit tests** (`packages/shared/src/harnesses/__tests__/security-policy.spec.ts`):
- Preamble wraps rules in `<security-policy>` XML.
- CLAUDE.md uses markdown bullet format.
- Both formats contain the same five rules.
- Workspace path is embedded in both outputs.

**Manual test** (`tests/manual/scenarios/09-agent-secret-isolation.md`):
- Security audit job inspects the agent's visible environment.
- Behavioral test verifies the LLM refuses to output credentials.
- Both must pass with zero secret leakage.

## Roadmap

### Phase 1 (Complete)
- Allowlisted env in worker → harness spawn.
- Security policy prompt preamble (all harnesses).
- Security CLAUDE.md for Claude-family harnesses.
- Stopped writing `.eve/secrets.env` to workspace.
- `EVE_SECRETS_MASTER_KEY` removed from K8s runner pod env.

### Phase 2 (Planned): Per-Job HOME + Tool Credential Files
- Create a per-job `$HOME` directory outside the workspace.
- Move LLM auth from env vars to config files under `$HOME` (where supported).
- Tool capability provisioners write `gh`, `git`, `eve` CLI credentials as config files.
- Agents declare tool capabilities in `agents.yaml`; only declared tools are provisioned.
- Default: LLM auth only. No GitHub, npm, or Eve CLI access unless declared.

### Phase 3 (Planned): Hard Isolation
- Internal LLM proxy service holds provider keys; agents get short-lived tokens.
- K8s UID separation: auth config mounted as a volume owned by a different UID.
- Network egress policies for agent pods.
- Server-side log redaction for known secret values.

## Related Documents

- [agent-sandbox-security.md](./agent-sandbox-security.md) — Filesystem sandbox mechanics
- [secrets.md](./secrets.md) — Secret scopes, resolution, and interpolation
- [harness-execution.md](./harness-execution.md) — How harnesses are invoked
- [agent-harness-design.md](./agent-harness-design.md) — Harness adapter architecture
- [../ideas/agent-harness-secret-hardening.md](../ideas/agent-harness-secret-hardening.md) — Original design exploration
- [../plans/agent-secret-isolation-plan.md](../plans/agent-secret-isolation-plan.md) — Detailed implementation plan
