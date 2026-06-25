# Worker Org Filesystem Parity

> **Status**: Complete
> **Date**: 2026-03-03
> **Completed**: 2026-03-03

## Problem

The org filesystem (shared per-org storage mounted at `.org/` in agent workspaces) only works for agents routed through the **agent runtime** (warm pods). Normal Eve jobs dispatched to the **worker** (via `eve job create`) silently ignore the `orgfs_mount` spec — even though the orchestrator already computes and passes it in the invocation data.

This means two identical agents produce different behavior depending on their execution path:
- Agent runtime path: sees `.org/`, can read/write shared org files
- Worker/runner pod path: no `.org/`, no org filesystem access

## Goal

Make org filesystem access work identically for worker-executed jobs. Any agent in any harness sees `.org/` in their workspace regardless of execution path.

## Assumptions

- Orchestration currently uses a single shared org filesystem volume (single-org/RWX semantics remain acceptable for now).
- Runner pods can still mount `eve-org-fs-org-default`.
- `EVE_ORG_FS_ROOT` is the explicit mount-point contract used by both runner and worker code paths.

## Current State

| Capability | Agent Runtime | Worker |
|-----------|:---:|:---:|
| Orchestrator computes `orgfs_mount` | Yes | Yes (passed, ignored) |
| `materializeScopedOrgFsMount()` called | Yes | No |
| `EVE_ORG_ROOT` set in harness env | Yes | No |
| Runtime metadata tracking | Yes | No |
| K8s PVC mounted | Yes (`/org`) | No |
| Docker-compose volume | No (env set, no vol) | No |

## Architecture

The orchestrator already derives `OrgFsMountContext` from the user's RBAC bindings and passes it as `invocationData.orgfs_mount` to **both** runtimes. The agent-runtime processes it; the worker ignores it.

```
Orchestrator
  |-- resolveOrgFsMountContext(userId, orgId, projectId)
  |     returns: { mode, allow_prefixes, read_only_prefixes }
  |
  |-- invocationData.orgfs_mount = mountSpec
       |
       |-- Agent Runtime: ensureOrgRoot() -> materializeScopedOrgFsMount() -> .org/
       |
       |-- Worker: [IGNORES orgfs_mount] <-- THIS IS THE GAP
```

## Implementation

### Step 1: Move `org-fs-mount.ts` to shared package

The materialization logic is self-contained (pure fs operations, no app-specific deps). Move it so both apps can import it.

**Move**: `apps/agent-runtime/src/invoke/org-fs-mount.ts` -> `packages/shared/src/org-fs/org-fs-mount.ts`

- Create `packages/shared/src/org-fs/index.ts` barrel export
- Export from `packages/shared/src/index.ts`
- Update agent-runtime import to use `@eve/shared`
- Move existing unit test alongside the module

**Files**:
- `apps/agent-runtime/src/invoke/org-fs-mount.ts` (delete)
- `apps/agent-runtime/test/unit/org-fs-mount.test.ts` (delete)
- `packages/shared/src/org-fs/org-fs-mount.ts` (create -- exact copy)
- `packages/shared/src/org-fs/index.ts` (create -- barrel)
- `packages/shared/src/index.ts` (add export)
- `packages/shared/test/org-fs-mount.test.ts` (create -- move from agent-runtime, update import)
- `apps/agent-runtime/src/invoke/invoke.service.ts` (update import)

### Step 2: Add org-fs materialization to worker `execute()`

Mirror what agent-runtime does in `ensureOrgRoot()`. Insert after workspace setup and before `materializeSecrets()`.

**File**: `apps/worker/src/invoke/invoke.service.ts` (after line ~1695)

```typescript
// After workspace setup, before materializeSecrets:
const orgFsMount = effectiveInvocation.data?.orgfs_mount;
let orgRootPath: string | null = null;
let orgFsMountSpec = { mode: 'none' as const, allow_prefixes: [] as string[], read_only_prefixes: [] as string[] };

const orgRoot = process.env.EVE_ORG_FS_ROOT;
if (orgRoot && orgFsMount) {
  const { mountPath, spec } = await materializeScopedOrgFsMount({
    workspacePath: repoPath,
    orgRoot,
    rawSpec: orgFsMount,
  });
  orgRootPath = mountPath;
  orgFsMountSpec = spec;
}

if (effectiveInvocation.attemptId) {
  await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, {
    orgfs_mount: {
      mode: orgFsMountSpec.mode,
      allow_prefixes: orgFsMountSpec.allow_prefixes,
      read_only_prefixes: orgFsMountSpec.read_only_prefixes,
      mounted: Boolean(orgRootPath),
    },
  });
}
```

The materialization is opt-in: if `EVE_ORG_FS_ROOT` isn't set or the directory doesn't exist, it gracefully skips (no `.org/`, no error).

Keep runtime metadata aligned with behavior:
- `mounted: false` when mount is skipped (env missing, invalid spec, or disabled mode)
- `mounted: true` only when `.org/` creation succeeds

### Step 3: Pass `orgRootPath` through to harness env

Update worker's `materializeSecrets()` to accept and set `EVE_ORG_ROOT`:

**File**: `apps/worker/src/invoke/invoke.service.ts`

- Add 4th parameter `orgRootPath: string | null` to `materializeSecrets()` signature
- Add `if (orgRootPath) { env.EVE_ORG_ROOT = orgRootPath; }` in the env block
- Update the call site to pass `orgRootPath`

This mirrors the agent-runtime's `materializeSecrets()` which already takes this parameter.

### Step 3b: Keep materialization explicit for harness and test paths

Any call path that reaches `materializeSecrets()` (including tests and helper scripts) should pass the computed `orgRootPath` so worker and agent-runtime behavior remains consistent.

### Step 4: Mount org-fs PVC in K8s runner pods

The runner pod manifest is built dynamically in `k8s-runner.ts`. Add the org-fs PVC as a second volume.

**File**: `apps/worker/src/invoke/k8s-runner.ts` (in `buildRunnerManifests()`)

- Add `{ name: 'EVE_ORG_FS_ROOT', value: '/org' }` to `envEntries`
- Add `{ name: 'org-fs', mountPath: '/org', readOnly: false }` to container `volumeMounts`
- Add `{ name: 'org-fs', persistentVolumeClaim: { claimName: 'eve-org-fs-org-default' } }` to pod `volumes`

The org-fs PVC (`eve-org-fs-org-default`) is `ReadWriteMany`, so multiple runner pods can mount it simultaneously. The PVC is already created by `k8s/base/agent-runtime-pvc.yaml`.

**Future**: When we support multi-org, the PVC name will need to be dynamic (derived from org ID in the invocation).

### Step 5: Add `EVE_ORG_FS_ROOT` to worker K8s deployments

The worker image is reused for runner pods. The env var tells the code inside the runner pod where to find the org root.

**Files**:
- `k8s/base/worker-deployment.yaml` -- add `EVE_ORG_FS_ROOT: /org`
- `packages/cli/assets/local-k8s/base/worker-deployment.yaml` -- same

The worker deployment itself doesn't need a PVC mount because in K8s mode it delegates to runner pods (which get the mount from step 4).

### Step 6: Docker-compose shared volume

Add `EVE_ORG_FS_ROOT` and a shared volume for parity between worker and agent-runtime.

**File**: `docker/compose/docker-compose.yml`

- Add `EVE_ORG_FS_ROOT: /org` to worker environment
- Add `org_fs:/org` volume mount to both worker and agent-runtime
- Add `org_fs:` named volume in the `volumes:` section

This gives docker-compose mode a shared `/org` directory between worker and agent-runtime, matching the K8s PVC model.

## Files Modified (Summary)

| File | Change |
|------|--------|
| `packages/shared/src/org-fs/org-fs-mount.ts` | Create (move from agent-runtime) |
| `packages/shared/src/org-fs/index.ts` | Create (barrel export) |
| `packages/shared/src/index.ts` | Add org-fs export |
| `packages/shared/test/org-fs-mount.test.ts` | Create (move from agent-runtime) |
| `apps/agent-runtime/src/invoke/org-fs-mount.ts` | Delete |
| `apps/agent-runtime/test/unit/org-fs-mount.test.ts` | Delete (moved to shared) |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Update import path |
| `apps/worker/src/invoke/invoke.service.ts` | Add org-fs materialization + metadata |
| `apps/worker/src/invoke/k8s-runner.ts` | Add org-fs PVC mount to runner pods |
| `k8s/base/worker-deployment.yaml` | Add `EVE_ORG_FS_ROOT` env var |
| `packages/cli/assets/local-k8s/base/worker-deployment.yaml` | Add `EVE_ORG_FS_ROOT` env var |
| `docker/compose/docker-compose.yml` | Add org-fs volume + env var |

## What Does NOT Change

- **Orchestrator**: Already computes and passes `orgfs_mount` -- no changes needed
- **env-builder.ts**: Both apps set `EVE_ORG_ROOT` directly in their `materializeSecrets()`, not through the shared env-builder
- **Agent-runtime PVC YAML**: Already exists (`k8s/base/agent-runtime-pvc.yaml`), shared by runner pods
- **Agent behavior**: The `.org/` directory appears identically -- agents don't need to change

## Verification

1. **Build**: `pnpm build` -- confirm no import errors after moving the module
2. **Unit tests**: `pnpm test` -- confirm org-fs-mount tests pass from their new location in shared
3. **K8s test**:
   - `./bin/eh k8s deploy` to redeploy with updated manifests
   - Create a job via `eve job create` (worker path) with a user that has orgfs permissions
   - Check `eve job show <id> --verbose` for `runtime_meta.orgfs_mount.mounted: true`
   - Verify `.org/` directory exists in the job workspace
4. **Negative check**: run the same job as a user without org-fs permissions and confirm `runtime_meta.orgfs_mount.mounted: false`
5. **Integration test**: `./bin/eh test integration` to verify no regressions

## Risks / Open Questions

- Single PVC name (`eve-org-fs-org-default`) is currently hardcoded and effectively single-tenant; revisit when multi-org isolation is implemented.
- Compose shared volume is cluster-wide for local environments; concurrent local multi-org runs can share `.org/` state unless isolated by additional namespacing.
