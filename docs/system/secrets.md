# Secrets

> Status: Current
> Last Updated: 2026-01-28

## Overview

Eve Horizon supports multi-level secrets scoped to system/org/user/project plus host-provided env for local development.
Secrets are encrypted at rest in the database and never returned in plaintext by the API.

## Host Env (local)

Use `.env` at the repo root for local secrets and internal tokens.
`system-secrets.env.local` stores OAuth tokens and system-level defaults (bootstrapped on API startup).
Both files are **never committed**.
Default dev works without a `.env` unless you need private repo access, API keys, or API secrets.

Example:

```bash
EVE_SECRETS_MASTER_KEY=replace-me
EVE_INTERNAL_API_KEY=replace-me
GITHUB_TOKEN=ghp_xxx
```

`create-pr` actions accept `EVE_GITHUB_TOKEN` for PR creation.

## API Secrets

Secrets can be stored at multiple scopes:

- **System**: `/system/secrets`
- **User**: `/users/:id/secrets`
- **Org**: `/orgs/:id/secrets`
- **Project**: `/projects/:id/secrets`

Resolution order (highest wins): **project → user → org → system**.

System secrets are loaded from `system-secrets.env.local` on API startup; restart the API to pick up changes.

Values are never returned in plaintext. The `show` endpoint returns a masked value (first/last characters only).

## Import secrets from a file (CLI)

You can attach a batch of secrets to a scope from an env-style file (KEY=VALUE lines):

```bash
# secrets.env
Z_AI_API_KEY=...
GITHUB_TOKEN=ghp_xxx

# Import into an org (shared across projects)
eve secrets import --org org_xxx --file ./secrets.env

# Import into a project
eve secrets import --project proj_xxx --file .env
```

Notes:
- Supported scopes: `--project`, `--org`, `--user`, `--system` (admin only).
- Lines starting with `#` are ignored; blank lines are ignored.
- Values are read verbatim after `=` (quotes are not stripped).
- Imports upsert each key as `env_var`.

## Manifest Requirements + Validation

Manifests can declare required secrets via `x-eve.requires.secrets` (top-level)
and step-level `requires.secrets`. These are validated on demand:

```bash
eve project sync --validate-secrets
eve project sync --strict
eve secrets validate --project proj_xxx
```

Validation reports missing secrets with scope-aware remediation hints
(`eve secrets set ... --scope project|org|user|system`).

## Safe Secrets (Ensure + Export)

Certain secrets are safe to auto-generate and export for configuring external systems.
Currently allowlisted:

- `GITHUB_WEBHOOK_SECRET`

Generate if missing and export:

```bash
eve secrets ensure --project proj_xxx --keys GITHUB_WEBHOOK_SECRET
eve secrets export --project proj_xxx --keys GITHUB_WEBHOOK_SECRET
```

Export returns the plaintext value (for webhook setup). Treat it as sensitive.

## Manifest Secrets Interpolation

Environment variable values in `eve.yaml` manifests support `${secret.KEY_NAME}` syntax for secret interpolation during deployment.
The same placeholder syntax is supported in job `env_overrides`: agent jobs,
workflow `script`/`run` steps, and pipeline `action: { type: run }` steps
resolve placeholders at execution time before launching the harness or bash
process. Missing referenced secrets fail fast with `missing_secret_override`;
`eve job show --json` still returns the raw unresolved placeholder text.

### Syntax

```yaml
services:
  api:
    environment:
      DATABASE_URL: postgres://user:${secret.DB_PASSWORD}@db:5432/mydb
      API_KEY: ${secret.EXTERNAL_API_KEY}
  db:
    environment:
      POSTGRES_PASSWORD: ${secret.DB_PASSWORD}
```

### Local Secrets File

For development, create `.eve/dev-secrets.yaml` in your project to provide local secrets (normally gitignored).
(`.eve/secrets.yaml` is deprecated but still supported as a fallback.)

```yaml
# .eve/dev-secrets.yaml
secrets:
  # Default secrets (fallback for any environment)
  default:
    DB_PASSWORD: dev_password

  # Environment-specific overrides
  test:
    DB_PASSWORD: test_password
  staging:
    DB_PASSWORD: staging_password
  production:
    DB_PASSWORD: ${REQUIRE_REAL_SECRET}  # Placeholder - set via API
```

**Resolution order**: API secrets → overlaid by local `.eve/dev-secrets.yaml`

Local secrets take precedence for developer convenience. This allows checking in safe dev defaults while production uses API secrets.

### K8s Deployments

For k8s deployments, local `.eve/dev-secrets.yaml` **only works** when:
- The project uses a `file://` repo URL pointing to a local path
- The worker has filesystem access to that path (e.g., host-mounted volume)

**For production k8s deployments**, set secrets via the API instead:

```bash
# Set project-level secret
eve secrets set POSTGRES_PASSWORD mypassword --scope project --project proj_xxx

# Set org-level secret (applies to all projects in org)
eve secrets set POSTGRES_PASSWORD mypassword --scope org --org org_xxx
```

This ensures secrets are stored securely and accessible to workers running in containers.

### Example Repo

The [eve-horizon-fullstack-example](https://github.com/eve-horizon/eve-horizon-fullstack-example) demonstrates this pattern with a checkable `.eve/dev-secrets.yaml` file.

## Worker Injection

- Resolved secrets are injected as environment variables for the worker and deployer (allowlisted). 
- File and `ssh_key` secrets are written **outside** the repo workspace and are **not** available to agent processes.
- The worker no longer writes `.eve/secrets.env` into the workspace and does **not** set `EVE_SECRETS_FILE`.
- Optional hooks still run in the worker context, but only see the allowlisted environment variables.

## Git Auth Injection

- HTTPS clone: `github_token` secrets are injected into the clone URL for private repo access.
- SSH clone: `ssh_key` secrets are written to a temp key and wired via `GIT_SSH_COMMAND`.
- Missing auth now surfaces explicit errors with remediation hints (use `eve secrets set`).

## OAuth Token Management

### Syncing Local Tokens to Eve Secrets

Use `eve auth sync` to register local Claude/Codex OAuth tokens as Eve secrets so agents can use them:

```bash
eve auth sync                      # User-level (default — available to all your jobs)
eve auth sync --org org_xxx        # Org-level (shared across all org projects)
eve auth sync --project proj_xxx   # Project-level (scoped to a single project)
eve auth sync --dry-run            # Preview what would be set without writing
```

This sets `CLAUDE_CODE_OAUTH_TOKEN` (Claude) and `CODEX_AUTH_JSON_B64` (Codex/Code) at the requested scope.

For Codex/Code auth files, `eve auth sync --codex` validates refresh-token usability before writing `CODEX_AUTH_JSON_B64`. If the refresh token has expired or was already used, the command fails before updating Eve secrets and tells you to run `codex login --device-auth`.

### Token Types and Lifetimes

| Token prefix | Type | Lifetime | Recommendation |
|---|---|---|---|
| `sk-ant-oat01-*` | `setup-token` (long-lived) | Long-lived | Preferred for jobs and automation |
| Other `sk-ant-*` | `oauth` (short-lived) | ~15h | Use for interactive dev; regenerate with `claude setup-token` |

`eve auth sync` warns when syncing a short-lived OAuth token. Use `eve auth creds` to inspect token type before syncing. For Codex/Code, `eve auth creds --codex` reports access token validity, refresh token presence/usability, and the `last_refresh` timestamp.

Claude setup-tokens (`sk-ant-oat01-*`) are preferred for managed jobs. At
runtime, `claude`/`mclaude` select secrets by scope specificity
(`project > org > user > system`), then prefer `ANTHROPIC_API_KEY` only within
the same scope. Selected setup-tokens are materialized to an attempt-scoped
`CLAUDE_CONFIG_DIR` under `EVE_JOB_USER_HOME`; conflicting Claude auth env vars
are scrubbed after `env_overrides`, and credential files are never written under
`repoPath`.

Verify the real managed auth path after syncing:

```bash
eve auth verify --harness claude --project proj_xxx --json
```

The JSON verdict includes `ok`, `secret_key`, `scope_type`, `token_class`,
`apiKeySource`, and `model_replied`.

### Automatic Codex/Code Token Write-Back

After each harness invocation, the worker checks if the Codex/Code CLI refreshed `auth.json` during the session. If the token changed, it is automatically written back to the originating secret scope (user/org/project) so the next job starts with a fresh token. This is transparent and non-fatal — a write-back failure logs a warning but does not affect the job result.

### Internal Secret Update Endpoint

The platform exposes `PATCH /internal/secrets/:scope_type/:scope_id/:key` for worker-to-API token write-back. This endpoint:
- Requires `x-eve-internal-token` header (same `EVE_INTERNAL_API_KEY` used by secret resolution)
- Is **update-only** — it will 404 if the secret does not already exist (no create semantics)
- Accepts `{ "value": "..." }` body

## Troubleshooting Secret Resolution

If a job fails during clone or secret resolution:

1. Confirm the secret exists: `eve secrets show <KEY> --project <id>`
2. Ensure `EVE_INTERNAL_API_KEY` and `EVE_SECRETS_MASTER_KEY` are set for API/worker
3. Check orchestrator/worker logs for `[resolveSecrets]` warnings
4. Re-run with corrected secret scope (`project` → `org` → `system`)

## GitHub Private Repos

- `github_token` secrets are used for HTTPS clone.
- `ssh_key` secrets are used for SSH clone (`GIT_SSH_COMMAND` with a temp key).

## Required Config

- `EVE_SECRETS_MASTER_KEY` (API): encryption key for secrets at rest (required to store API secrets).
- `EVE_INTERNAL_API_KEY` (worker + API): internal token for resolve endpoint (required for API secret resolution).

## Incident Response (Secrets)

If you suspect a secret leak or exposure:

1. **Contain**
   - Rotate the affected secret(s) at the source (GitHub, Slack, cloud provider, etc.).
   - Update the secret via `eve secrets set` or `eve secrets import`.
2. **Invalidate**
   - Restart affected services to flush cached credentials.
   - If a token was printed to logs, assume it is compromised.
3. **Audit**
   - Review recent job logs and pipeline logs for leakage patterns.
   - Check correlation IDs for affected requests.
4. **Recover**
   - Re-run failed jobs or deployments after rotation.
5. **Document**
   - Record what leaked, where it appeared, and why.
   - Add a test or guardrail if the leak was due to missing redaction or RBAC.
