# Per-Org Filesystem Isolation

> **Status**: Idea
> **Date**: 2026-03-03
> **Supersedes**: Single-PVC model in `docs/plans/worker-org-fs-parity.md`

Goal: make org filesystem opt-in per org, with storage-level isolation via per-org PVCs. Remove the hardcoded `eve-org-fs-org-default` PVC. No backwards compatibility — clean cut.

---

## Why This Matters

Today every org shares a single PVC (`eve-org-fs-org-default`). RBAC scoping prevents cross-org reads at the application layer, but at the storage layer there is zero isolation. A bug in prefix filtering = data leak between orgs.

Opt-in also matters: not every org needs a shared filesystem. Provisioning storage, mounting PVCs, and running materialization logic for orgs that don't use it is waste.

---

## Current State

| Aspect | How It Works Today |
|--------|-------------------|
| PVC | Single `eve-org-fs-org-default` — hardcoded in `k8s/base/agent-runtime-pvc.yaml` |
| Org entity | No `orgfs_enabled` field. No filesystem config. |
| Orchestrator | `resolveOrgFsMountContext()` derives permissions from RBAC bindings, doesn't check org config |
| Agent-runtime | Mounts `/org` from static PVC. `EVE_ORG_ID` set in overlay. |
| Runner pods | No org-fs mount at all (the gap `worker-org-fs-parity.md` addresses) |
| Docker compose | `../../org-fs:/org` bind mount in dev overlay. Single directory. |
| Materialization | `materializeScopedOrgFsMount()` creates `.org/` in workspace from `/org` base |

---

## Design

### Principle: Org Opts In, Platform Provisions

An org admin explicitly enables the filesystem. The platform creates the backing storage. Jobs for that org get the mount. Jobs for orgs without it don't.

### Data Model

Add `orgfs_config` to the `orgs` table:

```sql
ALTER TABLE orgs ADD COLUMN orgfs_config JSONB;
```

Schema:

```typescript
type OrgFsConfig = {
  enabled: boolean;
  storage_size?: string;     // K8s quantity, e.g. '10Gi'. Default: '5Gi'
  pvc_name?: string;         // Derived, stored for lookup: 'eve-org-fs-{slug}'
  provisioned_at?: string;   // ISO timestamp, null if not yet provisioned
};
```

Why JSONB over a boolean: extensibility. Storage quotas, retention policies, backup config — all future fields that slot in without migrations.

### PVC Naming

```
eve-org-fs-{orgSlug}
```

- `orgSlug` is unique, max 12 chars, lowercase alphanumeric + hyphen
- Examples: `eve-org-fs-acme`, `eve-org-fs-test-org`
- The old `eve-org-fs-org-default` is deleted (no backwards compat)

### API Surface

**Enable org filesystem:**

```
POST /orgs/:org_id/fs/enable
Body: { storage_size?: string }
Requires: orgs:admin
```

1. Validates org exists, caller has `orgs:admin`
2. Sets `orgfs_config.enabled = true` on the org
3. Creates PVC `eve-org-fs-{slug}` in the `eve` namespace via `@kubernetes/client-node` (same pattern as `k8s.service.ts:createPersistentVolumeClaim`)
4. Updates `orgfs_config.provisioned_at` and `orgfs_config.pvc_name`
5. Returns org with updated config

**Disable org filesystem:**

```
POST /orgs/:org_id/fs/disable
Requires: orgs:admin
```

1. Sets `orgfs_config.enabled = false`
2. Does NOT delete the PVC (data preservation). Adds `orgfs_config.disabled_at`.
3. Jobs stop getting mounts. Data remains until explicit cleanup.

**Check status (read):**

```
GET /orgs/:org_id/fs
Requires: orgs:read
```

Returns `orgfs_config` plus PVC status (bound/pending) if provisioned.

**CLI:**

```bash
eve org fs enable --org org_xxx --size 10Gi
eve org fs disable --org org_xxx
eve org fs status --org org_xxx
```

### Orchestrator Changes

`resolveOrgFsMountContext()` gains a pre-check:

```typescript
private async resolveOrgFsMountContext(
  job: Job,
  orgId: string,
): Promise<OrgFsMountContext & { org_slug?: string }> {
  // NEW: Check org has filesystem enabled
  const org = await this.orgsRepo.findById(orgId);
  if (!org?.orgfs_config?.enabled) {
    return NO_ORG_FS_MOUNT;
  }

  // Existing RBAC resolution (unchanged)
  const userId = job.actor_user_id?.trim();
  if (!userId) return NO_ORG_FS_MOUNT;

  const bindings = await accessRoleQueries(this.db).listApplicableBindings({
    orgId,
    principalType: 'user',
    principalId: userId,
    projectId: job.project_id,
  });

  const context = deriveOrgFsMountContext(bindings);

  // NEW: Include org slug for PVC lookup downstream
  return { ...context, org_slug: org.slug };
}
```

The `invocationData.orgfs_mount` now includes `org_slug`, which the worker/agent-runtime use to find the right PVC.

### Runner Pod Changes (k8s-runner.ts)

`buildRunnerManifests()` adds the org-fs volume when the invocation has a mount spec:

```typescript
// In buildRunnerManifests(), after workspace volume setup:

const orgFsMount = invocation.data?.orgfs_mount;
const orgSlug = orgFsMount?.org_slug;

if (orgSlug && orgFsMount?.mode !== 'none') {
  const pvcName = `eve-org-fs-${orgSlug}`;

  envEntries.push({ name: 'EVE_ORG_FS_ROOT', value: '/org' });

  volumeMounts.push({
    name: 'org-fs',
    mountPath: '/org',
    readOnly: false,
  });

  volumes.push({
    name: 'org-fs',
    persistentVolumeClaim: { claimName: pvcName },
  });
}
```

No mount spec, no org slug → no volume → runner pod unchanged for orgs without filesystem.

### Agent-Runtime Changes

The agent-runtime is org-scoped (one per org in production). Its deployment references the org's PVC:

**Option A — Deployment-time config (simpler):**

The agent-runtime deployment for org `acme` mounts `eve-org-fs-acme`. This is set when the agent-runtime is provisioned for that org. The current static PVC reference in `agent-runtime-deployment.yaml` becomes a template or kustomize variable.

```yaml
volumes:
  - name: org-fs
    persistentVolumeClaim:
      claimName: eve-org-fs-${ORG_SLUG}
```

If the org hasn't enabled filesystem, the agent-runtime simply doesn't mount `/org`. `EVE_ORG_FS_ROOT` is unset. `ensureOrgRoot()` returns null. Clean skip.

**Option B — Multi-org local dev:**

For `AGENT_RUNTIME_MULTI_ORG=true` (k3d local dev), the agent-runtime handles multiple orgs. Two sub-options:

1. **Mount all enabled org PVCs** at `/org/{slug}` and set `EVE_ORG_FS_ROOT=/org/{slug}` per invocation. Complex.
2. **Use invocation's org_slug** to construct the path, but only works if all PVCs are mounted. Impractical for many orgs.
3. **Skip org-fs in multi-org mode.** Agent-runtime delegates to runner pods (which mount the right PVC). The agent-runtime itself doesn't need the mount — it's the runner pod that runs the harness.

Option 3 is the cleanest. In local dev, org-fs materialization happens in the runner pod, not the agent-runtime process. The agent-runtime's role is dispatching to runners. This aligns with the worker-org-fs-parity plan anyway.

For production (single-org agent-runtime), the PVC is mounted at deploy time. Simple.

### Worker Direct Execution Changes

When the worker runs a job directly (no runner pod, no agent-runtime — e.g., docker compose mode):

```typescript
// In worker execute(), after workspace setup:

const orgFsMount = effectiveInvocation.data?.orgfs_mount;
const orgSlug = orgFsMount?.org_slug;
let orgRootPath: string | null = null;

const orgRoot = process.env.EVE_ORG_FS_ROOT;
if (orgRoot && orgSlug && orgFsMount?.mode !== 'none') {
  // In direct mode, orgRoot is a base directory with per-org subdirs
  const perOrgRoot = path.join(orgRoot, orgSlug);
  await fs.mkdir(perOrgRoot, { recursive: true });

  const { mountPath, spec } = await materializeScopedOrgFsMount({
    workspacePath: repoPath,
    orgRoot: perOrgRoot,
    rawSpec: orgFsMount,
  });
  orgRootPath = mountPath;
}
```

In docker compose mode, `EVE_ORG_FS_ROOT=/org` and each org gets `/org/{slug}/` — path-based isolation within a shared volume. Not as strong as PVC isolation, but acceptable for local dev.

### Docker Compose Changes

```yaml
# docker-compose.yml
worker:
  environment:
    EVE_ORG_FS_ROOT: /org
  volumes:
    - org_fs:/org

agent-runtime:
  environment:
    EVE_ORG_FS_ROOT: /org
  volumes:
    - org_fs:/org

volumes:
  org_fs:
```

The shared volume contains per-org subdirectories (`/org/acme/`, `/org/test-org/`). Created lazily by `materializeScopedOrgFsMount`.

### Shared Module (from worker-org-fs-parity plan)

Move `materializeScopedOrgFsMount()` to `packages/shared/src/org-fs/` so both worker and agent-runtime can import it. This step is unchanged from the parity plan.

---

## PVC Provisioning Implementation

The API needs a service that creates PVCs. The deployer already has `k8s.service.ts` with `createPersistentVolumeClaim()`. Reuse that pattern:

```typescript
// apps/api/src/orgs/org-fs-admin.service.ts

async enableOrgFs(org: Org, storageSize: string = '5Gi'): Promise<void> {
  const pvcName = `eve-org-fs-${org.slug}`;
  const namespace = process.env.EVE_K8S_NAMESPACE || 'eve';

  // Create PVC via K8s API
  await this.k8sService.createPersistentVolumeClaim(namespace, {
    metadata: {
      name: pvcName,
      namespace,
      labels: {
        'eve.type': 'org-fs',
        'eve.org_id': org.id,
        'eve.org_slug': org.slug,
      },
    },
    spec: {
      accessModes: ['ReadWriteMany'],
      resources: {
        requests: { storage: storageSize },
      },
    },
  });

  // Update org config
  await this.orgsRepo.update(org.id, {
    orgfs_config: {
      enabled: true,
      storage_size: storageSize,
      pvc_name: pvcName,
      provisioned_at: new Date().toISOString(),
    },
  });
}
```

**Non-K8s environments** (docker compose, local dev): The enable endpoint sets `orgfs_config.enabled = true` but skips PVC creation (no K8s API available). The shared volume + subdirectory model handles it.

---

## Migration

```sql
-- 00073_org_fs_config.sql

ALTER TABLE orgs ADD COLUMN orgfs_config JSONB;

COMMENT ON COLUMN orgs.orgfs_config IS
  'Org filesystem configuration. null = not configured. { enabled: true, pvc_name, storage_size, provisioned_at }';
```

Single column addition. No data backfill needed — null means not configured, which means disabled.

---

## What Gets Deleted

| File / Resource | Reason |
|----------------|--------|
| `k8s/base/agent-runtime-pvc.yaml` | No more static PVC. PVCs are created by the API. |
| `k8s/overlays/local/agent-runtime-pvc.patch.yaml` | Patch target gone |
| Hardcoded `eve-org-fs-org-default` references | Replaced by `eve-org-fs-{slug}` |

---

## Files Modified (Summary)

| File | Change |
|------|--------|
| `packages/db/migrations/00073_org_fs_config.sql` | Add `orgfs_config` column |
| `packages/shared/src/schemas/org.ts` | Add `OrgFsConfig` type, update org schema |
| `packages/shared/src/org-fs/org-fs-mount.ts` | Move from agent-runtime (per parity plan) |
| `packages/shared/src/org-fs/index.ts` | Barrel export |
| `apps/api/src/orgs/org-fs-admin.service.ts` | Create — PVC provisioning + enable/disable |
| `apps/api/src/orgs/org-fs-admin.controller.ts` | Create — REST endpoints |
| `apps/api/src/orgs/orgs.module.ts` | Register new service/controller |
| `apps/orchestrator/src/loop/loop.service.ts` | Check `orgfs_config.enabled`, pass `org_slug` |
| `apps/worker/src/invoke/k8s-runner.ts` | Dynamic org-fs PVC mount in runner manifests |
| `apps/worker/src/invoke/invoke.service.ts` | Per-org subdirectory in direct execution mode |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Update import, skip mount in multi-org mode |
| `k8s/base/agent-runtime-deployment.yaml` | Remove static PVC mount (production uses deploy-time config) |
| `k8s/base/agent-runtime-pvc.yaml` | Delete |
| `k8s/overlays/local/agent-runtime-pvc.patch.yaml` | Delete |
| `docker/compose/docker-compose.yml` | Add `org_fs` volume to worker + agent-runtime |

---

## Local Dev (k3d) Bootstrap

For local dev, the `./bin/eh k8s deploy` flow should auto-enable org-fs for the manual test org:

```bash
# After deploy, as part of bootstrap:
eve org fs enable --org org_manualtestorg --size 5Gi
```

This creates `eve-org-fs-manual-test-org` PVC in the `eve` namespace. Runner pods for jobs in that org mount it automatically.

---

## Execution Order

This plan subsumes the `worker-org-fs-parity.md` plan. Execute in this order:

1. **Migration + schema** — Add `orgfs_config` column and type
2. **Shared module** — Move `materializeScopedOrgFsMount()` to `packages/shared`
3. **API endpoints** — Enable/disable/status with PVC provisioning
4. **Orchestrator gate** — Check `orgfs_config.enabled`, pass `org_slug`
5. **Runner pod mount** — Dynamic PVC in `k8s-runner.ts`
6. **Worker direct execution** — Per-org subdirectory model
7. **Agent-runtime cleanup** — Remove static PVC, skip mount in multi-org
8. **Docker compose** — Add shared volume
9. **Delete static PVC manifests** — Clean up old resources
10. **Local dev bootstrap** — Auto-enable for test org in `eh k8s deploy`

---

## Verification

1. **Build**: `pnpm build` — no import errors after shared module move
2. **Unit tests**: `pnpm test` — org-fs-mount tests pass from shared, new org-fs-admin tests pass
3. **API test**: `POST /orgs/:id/fs/enable` creates PVC, `GET /orgs/:id/fs` shows status
4. **K8s test**:
   - Enable org-fs for test org via CLI
   - `kubectl -n eve get pvc | grep eve-org-fs` — PVC exists with correct name
   - Create a job via `eve job create` — runner pod mounts the org's PVC
   - `eve job show <id> --verbose` — `runtime_meta.orgfs_mount.mounted: true`
   - `.org/` directory exists in workspace with correct scoped contents
5. **Negative test**: Create a job for an org without org-fs enabled — no mount, no error
6. **Disable test**: `eve org fs disable` — new jobs stop getting mounts, PVC remains

---

## Risks / Open Questions

- **PVC cleanup**: When an org is deleted, should we garbage-collect the PVC? Probably yes, but needs a grace period or explicit admin action.
- **Storage class**: Per-org PVCs use the cluster default storage class. May need to be configurable for production (EFS vs EBS vs local-path).
- **Agent-runtime in production**: Each org's agent-runtime deployment needs its PVC name injected. This is a deployment-time concern — kustomize overlay or Helm values per org.
- **Quotas**: `storage_size` is set at enable time. Resizing PVCs is possible but storage-class-dependent. May need a resize endpoint later.
- **RWX requirement**: Per-org PVCs need `ReadWriteMany` for multiple runner pods to mount simultaneously. Not all storage classes support this. EFS does, local-path does not (but works for local dev with `ReadWriteOnce` if only one runner at a time).
