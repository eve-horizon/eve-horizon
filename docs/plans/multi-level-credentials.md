# Multi-Level Credentials Plan

> **Plan (Historical)**: This plan may be partially or fully implemented.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

Intent: add first-class, multi-level credentials that enable private Git repo access and safe secret propagation with repo-level `.env` for host secrets and `.env.local` for auth extraction only. Keep it simple, REST-first, and worker-only decryption.

## Decisions (confirmed)
- Host-supplied secrets live in `.env` (with `EVE_SECRET_` prefix for injected vars). `.env.local` is reserved for auth extraction.
- CLI `--show` returns masked values (first/last characters only).
- No job-level overrides.
- Post-clone hook location: `./.eve/hooks/post-clone.sh` (avoid conflict with top-level `./eve` executable).

## Requirements
- Secrets scoped to user/org/project with clear precedence (project > org > user > host file).
- REST + CLI CRUD with redaction by default; masked `--show` only.
- Worker can resolve secrets for a job; CLI/users cannot read plaintext.
- Optional post-clone hook with access to a generated secrets env file.

## Scope
- In: DB schema, API/CLI surfaces, worker injection, hook contract, docs/tests.
- Out: UI, external secret managers/KMS, key rotation.

## Files and entry points
- `apps/api` (controllers/services/schemas; internal worker endpoint)
- `apps/cli` or `packages/cli` (secret commands)
- `docker/worker/entrypoint.sh` (worker env injection)
- `docs/system` (API + deployment + secrets design)
- `docs/plans/multi-level-credentials.md` (this plan)

## Data model / API changes
- Table: `secrets`
  - `id`, `scope_type` (user|org|project), `scope_id`, `key`, `type` (env_var|file|github_token|ssh_key; default env_var)
  - `value_encrypted`, `created_by`, `created_at`, `updated_at`
  - Unique `(scope_type, scope_id, key)`
- Optional table: `secret_access_log` (lightweight audit of worker reads)

### Resolution order
1) Project
2) Org
3) User
4) Host env (`.env`)

### REST routes (draft)
- `POST /users/:id/secrets`
- `GET /users/:id/secrets` (redacted)
- `PATCH /users/:id/secrets/:secretId`
- `DELETE /users/:id/secrets/:secretId`
- Same for `/orgs/:id/secrets` and `/projects/:id/secrets`
- Internal worker-only: `GET /internal/projects/:id/secrets/resolved`

## CLI commands (draft)
- `eve secrets set --user <id> --key KEY --value VALUE`
- `eve secrets set --org <id> --key KEY --value VALUE`
- `eve secrets set --project <id> --key KEY --value VALUE`
- `eve secrets list --project <id>` (redacted)
- `eve secrets show --project <id> --key KEY` (masked)
- `eve secrets delete --project <id> --key KEY`
- Optional: `eve secrets import --project <id> --file .env`

## Worker injection flow
- Worker calls internal resolved endpoint at job claim time.
- Secrets injected as environment variables for harness execution.
- File/ssh_key types written to `.eve/` within workspace; env points to file paths.
- Worker writes `.eve/secrets.env` (env-formatted) and sets `EVE_SECRETS_FILE` for hooks.

## Post-clone hook contract
- Optional script at `./.eve/hooks/post-clone.sh`.
- Executed after clone, before harness starts.
- Environment includes:
  - `EVE_SECRETS_FILE` path
  - `EVE_JOB_ID`, `EVE_PROJECT_ID`, `EVE_ORG_ID`
  - `EVE_REPO_PATH`
- Hook output must be non-secret (logs are redacted, but assume visible).

## GitHub private repo auth
- `github_token` secrets: use `GIT_ASKPASS` or a temporary credential helper in workspace.
- `ssh_key` secrets: write to `.eve/ssh_key`, set `GIT_SSH_COMMAND` for clone.
- Do not persist credentials in repo checkout.

## Security posture
- Encrypt secret values at rest with a master key stored in `.env` (host only).
- API never returns plaintext; CLI only returns masked values.
- Worker-only decryption endpoint; internal auth only.
- Avoid logging secret values; redact known keys by pattern.

## Testing and validation
- DB: migration + uniqueness constraint.
- API: CRUD + redaction + permissions.
- CLI: set/list/show/delete + masking behavior.
- Worker: resolution order, env injection, hook execution, log redaction.
- E2E: private repo clone with project secret token/ssh key.

## Risks and edge cases
- Secret leakage via logs or hook output.
- Incorrect precedence causing unexpected overrides.
- Hook writes secrets into repo (accidental commit).

## Open questions
- Masking rule for `--show` (e.g., first 4 + last 4).
