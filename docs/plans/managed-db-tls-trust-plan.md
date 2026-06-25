# Managed DB TLS Trust — Eliminating `rejectUnauthorized: false`

**Status**: Shipped (5aad606)
**Author**: Adam / Claude
**Date**: 2026-03-30

## Goal

Remove app-side TLS verification bypasses for Eve-managed databases without breaking local managed DBs, migration jobs, or the current deploy flow.

The desired end state is:

- apps do not set `ssl: { rejectUnauthorized: false }`
- cloud managed DB URLs default to `sslmode=verify-full`
- the platform owns CA distribution and pod trust configuration

## Current State and Constraints

- Today, starter/example apps work around managed DB TLS by setting `rejectUnauthorized: false`.
- The worker deployer currently resolves managed DB tenants and only materializes `${managed.<service>.url}` in practice. This plan should hang off the connection URL and ambient env, not assume richer managed value interpolation exists today.
- Namespace-scoped Kubernetes resources are owned by the worker deployer. The orchestrator managed DB reconciler owns tenant records and connection URL defaults, but it does not own app namespace manifests.
- `x-eve.role: job` services need the same trust path as long-lived Deployments because migration jobs also connect to the managed DB.
- Current code treats `local` specially and shared managed DB types already use cloud provider names like `aws-rds` and `gcp-cloudsql`. The plan should align with those names instead of inventing new ones.

## Problem

The current pattern looks like this:

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
```

That gives encryption, but not authenticated server identity. Inside a trusted VPC the practical risk is reduced, but it is still the wrong security model and it pushes provider CA handling into every app.

### 5 Whys

1. **Why do apps disable verification?** Node `pg` cannot validate the managed DB certificate with the trust material currently available to the pod.
2. **Why is the trust material missing?** Eve injects the connection URL but not the provider CA bundle.
3. **Why does the platform only inject the URL?** Managed DB provisioning was designed around credentials and placement, not client trust distribution.
4. **Why was that acceptable initially?** Local managed DB uses `sslmode=disable`, so the gap was hidden during local development.
5. **Why is it visible now?** Cloud/staging flows set `sslmode=require`, and apps compensate with `rejectUnauthorized: false`.

## Design Principles

- **No app-managed trust material**. Apps should not fetch CA bundles, mount cert files, or disable verification themselves.
- **Worker-owned namespace changes**. Trust ConfigMaps, volume mounts, and pod env injection belong in the worker deploy path, not the orchestrator cron reconciler.
- **Driver-compatible, not wishful**. The plan must be validated against actual client behavior, especially Node `pg`. Do not assume `PGSSLROOTCERT` is honored by Node.
- **Safe rollout**. Ship pod trust first, then flip URL defaults to `verify-full`, then remove app workarounds.
- **Minimal phase-1 scope**. Cover `local`, `aws-rds`, and `gcp-cloudsql`. Custom/external CA injection can follow later if we actually need it.

## Proposed Design: Namespace Trust Store

### Concept

When the worker deployer sees managed DB tenants for an environment, it builds a namespace-scoped trust bundle and injects it into every app Deployment and job pod in that environment that could use the DB.

The platform does three things:

1. Creates or updates `ConfigMap/eve-db-trust` with the relevant provider root CAs
2. Mounts that bundle into pods at `/etc/eve/trust/ca-bundle.pem`
3. Injects trust env vars:
   - `NODE_EXTRA_CA_CERTS=/etc/eve/trust/ca-bundle.pem`
   - `PGSSLROOTCERT=/etc/eve/trust/ca-bundle.pem`

For Node, `NODE_EXTRA_CA_CERTS` is the important input. `PGSSLROOTCERT` is still useful for libpq-based clients, but this plan should not rely on it for Node `pg`.

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Managed DB Instance                                     │
│ provider=aws-rds | gcp-cloudsql | local                 │
└─────────────────────────┬────────────────────────────────┘
                          │
                          │ connection URL + provider metadata
                          ▼
┌──────────────────────────────────────────────────────────┐
│ Worker Deployer                                         │
│ 1. resolveManagedDbTenants()                            │
│ 2. collect unique providers for the env                 │
│ 3. fetch/build CA bundle via provider registry          │
│ 4. create/update ConfigMap eve-db-trust                 │
│ 5. inject volume + env into Deployments and Jobs        │
└─────────────────────────┬────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│ App Pod / Job Pod                                       │
│ DATABASE_URL=...sslmode=require|verify-full             │
│ NODE_EXTRA_CA_CERTS=/etc/eve/trust/ca-bundle.pem        │
│ PGSSLROOTCERT=/etc/eve/trust/ca-bundle.pem              │
│ /etc/eve/trust/ca-bundle.pem (ConfigMap mount)          │
└──────────────────────────────────────────────────────────┘
```

## Provider Trust Registry

Add a small shared registry for provider trust material:

```typescript
interface ManagedDbTrustProvider {
  /** Matches managed_db_instances.provider */
  name: string;

  /** Root CA bundle PEM for this provider, or null if TLS trust is not needed. */
  getCaBundle(input: { region: string }): Promise<string | null>;

  /** Default sslmode for URLs emitted for this provider. */
  defaultSslMode(): 'verify-full' | 'require' | 'disable';
}
```

Initial built-ins:

| Provider | CA source | Default sslmode |
|----------|-----------|-----------------|
| `aws-rds` | AWS RDS bundle; start with `global-bundle.pem`, switch to regional only if needed | `verify-full` |
| `gcp-cloudsql` | Cloud SQL CA bundle (bundled or fetched in a deterministic way) | `verify-full` |
| `local` | none | `disable` |

Notes:

- `local` returns no CA bundle and keeps `sslmode=disable`.
- Custom/external CA support is explicitly out of phase 1. Do not invent `x-eve.managed.ca_cert` in this pass without schema work.

## Implementation Plan

### 1. Shared trust helpers

Add a new shared package area, for example:

- `packages/shared/src/managed-db/trust/index.ts`
- `packages/shared/src/managed-db/trust/providers/aws-rds.ts`
- `packages/shared/src/managed-db/trust/providers/gcp-cloudsql.ts`

Responsibilities:

- normalize provider lookup
- fetch or return bundled CA PEM
- concatenate multi-provider bundles into one PEM
- expose the provider default `sslmode`

### 2. Worker deployer owns trust ConfigMap creation

After `resolveManagedDbTenants()` returns the ready tenant URLs for an environment, the worker should also gather the backing instances for those tenants and determine whether any of them require TLS trust material.

Add a helper in `apps/worker/src/deployer/deployer.service.ts` along these lines:

```typescript
type ManagedDbTrustContext = {
  enabled: boolean;
  configMapName?: string;
  bundlePath?: string;
};

async function ensureManagedDbTrustStore(...): Promise<ManagedDbTrustContext>
```

Behavior:

- if all tenants are `local` / `sslmode=disable`, return `enabled: false`
- otherwise:
  - fetch the relevant CA bundle(s)
  - create or update `ConfigMap/eve-db-trust` in the target namespace
  - return the mount/env details needed by pods

Use the existing `K8sService.createConfigMap()` instead of inventing a second namespace-writer path elsewhere.

### 3. Inject trust into both Deployments and Jobs

This plan must cover both render paths in `DeployerService`:

- `renderManifest()` for Deployments
- `runJobService()` for migration and other job containers

If trust is enabled for the environment:

- add a read-only volume from `ConfigMap/eve-db-trust`
- mount it at `/etc/eve/trust`
- inject:
  - `NODE_EXTRA_CA_CERTS=/etc/eve/trust/ca-bundle.pem`
  - `PGSSLROOTCERT=/etc/eve/trust/ca-bundle.pem`

Apply this to all rendered app Deployments and all job pods in that environment. The overhead is tiny and it avoids brittle "did this specific container interpolate `${managed.db.url}`?" detection logic.

### 4. Upgrade URL defaults in the managed DB reconciler

Once the worker trust path exists, update the tenant URL builder in `apps/orchestrator/src/cron/managed-db-reconciler.service.ts`:

- Tenant URLs now inherit `sslmode` from `DATABASE_URL` (the `resolveManagedDbSslMode` function was removed — it incorrectly mapped `provider=local` to `sslmode=disable` even when the "local" instance was RDS)
- For `verify-full` support: set `sslmode=verify-full` on cloud tenant URLs after trust injection ships

Important rollout sequencing:

- **before** the worker trust injection ships, cloud URLs must stay compatible with current apps
- **after** trust injection and app verification ship, default new cloud URLs to `verify-full`

### 5. Node `pg` compatibility gate

Do not assume the following without proving it in tests:

- Node `pg` will honor `PGSSLROOTCERT`
- plain `new Pool({ connectionString })` is sufficient in every case once `NODE_EXTRA_CA_CERTS` is present

Phase 1 acceptance should include a real integration test against a TLS Postgres with a non-public CA.

If Node `pg` still needs explicit root-cert wiring after `NODE_EXTRA_CA_CERTS`, the fallback should be platform-owned, not app-owned:

- preferably append `sslrootcert=/etc/eve/trust/ca-bundle.pem` to generated connection URLs
- only keep a tiny starter helper temporarily if the URL-only approach does not work

What must go away either way is `rejectUnauthorized: false`.

### 6. CA lifecycle

- **Fetch**: create/update the namespace ConfigMap on first deploy or first job run in an env that uses a TLS-managed DB
- **Refresh**: weekly refresh is fine, but manual refresh is acceptable for phase 1
- **Restart semantics**: when the CA bundle changes, roll pods. `NODE_EXTRA_CA_CERTS` is read at process start, so a ConfigMap update alone is not sufficient for Node workloads
- **Multi-provider**: concatenate PEM bundles when an environment uses more than one managed DB provider

## App Impact

### Desired end state

Apps stop doing this:

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
```

And move to this:

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
```

Two important caveats during rollout:

- apps must stop deleting `sslmode` from the URL unless we have verified that doing so is still correct with the platform-owned trust path
- the target is "no insecure override", not "rip out every helper before the verified platform path exists"

## Migration Path

1. **Ship worker trust injection first**
   - trust ConfigMap creation
   - Deployment volume/env injection
   - Job volume/env injection
2. **Add verification coverage**
   - Node `pg` against a CA-signed TLS Postgres
   - at least one libpq-based path if we claim `PGSSLROOTCERT` support
3. **Update starter/example apps**
   - remove `rejectUnauthorized: false`
   - stop stripping `sslmode` unless tests prove that remains correct
4. **Flip managed DB URL defaults**
   - new cloud tenants get `sslmode=verify-full`
5. **Migrate existing tenant URLs**
   - update stored `credential_secret_ref` values from `sslmode=require` to `sslmode=verify-full`
   - redeploy affected environments
6. **Delete compatibility code**
   - remove any temporary helper logic once the plain connection-string path is proven

## Verification

### Automated

- unit tests for provider trust registry and sslmode resolution
- deployer tests covering:
  - env with only `local` managed DB -> no trust ConfigMap
  - env with cloud managed DB -> ConfigMap + mount + env injection
  - `runJobService()` gets the same trust injection as `renderManifest()`
- integration test with TLS Postgres signed by a test CA:
  - `rejectUnauthorized: false` not used
  - `NODE_EXTRA_CA_CERTS` path succeeds
  - `sslmode=verify-full` succeeds

### Manual

- deploy starter/example app to staging
- confirm migrations succeed under `x-eve.role: job`
- confirm app boots with no TLS bypass
- confirm `eve db status --env <name>` reports the tenant as ready and the app can query it

## Scope

| Component | Change |
|-----------|--------|
| `apps/worker/src/deployer/deployer.service.ts` | ensure namespace trust ConfigMap; inject trust volume/env into Deployments and Jobs |
| `apps/worker/src/deployer/k8s.service.ts` | reuse existing ConfigMap support; add rollout helper only if needed |
| `apps/orchestrator/src/cron/managed-db-reconciler.service.ts` | add `verify-full` support and flip cloud default after rollout |
| `apps/orchestrator/src/cron/managed-db-reconciler.service.spec.ts` | update sslmode tests |
| `packages/shared/src/managed-db/trust/` | new provider trust registry |
| DB/query layer | migration helper to rewrite existing tenant `credential_secret_ref` URLs |
| `../eve-horizon-starter` | remove insecure SSL override once platform trust path is verified |
| sibling apps (`../reference-app`, `../eden`, etc.) | remove insecure SSL override once verified |
| `docs/system/db.md` | document managed DB trust behavior internally |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/database-ops.md` | document managed DB trust behavior publicly |

## Non-Goals

- client certificate authentication / mTLS
- phase-1 custom CA manifest schema for arbitrary external databases
- zero-downtime CA rotation without pod restart
- changing managed value interpolation beyond what this TLS fix needs
- per-tenant certificate authorities
