# Robust First-Deploy Experience for Eve Starter Apps

> Status: Complete
> Created: 2026-02-24
>
> Updated: 2026-02-24
> Dependencies: None — platform + starter changes only (`eve-horizon-2` for API/worker, `../eve-horizon-starter` for template app).
>
> References:
> - `../eve-horizon-starter/.eve/manifest.yaml` (environment + pipeline config)
> - `../eve-horizon-starter/apps/api/db.js` (database connection)
> - `../reference-app/.eve/manifest.yaml` (working reference — uses `type: job`, SSL handling)
> - `../reference-app/apps/api/src/db.ts` (SSL pattern to replicate)
> - `apps/worker/src/action-executor/action-executor.service.ts` (pipeline action routing)
> - `apps/worker/src/deployer/deployer.service.ts` (managed DB resolution)
> - `apps/orchestrator/src/cron/managed-db-reconciler.service.ts` (SSL mode)
> - `apps/api/src/environments/environments.service.ts` (deploy routing)

## Problem

Deploying `eve-horizon-starter` to staging fails at multiple points. The quickstart promise of "two commands to deploy" is broken:

```bash
eve project sync --dir .
eve env deploy sandbox --ref main   # fails
```

**Four cascading failures discovered during verification:**

1. **Environment bypasses pipeline** — `environments.sandbox` lacks `pipeline: deploy-sandbox`, so `eve env deploy` takes the direct path (no build, no migrate, no pipeline at all)
2. **Wrong action type for migrations** — Pipeline uses `type: run` (bash command executor) instead of `type: job` (service container runner). Error: "Run action requires either command or command_ref"
3. **SSL cert crash** — Managed Postgres URLs include `sslmode=require`, but the starter's `db.js` passes the URL raw to `pg.Pool`, causing `SELF_SIGNED_CERT_IN_CHAIN` against RDS
4. **Opaque error messages** — When `type: run` + `service:` is used without `command`, the platform gives no guidance on the fix

**Why reference-app works**: It uses `type: job` for migrations, has explicit SSL handling (`rejectUnauthorized: false`), and its environment references its pipeline.

**Clarification — build reuse is NOT broken**: `findReusableBuild()` correctly keys on `git_sha + manifest_hash`. When git_sha changes (new code push), a new build is triggered. The perceived "no rebuild" issue was caused by Failure #1 — direct deploy bypasses the pipeline entirely, so no build step ever runs.

## Goal

Make `eve env deploy sandbox --ref main` work end-to-end on first attempt for the starter template, and add platform guardrails so future apps don't hit these same issues.

## Execution Checklist

| Status | Owner | Item | Acceptance |
| --- | --- | --- | --- |
| - [x] | `../eve-horizon-starter` | Add `pipeline: deploy-sandbox` under `environments.sandbox` in `./.eve/manifest.yaml` | `eve env deploy sandbox --ref main` enters pipeline flow (build/release/deploy/migrate) |
| - [x] | `../eve-horizon-starter` | Change migrate step from `type: run` to `type: job` for service container execution | `migrate` step uses service container and does not hit `Run action requires either command or command_ref` |
| - [x] | `../eve-horizon-starter` | Add SSL-aware DB pool config in `apps/api/db.js` (reads `sslmode` param from URL) | Starter app boots against managed Postgres URLs with `sslmode=disable` (k3d) and `sslmode=require` (cloud) |
| - [x] | `eve-horizon-2` | Add explicit error in `action-executor` for `type: run` + `service` + missing command | Error message suggests `type: job` for service-backed actions |
| - [x] | `eve-horizon-2` | Add auto-resolution for this same manifest shape in `action-executor` execution path | Deployment continues with warning and no manual re-run required for legacy bad manifests |
| - [x] | `eve-horizon-2` + starter | Run k3d verification sequence (`project sync` + `env deploy`) and validate API/todos endpoints | `curl` health/todos checks pass and migration step creates expected schema objects |
| - [ ] | Cross-repo | Update `eve-read-eve-docs` references if behavior changes are accepted | Public docs include new guardrail/error guidance behavior |

---

## Phase 1: Fix the Starter Template

*Repo: `../eve-horizon-starter`*

### 1A. Wire environment to pipeline

**File**: `.eve/manifest.yaml`

```yaml
# BEFORE
environments:
  sandbox:
    type: persistent

# AFTER
environments:
  sandbox:
    type: persistent
    pipeline: deploy-sandbox
```

Without this, `eve env deploy sandbox` calls `deployDirect()` and skips the pipeline flow. That creates a release and deploys immediately with no build and no migration.

### 1B. Fix migrate step action type

**File**: `.eve/manifest.yaml`

```yaml
# BEFORE
      - name: migrate
        depends_on: [deploy]
        action:
          type: run
          service: migrate

# AFTER
      - name: migrate
        depends_on: [deploy]
        action:
          type: job
          service: migrate
```

`type: run` routes to `handleRun()` which expects a bash `command` property. `type: job` routes to `handleJob()` which understands `service:` and runs the container defined by `x-eve.role: job`. This matches reference-app's working pattern.

### 1C. Add SSL-aware database connection

**File**: `apps/api/db.js`

Replace naive `pg.Pool` setup with SSL awareness, following reference-app's proven pattern (`apps/api/src/db.ts`):

```javascript
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/eve_starter';

const parsed = new URL(DATABASE_URL);
const isLocal = ['localhost', '127.0.0.1'].includes(parsed.hostname);

// Strip sslmode from URL for non-local — we handle SSL via the driver option
if (!isLocal) {
  // managed DB URLs include sslmode=require; pg handles TLS via ssl option below
  parsed.searchParams.delete('sslmode');
}

const pool = new pg.Pool({
  connectionString: parsed.toString(),
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const query = (text, params) => pool.query(text, params);
const close = () => pool.end();

export { pool, query, close };
```

**Why**: Eve's managed DB reconciler (`managed-db-reconciler.service.ts`) adds `sslmode=require` to non-local URLs. The `pg` driver interprets this as needing cert verification. RDS certs aren't in Node's default CA bundle. `rejectUnauthorized: false` maintains encryption without cert pinning — acceptable for internal AWS networking.

---

## Phase 2: Platform Guardrails

*Repo: `eve-horizon-2`*

### 2A. Detect `type: run` + `service:` mismatch with clear guidance

**File**: `apps/worker/src/action-executor/action-executor.service.ts` (`handleRun`)

Before the generic "requires either command or command_ref" error, detect the common mistake:

```typescript
if (!command && !input.command_ref && input.service) {
  throw new Error(
    `Pipeline step uses "type: run" with "service: ${input.service}" but no "command". ` +
    `To run a service container, use "type: job" instead. ` +
    `Change your manifest to: action: { type: job, service: ${input.service} }`
  );
}
```

### 2B. Auto-resolve `type: run` + `service:` to `type: job`

**File**: `apps/worker/src/action-executor/action-executor.service.ts` (`execute`)

Before the action type switch, add auto-resolution so existing manifests with this mistake still work:

```typescript
let resolvedActionType = actionType;
if (
  actionType === 'run' &&
  mergedInput.service &&
  !mergedInput.command &&
  !mergedInput.command_ref
) {
  this.logger.warn(
    `Auto-resolving "type: run" to "type: job" for service "${mergedInput.service}" ` +
    `(no command provided). Update manifest to use "type: job" directly.`
  );
  resolvedActionType = 'job';
}
```

Then use `resolvedActionType` in the switch. Belt-and-suspenders — the starter fix (1B) is the primary fix; this prevents other apps from hitting the same trap.

---

## Phase 3: Deploy to Staging & Verify

1. Commit and push starter template changes
2. Build + test eve-horizon-2 changes (`pnpm build && pnpm test`)
3. Deploy eve-horizon-2 to staging if platform changes included
4. Test fresh deploy from starter template on staging:
   ```bash
   eve profile use staging
   eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
   cd ../eve-horizon-starter
   eve project sync --dir .
   eve env deploy sandbox --ref main
   ```
5. Verify:
   - Pipeline runs: build -> release -> deploy -> migrate (all green)
   - Health check: `curl http://api.<host>/health` returns `{"status":"ok"}`
   - Todos endpoint: `curl http://api.<host>/todos` returns `[]`
   - Migrations applied (todos table exists)

If validation fails:
1. Isolate the failing repo's change and roll back only that change set.
2. Re-run `eve project sync --dir .` in starter and rerun `eve env deploy sandbox --ref main`.
3. Capture logs with `eve pipeline logs` + `eve job diagnose` and reapply the smallest fix.

### Required follow-up

- Update public docs (`../eve-skillpacks/eve-work/eve-read-eve-docs`) for any platform behavior changes from Phase 2.
- Reopen or create a ticket for any remaining staging-only flakes (DB readiness, host naming, and smoke-test improvements).

---

## Files Modified

| File | Repo | Change |
|------|------|--------|
| `.eve/manifest.yaml` | eve-horizon-starter | Add `pipeline: deploy-sandbox` to environment, fix `type: run` -> `type: job` |
| `apps/api/db.js` | eve-horizon-starter | SSL-aware connection (reference-app pattern) |
| `apps/worker/src/action-executor/action-executor.service.ts` | eve-horizon-2 | Detect + auto-resolve `type: run` + `service:` mismatch |

## Out of Scope (track separately)

- **`eve db migrate` 403 permission issue** — needs RBAC investigation; not blocking first-deploy via pipeline (migrations run as a pipeline job, not via CLI)
- **Managed DB readiness timeout** — 60s poll with 2s interval is sufficient for local/staging; monitor for production
- **Smoke-test step in starter pipeline** — nice-to-have but `script:` steps need env var interpolation for deployed host URL which isn't straightforward yet
- **Platform-level `sslmode` fix** — the app-side fix (1C) is simpler and more portable than changing managed DB URL generation. Could revisit later with a `EVE_DB_SSL_NO_VERIFY` companion env var.
- **`eve env deploy` always-rebuild semantics** — not actually needed; build reuse correctly keys on git_sha. The perceived issue was caused by direct deploy bypassing the pipeline.

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Pipeline reference in env | Low | Only affects `eve env deploy` routing; explicit opt-in |
| `type: job` migration step | Low | Matches reference-app working pattern; `handleJob()` is battle-tested |
| SSL `rejectUnauthorized: false` | Low | Same pattern as reference-app in production; still encrypted, just no cert pinning |
| Auto-resolve `run` -> `job` | Low | Only triggers when `service:` present + no `command`/`command_ref`; logs a warning and preserves compatibility for this common manifest mistake. |
