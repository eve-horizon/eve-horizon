# Declarable Managed-Postgres Extensions Plan

> **Status**: Phase 1 implemented locally; Phase 2 provider-gated `pg_cron` support implemented as opt-in; TimescaleDB provider decision still required
> **Last Updated**: 2026-05-18
> **Purpose**: Let an Eve app declare in its manifest the list of Postgres extensions it needs on the managed DB. Eve records the declaration during deploy, then enables supported tenant-local extensions through the managed-DB reconciler using an admin connection before app migrations run. Extensions that require `shared_preload_libraries` are gated on explicit provider support and, for AWS, Terraform-managed parameter-group changes in `../deployment-instance`.
> **Source**: `~/dev/eve-horizon/eve-horizon/docs/plans/managed-postgres-extensions-plan.md`
> **Reference**: External spec `002 — Declarable managed-Postgres extensions` (PVS rebuild, opened 2026-05-13).

---

## 1) Why This Plan

[`packages/migrate/src/runner.ts:101-105`](../../packages/migrate/src/runner.ts) already does:

```ts
async function ensureExtensions(db: ReturnType<typeof postgres>): Promise<void> {
  await db`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await db`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
}
```

Apps that want anything else (PostGIS, pgvector, TimescaleDB, pg_cron, …) either embed `CREATE EXTENSION` in app migrations and hope the cloud allows it, or work around the platform with side-channel scripts. Neither is acceptable for the PVS rebuild, which wants to commit to Postgres-first storage with geographies and time-series behavior *before* it writes a line of schema. This plan makes supported extensions declarable while refusing to promise provider-impossible capabilities like TimescaleDB on AWS RDS.

This plan keeps the surface area small:

- **Just a list, not a catalog.** Apps declare `extensions: [...]` under `x-eve.managed`. The platform agrees to install everything in that list.
- **One installer, provider-gated capabilities.** The reconciler runs `CREATE EXTENSION IF NOT EXISTS` through the backing instance's admin connection. Plain extensions only need their package to be available on that instance. Preload-required candidates are not exposed until the provider has the package, the preload configuration, and safe tenant semantics.
- **No availability tiers, no `required: false`, no validation API.** The curated allowlist is documentation plus a sync-time check, not a runtime concept.

**Implementation note (2026-05-18):** Phase 1 is implemented in Eve Horizon for the `local` managed-DB provider: manifest validation, tenant desired/enabled extension tracking, reconciler installation, API/CLI reporting, local k3d Postgres image support, and docs/skillpack references. Phase 2 adds opt-in `pg_cron` gating through `EVE_MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS=pg_cron`, shared-preload preflight checks, local k3d preload support, and Terraform-managed RDS parameter-group support in `../deployment-instance`. `timescaledb` remains a candidate, not a declarable extension, until a Timescale-capable provider model exists.

---

## 2) Current State

### 2.1 Where extensions are installed today

[`packages/migrate/src/runner.ts:101-105`](../../packages/migrate/src/runner.ts) installs `pgcrypto` and `"uuid-ossp"` unconditionally at the start of every `applyMigrations()` call. The runner runs as the user-defined `x-eve.role: job` service whose image is `public.ecr.aws/w7c4v0w3/eve-horizon/migrate:latest` — see the fullstack example manifest:

```yaml
migrate:
  image: public.ecr.aws/w7c4v0w3/eve-horizon/migrate:latest
  environment:
    DATABASE_URL: ${managed.db.url}
  x-eve:
    role: job
    files:
      - source: db/migrations
        target: /migrations
```

The CLI entry [`packages/migrate/src/index.ts`](../../packages/migrate/src/index.ts) reads `DATABASE_URL` and `MIGRATIONS_DIR` from the environment. There is no env var for additional extensions.

### 2.2 Where managed-DB tenants are created

[`apps/orchestrator/src/cron/managed-db-reconciler.service.ts:459-502`](../../apps/orchestrator/src/cron/managed-db-reconciler.service.ts) provisions tenants on the `local` provider by running `CREATE ROLE` / `CREATE DATABASE` against the system Postgres. Extensions are never touched here today. The only current extension install path is the migrate runner's unconditional `pgcrypto` / `"uuid-ossp"` setup, and that runs later as the tenant user.

This matters because some extensions (e.g. PostGIS, TimescaleDB) require `CREATE EXTENSION` to be run by a superuser. The tenant role is **not** a superuser. So we need to install extensions during provisioning (as the admin connection) rather than during migrate (as the tenant role).

### 2.3 Manifest schema for managed DB

[`packages/shared/src/schemas/manifest.ts:133-140`](../../packages/shared/src/schemas/manifest.ts):

```ts
export const ManagedDbConfigSchema = z.object({
  class: z.string().min(1),
  engine: z.literal('postgres').default('postgres'),
  engine_version: z.string().optional(),
  backup: ManagedDbBackupConfigSchema.optional(),
});
```

No `extensions` field.

### 2.4 Where `${managed.db.url}` interpolation happens

[`apps/worker/src/deployer/deployer.service.ts:3345-3356`](../../apps/worker/src/deployer/deployer.service.ts) resolves `${managed.<svc>.<field>}` from a `managedValues: Map<string, string>` populated at [line 1751](../../apps/worker/src/deployer/deployer.service.ts). Today only `url` is populated. We can add `extensions` as a second key without altering the resolution shape.

### 2.5 Local k3d Postgres image

[`k8s/base/postgres-statefulset.yaml:36`](../../k8s/base/postgres-statefulset.yaml) uses `postgres:16-alpine`. That image has **no** PostGIS / pgvector / TimescaleDB / pg_cron available. Local verification needs a Postgres image bundling the supported extensions.

---

## 3) Target Behaviour

1. **Manifest list of extensions**:

   ```yaml
   services:
     db:
       x-eve:
         role: managed_db
         managed:
           class: db.p1
           engine: postgres
           engine_version: "16"
           extensions: [postgis, pgvector, pg_trgm]
   ```

2. **Phase 1 tenant-local extensions** (`postgis`, `pgvector`, `pg_trgm`, `btree_gist`, `hstore`, `citext`) — Eve verifies the extension is available, then runs `CREATE EXTENSION IF NOT EXISTS <extname>` as the admin user against the tenant DB after database creation and before the migrate job runs.

3. **Preload candidates** (`pg_cron`, maybe `timescaledb`) — Eve only exposes these after provider-specific support is proven. The reconciler must fail fast when the package is unavailable, `shared_preload_libraries` is missing the library, or the extension cannot be safely installed per tenant. AWS RDS currently supports `pg_cron` but not `timescaledb` in its published extension list; `timescaledb` therefore requires a self-hosted or Timescale-capable provider path before it can be accepted in manifests.

4. **Unknown names** rejected at `eve manifest validate` and `eve project sync`.

5. **`eve db extensions list --env <env>`** returns what's actually installed (queried from `pg_extension`).

6. **`eve db status`** includes `declared_extensions`, `enabled_extensions`, and live `installed_extensions: [{ name, version }]`.

7. **Auto-installed extensions** (`pgcrypto`, `uuid-ossp`) keep working without being declared — they remain always-on in the migrate runner.

---

## 4) Design

### 4.1 Curated allowlist

Single source of truth: a new file `packages/shared/src/managed-db/extensions.ts`:

```ts
export const SUPPORTED_EXTENSION_NAMES = [
  'postgis',
  'pgvector',
  'pg_trgm',
  'btree_gist',
  'hstore',
  'citext',
] as const;

export type SupportedExtension = typeof SUPPORTED_EXTENSION_NAMES[number];

export const SUPPORTED_EXTENSIONS: Record<SupportedExtension, {
  mode: 'plain';
  extname: string;
}> = {
  postgis:    { mode: 'plain', extname: 'postgis' },
  pgvector:   { mode: 'plain', extname: 'vector' }, // canonical extname is 'vector'
  pg_trgm:    { mode: 'plain', extname: 'pg_trgm' },
  btree_gist: { mode: 'plain', extname: 'btree_gist' },
  hstore:     { mode: 'plain', extname: 'hstore' },
  citext:     { mode: 'plain', extname: 'citext' },
};
```

Manifest names map to canonical `extname` values where they differ (`pgvector` → `vector`). All `CREATE EXTENSION` statements use the canonical `extname`, quoted through a small identifier-quoting helper. Do not store a pre-quoted string in the registry; keeping raw names makes validation, comparison, and `pg_available_extensions` checks less error-prone.

Preload candidates live in a separate `PRELOAD_EXTENSION_CANDIDATES` registry until Phase 2 proves provider support:

```ts
export const PRELOAD_EXTENSION_CANDIDATES = {
  pg_cron: {
    extname: 'pg_cron',
    preloadName: 'pg_cron',
    installScope: 'instance_admin_db',
  },
  timescaledb: {
    extname: 'timescaledb',
    preloadName: 'timescaledb',
    installScope: 'tenant_db',
    providerNote: 'not supported by AWS RDS PostgreSQL as of 2026-05-18',
  },
} as const;
```

These candidates are intentionally not included in `SUPPORTED_EXTENSION_NAMES` in Phase 1. Phase 2 promotes `pg_cron` into the supported registry as a provider-gated extension: it is only accepted when `EVE_MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS=pg_cron` is configured on API, worker, and orchestrator. `timescaledb` remains a candidate until a Timescale-capable provider model exists.

### 4.2 Manifest schema change

In [`packages/shared/src/schemas/manifest.ts`](../../packages/shared/src/schemas/manifest.ts), extend `ManagedDbConfigSchema`:

```ts
export const ManagedDbConfigSchema = z.object({
  class: z.string().min(1),
  engine: z.literal('postgres').default('postgres'),
  engine_version: z.string().optional(),
  backup: ManagedDbBackupConfigSchema.optional(),
  extensions: z.array(
    z.enum(SUPPORTED_EXTENSION_NAMES)
  ).default([]).superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, name] of value.entries()) {
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate managed DB extension "${name}"`,
        });
      }
      seen.add(name);
    }
  }),
});
```

The `z.enum(SUPPORTED_EXTENSION_NAMES)` makes `eve manifest validate` and `eve project sync` reject unknown names consistently. Import from `../managed-db/extensions.js`, not the `managed-db/index.js` barrel, so manifest schema parsing does not depend on a circular export.

Normalize the parsed list before persistence:

- Dedupe is rejected at validation time, so runtime code can treat duplicates as impossible.
- Store names in `SUPPORTED_EXTENSION_NAMES` order, not manifest order. This avoids array-comparison churn when users reorder the manifest without changing intent.

### 4.3 Where extensions are installed

**Decision**: install at **provisioning time**, by the reconciler, using the admin connection. Reasoning:

- Tenant role is not a superuser. `CREATE EXTENSION` for trusted extensions works as a non-superuser only for the *trusted* subset; PostGIS and TimescaleDB are not trusted.
- Provisioning is idempotent (`IF NOT EXISTS`). Re-running the reconciler when the manifest grows a new extension is the natural way to add one to an existing tenant.
- The migrate job's pre-existing `pgcrypto`/`uuid-ossp` install path stays unchanged — those two extensions are trusted and the tenant role can run them.

In [`apps/orchestrator/src/cron/managed-db-reconciler.service.ts`](../../apps/orchestrator/src/cron/managed-db-reconciler.service.ts), after `provisionLocalDb()` succeeds, run a new `installTenantExtensions(instance, tenant, requestedExtensions)`:

1. Open an admin connection scoped to **the tenant database** (not the platform DB).
2. For each requested extension, look up its canonical `extname` in `SUPPORTED_EXTENSIONS`.
3. Query `pg_available_extensions` for the canonical `extname`. If unavailable, fail with `extension_unavailable` and include the provider/engine version in the message.
4. Run `CREATE EXTENSION IF NOT EXISTS "<extname>"`.
5. `GRANT USAGE ON SCHEMA <ext-schema> TO "<tenant-user>"` where the extension installs into a non-public schema (PostGIS uses `public` by default, fine; `pg_cron` is not Phase 1).

The requested extension list is read from the manifest service. To know which manifest to consult during reconciliation, the tenant row needs a stable record of declared extensions. Two options:

- **(A) Carry normalized extension intent on the tenant row** as `text[]`. The deployer (which has the manifest) writes this when creating the tenant; the reconciler reads it.
- **(B) Look up the manifest from the environment record.** More indirect; manifests can be edited between sync and deploy.

Pick **(A)**, but use two explicit columns:

- `desired_extensions text[] NOT NULL DEFAULT '{}'` — normalized manifest declaration.
- `enabled_extensions text[] NOT NULL DEFAULT '{}'` — normalized manifest names that the reconciler has successfully ensured.

The reconciler only acts on `desired_extensions - enabled_extensions`. Removing an extension from the manifest is therefore a no-op for the database: `desired_extensions` shrinks, `enabled_extensions` remains a historical "already enabled" set, and Eve does not run `DROP EXTENSION` in v1.

### 4.4 Deployer changes

[`apps/worker/src/deployer/deployer.service.ts`](../../apps/worker/src/deployer/deployer.service.ts):

1. In `resolveManagedDbTenants`, after `findTenantByEnv` / `createTenant`, persist the manifest's `extensions` list onto the tenant row.
2. Populate `managedValues.set("${serviceName}.extensions", extensions.join(','))` so apps can write:
   ```yaml
   environment:
     EVE_EXTENSIONS: ${managed.db.extensions}
   ```
   to forward the list into the migrate job for observability (not for installation — installation already happened by then).
3. **Wait-for-ready** semantics:
   - If the tenant is new, create it with `desired_extensions` populated.
   - If the tenant already exists, call `syncTenantDesiredExtensions(tenant.id, desiredExtensions)`.
   - If `desired_extensions` contains any name missing from `enabled_extensions` and the tenant is `ready`, acquire the tenant operation lock and set `status='modifying'`.
   - If the tenant is already `provisioning` / `modifying`, update `desired_extensions` and let the existing poll loop wait.
   - If the manifest only removes names, do not set `modifying`; removal is sticky/no-op in v1.

### 4.5 Reconciler changes

Extend the existing `modifying` path instead of adding a new state. Today `handleModifying()` only clears `desired_class`; after this change it should reconcile both scale intent and extension intent:

1. Compute `missingExtensions = desired_extensions - enabled_extensions` using normalized manifest names.
2. If `missingExtensions.length > 0`, call `installTenantExtensions(instance, tenant, missingExtensions)`.
3. On success, update `enabled_extensions` to the union of its current value and `missingExtensions`, normalized in allowlist order.
4. If `desired_class` is set, preserve the current scale behavior.
5. Transition to `ready` only after both extension and scale work are complete.

The top-level `reconcileTenant()` catch currently collapses all failures into `reconcile_error`. Introduce a small typed error (for example `ManagedDbProvisioningError`) carrying `code` and `message` so `extension_unavailable` and Phase 2 `preload_missing` survive into `last_error_code`.

### 4.6 Preflight check for preload extensions

This is Phase 2 and must not be silently bundled into Phase 1.

Before `CREATE EXTENSION` for a preload extension, the reconciler queries:

```sql
SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries';
```

If the requested name is missing, fail-fast with:

```
[preload_missing] managed DB instance <id> ("<host>") does not load "pg_cron" in shared_preload_libraries.
Add it to the instance's parameter group (see deployment-instance-repo/modules/managed-db/parameter-group.tf)
and accept the resulting RDS reboot. Re-run deploy after the instance returns to "available".
```

Also query `pg_available_extensions` before the preload check. If the extension package is not listed, fail with `extension_unavailable` rather than `preload_missing`; a parameter-group change cannot fix a package the provider does not ship.

Important provider constraints:

- Query against the **backing instance connection**, not the platform DB connection. The platform DB might be a different RDS instance with a different parameter group.
- `pg_cron` on AWS RDS is not a normal tenant-local extension. AWS documents installing it in the default `postgres` database after adding `pg_cron` to `shared_preload_libraries`, and tenant jobs require careful grants / database targeting. Eve exposes `pg_cron` only behind the explicit provider gate and treats tenant self-service scheduling as follow-up work.
- `timescaledb` is not in the current AWS RDS PostgreSQL extension list. If PVS needs TimescaleDB, this plan needs either a self-managed/Timescale-capable backing provider or a different storage design; declarability alone cannot make RDS support it.

### 4.7 CLI changes

In [`packages/cli/src/commands/db.ts`](../../packages/cli/src/commands/db.ts):

- New nested subcommand `eve db extensions list --env <env> [--project <id>] [--json]`. In the current dispatcher this means adding a top-level `case 'extensions'` and checking `positionals[0] === 'list'`.
- The command calls `GET /projects/:id/envs/:env/db/extensions`, which runs `SELECT extname, extversion FROM pg_extension ORDER BY extname` against the resolved environment DB.
- Extend `handleStatus` so the existing `eve db status` output also prints `Declared Extensions`, `Enabled Extensions`, and `Installed Extensions` when present (already in the API response — see 4.8).

### 4.8 API changes

- `GET /projects/:id/envs/:env/db/managed` — extend [`apps/api/src/environments/managed-db.service.ts`](../../apps/api/src/environments/managed-db.service.ts) and [`packages/shared/src/schemas/managed-db.ts`](../../packages/shared/src/schemas/managed-db.ts) to include:
  - `declared_extensions: string[]` from `managed_db_tenants.desired_extensions`.
  - `enabled_extensions: string[]` from `managed_db_tenants.enabled_extensions`.
  - `installed_extensions: { name: string, version: string }[]` from a live `pg_extension` query when the tenant is ready.
- `GET /projects/:id/envs/:env/db/extensions` — add this under `EnvDbController` / `EnvDbService` with `envdb:read`. It should use the same environment DB resolution path as schema/RLS so self-hosted DBs and managed DBs behave consistently.

For both endpoints, live extension query failures should not hide the tenant status. Return declared/enabled fields from the row and include a readable `installed_extensions_error` only if the tenant is ready but the live query fails.

### 4.9 Migration runner changes

[`packages/migrate/src/runner.ts:101-105`](../../packages/migrate/src/runner.ts) stays the way it is — still installs `pgcrypto` + `uuid-ossp`. We do **not** add `EVE_EXTENSIONS` parsing to the migrate runner, because installation happens during provisioning (4.3). Apps that want telemetry on what's installed can read `EVE_EXTENSIONS` from `${managed.db.extensions}` interpolation.

This is a deliberate simplification vs. the source spec, which floated putting extension install in the migrate flow. Provisioning-time install solves the superuser-permissions problem cleanly and keeps the migrate runner's contract trivial.

### 4.10 Local k3d backing instance

[`k8s/base/postgres-statefulset.yaml:36`](../../k8s/base/postgres-statefulset.yaml) uses `postgres:16-alpine` — no extensions. Two paths:

- **(A) Swap the local image** to an upstream PostGIS/pgvector-capable image and add packages for any missing supported extensions. This is quick but makes local behavior depend on upstream image contents and tags.
- **(B) Build a small `eve-postgres-local:16` image** bundling everything. Lives in `tools/postgres-local/Dockerfile`; published via `bin/eh k8s-image build-postgres`.

Pick **(B)**. Reasons: pinned versions, no surprises when upstream images move, and we can match staging/RDS extension versions where the provider supports them.

Use a Debian-based image (`postgres:16-bookworm`) unless Alpine package availability is proven during implementation. The likely package path is PGDG/apt for `postgresql-16-postgis-3`, `postgresql-16-pgvector`, and `postgresql-16-cron`, plus the TimescaleDB apt repo only if Phase 2 keeps TimescaleDB. If a package is unavailable, build that extension from source in this local image rather than weakening the platform test.

### 4.11 Staging / infra-repo work

In `deployment-instance-repo`:

- All changes must be Terraform changes in `../deployment-instance`; do not make direct AWS mutations.
- Terraform module support under `terraform/aws/modules/rds/`:
  - Custom RDS parameter group with `shared_preload_libraries = 'pg_cron'` when `pg_cron` is enabled.
  - Modify the existing managed-DB RDS instance to use it.
  - `cron.database_name` policy decided explicitly. AWS's default is the `postgres` database; tenant DB scheduling needs a platform-owned wrapper/grant model.
- Document the reboot requirement; provide a maintenance-window runbook.

This is the ~1 day of Terraform work the source spec calls out for `pg_cron`. The code and local preflight checks live in this repo; RDS parameter-group wiring lives in `../deployment-instance`. `timescaledb` is not covered by this RDS Terraform path unless AWS support is confirmed for the target engine version.

---

## 5) Execution Plan (Phased)

### Phase 1 — Plain extensions end-to-end (implemented 2026-05-18)

**Scope:**

1. Add `SUPPORTED_EXTENSIONS` registry (`packages/shared/src/managed-db/extensions.ts`).
2. Extend `ManagedDbConfigSchema` with `extensions: z.array(z.enum(SUPPORTED_EXTENSION_NAMES)).default([])` plus duplicate rejection.
3. Migration `packages/db/migrations/00101_managed_db_extensions.sql`:
   ```sql
   ALTER TABLE managed_db_tenants
     ADD COLUMN desired_extensions text[] NOT NULL DEFAULT '{}',
     ADD COLUMN enabled_extensions text[] NOT NULL DEFAULT '{}';
   ```
4. Reconciler:
   - New `installTenantExtensions(tenant, requested)` method.
   - Call from `handleProvisioning` after `provisionLocalDb`.
   - Call from `handleModifying` when `desired_extensions - enabled_extensions` is non-empty.
   - Checks `pg_available_extensions` before `CREATE EXTENSION`.
   - Updates `tenant.enabled_extensions` on success.
5. Deployer (`resolveManagedDbTenants`):
   - Read `extensions` from manifest.
   - Set `desired_extensions` on tenant; if any desired name is missing from `enabled_extensions`, push status to `modifying`.
   - Populate `managedValues.set('<svc>.extensions', extensions.join(','))`.
   - Block deploy until reconciler completes the install (same poll loop as existing readiness wait).
6. API:
   - Extend `GET /projects/:id/envs/:env/db/managed` response.
   - New `GET /projects/:id/envs/:env/db/extensions`.
7. CLI: `eve db extensions list --env <env>`.
8. Local Postgres image (`tools/postgres-local/Dockerfile`), `bin/eh k8s-image build-postgres`.
9. Swap `k8s/base/postgres-statefulset.yaml` to the new image **in the local overlay only** — staging keeps RDS.
10. Unit + integration tests.

**Acceptance:** manifest with `extensions: [postgis, pgvector, pg_trgm]` deploys cleanly; `eve db extensions list` shows `postgis`, `vector`, and `pg_trgm` with versions; re-deploy with manifest now containing `[postgis, pgvector, pg_trgm, hstore]` reconciles to add `hstore`; manifest with `[made_up_ext]` is rejected at `eve manifest validate`; manifest with duplicate names is rejected with a duplicate-extension message.

### Phase 2 — Preload candidates (`pg_cron` implemented as opt-in; TimescaleDB requires provider decision)

**Scope:**

1. Preflight check in reconciler:
   - Before `CREATE EXTENSION` for a preload extension, query `SHOW shared_preload_libraries`.
   - If missing, fail with `preload_missing` error code and infra-repo hint.
   - If `pg_available_extensions` lacks the extension, fail with `extension_unavailable`.
2. `deployment-instance-repo` Terraform adds an opt-in RDS parameter group with `shared_preload_libraries = 'pg_cron'` when `managed_db_enabled_preload_extensions = ["pg_cron"]`.
3. `pg_cron` tenant semantics:
   - `pg_cron` installs in the instance admin DB (`postgres`), matching AWS RDS's documented model.
   - The reconciler grants `USAGE` on the `cron` schema to the tenant role after install.
   - App self-service scheduling across tenant DBs is still intentionally constrained by the AWS model; tenant DB targeting remains a platform-managed/admin operation.
4. Local image (`tools/postgres-local/Dockerfile`) bakes `pg_cron`; the local overlay starts Postgres with `shared_preload_libraries=pg_cron` and `cron.database_name=postgres`.
5. Integration tests:
   - Manifest with `[pg_cron]` is rejected until provider support is explicitly enabled.
   - With provider support enabled and configured, `pg_cron` deploys cleanly according to the chosen tenant model.
   - Misconfigured preload library fails with actionable `preload_missing`.
   - AWS RDS + `timescaledb` fails with `extension_unavailable` unless AWS support is confirmed for the target engine version.

**Acceptance:** PVS can declare `postgis` and `pgvector` in Phase 1. PVS can declare `pg_cron` only on platform instances that explicitly enable it and whose backing Postgres has been restarted with `shared_preload_libraries=pg_cron`; otherwise the platform fails fast with `preload_missing` or provider-gating validation. PVS can only declare `timescaledb` after a Timescale-capable provider is selected.

### Phase 3 — Docs and skillpacks (implemented 2026-05-18)

**Scope:**

1. Update [`docs/system/db.md`](../system/db.md) and [`docs/system/manifest.md`](../system/manifest.md) with the `extensions` field, supported Phase 1 list, sticky-removal behavior, and provider-gated preload caveat.
2. Update [`docs/plans/managed-postgres-dbaas-plan.md`](./managed-postgres-dbaas-plan.md) to cross-reference this plan.
3. Update `eve-skillpacks/eve-work/eve-read-eve-docs/references/database-ops.md` with managed extension behavior and `eve db extensions list`.
4. Update `eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` with the new `extensions` field and the curated list.
5. Update `eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md` with `eve db extensions list`.
6. If the CLI command ships in the same PR, follow the normal CLI release process after tests pass; do not cut a release tag from the docs-only phase.

---

## 6) Local k3d Verification Loop

This section is the explicit deliverable the task asked for. Each loop iteration:

```bash
# 0. Sanity: stack is up, agent is the k3d owner
./bin/eh status                              # must show running + k8s_owner: true
eve system health --json                     # status: ok

# 1. Rebuild + redeploy with the in-progress change
./bin/eh k8s-image build-postgres            # only when Postgres image changed (Phase 1 step 8)
./bin/eh k8s deploy                          # full rebuild (~60-90s) – picks up code + manifest changes

# 2. Provision a tenant with extensions
ORG_ID=$(eve org ensure manual-test-org --slug manual-test-org --json | jq -r '.id')
eve secrets import --org "$ORG_ID" --file manual-tests.secrets
PROJECT_ID=$(eve project ensure --org "$ORG_ID" --name ext-test \
    --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
    --branch main --json | jq -r '.id')
# Patch the cloned project manifest in-place to add the extensions list (or use a fixture project
# under tests/fixtures/managed-db-extensions/).
eve env deploy --project "$PROJECT_ID" --env test --follow
```

Decision tree per iteration:

| Symptom | Verification step | Likely fix |
|---|---|---|
| Deploy stays in "provisioning" forever | `eve job follow <deploy-id>`; then `eve system logs orchestrator --tail 200` | Reconciler isn't picking up `desired_extensions`; check column wiring |
| Deploy fails with `preload_missing` for `pg_cron` | Backing Postgres was not restarted with `shared_preload_libraries=pg_cron` | Apply Terraform parameter-group support and reboot/restart the backing DB before redeploy |
| Deploy fails with `extension_unavailable` for `pg_cron` | Provider image/engine does not ship the extension package | Install the package locally or choose an RDS engine version/provider that supports `pg_cron` |
| Deploy fails with `permission denied to create extension "postgis"` | Reconciler is connecting as tenant user, not admin | Fix admin connection scoping in `installTenantExtensions` |
| `eve manifest validate` accepts `made_up_ext` | Allowlist not wired into `ManagedDbConfigSchema` | Verify `z.enum(SUPPORTED_EXTENSION_NAMES)` is reached during parse |
| `eve db extensions list` shows nothing | Endpoint not wired or connecting to wrong DB | `eve system logs api --tail 200` and inspect SQL |

Verification queries — run after deploy succeeds:

```bash
eve db extensions list --env test --project "$PROJECT_ID" --json
# expect: { "extensions": [{"name":"postgis","version":"..."}, ...], ... }

eve db status --env test --project "$PROJECT_ID" --json | jq '.declared_extensions, .enabled_extensions, .installed_extensions'

# Direct admin verification (fallback)
./bin/eh kubectl -n eve exec -it sts/postgres -- psql -U eve -d <tenant_db_name> \
  -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
```

Reconcile-existing-tenant verification:

```bash
# 1. Deploy with [postgis]
# 2. Edit manifest to [postgis, pgvector]
# 3. Re-deploy
# Expect: pgvector appears in extensions; no recreation of the tenant DB.
eve db extensions list --env test --project "$PROJECT_ID"
```

Negative-path verification:

```bash
# Manifest with an unknown extension
sed -i.bak 's/extensions: \[postgis\]/extensions: [postgis, made_up_ext]/' .eve/manifest.yaml
eve manifest validate
# Expect: non-zero exit, message mentioning "made_up_ext" is not a supported extension.
```

Duplicate-path verification:

```bash
# Manifest with duplicate supported names
sed -i.bak 's/extensions: \[postgis\]/extensions: [postgis, postgis]/' .eve/manifest.yaml
eve manifest validate
# Expect: non-zero exit, message mentioning duplicate managed DB extension "postgis".
```

Phase 2 additions to the loop:

```bash
# After rebuilding the local Postgres image with pg_cron preloaded
./bin/eh kubectl -n eve exec sts/postgres -- psql -U eve -d eve -c "SHOW shared_preload_libraries;"
# Expect: pg_cron

# Manifest with [pg_cron], only after Phase 2 provider support is enabled
eve env deploy --project "$PROJECT_ID" --env test --follow

# pg_cron smoke test depends on the chosen tenant model; if installed in the admin DB,
# verify through the platform wrapper/grant path rather than direct tenant CREATE EXTENSION.
```

Optional TimescaleDB smoke test for a Timescale-capable provider only:

```bash
./bin/eh kubectl -n eve exec -it sts/postgres -- psql -U eve -d <tenant_db_name> -c "
  CREATE TABLE samples (ts TIMESTAMPTZ NOT NULL, v DOUBLE PRECISION);
  SELECT create_hypertable('samples', 'ts');
"
```

**Loop until:**

- All `eve db extensions list` assertions pass.
- Negative-path manifest validation rejects unknown names with a clear message.
- Duplicate-name manifest validation rejects duplicates with a clear message.
- Reconcile-existing-tenant adds extensions in place without recreation.
- (Phase 2) `preload_missing` fires when `shared_preload_libraries` is wrong, and passes when it's right.
- `eve job diagnose <deploy-id>` returns clean for the success cases.

---

## 7) Acceptance Criteria

Maps to the source spec's acceptance criteria, expanded with the design above:

1. Manifest with `extensions: [postgis]` → after `eve env deploy`, `SELECT extname FROM pg_extension` on the tenant DB includes `postgis`. Subsequent app migrations that issue `CREATE EXTENSION IF NOT EXISTS postgis` are no-ops.
2. Manifest with `extensions: [pgvector]` → live `pg_extension.extname` includes `vector`, while `declared_extensions` / `enabled_extensions` keep the manifest name `pgvector`.
3. Manifest with `extensions: [made_up_ext]` → rejected at `eve manifest validate` and `eve project sync` with a message listing supported extensions.
4. Manifest with duplicate names → rejected at validation with a duplicate-extension message.
5. `eve db status --env <env>` returns `declared_extensions`, `enabled_extensions`, and `installed_extensions: [{ name, version }]`.
6. `eve db extensions list --env <env>` returns the live installed array (table format by default, `--json` machine-readable).
7. Adding a new name to an existing manifest and re-deploying reconciles in place (no tenant recreation, no data loss).
8. Removing a declared extension from the manifest does not drop it from the DB and does not force `modifying`.
9. Phase 2: manifest with `pg_cron` remains rejected until provider support is explicitly enabled; `timescaledb` remains rejected until a Timescale-capable provider is selected.
10. Phase 2: misconfigured preload support fails fast with `preload_missing`; unavailable provider package fails fast with `extension_unavailable`.
11. `pgcrypto` and `uuid-ossp` continue to auto-install via the migrate runner, no manifest declaration needed.

---

## 8) Non-Goals (Same as Source Spec)

1. Self-service extension uploads / `pgxn` install-on-demand.
2. Availability tiers / `required: true|false` / `on_missing` behaviour.
3. Version pinning — v1 takes whatever the cloud ships for that engine version.
4. Cross-engine portability — Postgres only.
5. `DROP EXTENSION` on manifest removal — extensions stay sticky.
6. Per-environment extension overrides — declare on the service, all envs get the same set (the existing per-env service override mechanism handles this if anyone genuinely needs it).

---

## 9) Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Reconciler permission gap: tenant role can't `CREATE EXTENSION` for non-trusted extensions | Install via admin connection at provisioning time, not via tenant migrate job. Documented in §4.3. |
| Manifest-time validation drift between CLI and API | Single source of truth: `SUPPORTED_EXTENSIONS` in `@eve/shared`; CLI uses it for `eve manifest validate`, API uses it for sync. |
| PostgreSQL extension name vs. canonical `extname` mismatch (pgvector → `vector`) | Registry maps manifest name → raw canonical `extname`; SQL builder quotes identifiers at execution. Tests verify both directions. |
| Local Postgres image drift from RDS | Pin versions; document RDS engine-version → local image-tag mapping in `tools/postgres-local/README.md`. |
| Adding `pg_cron` to `shared_preload_libraries` forces RDS reboot | Documented in the infra runbook; staging maintenance window required. Out of scope for this repo. |
| TimescaleDB is required by PVS but unsupported on AWS RDS | Fail fast with `extension_unavailable`; choose a Timescale-capable backing provider or redesign the time-series layer before promising `timescaledb` in manifests. |
| Removing an extension from the manifest doesn't remove it from the DB | Intentional in v1 (data-loss risk). Document clearly; revisit only with explicit user demand. |
| Reconciler races: two deploys mutate `desired_extensions` concurrently | Existing `acquireOperationLock` covers it — `installTenantExtensions` runs under the same lock as provisioning. |

---

## 10) Touch Points

### eve-horizon

- [`packages/shared/src/managed-db/extensions.ts`](../../packages/shared/src/managed-db/) (new)
- [`packages/shared/src/schemas/manifest.ts:133-140`](../../packages/shared/src/schemas/manifest.ts) (extend `ManagedDbConfigSchema`)
- [`packages/db/migrations/NNNNN_managed_db_extensions.sql`](../../packages/db/migrations/) (new)
- [`packages/shared/src/managed-db/index.ts`](../../packages/shared/src/managed-db/index.ts) (export extension registry)
- [`packages/shared/src/schemas/managed-db.ts`](../../packages/shared/src/schemas/managed-db.ts) (extend tenant response schemas)
- [`packages/db/src/queries/managed-db.ts`](../../packages/db/src/queries/) (extend `createTenant`, add `syncTenantDesiredExtensions`, `markTenantExtensionsEnabled`)
- [`apps/orchestrator/src/cron/managed-db-reconciler.service.ts:459`](../../apps/orchestrator/src/cron/managed-db-reconciler.service.ts) (call `installTenantExtensions` after `provisionLocalDb`)
- [`apps/worker/src/deployer/deployer.service.ts:1751`](../../apps/worker/src/deployer/deployer.service.ts) (write `desired_extensions`; populate `managedValues['<svc>.extensions']`)
- [`apps/api/src/environments/`](../../apps/api/src/environments/) (extend managed-db response + new `/db/extensions` endpoint)
- [`packages/cli/src/commands/db.ts`](../../packages/cli/src/commands/db.ts) (new `extensions list` subcommand + extend `handleStatus`)
- [`tools/postgres-local/Dockerfile`](../../tools/postgres-local/) (new — bundle Phase 1 plain extensions)
- [`bin/eh-commands/k8s-image.sh`](../../bin/eh-commands/k8s-image.sh) (new `build-postgres`, `import-postgres`, and `push-postgres` subcommands)
- [`bin/eh-commands/k8s.sh`](../../bin/eh-commands/k8s.sh) (build/import the local Postgres image before applying the local overlay)
- [`k8s/overlays/local/postgres.patch.yaml`](../../k8s/overlays/local/) (new — swap image to `eve-postgres-local:16`)

### deployment-instance-repo (separate repo update)

- `terraform/aws/modules/rds/` module extension — RDS custom parameter group with `shared_preload_libraries = 'pg_cron'` when `managed_db_enabled_preload_extensions = ["pg_cron"]`.
- Apply to the staging managed-DB instance with maintenance window note.
- No AWS CLI mutations; Terraform must remain authoritative.

### eve-skillpacks (separate repo update)

- `eve-work/eve-read-eve-docs/references/database-ops.md` — document managed extension behavior, sticky removal, and provider-gated preload caveats.
- `eve-work/eve-read-eve-docs/references/manifest.md` — document `extensions` field + curated list.
- `eve-work/eve-read-eve-docs/references/cli.md` — document `eve db extensions list`.

---

## 11) Open Questions

1. **Schema mapping for PostGIS**: `CREATE EXTENSION postgis` installs into `public` by default. Some orgs prefer `CREATE EXTENSION postgis WITH SCHEMA postgis`. v1 accepts the default; revisit if anyone complains.
2. **pg_cron tenant scheduling API**: AWS's documented setup installs `pg_cron` in the default `postgres` database and can target other databases only through privileged job metadata updates. Eve now supports declaring/installing `pg_cron` behind the provider gate, but app self-service scheduling still needs a platform wrapper before it is advertised as a workflow feature.
3. **Provisioning timeout**: extension installation can be slow (PostGIS ~5s, TimescaleDB ~10s). The existing 60s/3-retry provisioning budget covers it, but worth a re-measure once Phase 2 lands.

---

## See Also

- [`docs/plans/managed-postgres-dbaas-plan.md`](./managed-postgres-dbaas-plan.md) — base managed-DB design.
- [`docs/plans/managed-db-snapshot-restore-dr-plan.md`](./managed-db-snapshot-restore-dr-plan.md) — adjacent managed-DB feature.
- [`packages/migrate/src/runner.ts`](../../packages/migrate/src/runner.ts) — current `ensureExtensions` site.
- [AWS RDS PostgreSQL extension support](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Extensions.html) — supported/trusted extension behavior and `rds.allowed_extensions`.
- [AWS RDS PostgreSQL extension versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html) — current engine-version extension list; verify target engine before adding support.
- [AWS RDS pg_cron setup](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL_pg_cron.html) — parameter group, restart, install database, and grants.
- External spec `002 — Declarable managed-Postgres extensions` (PVS rebuild, opened 2026-05-13).
