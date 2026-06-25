# Deploy Recovery and DB Reset Plan

> Status: Shipped (f178165)
> Last Updated: 2026-02-15
> Owner: TBD
> Consolidates:
> - `docs/ideas/self-service-deploy-recovery.md`
> - `docs/ideas/db-migrate-direct-and-reset.md`

## Summary

Introduce a unified recovery surface so Eve-compatible app teams can recover failed
deployments and bad schema states without platform operator intervention.

The plan combines:

1. Release-based deployment recovery (`deploy --release-tag`, `env rollback`)
2. Reliable environment teardown/reset (`env delete` semantics + `env reset`)
3. Local and CI DB migration/reset parity (`db migrate --url`, `db reset --url`)
4. State correctness and safety guards (readiness-gated release pointer, production protections)

## Problem Statement

As of 2026-02-15 (local k3d incident), teams can get stuck in mixed states:

1. Pipeline migrations fail (example: Prisma `P3018` relation already exists).
2. New pods fail to pull images while old release remains live.
3. Managed DB provisioning can fail before migrations run.
4. Recovery requires ad hoc operator actions instead of deterministic CLI workflows.
5. `eve env delete` orphans k8s workloads — it deletes the DB record and managed DB
   tenants but never calls the deployer to tear down the namespace.

## Goals

1. Recovery is self-service via Eve CLI for app teams.
2. Recovery operations are idempotent and observable.
3. Deploy state in DB matches actual k8s readiness.
4. Local, CI, and Eve-managed DB workflows use the same migration primitives.
5. Common failures are recoverable in under 5 minutes.

## Non-goals

1. Redesigning pipeline execution model.
2. Supporting non-Postgres drivers in this phase.
3. Replacing all existing commands with a brand-new command family.

## Current State (What Already Exists)

Before implementing, note what the codebase already provides:

| Capability | Location | Status |
|------------|----------|--------|
| `DeployRequest.release_tag` schema field | `packages/shared/src/schemas/release.ts` | Defined; needs CLI flag wiring |
| `deployer.rollback(envId, releaseId)` | `apps/worker/src/deployer/deployer.service.ts:500` | Implemented — calls `deploy()` with old release |
| `deployer.deleteEnvironment(envId)` | `apps/worker/src/deployer/deployer.service.ts:508` | Exists — deletes namespace via `k8sService.deleteNamespace()` |
| `EnvDbService.migrate()` | `apps/api/src/environments/env-db.service.ts:223` | Full migration runner for env databases |
| Managed DB tenant cleanup on delete | `apps/api/src/environments/environments.service.ts:187` | Cleans up tenants; does NOT call deployer teardown |
| `current_release_id` on environments | `environments` table, `environments.service.ts` | Updated immediately after deploy — not readiness-gated |
| `packages/migrate` CLI script | `packages/migrate/src/index.ts` | Standalone script; calls `process.exit()` — not importable as a library |

**Key gaps the plan addresses:**
- No `--url` mode on any `eve db` command (all go through `--env` + API)
- No dedicated `rollback` CLI command (must manually deploy with old ref)
- No `db reset` command at all
- No `env reset` composite operation
- Env DB routes are inconsistent (`/db/schema` and `/db/sql` vs `/migrate` and `/migrations`)
- `env delete` orphans k8s workloads (P0 bug)
- `current_release_id` updates before readiness confirmation

## Design Principles

1. Release-first recovery: recover to a known good release before rebuilding.
2. Parity by default: same commands should work in local (`--url`) and Eve env (`--env`) modes.
3. Fast fail, clear next step: errors should include concrete operator actions.
4. Safe by default: destructive operations require explicit confirmation.

## Target UX

### A. Recover a failed deploy by release

```bash
# Deploy known release by tag
eve env deploy staging --release-tag v1.2.3

# Explicit rollback
eve env rollback staging --release v1.2.2

# Rollback to previous release
eve env rollback staging --release previous
```

### B. Reset schema without tenant destroy/reprovision

```bash
# Eve-managed database
eve db reset --env staging

# Local Docker/Postgres
eve db reset --url postgres://app:secret@localhost:5432/myapp
```

### C. Local/CI migrations without Eve API dependency

```bash
# Direct mode via flag
eve db migrate --url $TEST_DATABASE_URL
eve db migrations --url $TEST_DATABASE_URL

# Or via env var (with .env file support)
export EVE_DB_URL=postgres://app:secret@localhost:5432/myapp
eve db migrate
```

### D. Full environment recovery (composite)

```bash
eve env reset staging --release v1.2.3
```

`env reset` is a composition of: cancel active runs -> teardown env workloads ->
optionally redeploy release -> verify readiness.

### E. Recovery diagnostics

```bash
eve env recover staging
```

Analyzes environment state (stuck pods, failed migrations, image pull errors) and
suggests the concrete next recovery action.

## Command and API Surface

### CLI additions and updates

1. `eve db migrate --url <postgres-url>` — apply pending migrations directly
2. `eve db migrations --url <postgres-url>` — list applied migrations directly
3. `eve db sql --url <postgres-url>` — run SQL directly
4. `eve db schema --url <postgres-url>` — show schema directly
5. `eve db reset --env <name>|--url <url> [--no-migrate] [--force]` — reset schema + re-migrate
6. `eve db wipe` — alias for `eve db reset --no-migrate --force`
7. `eve env deploy <env> (--ref <sha>|--release-tag <tag>) [--skip-preflight]` — deploy by ref or release tag
8. `eve env rollback <env> --release <release-id|tag|previous>` — redeploy known good release
9. `eve env reset <env> [--release <...>] [--force]` — composite recovery operation
10. `eve env recover <env>` — diagnostics + suggested next action (Phase 6)

### API additions and updates

1. `POST /projects/:id/envs/:name/db/reset` — reset env database schema
2. `POST /projects/:id/envs/:name/rollback` — rollback to specified release
3. `POST /projects/:id/envs/:name/reset` — composite env recovery
4. Normalize env DB API routes under `/db/*` (`/db/migrate`, `/db/migrations`) while keeping temporary compatibility aliases for `/migrate` and `/migrations`.
5. Extend `DeployRequest` with `skip_preflight?: boolean` and wire through CLI/API -> worker deploy call.
6. Fix `env delete` to call `deployer.deleteEnvironment()` before deleting the env record.

### Mode selection precedence (DB commands)

All `eve db` commands that accept `--url` follow this precedence:

```
--url flag  >  --env flag  >  EVE_DB_URL env var  >  .env file (EVE_DB_URL)  >  error
```

The CLI reads `.env` in the current directory when no flag or env var is set, matching
standard local development workflows.

## Unified Recovery Model

### Layer 1: Data recovery

1. `db migrate --url` and `db reset --url` run directly against Postgres using shared migration logic.
2. `db reset --env` resets schema in managed env DB without destroying tenant identity.
3. Managed tenant destroy (`db destroy`) remains available for hard recovery.

**Schema reset implementation**: Use `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
instead of `DROP DATABASE`. This avoids superuser privileges, requires no reconnection,
and preserves the database identity, roles, and credentials. If `--no-migrate` is not set,
re-apply all migrations after the schema drop.

For `--env` mode, the CLI sends migration SQL files from `--path` (default `db/migrations`)
to the API reset endpoint (same pattern as `db migrate`). The API should not assume repo
filesystem access for migration files.

### Layer 2: Deployment recovery

1. Rollback selects a known release and redeploys it.
2. Env reset handles stuck deploy artifacts and provides a clean deployment surface.
3. `env delete` remains terminal; `env reset` is the non-terminal recovery path.

**Rollback resolution**: `--release previous` resolves to the most recent release
(by `created_at`) before the current `current_release_id`, scoped to the same project.
No release history table needed — `releases` table ordering is sufficient.

**`env reset` default behavior**: When `--release` is omitted, redeploy the current
`current_release_id`. If no release has ever been deployed (pointer is null), require
`--release` explicitly.

### Layer 3: State correctness

1. Update `current_release_id` only after readiness confirmation (see Readiness Gate below).
2. If deploy fails, keep previous release pointer.
3. Diagnostics always show active pipeline runs and effective release status.

**Readiness gate mechanism**: After `deployRelease()` applies manifests, poll the
deployment rollout status (`kubectl rollout status` equivalent via k8s client) with a
configurable timeout (default: 120s). Readiness means all deployment replicas report
`Available`. If the timeout expires without readiness:
- Keep the previous `current_release_id` unchanged.
- Set a `last_failed_release_id` field on the environment for diagnostics.
- Return a clear error with the release ID that failed and pod statuses.

## Safety Model

| Command | Non-production | Production |
|---------|---------------|------------|
| `db migrate` | Runs immediately | Runs immediately |
| `db reset` | Requires `--force` | Requires `--danger-reset-production` |
| `db wipe` | Requires `--force` (implied) | Requires `--danger-reset-production` |
| `db sql --write` | Warning banner | Requires `--danger-write-production` |
| `env reset` | Requires `--force` on persistent envs | Requires `--danger-reset-production` |
| `env delete` | Confirmation prompt | Requires `--danger-delete-production` |

All destructive commands print a summary of what will be affected before executing and
require non-interactive confirmation flags (no interactive prompts in CI).

Production checks apply when targeting Eve environments via `--env`. For direct `--url`
mode, production cannot be inferred reliably; require explicit `--force` and print a
clear destructive-operation warning.

## Implementation Plan

### Phase 1a: Direct DB mode and shared migrate runner

Scope:
1. Refactor `packages/migrate` to export a reusable function (not just a CLI entrypoint).
2. Add `--url` mode to `eve db migrate`, `migrations`, `sql`, and `schema`.
3. Add `EVE_DB_URL` fallback with `.env` file loading.

**Migration runner extraction**: The current `packages/migrate/src/index.ts` calls
`process.exit()` on completion and cannot be imported as a library. Extract the core
logic into a reusable function:

```typescript
export interface MigrateOptions {
  connectionUrl: string;
  migrationsDir: string;
}

export interface MigrationResult {
  filename: string;
  applied: boolean;  // false if already applied
  checksum: string;
}

export interface MigrationStatus {
  filename: string;
  checksum: string;
  appliedAt: string;
}

export async function applyMigrations(opts: MigrateOptions): Promise<MigrationResult[]>;
export async function listMigrations(opts: MigrateOptions): Promise<MigrationStatus[]>;
```

The existing CLI entrypoint becomes a thin wrapper around `applyMigrations()`.

Primary files:
1. `packages/migrate/src/index.ts` — extract library API, keep CLI wrapper
2. `packages/migrate/src/runner.ts` — new: reusable migration logic
3. `packages/cli/src/commands/db.ts` — add `--url` path + `EVE_DB_URL` + `.env` loading

Acceptance:
1. `eve db migrate --url` works without API access.
2. `eve db migrations --url` and `eve db sql --url` work against local/CI DBs.
3. `EVE_DB_URL` from environment or `.env` file is used when no flags provided.

### Phase 1b: Fix `env delete` k8s teardown (bug fix)

Scope:
1. Fix `environments.service.delete()` to call `deployer.deleteEnvironment()` before
   deleting the environment record.
2. Handle the case where the deployer or namespace doesn't exist (idempotent teardown).

**Why this is Phase 1b**: This is a P0 bug — `eve env delete` currently orphans running
pods, services, and ingresses in k8s. It only deletes managed DB tenants and the DB row.
The deployer's `deleteEnvironment()` method already exists and handles namespace deletion;
it just isn't called from the environment service's delete flow.

Primary files:
1. `apps/api/src/environments/environments.service.ts` — call deployer teardown in `delete()`

Acceptance:
1. `eve env delete` removes namespace resources AND the env DB row.
2. Deleting an env with no namespace (never deployed) still succeeds.
3. No orphaned k8s workloads after deletion.

### Phase 2: DB reset API and CLI

*Parallelizable with Phase 3.*

Scope:
1. Add `db reset` command and `db wipe` alias.
2. Add env DB reset API endpoint.
3. Normalize env DB endpoints to `/db/*` route shape and keep backward-compatible aliases.
4. Implement schema reset via `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`.
5. Re-apply migrations after schema drop unless `--no-migrate` is set.

Primary files:
1. `apps/api/src/environments/env-db.controller.ts` — add `POST .../db/reset` endpoint
2. `apps/api/src/environments/env-db.service.ts` — add `resetSchema()` method
3. `packages/cli/src/commands/db.ts` — add `reset` and `wipe` subcommands
4. `packages/shared/src/schemas/*` — request/response types for reset

Acceptance:
1. `eve db reset --env` performs synchronous reset and reports applied migrations.
2. `eve db reset --url` matches behavior in direct mode.
3. Production guard flags are enforced per the safety model.

### Phase 3: Release-based deploy recovery

*Parallelizable with Phase 2.*

Scope:
1. Wire `DeployRequest.release_tag` (already in schema) to a `--release-tag` CLI flag on `env deploy`.
   Update CLI validation to allow exactly one of `--ref` or `--release-tag`.
2. Add `env rollback` CLI command and `POST .../rollback` API endpoint.
3. Implement release resolution: by ID, by tag (via `findByProjectAndTag`), or `previous`
   (by `created_at` ordering before current release).
4. Add optional `--skip-preflight` passthrough from CLI to deploy requests.

**Note**: The worker's `deployer.rollback()` method already exists and delegates to
`deploy()` with the target release. This phase is primarily CLI + API wiring, not
new deployer logic.

Primary files:
1. `packages/cli/src/commands/env.ts` — add `--release-tag` flag, `rollback` subcommand
2. `apps/api/src/environments/environments.controller.ts` — add rollback endpoint
3. `apps/api/src/environments/environments.service.ts` — add release resolver
4. `packages/shared/src/schemas/release.ts` — rollback request/response types

Acceptance:
1. `eve env deploy --release-tag v1.2.3` deploys the release matching that tag.
2. `eve env rollback --release previous` redeploys the release before the current one.
3. `eve env rollback --release rel_xxx` redeploys by release ID.
4. Clear error when release tag/ID not found.

### Phase 4: Environment reset composite operation

*Depends on Phase 1b (teardown fix) and Phase 3 (rollback).*

Scope:
1. Add `env reset` composite operation: cancel active pipeline runs -> teardown env
   workloads -> optionally redeploy release -> verify readiness.
2. Reuse `deployer.deleteEnvironment()` for teardown and `deployer.deploy()` for redeploy.

Primary files:
1. `apps/api/src/environments/environments.service.ts` — add `reset()` method
2. `apps/api/src/environments/environments.controller.ts` — add `POST .../reset` endpoint
3. `packages/cli/src/commands/env.ts` — add `reset` subcommand

Acceptance:
1. Reset recovers from failed rollout artifacts without manual kubectl.
2. Reset without `--release` redeploys the current release pointer.
3. Reset with `--release` deploys the specified release after teardown.

### Phase 5: State correctness and hardening

Scope:
1. **Readiness-gated `current_release_id`**: After `deployRelease()`, poll deployment
   rollout status for up to 120s (configurable). Only update `current_release_id` when
   all replicas are `Available`. On timeout, keep the previous pointer and set
   `last_failed_release_id` on the environment record. Return pod statuses in the error.
2. **Managed DB local TLS fix**: Add `EVE_DB_SSL_MODE` env var to the managed DB
   reconciler, defaulting to `require` in production and `disable` in local k3d
   (detected via the `eve-local` cluster context or an explicit overlay config).
3. **Image existence preflight**: Before rollout apply, verify all image digests in
   the release exist in the registry. Hard-fail with a clear error listing missing
   images. Skip with `--skip-preflight` if needed.

Primary files:
1. `apps/api/src/environments/environments.service.ts` — readiness gate on deploy
2. `apps/worker/src/deployer/deployer.service.ts` — readiness polling + preflight
3. `apps/orchestrator/src/cron/managed-db-reconciler.service.ts` — TLS mode config
4. `packages/db/migrations/*` + `packages/db/src/queries/environments.ts` — add/persist `last_failed_release_id`
5. `packages/shared/src/schemas/environment.ts` — expose `last_failed_release_id` in API response schema

Acceptance:
1. Failed deploy does not advance current release pointer.
2. `last_failed_release_id` is set on the environment after a failed deploy.
3. Local managed DB provisioning no longer fails due to forced TLS mismatch.
4. Deploy fails fast with clear error when images are missing from registry.

### Phase 6: Recovery diagnostics (follow-up)

Scope:
1. Add `eve env recover <env>` command that analyzes environment state and outputs
   a concrete suggested next action.
2. Checks: stuck pods (ImagePullBackOff, CrashLoopBackOff), failed migrations,
   stale pipeline runs, release pointer vs actual deployment mismatch.
3. Output format: problem summary + suggested command to run.

Primary files:
1. `packages/cli/src/commands/env.ts` — add `recover` subcommand
2. `apps/api/src/environments/environments.service.ts` — add recovery analysis method

Acceptance:
1. `eve env recover staging` identifies the current failure mode.
2. Suggested command is copy-pasteable and addresses the identified issue.

## Testing Plan

### Unit

1. DB CLI mode selection precedence (`--url` > `--env` > `EVE_DB_URL` > `.env` > error).
2. Safety guard behavior per command per environment type (see safety model table).
3. Rollback release resolver (`id`, `tag`, `previous`).
4. `.env` file loading for `EVE_DB_URL`.
5. `env deploy` arg validation (`--ref` xor `--release-tag`).

### Integration

1. `db reset --env` resets schema and reapplies migrations.
2. `db reset --url` resets schema via direct connection.
3. `env deploy --release-tag` deploys expected release.
4. `env rollback --release previous` restores previous release and health.
5. `env reset` clears broken deployment state and recovers.
6. `env delete` removes namespace resources AND env row (no orphans).
7. Failed deploy does not advance `current_release_id`.
8. Deploy with missing image fails fast with clear error.
9. `db migrate` and `db migrations` work on `/db/*` routes (with compatibility aliases preserved during transition).

### Manual scenarios (local k3d)

1. Reproduce image pull failure, recover via `env rollback`.
2. Reproduce migration/schema conflict, recover via `db reset`.
3. Validate M01 endpoint contract after recovery.
4. Delete environment, verify no orphaned pods/services remain.

## Rollout

1. **Ship Phase 1a + 1b first** — lowest risk, highest immediate value. Phase 1b is a bug fix.
2. **Ship Phase 2 and Phase 3 in parallel** — independent work streams.
3. **Ship Phase 4** after Phases 1b and 3 land (depends on both).
4. **Ship Phase 5** after integration tests prove readiness gate correctness.
5. **Ship Phase 6** as a follow-up — valuable but not blocking recovery workflows.

## Documentation Updates (Required)

1. `docs/system/db.md`
2. `docs/system/deploy-polling.md`
3. `docs/system/deployment.md`
4. `docs/system/manifest.md` (if deploy inputs/flags behavior changes)
5. `docs/ideas/self-service-deploy-recovery.md` — add superseded pointer
6. `docs/ideas/db-migrate-direct-and-reset.md` — add superseded pointer
7. Public skillpack refs in `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md` and `references/deploy-debug.md`
