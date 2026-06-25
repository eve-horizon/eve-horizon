# Fix: Deployer Graceful Shutdown for Database Services

**Bead:** eve-horizon-201 (P1 bug)
**Date:** 2026-02-02

## Incident

Deploying a new release to refapp sandbox caused PostgreSQL WAL corruption. The `sandbox-db` pod entered CrashLoopBackOff:

```
invalid resource manager ID in checkpoint record
PANIC: could not locate a valid checkpoint record
```

The database was unrecoverable without deleting the PVC and reinitializing from scratch.

## 5 Whys

**Why 1: Why was the WAL corrupted?**
PostgreSQL was killed mid-write during the deploy rollout. The WAL didn't have a valid checkpoint because postgres didn't finish its shutdown sequence.

**Why 2: Why was postgres killed mid-write?**
Kubernetes sent SIGTERM then SIGKILL after the default 30s `terminationGracePeriodSeconds`. No `preStop` hook was configured to trigger `pg_ctl stop` for a clean shutdown.

**Why 3: Why is there no graceful shutdown handling for DB pods?**
The deployer in `apps/worker/src/deployer/deployer.service.ts` (lines 576-631) generates Deployment specs with NO lifecycle hooks, NO `terminationGracePeriodSeconds` override, and NO deployment strategy. All services — stateless apps and stateful databases — get identical pod specs.

**Why 4: Why doesn't the deployer differentiate database services?**
The deployer detects `role: database` (line 1071) but only uses it for default mount paths. No special deployment strategy, graceful shutdown, or lifecycle handling is applied. The replica resolver (lines 862-877) has special logic for `role: worker` but nothing for `role: database`.

**Why 5: Why was RollingUpdate used for a single-replica DB with a PVC?**
No strategy is set (defaults to `RollingUpdate`). For a single-replica database with a `ReadWriteOnce` PVC, Kubernetes tries to start the new pod before the old one is fully terminated. The old pod may be killed ungracefully to release the volume.

## Root Cause

The deployer treats all services identically regardless of statefulness. Database services with persistent volumes need fundamentally different deployment behavior.

## Changes

### 1. `apps/worker/src/deployer/deployer.service.ts`

**a) Resolve role before building the Deployment spec** (around line 562, inside the `sortedServices.forEach` loop)

Add `const xeve = this.resolveXeve(service);` and `const role = xeve?.role;` early in the loop so we can use it when constructing the Deployment.

**b) Add `strategy` to Deployment spec** (line 583, after `spec: {`)

```typescript
strategy: role === 'database'
  ? { type: 'Recreate' }
  : undefined,
```

Services with `role: database` get `Recreate` (old pod fully stopped before new starts). All other services keep the K8s default (`RollingUpdate`).

**c) Add `terminationGracePeriodSeconds` to pod spec** (line 601, inside `template.spec`)

```typescript
terminationGracePeriodSeconds: role === 'database' ? 120 : undefined,
```

Gives postgres 2 minutes for clean checkpoint + WAL flush. Other services keep the K8s default (30s).

**d) Add `lifecycle.preStop` to container spec** (after line 623, after the liveness probe block)

```typescript
if (role === 'database') {
  container.lifecycle = {
    preStop: {
      exec: {
        command: ['sh', '-c', 'pg_ctl stop -D /var/lib/postgresql/data -m fast -w || true'],
      },
    },
  };
}
```

Triggers a clean postgres shutdown before SIGTERM. The `-w` flag waits for completion, `-m fast` disconnects clients and flushes. `|| true` prevents a non-zero exit from blocking termination if pg_ctl isn't present (non-postgres DB images).

**e) Validate RWO PVC + replicas** (inside the forEach loop, after resolving storage and replicas)

Add a warning log if `accessMode === 'ReadWriteOnce'` and `replicas > 1`.

### 2. `apps/worker/src/deployer/__tests__/deployer-database-lifecycle.spec.ts` (new)

Unit tests verifying the Deployment spec generation:

- Database service gets `strategy: { type: 'Recreate' }`, `terminationGracePeriodSeconds: 120`, `lifecycle.preStop` with `pg_ctl stop`
- Non-database service (no role, or role=worker) gets none of these fields
- Database with explicit healthcheck still gets probes AND lifecycle hooks
- Parse the YAML output from `renderManifest` and assert on the deployment structure

### 3. No schema changes needed

The `ServiceXeveSchema` and `ServiceStorageSchema` don't need modification. The behavior is automatic based on `role: database` — no new manifest fields required. Zero-config for users.

## Files to Modify

| File | Change |
|------|--------|
| `apps/worker/src/deployer/deployer.service.ts` | Add strategy, terminationGracePeriod, preStop for database role |
| `apps/worker/src/deployer/__tests__/deployer-database-lifecycle.spec.ts` | New test file |

## Acceptance Criteria

- [ ] Database services (`x-eve.role: database`) get `strategy: Recreate`
- [ ] Database services get `terminationGracePeriodSeconds: 120`
- [ ] Database services get preStop hook: `pg_ctl stop -m fast`
- [ ] RWO PVC with replicas > 1 produces a warning log
- [ ] Unit tests verify strategy/lifecycle for database vs app services
- [ ] Integration test: deploy DB service, trigger rollout, verify clean WAL

## Verification

1. `cd apps/worker && npx vitest run` — all tests pass including new ones
2. `cd apps/worker && npx tsc --noEmit` — type check passes
3. Deploy to staging and verify the generated K8s Deployment for a database service has the correct strategy/lifecycle fields
