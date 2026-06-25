# Eve-Managed Cloud Postgres (DBaaS) Plan

> Status: Draft — Open questions resolved
> Last Updated: 2026-02-11
> Purpose: Define an elegant third database mode for Eve projects: platform-managed cloud Postgres.

## Why This Plan

Today, Eve-compatible apps have two DB choices:

1. Run Postgres as an app service in the manifest (`x-eve.role: database` style container deployment).
2. Wire an external DB URL via secrets/overrides (`connection_url`, `DATABASE_URL`, env override `db.url`).

For Eve's longer-term PaaS vision, we need a third option:

- Eve provisions and manages Postgres for each app environment.
- Eve enforces tenant limits and guardrails.
- Eve meters and bills managed DB usage through existing pricing and balance primitives.

This plan is intentionally pre-MVP in spirit: simple first design, clear extension points, no speculative control planes.

---

## 1) Current State Deep-Dive

### 1.1 DB Resolution Today

Environment DB resolution is centralized in `apps/api/src/environments/env-db.service.ts`.

Resolution order:

1. Environment override (`environment.overrides_json.db`):
   - Uses `url` or `connection_url` or `database_url`, plus optional schema.
2. Manifest service resolution:
   - Uses `environment.db_ref` if set, else finds a unique `x-eve.role: database` service.
   - URL sources: `x-eve.connection_url`, `service.connection_url`, `service.url`, `environment.DATABASE_URL`, or derived from `POSTGRES_*` + service DNS.
3. Fallback:
   - Uses Eve core `DATABASE_URL` with a generated schema (`eve_env_<project>_<env>`).

### 1.2 Deployment Behavior Today

`apps/worker/src/deployer/deployer.service.ts` renders K8s resources from manifest services.

- Services marked `x-eve.external` or with `x-eve.connection_url` are skipped for deployment.
- Container database services are treated like normal K8s workloads.
- There is no managed cloud DB provisioning step in deploy flow.

### 1.3 Existing Cost/Budget Foundation We Can Reuse

Already implemented:

- Pricing rate cards: `packages/db/migrations/00038_pricing.sql`
- Balance ledger: `packages/db/migrations/00039_balances.sql`
- Usage records: `packages/db/migrations/00041_usage_records.sql`
- Usage sweeper + charging path: `apps/orchestrator/src/cron/usage-sweeper.service.ts`
- Budget suspension hooks: `apps/orchestrator/src/cron/suspension-controller.service.ts`

This means managed DB can be integrated without creating a new billing subsystem.

### 1.4 Gaps Blocking Managed DBaaS

1. No managed DB lifecycle model (provision/status/rotate/scale/destroy).
2. No provider abstraction (RDS/Cloud SQL API orchestration).
3. No placement model (which backing instance hosts which tenant DB).
4. No managed DB metering source writing `usage_records`.
5. No managed DB CLI/API surfaces.
6. No deploy-time fail-fast contract for managed DB readiness.

---

## 2) Target Product Model

### 2.1 Three Explicit DB Modes

1. **Container DB**: app-defined Postgres service deployed to K8s.
2. **External DB**: user-provided URL.
3. **Managed DB** (new): Eve-provisioned cloud Postgres.

### 2.2 Manifest UX (Recommended)

Reuse the existing service model and add a managed role:

```yaml
services:
  db:
    x-eve:
      role: managed_db
      managed:
        class: db.p1
        engine: postgres
        engine_version: "16"
```

Service consumers continue using environment variables, with Eve-managed interpolation:

```yaml
services:
  api:
    environment:
      DATABASE_URL: ${managed.db.url}
```

Per-environment tier override:

```yaml
environments:
  production:
    overrides:
      services:
        db:
          x-eve:
            managed:
              class: db.p2
```

### 2.3 Pre-MVP Product Boundaries

1. Postgres only.
2. Shared backing instances first, dedicated instances later.
3. No read replicas, no forking, no auto-rebalancing in first release.

### 2.4 Compatibility and Explicit Mode Resolution

Default behavior for existing projects remains unchanged unless a service explicitly sets `x-eve.role: managed_db`.

Declarable managed Postgres extensions are covered by
[`managed-postgres-extensions-plan.md`](./managed-postgres-extensions-plan.md).
Phase 1 keeps the allowlist to tenant-local extensions (`postgis`, `pgvector`,
`pg_trgm`, `btree_gist`, `hstore`, `citext`) and installs them through the
managed-DB reconciler before app migrations run.

Resolution contract (highest to lowest precedence):

1. Environment DB override (`environment.overrides_json.db.url|connection_url|database_url`) -> **external mode**.
2. Manifest service selected via `environment.db_ref` (or unique DB service when `db_ref` is unset):
   - `x-eve.role: managed_db` -> **managed mode**.
   - `x-eve.role: database` -> **container mode**.
3. Core Eve fallback schema DB (`eve_env_<project>_<env>`) when no DB target is configured.

Fail-fast rule:

- If a service is explicitly selected with `x-eve.role: managed_db`, Eve must not silently downgrade to container or core fallback DB.

---

## 3) Control Plane Design

### 3.1 Provider Interface

Introduce a narrow provider contract:

- `provisionTenantDb(...)`
- `getTenantStatus(...)`
- `rotateTenantCredentials(...)`
- `scaleTenantClass(...)`
- `deleteTenantDb(...)`
- `collectTenantUsage(...)`

Initial provider sequence:

1. `aws-rds` first.
2. `gcp-cloudsql` second.

### 3.2 Resource Model

Two new entities:

1. **Managed DB Instance** (backing host/cluster): shared or dedicated.
2. **Managed DB Tenant** (environment-owned database/user) hosted on an instance.

One tenant DB per Eve environment for v1.

### 3.3 Naming Strategy

Deterministic, collision-safe names (truncated/hash-suffixed):

- DB name: `<org>-<project>-<env>-<hash>`
- DB user: `<org>-<project>-<env>-u-<hash>`

Use normalized slugs and hard length caps to satisfy Postgres/provider constraints.

### 3.4 Lifecycle and Idempotency

Status states:

- `provisioning`, `ready`, `modifying`, `rotating`, `deleting`, `failed`

Rules:

1. Idempotent provisioning keyed by `env_id`.
2. Provider tags include Eve IDs for recovery/drift lookup.
3. Deployer blocks (fail-fast) when DB is not `ready`.
4. All mutate operations (`provision|rotate|scale|delete`) require an operation lock token to prevent concurrent actions for the same tenant.

### 3.5 Control Loop Ownership

To avoid split-brain and credential drift, each responsibility is explicit:

1. **API** accepts desired state changes and persists intent (`desired_class`, rotate request, destroy request).
2. **Orchestrator reconciler** is the only component that talks to cloud providers and transitions managed DB state.
3. **Worker deployer** is read-only for managed DB state: it verifies readiness, resolves interpolated managed values, and fails fast if not ready.
4. **Env DB resolver** (`EnvDbService`) uses tenant records as the source of truth for `eve db schema|rls|sql`.

---

## 4) Isolation, Security, and Limits

### 4.1 Tenant Isolation in Shared Instances

Per-tenant DB user + DB-level controls:

1. Connection caps (`CONNECTION LIMIT`) per tenant role.
2. Statement/idle timeout defaults.
3. Tier-based storage ceilings and alert thresholds.

### 4.2 Network Model

1. Private connectivity only between Eve workloads and managed DB.
2. Security group/firewall allowlists for cluster egress.
3. No public DB endpoint by default.

### 4.3 Secrets and Rotation

1. Eve stores tenant credentials encrypted using existing secret framework.
2. Rotation flow creates new credential, updates resolved managed values, then revokes old credential after grace.
3. Never persist plaintext credentials in environment overrides.

### 4.4 Fail-Fast Policy

Provisioning or credential failures must fail deployment immediately with actionable diagnostics.
No silent fallback to core Eve DB when mode is `managed_db`.

---

## 5) Cost and Billing Integration

### 5.1 Metering Model

Emit managed DB usage into existing `usage_records`:

- `resource_type = managed_db`
- `resource_class = db.p1|db.p2|...`
- Units:
  - `hours` for instance class runtime
  - `gb_hours` for allocated storage
- Granularity:
  - Hourly aggregation for billing
  - Idempotent upserts keyed by `(tenant_id, usage_window_start, usage_window_end, unit)`

### 5.2 Rate Card Extension

Extend pricing config to include DB class pricing:

- class hourly base cost
- storage hourly base cost

Use existing markup + billing currency + FX flow.

### 5.3 Charge Path

Reuse existing ledger flow:

1. Sweeper writes `usage_records`.
2. Billing posts `balance_transactions` with idempotent `source_id`.
3. Spend APIs include managed DB charges naturally.

---

## 6) Infrastructure Separation

Eve Horizon uses a three-repo deployment model (see `docs/deploy/aws.md`):

1. **eve-horizon** (this repo) — application source code and image publishing.
2. **eve-horizon-infra** (public template) — Terraform modules, K8s overlays, deploy workflows.
3. **Per-client infra repos** (e.g. `deployment-instance-repo`) — instantiated from the template with environment-specific config.

Backing RDS/Cloud SQL instances are provisioned by Terraform in the infra repo, not by Eve application code. Eve's managed DB control plane (orchestrator reconciler, admin API) operates on instances that have already been provisioned and registered via `POST /admin/managed-db/instances`. This keeps a clean boundary: infra repos own cloud resource lifecycle, Eve owns tenant DB lifecycle on those resources.

Network-level controls (security groups, firewall allowlists, private connectivity) are also infra-repo concerns. The DBaaS plan's network model (Section 4.2) describes the required posture; the infra template must implement it.

---

## 7) Scaling Strategy

### Stage A: Single Shared Backing Instance

- Fastest path to value.
- Infra repo provisions RDS via Terraform; admin registers it in Eve via API.

### Stage B: Multi-Instance Shared Fleet

- Add placement policy: lowest load + class compatibility.
- Track capacity per instance.

### Stage C: Dedicated Tier

- Large/noisy tenants can move to dedicated instances.
- Async provisioning allowed for dedicated class upgrades.

### Stage D: Platform-Agent Automation

- Capacity/provisioning agents create and retire backing instances.
- Rebalancing automation only after strong safety instrumentation.

---

## 8) API, CLI, and Schema Changes

### 8.1 Data Model (New)

Add migration for:

1. `managed_db_instances`
2. `managed_db_tenants`

Required fields and constraints:

1. `managed_db_instances`
   - `id`, `provider`, `provider_instance_id`, `region`, `engine`, `engine_version`
   - `host`, `port`, `instance_class`, `status`, `capacity_json`
   - `last_error_code`, `last_error_message`, `created_at`, `updated_at`
   - Unique: `(provider, provider_instance_id)`
2. `managed_db_tenants`
   - `id`, `org_id`, `project_id`, `env_id`, `service_name`
   - `instance_id`, `provider_tenant_id`, `db_name`, `db_user`
   - `credential_secret_ref`, `class`, `desired_class`, `status`
   - `operation_token`, `last_error_code`, `last_error_message`
   - `ready_at`, `created_at`, `updated_at`, `deleted_at`
   - Unique: `(env_id, service_name)` and `(provider_tenant_id)`

### 8.2 API (Project/Env Scope)

1. `GET /projects/:id/envs/:env/db/managed`
2. `POST /projects/:id/envs/:env/db/managed/rotate`
3. `POST /projects/:id/envs/:env/db/managed/scale`
4. `DELETE /projects/:id/envs/:env/db/managed` (owner/admin guarded)

### 8.3 API (Admin Scope)

1. `GET /admin/managed-db/instances`
2. `POST /admin/managed-db/instances` (register/import)
3. `GET /admin/managed-db/instances/:id`

### 8.4 CLI

Add subcommands in `packages/cli/src/commands/db.ts`:

1. `eve db status --env <env> [--project <id>] [--json]`
2. `eve db rotate-credentials --env <env> [--project <id>] [--json]`
3. `eve db scale --env <env> --class db.p2 [--project <id>] [--json]`
4. `eve db destroy --env <env> --force [--project <id>] [--json]`

Conventions:

- Keep existing `eve db schema|rls|sql|migrate|migrations|new` behavior unchanged.
- New subcommands follow existing CLI flag style (`--env`, optional `--project`, `--json` support).

Optional admin helper:

- `eve admin db register-instance ...`

### 8.5 Existing Code Touch Points

1. `apps/api/src/environments/env-db.service.ts`
   - Add managed tenant lookup path before fallback.
2. `apps/worker/src/deployer/deployer.service.ts`
   - Skip `managed_db` from K8s rendering.
   - Ensure managed DB is provisioned before deploying dependent services.
   - Add `${managed.<service>.<field>}` interpolation.
3. `packages/shared/src/schemas/manifest.ts`
   - Allow role `managed_db` + `x-eve.managed` schema.
4. `apps/orchestrator/src/managed-db/*` (new)
   - Reconciler loop for provisioning, scaling, rotation, and destroy.
5. `packages/db/src/queries/managed-db.ts` (new)
   - Query helpers for tenant/instance lifecycle and operation locking.

---

## 9) Execution Plan (Phased)

### Phase 0: Foundations

Scope:

1. New migrations and query layer.
2. Provider interface and DB class config scaffold.
3. Type-safe schema changes in shared manifest/types.
4. Feature flag/config gate for managed DB rollout.

Acceptance:

1. Migration applies and tests pass.
2. CRUD/query tests for managed DB tables pass.
3. Existing container/external DB integration tests remain green (no regression).

### Phase 1: Shared Managed DB Core

Scope:

1. RDS provider implementation.
2. Tenant provisioning and readiness tracking.
3. Orchestrator reconciler with operation locking + retries.
4. Deployer preflight integration and fail-fast behavior.

Acceptance:

1. Env deploy provisions managed tenant DB once (idempotent).
2. App can connect with `${managed.db.url}`.
3. `eve db schema/sql` work for managed mode.
4. Deploy fails with actionable error when tenant status is not `ready`.

### Phase 2: User/Operator Workflows

Scope:

1. Managed DB API endpoints.
2. CLI status/rotate/scale/destroy commands.
3. Manifest validation and error messaging.
4. Docs updates (`docs/system/*`, CLI help, and user-facing skill references).

Acceptance:

1. CLI can inspect and operate managed DB lifecycle safely.
2. Credential rotation works end-to-end.
3. Manual test scenario validates managed DB deploy + rotate + rollback behavior.

### Phase 3: Metering and Billing

Scope:

1. Managed DB usage sweeper.
2. Rate card extension and charge posting.
3. Spend visibility integration.
4. Budget suspension behavior includes managed DB spend.

Acceptance:

1. Managed DB usage records appear and charge balances.
2. Spend endpoints show managed DB costs.
3. Over-budget org behavior is enforced consistently with existing suspension controller.

### Phase 4: Guardrails and Placement

Scope:

1. Tier-based limit enforcement.
2. Multi-instance placement for shared tenancy.
3. Storage and connection pressure alerts.
4. Placement scoring with deterministic tie-breaker.

Acceptance:

1. Tenant-level constraints prevent noisy-neighbor saturation.
2. New tenants place onto healthy/shared capacity deterministically.
3. Placement decisions are traceable via logs/diagnostics.

### Phase 5: Lifecycle Hardening

Scope:

1. Environment delete hooks for managed tenant cleanup.
2. Snapshot-before-destroy policy.
3. Graceful orphan/failed-resource reconciliation.
4. Runbook for provider drift recovery.

Acceptance:

1. Env teardown removes tenant DB safely with snapshot path.
2. No orphan managed tenant records after retries.
3. Destroy path is idempotent and auditable.

---

## 10) Risks, Decisions, and Open Questions

### 10.1 Key Risks

1. Shared host blast radius.
2. Credential rotation cutover errors.
3. Misaligned deploy/DB state if provisioning idempotency is weak.
4. Storage growth and performance variability across tenants.

### 10.2 Recommended Decisions

1. **Start with AWS RDS shared instances** and manual instance registration.
2. **Use `managed_db` as a service role extension**, not a parallel top-level DSL.
3. **Block deploy when managed DB is not ready** (strict fail-fast).
4. **Integrate billing immediately** using `usage_records` + existing ledger.
5. **Keep dedicated instances as an upgrade tier**, not default behavior.

### 10.3 Deferred by Design

1. Multi-engine DB support.
2. Automatic tenant rebalancing.
3. Read replicas and advanced HA tiers.
4. Database branching/forking for preview environments.

### 10.4 Resolved Questions

1. **Persistent environments only.** Managed DB is restricted to long-lived environments in v1. Ephemeral/preview environments use container DB or the core fallback schema. This avoids cloud provisioning latency for throwaway work and simplifies cleanup.
2. **60-second timeout with 3 retries.** Tenant creation on a shared instance is fast (`CREATE DATABASE` + `CREATE ROLE`). 60s per attempt, 3 retries = ~3 min max before deploy fails. The slow path (new RDS instance) is an admin operation, never deploy-time.
3. **Snapshot-on-delete for production classes only.** Only `db.p2+` (or explicitly production-tagged environments) get automatic snapshots before destroy. Dev/staging teardown stays fast and avoids unnecessary storage cost.
4. **Environment-scoped credentials.** `credential_secret_ref` is scoped per-environment, matching the 1:1 tenant-per-env model. Clean isolation boundary; credential rotation affects only one environment.

---

## 11) Test and Rollout Gates

Before GA:

1. Integration tests cover all three DB modes (container, external, managed).
2. Manual scenario validates failure modes: provider timeout, invalid credentials, rotation rollback.
3. Observability includes `eve db status` diagnostics for status, class, provider IDs (redacted), and last error.
4. Managed DB remains behind a feature flag until staging burn-in passes for at least one full release cycle.

---

## Success Criteria Summary

This plan is successful when an Eve project can choose `managed_db`, deploy without manually provisioning a database, operate it via CLI, and see its cost reflected in the same balance and budget model already used by the platform.
