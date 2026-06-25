# Claude Code Setup-Token Auth Durability Plan

> **Status**: Implemented and locally verified
> **Date**: 2026-06-04
> **Source**: External gap report (via Codex) — "Claude Code setup-token auth should be durable across managed agent jobs"
> **Motivation**: A manifest workflow uses the `claude` harness as its primary long-running agent. The project has no provider API key and relies on a project-scoped `CLAUDE_CODE_OAUTH_TOKEN` holding a long-lived `sk-ant-oat01-…` setup-token. `eve auth creds` reports a `setup-token` class locally; `eve auth sync --claude --project …` writes the secret; `eve secrets validate` reports no missing key. Yet the **managed** Claude Code agent step fails immediately with `401 Invalid authentication credentials`. The operator can prove "setup-token exists locally" and "project secret exists remotely" but **cannot prove why the managed job sees invalid or absent credentials**.
> **Scope**: The Claude-family managed credential path only — `packages/shared/src/invoke/`, `apps/agent-runtime/src/invoke/invoke.service.ts`, `packages/shared/src/harnesses/adapters/{claude,mclaude}.ts`, `packages/cli/src/commands/auth.ts`. **Out of scope**: workflow logic, Cloud FS, workspace clone, application secrets, and non-Claude harnesses (the failing step reached harness startup).

> **Review fixes applied 2026-06-04**: keep Claude credential files out of the workspace, scrub the final harness env **after** `env_overrides`, update the worker fallback path where all resolved secrets are forwarded, and add a mandatory local k3d verification loop before tagging.
>
> **Implementation note 2026-06-04**: `eve auth verify` is implemented as an ephemeral managed job that exercises the normal agent-runtime materialization/spawn path. The job carries `auth_probe: true` and `skip_workspace_skills: true` hints so auth verification is not blocked by optional workspace skill packs; ordinary jobs still materialize workspace skills normally.

---

## TL;DR

| Gap | Today | After |
| --- | --- | --- |
| **A. Silent precedence hijack** | `resolveMclaudeAuth` picks **any** `ANTHROPIC_API_KEY` secret at **any** scope over the project OAuth token (`invoke.service.ts:1012`). A forgotten org/user `ANTHROPIC_API_KEY` (or an empty/stale one) defeats the intended project setup-token with zero signal — and in `claude -p` an API key "is always used when present", so it 401s before the OAuth token is ever tried. | A shared, scope-aware `selectClaudeAuth()` returns an explicit decision. Within a scope, API key wins (matches Claude's own precedence); across scopes, the **more specific scope wins**, so a project setup-token beats a broader-scope API key. When the OAuth token is selected, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are **scrubbed** from the harness env so they cannot hijack precedence. Empty/whitespace token values are treated as absent. |
| **B. Env-only fragility / `--bare`** | The token reaches Claude only as `CLAUDE_CODE_OAUTH_TOKEN`. No credentials file is ever materialized (`createJobUserHome` makes an empty `.claude/`; `writeEveCredentials` writes only the Eve token). `--bare` mode ignores `CLAUDE_CODE_OAUTH_TOKEN`, and Anthropic has stated `--bare` will become the `-p` default. | For **setup-tokens only** (`sk-ant-oat01-…`), prepare a **per-attempt runtime `CLAUDE_CONFIG_DIR` outside the repo** and materialize `.credentials.json` there (mode `0600`). Never write token files into the repo-backed config dir (`.agent/harnesses/claude`), because git policies could commit them. Setup-tokens are self-contained (~1 yr, no refresh), so a materialized file does **not** suffer the stale-copied-creds failure that kills short-lived OAuth tokens. Env var retained for current `-p`; safe config file covers the `--bare` default flip. |
| **C. No proof of what reached the harness** | Nothing records which auth source/scope/class was selected. The "credentials write" lifecycle event refers to the **Eve** token, not Claude auth. | A redacted pre-launch lifecycle diagnostic records `{ auth_source, secret_key, secret_scope, token_class, materialized_file, runtime_config_dir, source_config_dir, home }` plus token length/fingerprint only — never token bytes or token prefixes. "Which token class/scope reached the harness" becomes provable from `eve job logs`. |
| **D. Opaque 401** | A 401 / `apiKeySource: none` from Claude Code is logged as an ordinary harness error. The operator cannot distinguish missing-secret / short-lived / invalid-setup-token / platform-didn't-materialize. | The stream-json reader inspects Claude Code's own `system/init.apiKeySource` and watches for `401` / `Invalid authentication credentials` / `OAuth token has expired`. On failure while a token **was** selected, it emits a structured provisioning error naming the **selected secret key + scope + class** and the probable cause. |
| **E. Validation only proves existence** | `eve secrets validate` confirms the key is present; `eve auth creds` only checks the `sk-ant-oat01-` prefix. Neither exercises the token, so a revoked/typo'd setup-token passes both and 401s at runtime. | `eve auth verify --harness claude --project <id>` runs the **real** server-side materialization path (same `selectClaudeAuth` + materialize + spawn as a job), invokes `claude -p` for a known string, and asserts `apiKeySource != none`. Returns a structured verdict; an invalid token fails fast naming the key + scope. |

Net effect: Claude Code becomes usable as the primary long-running workflow harness with project-scoped setup-tokens and no per-job intervention, **and** every auth failure becomes actionable.

---

## Background — the verified launch path

Tracing a managed `claude` job end to end (confirmed by reading the code):

1. **Token extraction.** `resolveOAuthTokens(resolvedSecrets)` finds the `CLAUDE_CODE_OAUTH_TOKEN` secret and returns `{ accessToken }` — **dropping scope and token class** (`apps/agent-runtime/src/invoke/invoke.service.ts:128-136`).
2. **Auth helper.** `helpers.resolveMclaudeAuth` (`invoke.service.ts:1009-1021`): if **any** `ANTHROPIC_API_KEY` secret resolves it sets `ANTHROPIC_API_KEY`; **else** it sets `CLAUDE_CODE_OAUTH_TOKEN`. It `mkdir`s the config dir but **writes no credentials file**.
3. **Adapter.** `claude.ts` / `mclaude.ts` (`packages/shared/src/harnesses/adapters/`) call `resolveMclaudeAuth({ configDir })` and return `{ env: { ...auth.env, ANTHROPIC_BASE_URL, CLAUDE_CONFIG_DIR } }`. `claude` and `mclaude` are auth-identical. Today `resolveClaudeConfigDir()` defaults to `repoPath/.agent/harnesses/claude`, so any credential-file materialization must first switch to a per-attempt runtime config dir outside `repoPath`.
4. **Per-job HOME.** `createJobUserHome(attemptId)` (`packages/shared/src/invoke/job-user-home.ts`) creates `/tmp/eve/agent-homes/<attemptId>/home/` with an **empty** `.claude/` — nothing copied or symlinked.
5. **Eve credentials.** `writeEveCredentials()` (`packages/shared/src/invoke/eve-credentials.ts`) writes `~/.eve/credentials.json` (the **Eve API job token**, not Claude auth). This is the "credentials write" lifecycle event at `invoke.service.ts:1191-1199`.
6. **Sanitized env.** `buildSanitizedHarnessEnv()` (`packages/shared/src/harnesses/env-builder.ts:60-121`) is an **allowlist** — host `process.env` secrets do not pass; only adapter-provided vars (incl. `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`) and `EVE_HARNESS_*`/`EVE_WORKER_*` prefixed vars are forwarded. `HOME = jobUserHome`. The worker fallback path differs: it starts `harnessEnv` from `secretsContext.env`, so all resolved secrets are present unless the final env scrub removes the losing Claude keys.
7. **Spawn.** `eve-agent-cli --harness claude --permission … --output-format stream-json --workspace … --prompt …` (`invoke.service.ts:1322`), which in turn spawns `claude --print --verbose --output-format stream-json --add-dir <ws> [--model …] --dangerously-skip-permissions <prompt>` (`packages/eve-agent-cli/src/harnesses/claude.ts:4,17-44`). **Note: `--print` (`-p`), not `--bare`** — so `CLAUDE_CODE_OAUTH_TOKEN` is honored *today*.
8. **Auth check.** The harness auth probe (`packages/shared/src/harnesses/auth.ts:27-41`) accepts `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → `~/.claude/.credentials.json` → keychain, in that order.

### Why this 401s while every local check passes

The platform cannot today distinguish these independently-sufficient causes — all four are consistent with the reported symptoms:

1. **Precedence hijack (most likely).** `resolveMclaudeAuth` prefers `ANTHROPIC_API_KEY` from **any** scope. A stale or empty `ANTHROPIC_API_KEY` at **org or user** scope silently outranks the project setup-token. In `claude -p`, a present API key is *always* used → `X-Api-Key: <stale>` → 401, and the OAuth token (Claude precedence #5) is never reached. The project checks all pass because they only look at the project scope and at the OAuth key.
2. **Env not honored.** If a future Claude Code flips the `-p` default to `--bare` (Anthropic has said it will), `CLAUDE_CODE_OAUTH_TOKEN` is ignored → `apiKeySource: none` → 401. Same class of failure if the var fails to propagate across a boundary.
3. **Invalid/revoked setup-token.** `eve auth creds` only prefix-checks `sk-ant-oat01-`; `eve secrets validate` only checks existence. A revoked, truncated, or wrong-account setup-token passes both and 401s at first model call.
4. **No observability.** Nothing logs the selected source/scope/class, and nothing parses Claude Code's own `apiKeySource`/401, so the operator gets an opaque blocker.

The fix is therefore a **converging set**: deterministic scope-aware selection + env hygiene (A), credential-file materialization for setup-tokens (B), redacted pre-launch diagnostics (C), post-init structured error detection (D), and a real end-to-end validation command (E).

---

## Design

### Shared module: `packages/shared/src/invoke/claude-auth.ts` (new)

A single source of truth used by both agent-runtime and worker (consistent with the invoke-parity strategy in `docs/plans/invoke-parity-and-shared-module-plan.md`).

```ts
export type ClaudeTokenClass = 'setup-token' | 'oauth' | 'api-key';
export type SecretScope = 'project' | 'org' | 'user' | 'system' | 'unknown';

export interface ClaudeAuthDecision {
  source: 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN';
  secretKey: string;            // the resolved secret key that won
  scopeType: SecretScope;
  scopeId?: string;
  tokenClass: ClaudeTokenClass; // setup-token | oauth | api-key
  // env to forward; when OAuth is chosen, also lists vars to DELETE
  env: Record<string, string | undefined>;
  scrub: string[];              // e.g. ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN']
  warnings?: string[];
}

export function classifyClaudeToken(value: string): ClaudeTokenClass; // 'sk-ant-oat01-' => setup-token
export function selectClaudeAuth(secrets: SecretResolveItem[]): ClaudeAuthDecision | null;
export function scrubClaudeAuthEnv(env: NodeJS.ProcessEnv, decision: ClaudeAuthDecision | null): string[];
export async function prepareClaudeRuntimeConfig(
  repoPath: string,
  sourceConfigDir: string,
  jobUserHome: string,
  attemptId: string,
  harness: 'claude' | 'mclaude',
  variant?: string,
): Promise<{ runtimeConfigDir: string; copiedFromRepo: boolean }>;
export async function materializeClaudeCredentials(
  configDir: string,
  decision: ClaudeAuthDecision,
): Promise<{ wrote: boolean; path?: string }>;
export function redactAuthDecision(d: ClaudeAuthDecision): Record<string, unknown>; // length+fingerprint, never bytes or prefixes
```

**`selectClaudeAuth` rule** (the behavioral fix for A):

1. Drop any candidate whose value is empty/whitespace (an empty `ANTHROPIC_API_KEY` is *absent*, never forwarded).
2. Rank `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` candidates by **scope specificity**: `project (3) > org (2) > user (1) > system/unknown (0)`.
3. Pick the highest-specificity scope. **Within the same scope**, `ANTHROPIC_API_KEY` wins (matches Claude Code's documented precedence). **Across scopes**, the more specific scope wins — so a project-scoped setup-token beats an org-scoped API key. This directly serves the reported intent.
4. When the winner is `CLAUDE_CODE_OAUTH_TOKEN`, set `scrub = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN']`. The caller deletes these from the **final** harness env after adapter resolution and after `env_overrides`, so a broader-scope key, a forwarded worker secret, or an override cannot hijack `claude -p`. **Never** set them to empty string — Claude treats empty as present.
5. `tokenClass` from `classifyClaudeToken` (prefix `sk-ant-oat01-` ⇒ `setup-token`, other `sk-ant-` ⇒ `oauth`, `ANTHROPIC_API_KEY` ⇒ `api-key`).

> **Requires scope on resolved secrets.** `SecretResolveItem` already carries `scope_type`/`scope_id` (used for Codex write-back at `invoke.service.ts:1002-1005`). `resolveOAuthTokens` currently discards it — `selectClaudeAuth` consumes the full items so scope survives.

**`prepareClaudeRuntimeConfig` + `materializeClaudeCredentials`** (B): only materialize credentials after moving Claude's config to a per-attempt runtime directory outside `repoPath`.

1. Take the adapter-selected `sourceConfigDir` (often `repoPath/.agent/harnesses/claude`).
2. Create `runtimeConfigDir = path.join(jobUserHome, '.claude-runtime', harnessNameOrVariant)`.
3. Copy non-secret config files from `sourceConfigDir` to `runtimeConfigDir` if the source exists, but **never** copy `.credentials.json`, `auth.json`, or files with `0600` secret-like names.
4. Set `harnessOptionsResolved.env.CLAUDE_CONFIG_DIR = runtimeConfigDir` before `writeSecurityClaudeMd()`, `materializeClaudeCredentials()`, and `buildSanitizedHarnessEnv()`.

Then, for `tokenClass === 'setup-token'`, write `${runtimeConfigDir}/.credentials.json` (mode `0600`):

```json
{ "claudeAiOauth": { "accessToken": "<setup-token>", "expiresAt": <now + 365d ms>,
  "scopes": ["user:inference"], "subscriptionType": "unknown" } }
```

Setup-tokens are self-contained and need no refresh, so the materialized file is durable (this is **not** the stale-copied-creds case that breaks short-lived OAuth tokens). For `tokenClass === 'oauth'` it writes nothing and the decision carries a warning (short-lived token will expire ~15h; recommend `claude setup-token`). On Linux containers `${CLAUDE_CONFIG_DIR}/.credentials.json` is the documented file location; the macOS keychain path is irrelevant to the runtime. The file must be under `jobUserHome` or `/tmp/eve/agent-homes/<attempt>/...`, never under the checked-out repo.

---

### Phase 0 — Shared selector + classifier (pure, no I/O)

- Add `packages/shared/src/invoke/claude-auth.ts` with `classifyClaudeToken`, `selectClaudeAuth`, `redactAuthDecision` (pure), `scrubClaudeAuthEnv`, `prepareClaudeRuntimeConfig`, and `materializeClaudeCredentials` (fs).
- Export from `packages/shared/src/invoke/index.ts`.
- **Unit tests** (`claude-auth.spec.ts`): project OAuth beats org API key; same-scope API key beats OAuth; empty `ANTHROPIC_API_KEY` ignored; `scrub` set only for OAuth; classifier prefixes; `redactAuthDecision` never emits full token or token prefix; runtime config copy excludes credential files and never writes under `repoPath`.

### Phase 1 — Deterministic selection + env hygiene (fixes A)

- Rewrite the agent-runtime `resolveMclaudeAuth` (`invoke.service.ts:1009-1021`) to delegate to `selectClaudeAuth(resolvedSecrets)`:
  - return `decision.env`;
  - carry `decision` forward (needed by Phases 2–4). The simplest implementation is a closure-local `let claudeAuthDecision: ClaudeAuthDecision | null = null` set inside `resolveMclaudeAuth`; if the helper return type is widened, update adapter tests at the same time.
- Apply `scrubClaudeAuthEnv(finalEnv, decision)` **after** `applyEnvOverrides()` and before `buildSanitizedHarnessEnv()`:
  - agent-runtime: scrub `adapterEnv`, because it is the final adapter-provided env.
  - worker fallback: scrub `harnessEnv`, because it begins with `secretsContext.env` and therefore can still contain the broader `ANTHROPIC_API_KEY` even when the adapter selected project OAuth.
  - delete scrubbed keys; also delete whitespace-only `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` values.
- Mirror selection in the worker (`apps/worker/src/invoke/invoke.service.ts:1650-1672`) so the fallback path stays consistent (worker's agent path is fallback-only but must not drift — see CLAUDE.md routing rules).
- Treat `env_overrides` attempting to set `ANTHROPIC_API_KEY` as allowed only when the final decision selected an API key from the same or more-specific scope. If OAuth/setup-token won, the override is scrubbed and a lifecycle diagnostic records `scrubbed_env_keys`.
- **Tests**:
  - pure selector: project `CLAUDE_CODE_OAUTH_TOKEN` beats org `ANTHROPIC_API_KEY`; same-scope API key beats OAuth; empty/whitespace values ignored.
  - env scrub: with project OAuth selected, final `buildSanitizedHarnessEnv()` output has `CLAUDE_CODE_OAUTH_TOKEN` and does **not** have `ANTHROPIC_API_KEY`, even if `env_overrides` or worker `secretsContext.env` introduced it.
  - worker fallback: all resolved secrets are still forwarded for normal tools, but losing Claude auth keys are removed.

### Phase 2 — Safe runtime config + setup-token credentials file (fixes B)

- Move `createJobUserHome(invocationWithOptions.attemptId)` earlier so it runs immediately after harness options are resolved and before any Claude config writes. Then replace the adapter-selected `CLAUDE_CONFIG_DIR` with a safe per-attempt runtime config dir:
  - source config dir: `harnessOptionsResolved.env.CLAUDE_CONFIG_DIR`;
  - destination: `path.join(jobUserHome, '.claude-runtime', harnessOptionsResolved.harness, variant ?? 'default')`;
  - copy non-secret config only; do not copy `.credentials.json`, `auth.json`, `.env`, files ending in `_KEY`, or files with owner-only secret modes.
- Call `writeSecurityClaudeMd(repoPath, runtimeConfigDir)` so the security `CLAUDE.md` lands in the same config dir Claude uses.
- Call `materializeClaudeCredentials(runtimeConfigDir, decision)` after the runtime config dir exists.
- Record `materialized_file`, `runtime_config_dir`, and `source_config_dir` on the Phase 3 diagnostic. Log paths only, not token values.
- Keep forwarding the env var (covers current `-p`); the file covers the `--bare` future. Both reference the same token, so precedence order is moot.
- **Tests**:
  - setup-token ⇒ file written at `${jobUserHome}/.claude-runtime/<harness>/.credentials.json`, mode `0600`, valid `claudeAiOauth.accessToken`;
  - no `.credentials.json` appears anywhere under `repoPath`;
  - existing non-secret `CLAUDE.md` / settings from `.agent/harnesses/claude` are preserved in the runtime config dir;
  - oauth token ⇒ no file + warning.

### Phase 3 — Redacted pre-launch lifecycle diagnostic (fixes C)

- Immediately before spawn (after the existing Eve credentials lifecycle event at `invoke.service.ts:1191-1199` and before `spawn` at `:1322`), emit:
  ```ts
  await this.logLifecycleEvent(attemptId, 'secrets', 'log', {
    kind: 'claude_auth_selected',
    ...redactAuthDecision(decision),       // auth_source, secret_key, scope_type, scope_id, token_class, token_len, token_fingerprint
    materialized_file: decision.materializedFile,
    runtime_config_dir: runtimeConfigDir,
    source_config_dir: sourceConfigDir,
    scrubbed_env_keys: scrubbedEnvKeys,
    home: jobUserHome,
    base_url_set: Boolean(harnessOptionsResolved.env.ANTHROPIC_BASE_URL),
  });
  ```
- `redactAuthDecision` emits `token_len` and a short SHA-256 `token_fingerprint` for cross-job correlation — never token bytes or token prefixes. Reuse the existing `logLifecycleEvent` machinery (`invoke.service.ts:306-328`); no new event plumbing.
- Surface the same fields in `eve job diagnose` so the operator sees auth source/scope/class without reading raw logs.

### Phase 4 — Post-init structured auth error (fixes D)

- In the stdout JSONL line handler (the `readline` enqueue block in `apps/agent-runtime/src/invoke/invoke.service.ts`), after `JSON.parse(line)`:
  - When `parsed.type === 'system' && parsed.subtype === 'init'`, capture `parsed.apiKeySource` into a local.
  - Detect auth failure: `apiKeySource === 'none'`, **or** a `result`/error line whose text matches `/401|invalid authentication credentials|oauth token has expired|api key/i`.
- On a detected auth failure while `decision` was non-null, emit **once** a structured provisioning error via `deliverProvisioningError` (`packages/shared/src/invoke/eve-message-relay.ts:23`) plus a `system.provisioning.error` log:
  ```
  errorCode: 'claude_auth_failed'
  message: 'Claude Code rejected the selected credential (apiKeySource=<x>). '
         + 'Selected <auth_source> from secret "<secret_key>" at <scope_type>:<scope_id> '
         + '(class <token_class>). Likely: <expired/revoked setup-token | precedence hijack | not propagated>. '
         + 'Run `eve auth verify --harness claude --project <id>`.'
  ```
- Classify the probable cause: `apiKeySource: none` ⇒ "token not honored (check `--bare`/propagation)"; 401 with a selected setup-token ⇒ "invalid or revoked setup-token"; an `api-key` class selected when the project intended OAuth ⇒ "broader-scope ANTHROPIC_API_KEY hijack".
- **Tests**: feed a synthetic `system/init` with `apiKeySource: none` and a 401 `result` line through the handler; assert a single structured provisioning error naming the secret key + scope, and that token bytes never appear.

### Phase 5 — `eve auth verify` end-to-end validation (fixes E)

`eve secrets validate` proves existence; this proves the credential **works** by running the real materialization path server-side.

- **CLI**: `eve auth verify --harness claude --project <id> [--org <id>] [--json]` (`packages/cli/src/commands/auth.ts`). Thin REST wrapper per `api-philosophy.md`.
- **API/runtime**: a minimal **auth-probe** managed job that runs the exact `selectClaudeAuth → scrub → materializeClaudeCredentials → spawn` path with prompt `Reply with exactly: EVE_AUTH_OK`, then asserts: exit 0, `apiKeySource != none`, and the output contains `EVE_AUTH_OK`. The CLI creates a short-lived ephemeral job with `auth_probe: true` and `skip_workspace_skills: true` so it still exercises clone, secret resolution, env construction, materialization, and harness spawn, but does not fail on unrelated optional local skill-pack sources.
- **Returns** structured JSON: `{ ok, auth_source, secret_key, scope_type, scope_id, token_class, apiKeySource, model_replied }`. On failure: `{ ok: false, reason, secret_key, scope_type }` with non-zero exit — directly satisfying "an intentionally invalid project-scoped setup-token fails fast with a structured error that names the secret key and scope".
- This is the command the Phase 4 error message points at, closing the loop.

### Phase 5a — Required local k3d verification loop

This loop is mandatory before tagging any runtime/auth PR from this plan. It proves the behavior against the same local k3d agent-runtime path used by managed jobs; unit tests alone are not sufficient.

Restart from step 1 after every code change or failure.

```bash
# 1. Build + deploy this checkout to local k3d
./bin/eh status                         # must show K8s Owner: true
pnpm build
./bin/eh k8s start
./bin/eh k8s deploy

# 2. Target the local k3d API and verify platform health
export EVE_API_URL=http://api.eve.lvh.me
eve profile use local
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
eve system health --json | jq -e '.status == "ok"'

# 3. Create an isolated local org/project for the auth durability checks
ORG_ID=$(eve org ensure "claude-auth-durability" --slug claude-auth-durability --json | jq -r '.id')
# Slugs must be 4-8 alphanumeric characters starting with a letter.
PROJECT_ID=$(eve project ensure \
  --org "$ORG_ID" \
  --name "claude-auth-durability" \
  --slug clauth \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json | jq -r '.id')

# 4. Put only the setup-token at project scope; add a bogus broader API key.
#    This reproduces the reported precedence hijack without disturbing manual-test-org.
rg '^CLAUDE_CODE_OAUTH_TOKEN=' manual-tests.secrets > /tmp/eve-claude-project.env
eve secrets import --project "$PROJECT_ID" --file /tmp/eve-claude-project.env
eve secrets set ANTHROPIC_API_KEY sk-ant-invalid-precedence-test --org "$ORG_ID" --json

# 5. Verify the real server-side materialization path
pnpm -C packages/cli build
node packages/cli/bin/eve.js auth verify --harness claude --project "$PROJECT_ID" --json \
  | jq -e '.ok == true and .scope_type == "project" and .token_class == "setup-token" and .apiKeySource != "none"'

# 6. Verify a managed job authenticates and logs the redacted decision
JOB_ID=$(eve job create \
  --project "$PROJECT_ID" \
  --description "Reply with exactly: EVE_AUTH_OK" \
  --harness claude \
  --json | jq -r '.id')
eve job follow "$JOB_ID"
eve job show "$JOB_ID" --json | jq -e '.phase == "done"'
eve job logs "$JOB_ID" | rg 'claude_auth_selected|token_class|setup-token|scope_type|project'
! eve job logs "$JOB_ID" | rg 'sk-ant-oat01-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}'

# 7. Run a second managed job without re-syncing secrets.
#    Both jobs must succeed and show the same redacted token_fingerprint, if emitted.
JOB2_ID=$(eve job create \
  --project "$PROJECT_ID" \
  --description "Reply with exactly: EVE_AUTH_OK" \
  --harness claude \
  --json | jq -r '.id')
eve job follow "$JOB2_ID"
eve job show "$JOB2_ID" --json | jq -e '.phase == "done"'

# 8. Negative path: invalid project setup-token fails fast with structured auth context.
BAD_PROJECT_ID=$(eve project ensure \
  --org "$ORG_ID" \
  --name "claude-auth-invalid-token" \
  --slug clbad \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json | jq -r '.id')
eve secrets set CLAUDE_CODE_OAUTH_TOKEN sk-ant-oat01-invalid-token-for-k3d-auth-verify --project "$BAD_PROJECT_ID" --json
! node packages/cli/bin/eve.js auth verify --harness claude --project "$BAD_PROJECT_ID" --json
```

Pass bar:

- `eve auth verify` succeeds for the valid project setup-token even with a bogus org `ANTHROPIC_API_KEY`.
- Both managed `claude` jobs complete without re-syncing credentials.
- `eve job logs` / `eve job diagnose` show `claude_auth_selected` with source/scope/class/materialization fields and no token bytes.
- The invalid-token probe exits non-zero with `claude_auth_failed` (or equivalent structured reason) naming `CLAUDE_CODE_OAUTH_TOKEN`, `project`, and the project scope ID.
- No `.credentials.json` appears under the checked-out repo or in committed changes: `find . -path '*/.credentials.json' -print` returns nothing from `repoPath`.

Verified local k3d loop on 2026-06-04:

- Valid project setup-token selected over bogus org `ANTHROPIC_API_KEY` with `eve auth verify` (`scope_type=project`, `token_class=setup-token`, `apiKeySource=unknown`, model replied).
- Two ordinary managed `claude` jobs returned `EVE_AUTH_OK` without re-syncing credentials.
- Invalid project setup-token returned non-zero structured `ok=false` with `secret_key=CLAUDE_CODE_OAUTH_TOKEN`, `scope_type=project`, and `token_class=setup-token`.
- `eve job logs` and `eve job diagnose` output did not contain the valid setup-token, its prefix, or the invalid token literal.
- k3d `eve-agent-runtime` and `eve-worker` pods had no `.credentials.json` under `/opt/eve/workspaces/*/repo`.

Slow lane (run at least once before release, not on every iteration): a managed `claude` job that performs model calls separated by >45 minutes still succeeds with the setup-token file + env path. Capture both job ID and redacted auth diagnostic in the PR.

### Phase 6 — Secondary hardening (optional, same PR if cheap)

- **`ANTHROPIC_BASE_URL` guard**: log `base_url_set` (Phase 3) and only forward a non-empty value; a stray base URL pointed at an incompatible proxy is a known 401 source. Adapter at `packages/shared/src/harnesses/adapters/claude.ts:32`.
- **`eve auth creds` honesty**: note in output that a `setup-token` *class* does **not** imply the token is valid — point to `eve auth verify` (`packages/cli/src/commands/auth.ts:610-617,734`).

---

## Acceptance tests → phases

| Acceptance test (from the gap report) | Satisfied by |
| --- | --- |
| Only a project-scoped `CLAUDE_CODE_OAUTH_TOKEN` (no `ANTHROPIC_API_KEY`) → minimal managed `claude` job authenticates and returns a known string | Phase 1 (selection) + Phase 2 (materialize); verified by Phase 5 probe |
| Two sequential managed `claude` jobs authenticate without re-syncing between them | Phases 1–2 (deterministic, no per-job mutation of the secret) |
| A managed `claude` job running > 45 min keeps authenticating for later model calls | Setup-token is ~1 yr and self-contained; Phase 2 file + env both reference it, no refresh needed |
| Safe lifecycle logs show token source/scope/class but never the value | Phase 3 (`redactAuthDecision`) + Phase 4 (redacted error) |
| An intentionally invalid project-scoped setup-token fails fast with a structured error naming the secret key + scope | Phase 4 (runtime) + Phase 5 (`eve auth verify`) |

---

## Risks & mitigations

- **Behavioral change to auth precedence** (project OAuth now beats broader-scope API key). This is the intended fix, but could surprise a project that *deliberately* set an org API key to override. Mitigation: same-scope still prefers API key; the Phase 3 diagnostic always shows which won; document in `secrets.md` + skillpack `secrets-auth.md`.
- **Materialized file vs env precedence.** Claude ranks `CLAUDE_CODE_OAUTH_TOKEN` (env) above the credentials file; both reference the same token, so there is no conflict. If only one is honored (e.g. `--bare` ignores env), the other covers it.
- **Credential file leakage through repo config dirs.** Current `CLAUDE_CONFIG_DIR` often points inside `repoPath/.agent/harnesses/claude`. Writing `.credentials.json` there would expose it to agent shell commands and git commit/push policies. Mitigation: Phase 2 switches to an isolated runtime config dir under `jobUserHome`, copies only non-secret config, and asserts `find <repoPath> -path '*/.credentials.json'` is empty in tests and k3d verification.
- **Probe cost / side effects** (Phase 5). The probe makes one cheap model call. Bound it with a short timeout and `max_tokens`, skip clone/coordination, and clean up the temp config dir. Never write back or mutate the project secret.
- **macOS vs Linux creds location.** Runtime is Linux containers, where `${CLAUDE_CONFIG_DIR}/.credentials.json` is correct. Local `mclaude` dev on macOS still uses the keychain/env path unchanged.
- **Worker drift.** All agent jobs route to agent-runtime; the worker change is parity-only. Keep both calling the shared selector so they cannot diverge (per CLAUDE.md routing rules + invoke-parity plan).

---

## Documentation & skillpack sync (CRITICAL — per CLAUDE.md)

| Change | File |
| --- | --- |
| New auth precedence (scope-aware), credential-file materialization for setup-tokens, redacted diagnostics | `docs/system/secrets.md` (§OAuth Token Management) |
| `eve auth verify` command + flags | `docs/system/auth.md`; `docs/system/secrets.md`; skillpack `eve-read-eve-docs/references/cli-auth.md` and `secrets-auth.md` |
| Token class ≠ token validity; `eve auth verify` for proof | skillpack `secrets-auth.md` |
| Structured `claude_auth_failed` provisioning error & `eve job diagnose` auth fields | `docs/system/agent-runtime.md`, skillpack `deploy-debug.md` |
| Durable Claude harness auth local regression | Update `tests/manual/scenarios/27-claude-harness-auth.md` from "Env Var Path" to "Setup-Token Durability"; list it in `tests/manual/README.md` with the k3d precedence + sequential-job checks |

Update the matching `../eve-skillpacks/eve-work/eve-read-eve-docs/references/*` files in the same change (the docs agents read to learn Eve).

---

## Implementation order (suggested PRs)

1. **PR 1 (Phase 0 + 1)** — shared `claude-auth.ts` selector/classifier + deterministic selection + env scrub. Pure unit tests + one integration test. *Fixes the most likely root cause (A) alone.*
2. **PR 2 (Phase 2 + 3)** — materialize setup-token credentials file + redacted pre-launch diagnostic.
3. **PR 3 (Phase 4)** — post-init `apiKeySource`/401 detection → structured provisioning error.
4. **PR 4 (Phase 5 + 6)** — `eve auth verify` end-to-end probe + secondary hardening + docs/skillpack sync.

Each PR is independently shippable and improves observability or determinism on its own. Runtime PRs must run the local k3d loop through the lanes implemented by that PR; PR 4 must run the full Phase 5a loop before tagging. Track the phases in beads (`bd create … --type task`) when implementation begins.

---

## Closed decisions

- **Probe placement**: use an ephemeral managed job instead of a dedicated endpoint. It preserves the real runtime path and only skips optional workspace skill materialization through `auth_probe`/`skip_workspace_skills`.
- **Far-future `expiresAt` for materialized setup-tokens**: write `now + 365d` in `.credentials.json`; omitting `expiresAt` risks Claude treating the token as expired.
- **`apiKeySource` enum stability**: only `none` is treated as failure; any non-`none` value proves Claude resolved some auth source. Do not hard-code the full enum.
