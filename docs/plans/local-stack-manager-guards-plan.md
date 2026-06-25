# Plan: Stack Manager Guards for `eve local` vs `./bin/eh`

> **Status**: Proposed
> **Date**: 2026-02-17
> **Relates to**: [eve-local-vs-bin-eh-consolidation-plan.md](./eve-local-vs-bin-eh-consolidation-plan.md)

## Context

`eve local up` (CLI) and `./bin/eh k8s deploy` (repo scripts) both target the same k3d cluster (`eve-local`) and namespace (`eve`), but use fundamentally different image sourcing: CLI pulls released images from GHCR, while `./bin/eh` builds from local source. Running one after the other silently overwrites images, causing confusion and wasted time.

We need fail-fast guards so each tool detects when the other is managing the stack.

## Approach: Namespace Annotation

Use an annotation on the `eve` namespace: `eve-managed-by` with value `cli` or `bin-eh`.

Why annotation over ConfigMap:
- No extra resource to create/manage
- No kustomization changes needed
- Readable before manifests are applied (namespace may already exist from a prior deploy)
- If namespace doesn't exist yet → first deploy → no conflict possible → proceed

## Changes

### 1. `packages/cli/src/commands/local.ts`

Add two functions following the `readSecretValue` pattern (lines 970-991):

```typescript
function readManagerMarker(kubectl: string): string {
  const result = run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, 'get', 'namespace', 'eve',
     '-o', 'jsonpath={.metadata.annotations.eve-managed-by}'],
    { stdio: 'pipe', allowFailure: true },
  );
  return result.status === 0 ? result.stdout.trim() : '';
}

function writeManagerMarker(kubectl: string, runtimeOptions: UpRuntimeOptions): void {
  run(
    kubectl,
    ['--context', DEFAULT_KUBE_CONTEXT, 'annotate', 'namespace', 'eve',
     'eve-managed-by=cli', '--overwrite'],
    { stdio: runtimeOptions.verbose && !runtimeOptions.quiet ? 'inherit' : 'pipe',
      allowFailure: true },
  );
}
```

**Guard check** — insert in `handleUp()` after `ensureClusterReady()`, before `importPlatformImages()`:

```typescript
if (!skipDeploy) {
  const kubectl = requireToolPath('kubectl', ...);
  const marker = readManagerMarker(kubectl);
  if (marker && marker !== 'cli') {
    throw new Error(
      `This local stack is managed by './bin/eh k8s deploy' (marker: ${marker}).\n` +
      `'eve local up' would overwrite source-built images with released GHCR images.\n\n` +
      `To switch to CLI management: eve local reset --force\n` +
      `To continue with repo scripts: ./bin/eh k8s deploy`
    );
  }
  // ... existing deploy flow ...
}
```

**Write marker** — after `applyLocalManifests()` (namespace guaranteed to exist):

```typescript
applyLocalManifests(runtimeOptions);
writeManagerMarker(kubectl, runtimeOptions);
```

### 2. `bin/eh-commands/k8s.sh`

Add two functions following existing patterns:

```bash
read_manager_marker() {
  eh_kubectl_local get namespace eve \
    -o jsonpath='{.metadata.annotations.eve-managed-by}' 2>/dev/null || true
}

write_manager_marker() {
  eh_kubectl_local annotate namespace eve eve-managed-by=bin-eh --overwrite 2>/dev/null || true
}

check_manager_guard() {
  local marker
  marker=$(read_manager_marker)
  if [[ -n "$marker" && "$marker" != "bin-eh" ]]; then
    echo -e "${RED}ERROR: This local stack is managed by 'eve local up' (marker: ${marker}).${NC}"
    echo ""
    echo "'./bin/eh k8s deploy' builds from source; mixing with 'eve local up' causes image conflicts."
    echo ""
    echo "To switch to repo scripts: eve local reset --force"
    echo "To continue with CLI: eve local up"
    exit 1
  fi
}
```

**Guard check** — in `run_deploy()` after `ensure_cluster_connectivity`, before image build:

```bash
run_deploy() {
  ensure_k3d_cluster
  ensure_cluster_connectivity
  check_manager_guard          # NEW

  echo "Building and importing images..."
  # ... rest unchanged
}
```

**Write marker** — after `kubectl_mutate_local apply -k` (namespace exists):

```bash
kubectl_mutate_local apply -k "$LOCAL_OVERLAY"
write_manager_marker           # NEW
```

### 3. `eve local reset` clears the marker

The `handleReset()` function already calls `handleDown({ destroy: true })` which destroys the entire cluster. When a new cluster is created, the namespace (and annotation) are gone. No additional code needed — reset naturally clears the marker.

### 4. Update consolidation plan doc

Edit `docs/plans/eve-local-vs-bin-eh-consolidation-plan.md`:
- Remove Phase 3 (auto-load system secrets) — platform-level secrets are deprecated in favor of org/project secrets
- Add this guard implementation as Phase 0 (highest priority)
- Note in Phase 4 (docs) that platform-level secrets are deprecated

## Files Modified

| File | Change |
|---|---|
| `packages/cli/src/commands/local.ts` | Add guard check + marker write in `handleUp()` |
| `bin/eh-commands/k8s.sh` | Add guard check + marker write in `run_deploy()` |
| `docs/plans/eve-local-vs-bin-eh-consolidation-plan.md` | Remove Phase 3, add guard as Phase 0 |

## Verification

1. **Fresh stack — `eve local up` works**:
   ```bash
   eve local reset --force    # clean slate
   eve local up               # should succeed, write marker 'cli'
   kubectl get ns eve -o jsonpath='{.metadata.annotations.eve-managed-by}'  # → 'cli'
   ```

2. **`./bin/eh` rejects CLI-managed stack**:
   ```bash
   # After step 1:
   ./bin/eh k8s deploy         # should fail fast with clear error
   ```

3. **Fresh stack — `./bin/eh` works**:
   ```bash
   eve local reset --force     # clean slate
   ./bin/eh k8s deploy         # should succeed, write marker 'bin-eh'
   kubectl get ns eve -o jsonpath='{.metadata.annotations.eve-managed-by}'  # → 'bin-eh'
   ```

4. **`eve local up` rejects `./bin/eh`-managed stack**:
   ```bash
   # After step 3:
   eve local up                # should fail fast with clear error
   ```

5. **Reset allows switching**:
   ```bash
   eve local reset --force     # destroys cluster, clears marker
   eve local up                # works again
   ```
