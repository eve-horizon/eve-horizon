# Harness Execution

> Status: Current
> Last Updated: 2026-02-13
> Purpose: Document the complete harness invocation flow including authentication, workspace setup, and per-harness configuration.
> See also: [harness-adapters.md](./harness-adapters.md) for adding new harnesses

## Overview

When a job attempt is executed, the worker:

1. Prepares the workspace directory
2. Clones/copies the repository (GitWorkspace when `job.git` is set)
3. Resolves harness-specific configuration (auth, config dirs, environment)
4. Spawns `eve-agent-cli` which invokes the actual harness binary
5. Streams output as JSON events to the execution log

### Worker Variants

Jobs can request specific worker types via `hints.worker_type` to access specialized container images:

- **base-worker** (default): Standard worker with common CLI tools
- **python-worker**: Includes Python runtime and package managers
- **rust-worker**: Includes Rust toolchain and Cargo
- **node-worker**: Includes Node.js runtime and npm/yarn

The worker type determines which container image is deployed but does not affect the harness execution flow. All variants follow the same invocation pattern described in this document.

For full details on worker types and their capabilities, see [worker-types.md](./worker-types.md).

## Invocation Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           HarnessInvocation                             │
│  {attemptId, jobId, projectId, text, workspacePath, repoUrl, harness}  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      InvokeService.execute()                            │
│                                                                         │
│  1. prepareWorkspace()                                                  │
│     - mkdir workspacePath                                               │
│     - git clone/cp repo → workspacePath/repo                            │
│                                                                         │
│  2. resolveWorkerAdapter(harness)                                       │
│     - Look up WorkerHarnessAdapter by name                              │
│                                                                         │
│  3. adapter.buildOptions(ctx)                                           │
│     - Resolve auth (OAuth tokens, API keys)                             │
│     - Set config directories                                            │
│                                                                         │
│  4. executeEveAgentCli(invocation, options)                             │
│     - Spawn eve-agent-cli with args                                     │
│     - Stream JSON output to execution_logs                              │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          eve-agent-cli                                  │
│                                                                         │
│  1. resolveCliAdapter(harness)                                          │
│     - Look up CliHarnessAdapter by name                                 │
│                                                                         │
│  2. adapter.buildCommand(ctx)                                           │
│     - Construct binary + args + env                                     │
│     - Map permission policy to harness-specific flags                   │
│                                                                         │
│  3. spawn(binary, args, {cwd: workspace, env})                          │
│     - Run the actual harness CLI                                        │
│     - Normalize output to JSON events                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Workspace Directory Structure

```
$WORKSPACE_ROOT/                     # e.g., /opt/eve/workspaces
└── {attemptId}/                     # Unique per attempt
    └── repo/                        # Cloned/copied repository (required)
        ├── AGENTS.md                # Project memory for agents
        ├── CLAUDE.md                # Claude-specific instructions
        ├── .agents/skills/           # Installed skills (gitignored)
        ├── .claude/skills/          # Symlink or overrides (gitignored)
        └── ...                      # Project files
```

### Directory Resolution

| Variable | Value | Description |
|----------|-------|-------------|
| `workspacePath` | `$WORKSPACE_ROOT/{attemptId}` | Root workspace for attempt |
| `repoPath` | `$workspacePath/repo` | Cloned repository location |
| `cwd` (harness) | `$repoPath` | Working directory for harness execution |

The harness runs with `cwd` set to `repoPath` so it can see project files like AGENTS.md, CLAUDE.md, and other project configuration.

### Environment Contract

All workers provide a standard environment contract for harness execution:

**Standard Paths:**
- `EVE_WORKSPACE_ROOT`: Root directory for all workspaces (e.g., `/opt/eve/workspaces`)
- `EVE_CACHE_ROOT`: Shared cache directory for package managers and build artifacts (e.g., `/opt/eve/cache`)

**Security Context:**
- Processes run as user ID 1000 (non-root)
- Workspace directories are writable by the worker process
- Cache directories are shared across attempts for efficiency

**Volume Mounts:**
- Workspace root is mounted with read-write access
- Cache root is mounted with read-write access
- Credentials and configuration are injected via secrets/config maps

For complete details on the environment contract and worker-specific tooling, see [worker-types.md](./worker-types.md).

### Repository Preparation

The `repoUrl` is required for job execution. The worker prepares the repository based on the URL type:

- **Remote URL** (https://, git://):
  - If `job.git` is provided, the worker uses **GitWorkspace**: shallow clone of the resolved ref, fetch-based checkout, and branch creation if requested.
  - Otherwise, legacy shallow clone (`git clone --depth 1 --branch <project.branch>`).
- **Local URL** (file://): Copy directory with `fs.cp` (branch is ignored). **Dev/test only.**
  - Not supported in k8s runtime.
  - Not supported for push-required workflows unless a remote is configured.

```typescript
// From invoke.service.ts (simplified)
if (!repoUrl) throw new Error('repoUrl is required for job execution');

if (gitConfig) {
  // GitWorkspace: resolve ref, clone, checkout, create branch
  await workspace.init(resolvedRef);
  if (gitConfig.branch) {
    await workspace.createBranch(gitConfig.branch, resolvedRef, createPolicy);
  } else {
    await workspace.checkout(resolvedRef);
  }
} else if (localRepoPath) {
  await fs.cp(localRepoPath, repoPath, { recursive: true });
} else {
  await runGit(['clone', '--depth', '1', '--branch', repoBranch, repoUrl, repoPath]);
}
```

### Git Controls (Current)

If a job has `git` controls, the worker:

- Resolves the ref according to `git.ref_policy` (env release → manifest defaults → project branch).
- Creates or checks out a branch per `git.branch` and `git.create_branch`.
- Applies commit and push policies **after** execution:
  - `commit=auto` runs `git add -A` and commits any uncommitted changes (staged or unstaged), even on failed attempts.
  - `commit=required` fails on success if the working tree is clean (does not auto-commit or check existing commits).
  - `push=on_success` or `push=required` pushes only when the worker created commits in this attempt.
- Stores resolved metadata on the attempt (`job_attempts.git_json`).

See [job-git-controls.md](./job-git-controls.md) for the full specification.

### Disk Management

To prevent workspace growth from exhausting disk:

Operator knobs (suggested env vars):
- `EVE_WORKSPACE_MAX_GB`: total workspace budget per instance
- `EVE_WORKSPACE_MIN_FREE_GB`: hard floor; refuse new claims if below
- `EVE_WORKSPACE_TTL_HOURS`: idle TTL for job worktrees
- `EVE_SESSION_TTL_HOURS`: idle TTL for session workspaces
- `EVE_MIRROR_MAX_GB`: cap for bare mirrors

Policies:
- LRU eviction of worktrees when over budget.
- TTL cleanup for idle job/session worktrees.
- Mirror maintenance via `git fetch --prune` and periodic `git gc --prune=now`.
- Fail-fast on low disk (emit system event; do not start new attempts).

Note: Workspace reuse modes are not yet enforced by the worker; these knobs are for planned implementation.

K8s:
- Per-attempt PVCs are deleted after completion.
- Session-scoped PVCs should have TTL cleanup and storage quotas.

## Usage Events (`llm.call`)

Harnesses emit `llm.call` events after each provider call with usage-only
metadata (token counts, model identifiers, and timing). These events are stored
in `execution_logs` and used to assemble receipts and enforce per-job budgets.
No prompt or response content is included in these events.


## Authentication

### Claude-Based Harnesses (mclaude, claude)

`claude` and `mclaude` use the shared Claude auth selector in `@eve/shared`.
Selection is based on resolved Eve secrets, not arbitrary worker env ordering.

#### Authentication Priority

1. **Scope specificity wins first:** `project` > `org` > `user` > `system`/unknown.
   A project `CLAUDE_CODE_OAUTH_TOKEN` setup-token beats an org `ANTHROPIC_API_KEY`.
2. **Within the same scope, API key wins:** `ANTHROPIC_API_KEY` is selected over
   `CLAUDE_CODE_OAUTH_TOKEN` only when both are at the same scope.
3. Empty/whitespace values are ignored.

#### Setup-Token Materialization

Long-lived Claude setup-tokens are stored as `CLAUDE_CODE_OAUTH_TOKEN` secrets
with the `sk-ant-oat01-` prefix. At runtime, Eve writes them to:

```text
$EVE_JOB_USER_HOME/.claude-runtime/<claude|mclaude>/<variant-or-default>/.credentials.json
```

The runtime config is attempt-scoped and outside `repoPath`. Non-secret config is
copied from the repo harness config, but `.credentials.json` and `credentials.json`
are never copied from the repo and are never written under `.agent/harnesses/*`.

Short-lived OAuth tokens are passed as `CLAUDE_CODE_OAUTH_TOKEN` env vars and
emit a warning. API keys are passed as `ANTHROPIC_API_KEY`.

#### Final Auth Env Scrub

After per-job `env_overrides` are applied, Claude auth vars are scrubbed again:

- setup-token: removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, and `CLAUDE_OAUTH_EXPIRES_AT` from the final harness env
  because auth is file-backed.
- OAuth token: removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.
- API key: removes `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_OAUTH_EXPIRES_AT`, and
  `ANTHROPIC_AUTH_TOKEN`.

This scrub happens in both agent-runtime and the worker fallback path.

#### Diagnostics

Each Claude attempt logs `claude_auth_selected` with redacted metadata:
selected key, scope, token class, token length/fingerprint, runtime config dir,
credentials materialization status, scrubbed keys, and whether `ANTHROPIC_BASE_URL`
was set. Token bytes are not logged.

If Claude Code reports `apiKeySource: "none"` or emits 401/invalid credential
text, Eve logs `claude_auth_failed` once and sends a provisioning error to the
job coordination thread. The error names the selected key/scope/class and points
operators at `eve auth verify`.

#### Verification

Use the managed probe command to exercise the real job path:

```bash
eve auth verify --harness claude --project <project-id> --json
```

Expected success includes:

```json
{"ok":true,"secret_key":"CLAUDE_CODE_OAUTH_TOKEN","scope_type":"project","token_class":"setup-token","apiKeySource":"...","model_replied":true}
```

### Zai Harness

Requires `Z_AI_API_KEY` environment variable. The worker adapter maps this to `ANTHROPIC_API_KEY` when spawning the zai process (cc-mirror reads `ANTHROPIC_API_KEY` at runtime).

`ANTHROPIC_BASE_URL` precedence for zai adapter:
1. `ANTHROPIC_BASE_URL` (if explicitly set by routing/policy)
2. `Z_AI_BASE_URL` (fallback)

**Important**: The Docker image creates the zai cc-mirror variant with a placeholder API key, then strips `ANTHROPIC_API_KEY` from settings.json. This is necessary because:
1. cc-mirror requires an API key to create the variant
2. The cc-mirror wrapper script unconditionally exports settings.json env vars, which would overwrite runtime values
3. By stripping the key from settings.json, the runtime `ANTHROPIC_API_KEY` (mapped from `Z_AI_API_KEY`) takes precedence

### Gemini Harness

Uses `GEMINI_API_KEY` or `GOOGLE_API_KEY` from environment. No special credential setup required.

### Code/Codex Harnesses

Use OpenAI OAuth credentials written by entrypoint:

```bash
# docker/worker/entrypoint.sh
write_codex_credentials() {
  # Write to ~/.code/auth.json (Every Code CLI)
  # Write to ~/.codex/auth.json (OpenAI Codex CLI)
}
```

**Credentials file format:**
```json
{
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "id_token": "...",
    "account_id": "..."
  }
}
```

## Token Lifecycle Management

### Claude Tokens

Claude setup-tokens (`sk-ant-oat01-*`) are long-lived and preferred for managed
jobs. Eve materializes them into an attempt-scoped Claude `.credentials.json`
outside `repoPath`. Other `sk-ant-*` Claude tokens are treated as short-lived
OAuth tokens and are passed through as `CLAUDE_CODE_OAUTH_TOKEN`.

**Token types detected by `eve auth creds` and `eve auth sync`:**

| Token prefix | Type | Lifetime |
|---|---|---|
| `sk-ant-oat01-` | `setup-token` | Long-lived (preferred) |
| Other `sk-ant-*` | `oauth` | ~15h (short-lived) |

`eve auth sync` emits a warning (and includes `warnings` in `--json` output) when syncing a short-lived
OAuth token (i.e., any Claude token that does NOT start with `sk-ant-oat01-`), reminding you to use a
setup-token for long-running jobs.

Run `eve auth verify --harness claude --project <id> --json` after syncing to
prove the selected secret works through the managed runtime path.

### Codex/Code OAuth Tokens

Codex and Code CLI (`@openai/codex`, `@just-every/code`) store OAuth tokens in `auth.json` under
`~/.codex/` or `~/.code/` respectively. The CLI may refresh these tokens automatically during a session.

**Write-back flow (worker and agent-runtime):**

1. Before invocation: the worker captures the base64-encoded `auth.json` and its originating secret scope.
2. After invocation: the worker reads `auth.json` from disk (picks the freshest across `~/.code` and `~/.codex`).
3. If the base64 differs from the original (token was refreshed), the new value is written back to the originating secret via `PATCH /internal/secrets/:scope_type/:scope_id/CODEX_AUTH_JSON_B64`.
4. Write-back failures are non-fatal (logged as `warn`).

This ensures tokens stay fresh without manual re-sync between jobs.


Current bridge registry includes:
- `litellm-anthropic-openai` (`anthropic` -> `openai`)

Runtime config (worker env, typically from system secrets):
- `EVE_BRIDGE_LITELLM_ANTHROPIC_OPENAI_URL`
- `EVE_BRIDGE_LITELLM_ANTHROPIC_OPENAI_KEY`

For bridge routes, the harness receives bridge URL/key (not upstream provider key), while
`EVE_LLM_PROVIDER` remains the upstream provider for receipts/diagnostics.

## Per-Harness Configuration

### Harness Config Root

Harness configuration is read from a single root directory with per-harness
subfolders. The default is in-repo, and deployments can override via env.

```
.agent/harnesses/
  <harness>/
    config.toml|json|yaml
    variants/
      <variant>/
        config.toml|json|yaml
```

Resolution:

- `EVE_HARNESS_CONFIG_ROOT` (if set) → `<root>/<harness>`
- otherwise → `<repo>/.agent/harnesses/<harness>`

If a `variants/<variant>` directory exists, it is used as an overlay on the
base config directory.

### mclaude

| Property | Value |
|----------|-------|
| Binary | `mclaude` (cc-mirror variant) |
| Config Dir | `<harness config root>/mclaude` or `$CLAUDE_CONFIG_DIR` |
| Auth | OAuth credentials file + env vars |
| Model | `$CLAUDE_MODEL` or `sonnet`; Opus 4.7 forms (`opus4.7`, `opus-4-7`, `claude-opus-4-7`) are normalized to Claude Code's `opus` alias |
| Skills | Installed from `skills.txt` into `.agents/skills/` at runtime |

**CLI Args:**
```
mclaude --print --verbose --output-format stream-json \
  --model opus \
  --permission-mode default \
  "<prompt>"
```

### claude

| Property | Value |
|----------|-------|
| Binary | `claude` (@anthropic-ai/claude-code) |
| Config Dir | `<harness config root>/claude` or `$CLAUDE_CONFIG_DIR` |
| Auth | OAuth credentials file + env vars |
| Model | `$CLAUDE_MODEL` or `sonnet`; Opus 4.7 forms (`opus4.7`, `opus-4-7`, `claude-opus-4-7`) are normalized to Claude Code's `opus` alias |
| Skills | Not synced (official CLI has its own skill system) |

**CLI Args:**
```
claude --print --verbose --output-format stream-json \
  --model opus \
  --permission-mode default \
  "<prompt>"
```

### zai

| Property | Value |
|----------|-------|
| Binary | `zai` (cc-mirror variant) |
| Config Dir | `<harness config root>/zai` or `$CLAUDE_CONFIG_DIR` |
| Auth | `Z_AI_API_KEY` required |
| Model | `$ZAI_MODEL` or `$CLAUDE_MODEL` |

**CLI Args:**
```
zai --print --verbose --output-format stream-json \
  --model <model> \
  --permission-mode default \
  "<prompt>"
```

### gemini

| Property | Value |
|----------|-------|
| Binary | `gemini` (@google/gemini-cli) |
| Auth | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |

**CLI Args:**
```
gemini --output-format stream-json \
  --model <model> \
  --approval-mode default \
  "<prompt>"
```

**Note:** Gemini uses `--approval-mode` instead of `--permission-mode`.

### code / coder

| Property | Value |
|----------|-------|
| Binary | `code` or `coder` (@just-every/code) |
| Config Dir | `<harness config root>/code` or `$CODEX_HOME` |
| Auth | `auth.json` in config dir (from CODEX_AUTH_JSON_B64 or CODEX_OAUTH_* vars) |

**CLI Args:**
```
code --ask-for-approval on-request \
  --model <model> \
  --profile <variant> \
  exec --json --skip-git-repo-check \
  "<prompt>"
```

### codex

| Property | Value |
|----------|-------|
| Binary | `codex` (@openai/codex) |
| Config Dir | `<harness config root>/codex` or `$CODEX_HOME` |
| Auth | `auth.json` in config dir (from CODEX_AUTH_JSON_B64 or CODEX_OAUTH_* vars) |

**Token write-back:** After each invocation, Eve reads the `auth.json` that Codex/Code may have refreshed
during the session. If the token changed, Eve automatically writes it back to the originating secret scope
(user/org/project) via the internal secret update endpoint. This keeps the stored token fresh across jobs.
If the write-back fails (e.g., network error), a warning is logged but the job result is not affected.

To initially register tokens, re-auth with the CLI (`codex auth` / `code auth`), then run `eve auth sync`.

**CLI Args:**
```
codex --ask-for-approval on-request \
  --model <model> \
  -c 'model_reasoning_effort="<reasoning>"' \
  --profile <variant> \
  exec --json --skip-git-repo-check \
  "<prompt>"
```

## Permission Policies

Each harness maps the abstract permission policy to harness-specific flags:

| Policy | mclaude/claude/zai | gemini | code/codex |
|--------|-------------------|--------|------------|
| `default` | `--permission-mode default` | `--approval-mode default` | `--ask-for-approval on-request` |
| `auto_edit` | `--permission-mode acceptEdits` | `--approval-mode auto_edit` | `--ask-for-approval on-failure` |
| `never` | `--permission-mode dontAsk` | (fallback to default) | `--ask-for-approval never` |
| `yolo` | `--dangerously-skip-permissions` | `--yolo` | `--ask-for-approval never` |

## eve-agent-cli Arguments

The worker invokes eve-agent-cli with these arguments:

```
eve-agent-cli \
  --harness <harness>       # mclaude, claude, zai, gemini, code, codex
  --permission <policy>     # default, auto_edit, never, yolo
  --output-format stream-json
  --workspace <workspacePath>
  --prompt "<text>"         # Job description passed through as the prompt
  [--variant <variant>]     # Optional harness variant
  [--model <model>]         # Optional model override
```

## Environment Variables Reference

### Claude Auth

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude setup-token or OAuth token secret. Setup-tokens are materialized to attempt HOME and scrubbed from final env. |
| `CLAUDE_OAUTH_EXPIRES_AT` | Optional OAuth token expiry metadata |
| `ANTHROPIC_API_KEY` | Claude API key. Wins only within the same secret scope. |
| `ANTHROPIC_AUTH_TOKEN` | Scrubbed from Claude final env when OAuth/setup-token/API-key selection would conflict |

### Harness Configuration

| Variable | Description |
|----------|-------------|
| `EVE_HARNESS_CONFIG_ROOT` | Root folder for harness configs (overrides repo .agent/harnesses) |
| `CLAUDE_CONFIG_DIR` | Config directory for Claude-based harnesses |
| `CLAUDE_MODEL` | Default model for Claude harnesses |
| `ZAI_MODEL` | Model override for zai harness |
| `Z_AI_API_KEY` | API key for zai harness |
| `GEMINI_API_KEY` | API key for Gemini |
| `GOOGLE_API_KEY` | Alternative API key for Gemini |

### Code/Codex OAuth

| Variable | Description |
|----------|-------------|
| `CODEX_AUTH_JSON_B64` | Base64-encoded auth.json |
| `CODEX_OAUTH_ACCESS_TOKEN` | OAuth access token |
| `CODEX_OAUTH_REFRESH_TOKEN` | OAuth refresh token |
| `CODEX_OAUTH_ID_TOKEN` | OAuth ID token |
| `CODEX_OAUTH_ACCOUNT_ID` | Account ID |
| `CODEX_HOME` | Config directory for Code/Codex |

### Worker Configuration

| Variable | Description |
|----------|-------------|
| `WORKSPACE_ROOT` | Root directory for workspaces |
| `EVE_AGENT_CLI_PATH` | Override path to eve-agent-cli |

## Execution Logging

All harness output is logged to the `execution_logs` table:

| Type | Description |
|------|-------------|
| `event` | Normalized harness event (assistant, tool_use, tool_result, etc.) |
| `system` | System events (init, completed) |
| `system_error` | Stderr output |
| `parse_error` | Failed to parse JSON line |
| `spawn_error` | Failed to spawn harness process |
| `claude_auth_selected` | Redacted Claude auth selection/materialization diagnostic |
| `claude_auth_failed` | Structured Claude auth failure with selected key/scope/class |

## Docker Entrypoint Responsibilities

The worker container entrypoint (`docker/worker/entrypoint.sh`) runs before the worker process:

1. **Create workspace directory** with proper permissions
2. **Install cc-mirror variants** (mclaude, zai) if not present
3. **Report Claude auth availability** from env/file fallback (job credentials are materialized per attempt)
4. **Write Codex credentials** to harness config dir (local dev only)
5. **Set environment aliases** (Z_AI_API_KEY from ZAI_API_KEY)

This ensures credentials files exist before any job attempts to use them.

## Adding a New BYOK Model

1. **Rate card** — `packages/shared/src/pricing/default-rate-card.ts`:
   add entry under `llm.byok.<provider>.<model-id>`, update effective date.
2. **Model examples** — `packages/shared/src/harnesses/capabilities.ts`:
   update `model_examples` for the relevant harness (recommended default first).
3. **Env example** — `.env.example`: update the suggested model if it's the new default.
4. **Model normalization** — `packages/shared/src/pricing/model-normalization.ts`:
   add rules if provider uses non-standard suffixes.
