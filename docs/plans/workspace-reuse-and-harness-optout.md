# Workspace Reuse + Harness Opt-Out

> **Plan (Historical)**: This plan may be partially or fully implemented.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

## Goal

Speed up job startup for repeated attempts or frequent jobs by reusing cached git data, while allowing harnesses/variants that manage their own git trees to opt out and receive clean, isolated workspaces.

## Scope

- Add workspace reuse via bare mirror + worktree reset
- Allow harness or variant to declare workspace requirements
- Preserve existing behavior by default

Out of scope: UI changes, distributed cache, remote workspace sharing.

## Design Summary

### 1) Shared mirror + per-job worktree

Workspace layout:

```
WORKSPACE_ROOT/
  mirrors/{projectId}/repo.git     # bare mirror (shared)
  worktrees/{projectId}/{jobId}/   # per-job working tree
```

Fast path:

- Ensure mirror exists or fetch latest
- Ensure worktree exists or create it
- Reset to target branch/commit and clean

### 2) Harness capability flags

Add simple capability fields to harness spec (or adapter metadata):

- `workspace_mode: "shared" | "isolated" | "none"`
  - `shared`: reuse cached worktree (default)
  - `isolated`: create fresh workspace per attempt, no reuse
  - `none`: harness manages git/workspace; worker does not prepare repo
- `manages_git_trees: boolean` (default false)
- `requires_clean_repo: boolean` (default true)

### 3) Worker behavior by mode

- `shared`: mirror + worktree reset/clean
- `isolated`: mirror + new worktree per attempt (unique path)
- `none`: skip repo prep, pass repo URL/branch to harness

This prevents clashes with harnesses (e.g., autodrive/code) that manage their own git trees.

## Implementation Plan

### Step 1: Add harness capability metadata

- Extend harness definition type and adapters
- Default to current behavior (`shared`, `requires_clean_repo=true`)

### Step 2: Workspace manager

- Add workspace helper in worker to:
  - Create/fetch bare mirror
  - Create or reuse worktree
  - Reset/clean to target ref

### Step 3: Worker integration

- In `InvokeService`, branch workspace logic by harness capability
- Ensure `file://` repo paths still work (skip mirror, use copy + clean)

### Step 4: Cleanup policy

- Keep worktree for job across attempts
- Remove on job completion only (optional, controlled by existing cleanup flags)

### Step 4b: Disk Management (Operator Knobs)

Goal: prevent uncontrolled growth from mirrors + worktrees while keeping reuse fast.

Defaults (suggested env vars):
- `EVE_WORKSPACE_MAX_GB` (total workspace budget per instance)
- `EVE_WORKSPACE_MIN_FREE_GB` (hard floor; refuse new claims if below)
- `EVE_WORKSPACE_TTL_HOURS` (idle TTL for job worktrees)
- `EVE_SESSION_TTL_HOURS` (idle TTL for session workspaces)
- `EVE_MIRROR_MAX_GB` (cap for bare mirrors)

Policies:
- LRU eviction of worktrees when over budget.
- TTL cleanup for idle job/session worktrees.
- `git fetch --prune` + periodic `git gc --prune=now` for mirrors.
- Fail-fast on low disk (emit system event, do not start new attempts).

K8s:
- Per-attempt PVCs remain disposable (delete on completion).
- Session-scoped PVCs must have TTL cleanup and a storage quota.

### Step 5: Tests

- Reuse path avoids reclone for second attempt
- Isolated mode always creates new workspace
- None mode skips workspace prep

## File Targets

- `apps/worker/src/invoke/invoke.service.ts`
- `apps/worker/src/invoke/harnesses/*`
- `packages/shared/src/agent-harness.ts` (or equivalent harness spec)
- `docs/system/agent-harness-design.md` (update after implementation)

## Risks / Mitigations

- **Workspace corruption**: always `git reset --hard` + `git clean -fdx`
- **Concurrent jobs on same worktree**: keep worktree per job (not per project)
- **Disk usage growth**: add periodic cleanup of idle job worktrees

## Success Criteria

- Repeat attempts are fast (no reclone)
- Harnesses that manage git trees can opt out cleanly
- No change in behavior for existing harnesses by default
