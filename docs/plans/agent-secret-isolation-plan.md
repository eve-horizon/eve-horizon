# Agent Secret Isolation Plan

> Status: Draft
> Last Updated: 2026-02-05
> Supersedes: `agent-harness-tool-home-auth-plan.md`, `agent-harness-secret-hardening.md` (ideas)
> Purpose: Remove secrets from agent-reachable space via three defense layers: sanitized env, scoped provisioning, and LLM security policy.

## Dependencies

- `apps/worker/src/invoke/invoke.service.ts`
- `apps/worker/src/invoke/k8s-runner.ts`
- `packages/eve-agent-cli/src/index.ts`
- `packages/eve-agent-cli/src/harnesses/*`
- `packages/shared/src/harnesses/config.ts`
- `apps/orchestrator/src/loop/loop.service.ts`

## Goals

- **Least-privilege secrets**: agent jobs receive only the secrets they explicitly need, not everything.
- **No secrets in workspace files**: stop writing `.eve/secrets.env` and `.eve/secrets/` into the repo sandbox.
- **Sanitized process env**: strip worker-internal secrets (`DATABASE_URL`, `EVE_SECRETS_MASTER_KEY`, etc.) before launching the harness.
- **Cross-harness security instructions**: inject LLM-level policy that discourages secret access, regardless of harness type.
- **Capability declaration**: manifests/agents declare which tool capabilities a job needs; only those secrets are provisioned.
- **Standard tool auth**: tools (`gh`, `git`, `eve`) use their own config-file mechanisms under a per-job `$HOME`; no command proxying through the Eve CLI.

## Non-Goals

- Full LLM proxy (Phase 3 — separate plan when needed).
- Changing how deployed apps receive runtime secrets (K8s Secrets / manifest interpolation is fine).
- Replacing harnesses or changing LLM providers.
- Adding command-proxy wrappers to the Eve CLI (tools use their own auth).

---

## Current Attack Surface

Traced through the actual code paths:

### 1. Process env firehose

Three layers each spread the full `process.env`:

| Layer | File | Line | What happens |
|-------|------|------|-------------|
| Worker → eve-agent-cli | `invoke.service.ts` | ~1575 | `{ ...process.env, ...options.env }` |
| eve-agent-cli → adapter | `index.ts` | 225 | `{ ...process.env, EVE_HARNESS_NAME: harness }` |
| Adapter → harness binary | `claude.ts` | 9 | `{ ...ctx.env }` |

Result: `DATABASE_URL`, `EVE_SECRETS_MASTER_KEY`, `EVE_INTERNAL_API_KEY`, and every worker-level secret reaches the LLM process. The agent can read them via `env` or `echo $VAR` in bash.

### 2. Secrets written inside the sandbox

`invoke.service.ts:materializeSecrets()` (line 829–879):
- Writes **all** resolved project secrets as env vars
- Writes file/ssh_key secrets to `.eve/secrets/` **inside the repo**
- Writes all secrets to `.eve/secrets.env` **inside the repo**
- Both paths are within the `--add-dir` sandbox — the agent can `cat .eve/secrets.env`

### 3. K8s runner pod env

`k8s-runner.ts` (lines 220–227) pushes all LLM API keys into the pod spec:
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON_B64`, `OPENAI_API_KEY`, `Z_AI_API_KEY`, `GEMINI_API_KEY`
Plus `DATABASE_URL`, `EVE_INTERNAL_API_KEY`, `EVE_SECRETS_MASTER_KEY`.

### 4. Sandbox limitations

`--add-dir` and `--sandbox workspace-write` restrict the LLM's **file tools** (Read, Write, Edit, Glob) but NOT:
- Bash commands that read files or env (`cat ~/.config/gh/hosts.yml`, `env`)
- Network egress (exfiltration)

---

## Design: Three Defense Layers

```
Layer 1: Nothing to find    — env is clean, secrets aren't in reachable files
Layer 2: Can't look (tools) — file tools restricted by --add-dir / --sandbox
Layer 3: Won't look (LLM)   — security policy in system prompt + prompt preamble
```

Any one layer failing is caught by the other two.

### Layer 1: Sanitized Env + Scoped Provisioning

**Allowlisted env.** Instead of `{ ...process.env }`, build a minimal env:

```typescript
const processEnv = {
  PATH: pathEnv,
  HOME: jobUserHome,
  TERM: process.env.TERM,
  LANG: process.env.LANG,
  // Only harness-specific env from adapter (e.g., ANTHROPIC_API_KEY):
  ...options.env,
  // Non-secret job metadata:
  EVE_JOB_ID, EVE_ATTEMPT_ID, EVE_PROJECT_ID, EVE_REPO_PATH,
};
```

**No secrets in workspace.** Stop writing `.eve/secrets.env` and `.eve/secrets/` into the repo for agent jobs. Hooks that need secrets (e.g., `on-clone.sh` for `npm install --registry`) run in the worker process context where secrets are already available — before the harness launches.

**Capability-scoped secrets.** Only resolve and inject secrets that the job declares it needs (see Capability Declaration below).

### Layer 2: Per-Job HOME + File-Tool Sandbox

**Per-job HOME** outside the workspace:

```
/var/lib/eve/agent-homes/<attempt_id>/
  home/                          # HOME for harness (EVE_JOB_USER_HOME)
    .config/gh/hosts.yml         # gh auth (if github capability declared)
    .config/eve/credentials.json # eve CLI auth (if eve-api capability declared)
    .claude/.credentials.json    # Claude auth (written by worker)
    .cc-mirror/zai/config/...    # zai auth via cc-mirror (written by worker)
    .code/auth.json              # Code/Codex auth (written by worker)
    .agent/harnesses/...         # Non-secret harness config (CLAUDE.md, settings)
```

`HOME` is set to the job home. LLM API auth is written here as config files rather than env vars where possible.

**File-tool sandbox** already restricts LLM file tools to workspace via `--add-dir` / `--sandbox workspace-write`. Agent's file tools can't read `$HOME/.config/gh/hosts.yml`. The Bash tool can (see Layer 3).

### Layer 3: LLM Security Policy

Cross-harness security instructions injected via **two paths**:

**Path A: Prompt preamble** (harness-agnostic). Prepend to `invocation.text` in the worker before launching eve-agent-cli:

```xml
<eve-security-policy>
You are running in an Eve job sandbox. These rules are MANDATORY:
- ONLY access files within your workspace: ${WORKSPACE_PATH}
- NEVER use bash to read files outside your workspace
  (no cat/ls/head targeting ~/, ~/.config/, /etc/, /var/, or any path outside workspace)
- NEVER run env, printenv, set, or echo $VAR to inspect environment variables
- NEVER include API keys, tokens, passwords, or credentials in your output
- If a CLI tool needs auth, it is pre-configured — do not search for credential files
</eve-security-policy>
```

Works for every harness since they all receive the prompt via `--prompt`.

**Path B: Harness config files** (system-prompt tier). Write security instructions into each harness's native config mechanism:

| Harness | Config mechanism | What we write |
|---------|-----------------|---------------|
| claude/mclaude/zai | `CLAUDE_CONFIG_DIR/CLAUDE.md` | Security policy section |
| code/codex | `CODEX_HOME/AGENTS.md` or instructions file | Security policy section |
| gemini | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` or prompt | Security policy section |

This gets system-prompt-tier weighting for harnesses that support it.

**Policy text lives in `@eve/shared`** as a single constant/template function, reusable across worker and agent-runtime.

### Honest Security Assessment

| Threat | Layer 1 | Layer 2 | Layer 3 | Net |
|--------|---------|---------|---------|-----|
| Agent reads env for secrets | Blocked (env clean) | — | Reinforced | **Strong** |
| Agent reads `.eve/secrets.env` | Blocked (not written) | — | Reinforced | **Strong** |
| Agent reads `~/.config/gh/hosts.yml` via bash | Present but scoped | File tools blocked | Discouraged | **Medium** |
| Naive prompt injection ("print your env") | Nothing to find | — | Blocked | **Strong** |
| Sophisticated prompt injection | Nothing to find | File tools blocked | May bypass | **Medium** |
| Malicious code in repo hooks/scripts | N/A (runs pre-harness) | N/A | N/A | **Out of scope** |
| Accidental secret leak in logs | Reduced (fewer secrets) | — | Discouraged | **Medium** |

The remaining gap (bash reading config files under `$HOME`) is addressed in Phase 3 via UID isolation or sidecar auth.

---

## Capability Declaration

Jobs declare what tool capabilities they need. Only declared capabilities are provisioned.

### Declaration in manifest or agents.yaml

```yaml
# In agents.yaml
agents:
  my-agent:
    harness: zai
    tools:
      github: true          # provisions ~/.config/gh/hosts.yml from GITHUB_TOKEN
      eve-api: true          # provisions ~/.config/eve/credentials.json from EVE_API_TOKEN
      npm-registry: true     # provisions ~/.npmrc from NPM_TOKEN

# Or in manifest x-eve section for pipeline/workflow jobs
x-eve:
  defaults:
    tools:
      github: true
```

### Tool capability provisioners

Each capability is a small function that knows:
- Which secret key(s) to resolve (e.g., `GITHUB_TOKEN`)
- Where to write the config file (e.g., `$HOME/.config/gh/hosts.yml`)
- The file format the tool expects

```typescript
// packages/shared/src/harnesses/tool-provisioners.ts

type ToolProvisioner = {
  secretKeys: string[];
  provision: (home: string, secrets: Record<string, string>) => Promise<void>;
};

const TOOL_PROVISIONERS: Record<string, ToolProvisioner> = {
  github: {
    secretKeys: ['GITHUB_TOKEN'],
    provision: async (home, secrets) => {
      // Write ~/.config/gh/hosts.yml
      const ghDir = path.join(home, '.config', 'gh');
      await fs.mkdir(ghDir, { recursive: true });
      await fs.writeFile(path.join(ghDir, 'hosts.yml'), yaml.stringify({
        'github.com': { oauth_token: secrets.GITHUB_TOKEN, user: '', git_protocol: 'https' }
      }), { mode: 0o600 });
    },
  },
  'eve-api': {
    secretKeys: ['EVE_API_TOKEN'],
    provision: async (home, secrets) => {
      // Write ~/.config/eve/credentials.json
      const eveDir = path.join(home, '.config', 'eve');
      await fs.mkdir(eveDir, { recursive: true });
      await fs.writeFile(path.join(eveDir, 'credentials.json'), JSON.stringify({
        token: secrets.EVE_API_TOKEN,
      }), { mode: 0o600 });
    },
  },
  // ... npm-registry, etc.
};
```

### Env-var tools (no config-file support)

For tools that genuinely need env vars, the declaration specifies which vars:

```yaml
tools:
  custom-tool:
    env: [CUSTOM_API_KEY]   # only this var gets through to the harness env
```

The worker resolves `CUSTOM_API_KEY` from project/org secrets and adds it to the allowlisted env. Nothing else leaks.

### Default capabilities

If no tools are declared, the job gets **only LLM auth** (the harness API key). No GitHub, no Eve API, no npm — just the ability to run the LLM and use workspace-local tools.

---

## Implementation Plan

### Phase 1: Sanitize Env + Stop Writing Secrets to Workspace

**Biggest immediate win. No manifest changes needed.**

1. **Allowlisted env in `invoke.service.ts:executeEveAgentCli`** — replace `{ ...process.env, ...options.env }` with a minimal allowlist. Keep `PATH`, `HOME`, `TERM`, `LANG`, plus adapter-provided env.

2. **Allowlisted env in `eve-agent-cli/index.ts`** — replace `{ ...process.env }` with a minimal passthrough. The eve-agent-cli should forward only what it receives, not re-spread `process.env`.

3. **Stop writing `.eve/secrets.env`** — in `materializeSecrets()`, skip writing the secrets file for agent jobs. Hooks already run before the harness in the worker context where secrets are available.

4. **Stop writing `.eve/secrets/`** — same: don't write file-type secrets into the repo sandbox.

5. **Allowlisted env in `k8s-runner.ts`** — only push LLM API keys and `EVE_API_URL`/`EVE_INTERNAL_API_KEY` (for runner → API communication) into the pod env. Remove `DATABASE_URL` and `EVE_SECRETS_MASTER_KEY` from the runner pod (the runner uses its own DB connection, not the worker's).

6. **Add security prompt preamble** — in `invoke.service.ts:executeEveAgentCli`, prepend the security policy text to `invocation.text`. Policy text defined in `@eve/shared`.

### Phase 2: Per-Job HOME + Capability Provisioning

1. **Create per-job home directory** — `invoke.service.ts` creates `/var/lib/eve/agent-homes/<attempt_id>/home/` with `0700` perms. Set `HOME` and `EVE_JOB_USER_HOME` in the allowlisted env.

2. **Move LLM auth to config files** — instead of passing `ANTHROPIC_API_KEY` / `Z_AI_API_KEY` as env vars, write them into the appropriate config file under the job home:
   - mclaude/zai: `$HOME/.cc-mirror/<variant>/config/.credentials.json` via cc-mirror `quick` command, or direct file write
   - code/codex: `$HOME/.code/auth.json` or `$HOME/.codex/auth.json`
   - gemini: env var (no file-based auth available — keep in env for now)

3. **Tool capability provisioners** — implement the provisioner registry in `@eve/shared`. Worker calls provisioners based on declared capabilities, writing config files into the job home.

4. **Capability declaration schema** — add `tools` field to agents.yaml and manifest `x-eve.defaults`. Worker reads and provisions accordingly.

5. **Harness config security files** — write security policy into each harness's config mechanism (CLAUDE.md for Claude-family, equivalent for Code-family). Written by the worker when creating the harness config dir.

6. **Cleanup** — per-job home directory cleaned up after attempt completion (alongside workspace cleanup).

### Phase 3: Hard Isolation (Future)

1. **LLM proxy** — internal service holds provider API keys, issues short-lived job tokens. Removes API keys from agent env/files entirely.

2. **K8s UID separation** — mount auth config as a volume owned by a different UID. Harness reads auth at startup, agent process can't access the files even via bash.

3. **Network policies** — egress allowlists for agent pods to reduce exfiltration risk.

4. **Log redaction** — server-side redaction of known secret values before storage/streaming.

---

## Tests

### Phase 1

- **Unit**: verify `executeEveAgentCli` env does not contain `DATABASE_URL`, `EVE_SECRETS_MASTER_KEY`, `EVE_INTERNAL_API_KEY`.
- **Unit**: verify `materializeSecrets` does not write `.eve/secrets.env` or `.eve/secrets/` for agent jobs.
- **Integration**: run agent job, confirm harness succeeds with sanitized env.
- **Integration**: verify hooks still receive secrets (they run pre-harness in worker context).
- **Manual**: run manual test scenarios 01-04, confirm all pass with sanitized env.

### Phase 2

- **Unit**: tool provisioner writes correct config file format for each tool.
- **Unit**: harness config dir includes security policy CLAUDE.md.
- **Integration**: agent job with `tools.github: true` can use `gh` with provisioned auth.
- **Integration**: agent job without `tools.github` cannot use `gh` (no auth available).
- **Security**: agent file tools cannot read `$HOME/.config/gh/hosts.yml` (outside sandbox).

---

## Migration / Backwards Compatibility

- **Phase 1 is additive** — existing jobs work because harness adapters already return the specific env vars they need. We're just stopping the extras from leaking through.
- **Phase 2 needs capability declarations** — jobs without declarations get default behavior (LLM auth only). Existing agent configs in `agents.yaml` would need `tools:` added if they use `gh`, `git push`, or `eve` CLI.
- **No changes to hooks** — hooks run before the harness in the worker context, so they still have full access to secrets. This is intentional (hooks are developer-authored, not LLM-controlled).

## Open Questions

- Should we allow an escape hatch (`tools: all`) for dev/testing that provisions everything? Probably yes for local dev, no for production.
- How do we handle secrets needed by code in the repo at runtime (e.g., an API key the code under test needs)? This is a different concern from agent tool auth — probably a separate `runtime_env` declaration.
- Should the security policy prompt preamble be configurable per-org/project, or always the same system-wide?
- For gemini: no file-based auth mechanism exists. Keep API key in env until gemini supports config-file auth or we build the LLM proxy.
