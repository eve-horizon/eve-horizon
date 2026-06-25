# Agent Runtime Heartbeat Silently Fails on org_default FK Violation

> **Status**: FIXED
> **Severity**: High — agent runtime appears healthy but never dispatches jobs
> **Created**: 2026-03-31
> **Fixed**: 2026-03-31
> **Discovered in**: downstream infra deployment (customer cluster, v0.1.239)

## Problem

The base k8s manifest hardcodes `EVE_ORG_ID: org_default`. Nothing in the platform creates an `org_default` row in the `orgs` table. When a downstream deployment creates their own org (e.g. `org_customer`) and deploys, the agent runtime heartbeat hits a foreign key violation on every tick:

```
insert or update on table "agent_runtime_pods" violates foreign key constraint "agent_runtime_pods_org_id_fkey"
```

The API returns 500, the runtime logs a warning, and the cycle repeats every 15 seconds forever. The pods show `1/1 Running` in kubectl, the health endpoint returns 200, readiness probes pass — but no jobs are dispatched because the pods are stale or missing from the org's registry.

## Why This Is Hard to Diagnose

1. The runtime pod is `Running` and `Ready` — kubectl shows no problem
2. The health endpoint (`/health`) returns 200 — it doesn't check heartbeat status
3. The `eve agents runtime-status` command shows pods as `stale: true` with no explanation why
4. Job diagnosis shows attempts failing instantly with `execution_started_at: null`
5. The actual error (`FK violation on agent_runtime_pods`) is only in the API pod logs, not the runtime logs — the runtime just sees "500 Internal Server Error"
6. The heartbeat warning is buried in thousands of identical 15-second log lines

In our case, debugging this took over an hour because every signal says "healthy" except one buried API log line.

## Root Cause

The design assumes `EVE_ORG_ID` matches a real org in the database. But the base template uses a placeholder value (`org_default`) that is never seeded. The heartbeat upsert into `agent_runtime_pods` requires `org_id` as a foreign key to `orgs(id)`, so it fails when the org doesn't exist.

### Why does the agent runtime need an org at all?

The `agent_runtime_pods` table uses `(org_id, pod_name)` as its composite primary key. This supports multi-tenancy — different orgs can have separate pod pools with independent sharding. The heartbeat is per-org so each org's pod registry is isolated.

For multi-tenant SaaS deployments with many orgs sharing infrastructure, this makes sense. But most Eve Horizon deployments are **single-tenant**: one cluster, one org, one set of runtime pods. The org_id requirement adds operational complexity with zero benefit:

- The downstream deployer must discover their org ID and patch the k8s manifest
- Nothing in the setup docs, CLI output, or error messages tells them to do this
- The template's `org_default` placeholder is never created and never works
- The failure mode is silent — everything looks healthy until jobs stop running

## Proposed Fix

### Option A: Auto-resolve org from database on startup (recommended)

If `EVE_ORG_ID` is `org_default` or unset, the runtime should query the database for available orgs and register for all of them. Single-tenant deployments have one org; it should just work.

```typescript
// runtime.service.ts — seedTrackedOrgIds()
private async seedTrackedOrgIds(): Promise<void> {
  const envOrg = this.resolveOrgIdFromEnv();

  if (!envOrg || envOrg === 'org_default') {
    // Auto-discover orgs from database
    const orgs = await this.db.query('SELECT id FROM orgs LIMIT 10');
    for (const org of orgs) {
      this.registerOrg(org.id);
    }
    if (orgs.length > 0) {
      this.logger.log(`Auto-discovered ${orgs.length} org(s): ${orgs.map(o => o.id).join(', ')}`);
    } else {
      this.logger.warn('No orgs found in database — heartbeat will wait for first invocation');
    }
    return;
  }

  this.registerOrg(envOrg);
}
```

This is backward-compatible: existing deployments with an explicit `EVE_ORG_ID` keep working. New deployments with the template default just work without configuration.

### Option B: Validate org exists before heartbeat

Before the first heartbeat, check that the org exists. If it doesn't, log a clear error with remediation steps instead of silently 500-ing forever:

```typescript
const sendHeartbeat = async () => {
  for (const orgId of orgIds) {
    const exists = await this.checkOrgExists(orgId);
    if (!exists) {
      this.logger.error(
        `Org '${orgId}' does not exist in the database. ` +
        `Set EVE_ORG_ID to your org's ID (check: SELECT id FROM orgs) ` +
        `or create the org first.`
      );
      continue;
    }
    // ... normal heartbeat
  }
};
```

### Option C: Remove org_id from the primary key (cleanest long-term)

For single-tenant deployments, the org dimension on `agent_runtime_pods` is unnecessary overhead. A simpler schema:

```sql
-- Current: PRIMARY KEY (org_id, pod_name) with FK to orgs
-- Proposed: PRIMARY KEY (pod_name), org_ids as an array or join table
ALTER TABLE agent_runtime_pods DROP CONSTRAINT agent_runtime_pods_pkey;
ALTER TABLE agent_runtime_pods ADD PRIMARY KEY (pod_name);
ALTER TABLE agent_runtime_pods ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE agent_runtime_pods DROP CONSTRAINT agent_runtime_pods_org_id_fkey;
```

Then the heartbeat doesn't need an org at all. The orchestrator resolves the job's org from the project and routes to any healthy pod. Multi-tenant isolation (if needed) moves to the placement layer, not the heartbeat layer.

This is a bigger change but eliminates the entire class of "heartbeat fails because org config is wrong" bugs.

### Option D: Seed `org_default` in a migration

The simplest fix — just create the org:

```sql
INSERT INTO orgs (id, name, slug) VALUES ('org_default', 'Default', 'default')
ON CONFLICT DO NOTHING;
```

But this papers over the real problem. The runtime still heartbeats for a meaningless placeholder org. Jobs belonging to the downstream org may not route to pods registered under `org_default`. It trades one failure mode for a subtler one.

## Recommendation

**Option A** for the immediate fix. The runtime should be smart enough to discover its orgs from the database rather than requiring a hardcoded env var that doesn't match anything. This is the only option that makes single-tenant deployments work out of the box.

**Option C** as a follow-up if multi-tenancy at the pod level isn't actually needed. The org dimension on heartbeats adds complexity for a feature (per-org pod pools) that no current deployment uses.

## Files to Change

| File | Change |
|------|--------|
| `apps/agent-runtime/src/runtime/runtime.service.ts` | Auto-discover orgs when EVE_ORG_ID is unset or `org_default` |
| `apps/api/src/agent-runtime/agent-runtime.service.ts` | Validate org exists before upsert, return 404 not 500 |
| `k8s/base/agent-runtime-deployment.yaml` | Consider removing the default entirely (let auto-discovery handle it) |
| `docker/compose/docker-compose.yml` | Same — `${EVE_ORG_ID:-}` instead of `${EVE_ORG_ID:-org_default}` |

## Workaround (Current)

Downstream deployers must override `EVE_ORG_ID` in their cloud overlay to match their actual org ID. In the incident that exposed this, the override lived in `k8s/overlays/gcp/agent-runtime-deployment-patch.yaml`. This is undocumented and only discoverable by reading API logs.
