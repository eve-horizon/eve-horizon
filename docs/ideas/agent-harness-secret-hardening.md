# Agent Harness Secret Hardening (Plan)

Goal: remove secrets from agent-visible process space wherever possible, while preserving all required capabilities. This should also define a reusable pattern for Eve-compatible apps.

---

## Why This Matters

Today the worker resolves project/org/user/system secrets and injects them into the harness environment and `.eve/secrets.env` for agent jobs. This means the LLM can access secrets via tools, logs, or prompt injection. We need a hardened, explicit capability model that keeps secrets out of the agent, yet preserves functionality.

---

## Current State (Observed)

Secrets are currently exposed to agent execution through multiple paths:

- Worker resolves secrets and writes them into env plus `.eve/secrets.env` (`apps/worker/src/invoke/invoke.service.ts`).
- Runner pod environment explicitly includes secrets and harness auth (`apps/worker/ARCHITECTURE.md`).
- `eve-agent-cli` passes full `process.env` to the harness (`packages/eve-agent-cli/src/index.ts`), and adapters forward the env to the underlying tools (`packages/eve-agent-cli/src/harnesses/*`).
- Secrets are also used for git/registry actions in worker code paths (`apps/worker/src/action-executor/*`, `apps/worker/src/builder/*`, `apps/worker/src/script-executor/*`).

---

## Secret Inventory (Manual Tests + Sister Repo Manifests)

Secrets referenced by manual tests and example manifests:

| Secret | Used For | Source |
| --- | --- | --- |
| `Z_AI_API_KEY` | LLM harness auth | `tests/manual/README.md`, `manual-tests.secrets.example` |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY` / `CODEX_AUTH_JSON_B64` / `GEMINI_API_KEY` | LLM harness auth variants | `../eve-horizon-starter/secrets.env.example` |
| `GITHUB_TOKEN` | Private repo clone + build | `tests/manual/README.md`, `tests/manual/scenarios/05-deploy-flow.md`, `tests/manual/scenarios/07-sentinel-deploy.md` |
| `GHCR_USERNAME` / `GHCR_TOKEN` | Registry auth | `tests/manual/README.md`, `tests/manual/scenarios/05-deploy-flow.md`, `../eve-horizon-fullstack-example/.eve/manifest.yaml` |
| `POSTGRES_PASSWORD` | App DB runtime | `tests/manual/scenarios/05-deploy-flow.md`, `../eve-horizon-fullstack-example/.eve/manifest.yaml` |
| `EVE_API_TOKEN` / `EVE_API_URL` | Sentinel app calling Eve API | `tests/manual/scenarios/07-sentinel-deploy.md` |
| `EVE_GATEWAY_PROJECT_ID` | Chat gateway routing | `tests/manual/README.md`, `tests/manual/scenarios/08-chat-gateway-slack.md` |
| Slack bot token (`xoxb-*`) | Slack integration stub | `tests/manual/scenarios/08-chat-gateway-slack.md` |

Key observation: agent jobs only need a subset of these secrets, but they currently receive all resolved secrets.

---

## Threat Model (Agent Context)

We need to reduce or eliminate these exposure paths:

- Agent can read env or files (`.eve/secrets.env`, `.eve/secrets/*`).
- Agent can leak secrets into logs (stdout/stderr or JSONL logs).
- Prompt injection can coerce the agent into printing or exfiltrating secrets.
- LLM prompts may include secret values if code or hooks print them.

We should assume that any secret in the agent process is at high risk.

---

## Hard Constraint Today: LLM Harness Auth

Current harnesses expect provider keys in the process environment (examples: `Z_AI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Without harness-level changes, we cannot make `llm.call` secretless.

What we can do immediately:

- Keep LLM creds in the harness process only, but **remove them from tool execution envs** where feasible.
- Prefer file-based auth in non-workspace config dirs (where supported) instead of env vars, so tools running in the workspace cannot read secrets via `env` or file access.
- Add log redaction for any known secret values to reduce accidental leakage.
- Add egress allowlists to reduce exfil routes.

What likely needs harness changes:

- A local proxy or token-file mechanism so harnesses never receive raw provider keys.
- A dedicated LLM gateway that accepts short-lived tokens (no raw keys in env).

---

## Design Principles

1. **Secrets stay out of agent env by default.**
2. **Agents use normal CLI tools; credentials live outside the workspace and are unreadable to the agent.**
3. **Least privilege per job/step, with clear audit trails.**
4. **Separate harness env (LLM creds) from tool env (no secrets, only config paths).**
5. **System-level skills enforce the safe tool paths for all agents.**

---

## Proposed Framework: Isolated Tool Credentials (Normal Agent Tools)

We keep agents “normal” by letting them use standard CLI tools. Hardening comes from isolating **where credentials live** and ensuring the agent cannot read those paths.

### 1) Per-Job Tool Home (Outside Workspace)

Create a per-job tool home directory outside the workspace:

```
/var/lib/eve/agent-homes/<attempt_id>/
  home/                # HOME for the harness process (EVE_JOB_USER_HOME)
  home/.config/gh      # gh config + auth (standard path)
  home/.config/eve     # eve cli config + auth (standard path)
  home/.claude         # Claude auth (standard path)
  home/.cc-mirror      # cc-mirror configs (standard path)
  home/.code           # Code/Codex auth (standard path)
  home/.codex          # Codex auth (standard path)
  home/.eve/harnesses  # Harness config root (new default)
```

Set for harness execution (minimal env):

- `EVE_JOB_USER_HOME=<tool_home>/home`
- `HOME=$EVE_JOB_USER_HOME`

This makes credential paths **predictable**, **job-scoped**, and **outside the workspace** while relying on normal CLI conventions.

**Impact on existing global harness configs:** we can keep a global (read‑only) harness template root and **copy or symlink** it into the per‑job harness dir at job start. Credentials are still written only into the per‑job dir. This preserves today’s shared config behavior without leaking secrets across jobs.

### 2) Tool Sandbox Restricts Access to Workspace

Keep existing harness sandbox flags:

- Claude: `--add-dir <workspace>`
- Code/Codex: `--sandbox workspace-write -C <workspace>`

Net effect: the LLM can only read/write inside the workspace, while tools can still read their own config paths in tool home.

### 3) Store Credentials Only in Tool Home

Never write secrets into:

- `.eve/secrets.env`
- `.eve/secrets/*`
- repo-local `.agent/harnesses/*`

Instead:

- Write OAuth/API auth files into standard tool paths under `$HOME`.
- Use env only to point tools at those directories (no secret values in env).
  - Example: update harness config resolution to default to `$HOME/.eve/harnesses/<harness>` for agent jobs.
  - Keep `EVE_HARNESS_CONFIG_ROOT` as an override, not the default.

### 4) Standard CLI Tools (No Broker)

Agents use normal tools:

- `gh` for GitHub
- `eve` for Eve API actions
- `git` for repo operations (when no private auth needed)

We provide **system skills** that teach agents to use these tools and avoid accessing env secrets.

### 3) Explicit Policy in Manifest

Define a new section that maps **tool access** to workflows, pipelines, or agents:

```yaml
x-eve:
  capabilities:
    git.clone:
      allow: [agent, script, action]
    registry.push:
      allow: [action]
    llm.call:
      allow: [agent]
```

Extend `x-eve.requires.secrets` to map secrets to tool scopes (gh/eve/harness) rather than to agent env.

### 4) Separate Env for Harness vs Tools

Provide two env layers:

- **Harness env**: LLM creds + minimal metadata (temporary, until proxy support).
- **Tool env**: no secrets, only config-path pointers (tool home).

This requires updating `eve-agent-cli` to accept a "sanitized tool env" and to avoid forwarding secrets to child processes.

### 5) Redaction and Audit

Add server-side redaction on job logs:

- Maintain a resolved secret list per job
- Replace occurrences in logs before storage/streaming

Add audit logs:

- Which tool action used
- By which job/step
- Time and duration

---

## CLI and UX Additions (Proposal)

- `eve secrets audit --project <id>`: report which secrets are resolved and which jobs/steps would access them.
- `eve secrets policy --project <id>`: show capability mapping and allowlists.
- `eve github <...>`: optional wrapper around `gh` that enforces `HOME`/tool-home and policy checks.
- `eve api request <method> <path>`: Eve API CLI that uses `$HOME/.config/eve` creds (no token in env).
- `eve job show --secrets` (admin-only): shows resolved secret keys, not values.

---

## Platform-Wide Agent Skills (System)

We should ship a system-level skillpack (applies to all agents) that:

- Instructs agents to use `eve github` for GitHub actions instead of raw `gh` or `git` when auth is needed.
- Instructs agents to use `eve api request` for HTTP calls that require credentials.
- Explicitly forbids reading env vars or `.eve/secrets.env`.
- Documents capability boundaries and escalation flow when a capability is missing.

This must be injected regardless of project-level skills (system prompt or default skillpack).

---

## Implementation Plan (Phased)

### Phase 0: Audit and Baseline

- Add instrumentation to record which secrets are resolved per job.
- Generate a report from manual test scenarios and example repos.
- Add `eve secrets audit` CLI (read-only) for visibility.

### Phase 1: Reduce Secret Injection

- Keep LLM creds in harness env (constraint), but **remove all other secrets** from agent env by default.
- Only allow secrets to agent tools if `requires.secrets` explicitly declares and an allowlist is present.
- Stop writing `.eve/secrets.env` for agent jobs by default (or write only to a non-workspace path).
- Add tool-env sanitization in `eve-agent-cli` so shell/tool execution cannot see harness env.
- Keep hooks/scripts unchanged for now, but add allowlist enforcement.

### Phase 2: Tool Home + CLI Credential Paths

- Implement per-job tool home and set `EVE_JOB_USER_HOME` + `HOME`.
- Update harness config resolution to default to `$HOME/.eve/harnesses/<harness>` for agent jobs.
- Configure `gh` and `eve` CLI to read creds from `$HOME/.config/gh` and `$HOME/.config/eve`.
- Update system skills and agent prompt to mandate these tool paths (no env secrets).

### Phase 3: LLM Proxy

- Introduce an internal LLM proxy service that holds provider keys.
- Agents get only a short-lived proxy token.
- Remove provider keys from runner env entirely once harnesses support proxy or token-file auth.

### Phase 4: App-Level Adoption

- Expose the same tool-home pattern for Eve-compatible apps.
- Provide a lightweight in-cluster CLI that reads creds from mounted tool-home paths.

---

## Open Questions

- How do we prevent LLMs from leaking proxy tokens, even if short-lived?
- Should we enforce egress allowlists for agent pods to reduce data exfiltration?
- Do we need per-agent capability policies in `agents.yaml`?
- Should `.eve/dev-secrets.yaml` be disallowed for agent jobs in non-local modes?
- Should we standardize a token-file contract with harnesses (cc-mirror, Claude Code, Codex) to avoid env vars entirely?
- Do we need an allowlist for external hosts used by `eve api request` to prevent exfiltration?

---

## Implementation Sketch (Concrete)

### Worker (invoke flow)

1. Compute job user home:
   - `jobHome = /var/lib/eve/agent-homes/<attempt_id>/home`
2. Ensure directories exist with 0700 perms.
3. Set env before launching harness:
   - `EVE_JOB_USER_HOME=jobHome`
   - `HOME=jobHome`
4. Move all tool credential writes into `$HOME` paths:
   - Claude: `$HOME/.claude/.credentials.json` and `$HOME/.cc-mirror/<harness>/config/.credentials.json`
   - Code/Codex: `$HOME/.code/auth.json` or `$HOME/.codex/auth.json`
   - gh: `$HOME/.config/gh/hosts.yml`
   - eve: `$HOME/.config/eve/credentials.json` (new)

### Shared Harness Config

Update `resolveHarnessConfigRoot` to:

- If `EVE_JOB_USER_HOME` (or `EVE_JOB_ID`) is set, use `$HOME/.eve/harnesses/<harness>` as the default.
- If `EVE_HARNESS_CONFIG_ROOT` is set, treat it as a **template source** and copy/symlink into the job dir on first use.
- Only fall back to repo `.agent/harnesses` in non-job contexts.

### Eve CLI Pattern

Adopt standard CLI conventions:

- Default config/credentials path: `$HOME/.config/eve/`
- Token never stored in env during agent execution.
- `eve api request` reads from the config file like other CLIs do.

This keeps the agent “normal” (tools + skills), while secrets stay outside its reachable filesystem.

---

## Success Criteria

- Agent jobs no longer receive secrets by default.
- All current manual test scenarios still pass with tool-home credentials.
- Secrets never appear in job logs (with redaction enabled).
- Capability framework is usable by both agent jobs and Eve-compatible apps.
