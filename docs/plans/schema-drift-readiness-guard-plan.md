# Schema Drift Readiness Guard & Migration Numbering Plan

> **Status**: Proposed
> **Created**: 2026-05-13
> **Origin**: Production incident on a downstream cluster — API at v0.1.281 had been deployed against a database last migrated on v0.1.225 (~6 weeks / 10 unapplied migrations). A code path that referenced `jobs.harness_profile_override` (added by `00090_per_job_harness_overrides.sql`) raised an opaque HTTP 500 to the client; nothing detected or surfaced the schema drift.

## The Problem

The platform allows an API pod to start, pass readiness, and serve traffic against a database whose schema is behind the migrations bundled in the same release artifact. The mismatch is silent until a request happens to touch new schema; then it surfaces as `PostgresError: column "X" of relation "Y" does not exist` wrapped in a generic 500.

Operators running `eve-migrate` out of band — or downstream operators whose deploy pipeline forgets to apply migrations — get healthy-looking pods that serve normal traffic for most paths and 500 only on the codepaths that hit new columns. The window between "code shipped" and "operator notices" can be weeks.

A secondary, smaller issue: the migrations directory contains two files at the `00090_` prefix (`00090_add_env_applied_release_and_failure.sql` and `00090_per_job_harness_overrides.sql`). They sort and apply correctly today, but the colliding numbering invites future ordering mistakes.

## 5 Whys Root Cause Analysis

### Why #1: Why can the API serve traffic against a schema older than its code?
The `/health` endpoint at `apps/api/src/health/health.controller.ts` does `SELECT 1` and nothing more. It does not compare the bundled migration list to the `_migrations` table. Kubernetes treats the pod as Ready as soon as that endpoint returns 200, regardless of schema state.

### Why #2: Why is there no schema-version handshake at startup?
The migration runner (`packages/db/src/migrate.ts`) and the API service are decoupled: migrate is its own container image and its own Job, and the API has no startup hook that reads `_migrations` or the bundled `migrations/*.sql` filenames. Migrate-on-startup was explicitly avoided historically — likely to keep API startup fast and to allow operators to stage non-additive migrations by hand — but the trade-off was made without adding a *detection* path to replace it.

### Why #3: Why does a missing column surface as an opaque 500 rather than a typed error?
The job-create path in `packages/db/src/queries/jobs.ts` ultimately issues SQL referencing `harness_profile_override`. When the column is absent, `postgres@3.4.8` throws a `PostgresError` whose name is `PostgresError` and message contains the column name. NestJS's default `ExceptionsHandler` logs it (good — we found the trace) but renders it as `{ "statusCode": 500, "message": "Internal server error" }`. There is no error class for "database schema is behind bundled code," nor any mapping from PostgresError `42703` (`undefined_column`) to a specific 5xx with an actionable body.

### Why #4: Why didn't the downstream operator's deploy flow apply the migrations?
The downstream `eve-infra deploy` CLI applied kustomize-built Deployment manifests but explicitly excluded the `eve-db-migrate` Job (Kubernetes Jobs are immutable, so `kubectl apply` over a completed Job is a no-op). The original design parked migrate-running on a GitHub Actions workflow that was later deleted. The exclusion comment in the kustomization stayed, pointing at infrastructure that no longer exists. That bug is being fixed downstream by folding migrate into deploy — but the platform allowed the failure mode to exist in the first place because nothing forced the issue at the API surface.

### Why #5: Why wasn't this caught by the existing alerting / smoke tests?
The deployed-image version and the migrated-schema version are not compared anywhere — not in health checks, not in `eve-infra status`, not in upstream's own staging smoke tests. There is no canary path that exercises a recently-added column on every release. The `_migrations` table is opaque to all of the platform's observability.

---

## Root Cause Summary

**Two independent gaps compound:**

1. **No schema-vs-code consistency check at startup.** The API will happily serve against a schema that's older than its bundled migrations. This converts an operator workflow gap (missed migrate) into invisible silent drift that only surfaces on the unhappy paths of new features.
2. **Untyped Postgres errors leak through as opaque 500s.** Even *when* the schema mismatch fires, the response gives operators no signal pointing at the actual fault.

And one numbering smell:

3. **Two migrations share the `00090_` prefix.** Not breaking today, but a foot-gun for the next person reading commit history or trying to bisect a regression.

---

## Proposed Changes

### 1. Add a `/health/ready` endpoint that gates on schema freshness

**File:** `apps/api/src/health/health.controller.ts`
**What:**
- Add a new `@Get('ready')` handler distinct from the existing `@Get()` liveness handler.
- At handler time, list `<package-root>/packages/db/migrations/*.sql` filenames (the same list the migration runner uses).
- Query `SELECT name FROM _migrations` and compute the diff.
- If the set of `migrations/*.sql` filenames is a subset of applied names, return `{ status: 'ready' }` plus a count.
- Otherwise raise `ServiceUnavailableException` with a structured body listing the missing migration filenames.

**Why:** Kubernetes readiness gating already removes failing pods from the Service endpoints. A pod that comes up against a stale DB will simply never become Ready, surfacing the drift to the operator within seconds (via `kubectl get pods` showing `0/1`) rather than weeks (silent until a new-schema codepath fires).

**Caveat:** The filename-listing should be done **once at module init**, not on every request, so a request-rate-driven file system scan doesn't become a hot path. Cache the result in memory at boot; the bundle is immutable per pod.

**Caveat 2:** This intentionally does *not* run migrations. Auto-migrate-on-start is a separate design question (transaction locking, multi-pod startup races) and out of scope here.

### 2. Update `livenessProbe` vs `readinessProbe` paths in the platform's reference manifests

**Files:**
- `k8s-templates/` (or whichever sister-repo holds the reference manifests; downstream copies will inherit)
- Both downstream overlays in this incident's repo: `k8s/base/api-deployment.yaml` (already in the downstream).

**What:** Point the readiness probe at `/health/ready` and keep the liveness probe at `/health`. A schema-drift failure should block traffic without restarting the pod (a restart wouldn't help — the DB still isn't migrated).

**Why:** Without splitting the probe paths, a failing readiness check would also fail liveness and trigger a crash-restart loop, which would be both noisy and useless.

### 3. Add an "old code on new schema" warning case (forward-only check)

**File:** `apps/api/src/health/health.controller.ts`
**What:** If `_migrations` contains names not present in the bundled list, log a structured warning (`SCHEMA_AHEAD_OF_CODE`) but **still return Ready**. This catches the rollback case: when an operator downgrades the API image but the DB has migrations from the newer release.

**Why:** Forward-compatible migrations should not block a rollback. Surfacing a warning gives the operator confirmation without blocking traffic. (If a future migration is non-additive, the operator already needs to hand-stage the rollback.)

### 4. Map `undefined_column` / `undefined_table` Postgres errors to a typed 5xx with a clear body

**File:** `apps/api/src/main.ts` (the global exception filter that the `transient-500-retry-improvements` plan also touches — coordinate)
**What:** When the underlying cause is a `PostgresError` with code `42703` (`undefined_column`) or `42P01` (`undefined_table`), respond with:
```json
{
  "statusCode": 503,
  "error": "SchemaDrift",
  "code": "SCHEMA_DRIFT",
  "message": "Database schema is behind the running code. Run `eve db migrate` against this database.",
  "details": { "missing": "jobs.harness_profile_override" }
}
```
**Why:** When (#1) is in place, drift should never surface to clients at all — but if there's a race window (pod becomes Ready, then a migration is rolled back, then a request lands), the typed error tells the operator exactly what to do instead of bare 500.

### 5. Deconflict the two `00090_*` migrations

**Files:**
- `packages/db/migrations/00090_add_env_applied_release_and_failure.sql` → rename to `00088_add_env_applied_release_and_failure.sql` (it predates 00089 by content/intent — verify with `git log`).
- Or alternatively bump `00090_per_job_harness_overrides.sql` → `00091_per_job_harness_overrides.sql` and renumber the existing 00091/00092/… cascade.

**What:** Pick whichever rename produces the smaller diff. Renaming a file that **has already been applied to every existing cluster** is dangerous — the migrate runner tracks by full filename, so the rename would cause it to re-apply. Two safe options:

- **Option A (no rename, additive only):** Leave the existing files alone. Add a CI check (`packages/db/scripts/check-migration-numbering.sh`) that fails the build if two migrations share a numeric prefix. Document the convention in `packages/db/README.md`.
- **Option B (idempotent rename):** Rename the file in the source tree AND insert the new name into every existing `_migrations` table via a *new* migration `00098_alias_migration_00090_per_job_harness_overrides.sql` that does:
  ```sql
  INSERT INTO _migrations (name) VALUES ('<new-name>')
    ON CONFLICT (name) DO NOTHING;
  ```
  Then the migrate runner will skip the renamed file on existing clusters and apply it normally on fresh ones.

**Recommendation:** Option A. The numbering collision is cosmetic; Option B's complexity outweighs the benefit.

**Why:** Prevent the next person from getting the ordering wrong, without paying the rename cost on already-deployed clusters.

### 6. Add a release-canary migration smoke test

**File:** `apps/api/test/migration-canary.spec.ts` (new)
**What:** A test that, against a fresh DB, runs all migrations and then asserts each column referenced in `packages/db/src/queries/*.ts` exists in `information_schema.columns`. Could be implemented by parsing the SQL with `pgsql-parser` or by introspecting Drizzle/Kysely (whichever the codebase uses) at test time.

**Why:** Catches "code references column that no migration creates" at PR time, not in production. This is the inverse of (#1): (#1) protects against operators missing migrations; this protects against developers forgetting to add the migration to a feature PR.

---

## Implementation Order

1. **(#1) Readiness endpoint** — biggest immediate impact, smallest blast radius. Self-contained in one file.
2. **(#2) Probe path update in reference manifests** — pairs with (#1); without it, (#1) buys nothing.
3. **(#4) Typed Postgres error mapping** — safety net for the race window. Coordinate with the existing transient-500-retry-improvements plan if that has shipped.
4. **(#5) Option A numbering CI check** — small PR, lands anytime.
5. **(#3) Forward-only warning** — small follow-up after (#1) is in.
6. **(#6) Canary spec** — last; it's a developer-side improvement, not an operator-side one.

## Testing

**For #1 + #2:**
- Unit: `health.controller.spec.ts` — mock `_migrations` query returning a strict subset of bundled filenames, assert `ServiceUnavailableException` with body listing the missing names.
- Integration: spin up the API container against a Postgres image whose `_migrations` was truncated; assert `kubectl wait --for=condition=Ready` times out and `/health/ready` returns 503 with the missing list.
- Rollout test: with full migrations applied, assert `/health/ready` returns 200 in <50ms (filename list is cached at boot).

**For #4:**
- Unit: throw a `PostgresError` with code `42703` from a mocked DB; assert the global filter renders the `SCHEMA_DRIFT` body with HTTP 503.

**For #5 Option A:**
- Unit: write a script test that creates a fixture directory with `00090_foo.sql` and `00090_bar.sql` and asserts the check exits non-zero.

**For #6:**
- The spec itself is the test. Run it in CI on every PR.

## Risk & Rollback

- **#1/#2** — If a fresh cluster has zero migrations applied (brand-new install), the readiness check would fail and the pod never reaches Ready. Either run migrations as an init-container, or have the readiness check treat "zero migrations applied AND zero recorded" as a special "not-yet-bootstrapped" state that returns 200 with a warning. The simpler resolution: the existing deploy flow already runs migrations before pods start; this just enforces the ordering.
- **#4** — Mapping arbitrary `PostgresError` to 503 may mask real schema bugs in code (e.g. typoed column name in a query). Limit the typed-error mapping to errors raised during `_migrations` drift specifically — if (#1) is in place, this code path should only fire during the race window.
- **#5 Option A** — Zero data risk; pure source-tree convention.
- **#6** — May add 10–30s to CI. Consider gating it to the `db`/`api` packages' file paths only.

## Out of Scope (Filed Separately)

- The downstream `eve-infra deploy` CLI now fold-runs `db migrate` before applying manifests (fixed in the downstream repo at `bin/eve-infra` and overlay kustomizations). That fix prevents the failure-mode at the operator layer; the changes in this plan defend the API surface itself.
- The "manifest sync returns 500 but persists" symptom reported by the same incident is a separate transactional-response-correctness bug in `apps/api/src/projects/projects.service.ts`'s manifest handler. File a distinct plan.
