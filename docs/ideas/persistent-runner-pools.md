# Persistent Runner Pools for Swarming Jobs

> **Idea / Draft**: Brainstorming doc for faster parallel job execution in k8s.
> Status: Idea
> Last Updated: 2026-01-29

## Problem

K8s runner pods are created per job attempt today. Pod scheduling + image pulls can take
20+ seconds, which makes short-lived swarm jobs (many small sub-jobs) painfully slow.
We need a model that preserves isolation but avoids paying the pod startup tax for every
attempt.

## Current Behavior (Baseline)

- Worker creates a fresh runner pod per attempt and deletes it afterward.
- Each attempt uses a unique workspace path (per-attempt workspace).
- Runner pods provide container isolation and are the primary execution unit in k8s.

References:
- `docs/ideas/runtime-core-design.md` (runner pod per job + workspace PVC)
- `docs/plans/runtime-k8s-final-design.md` (runner pod + PVC model)
- `apps/worker/src/invoke/k8s-runner.ts` (create pod + PVC, wait ready, invoke, delete)
- `docs/system/agent-sandbox-security.md` (runner pod isolation model)

## Goals

1. **Fast start**: near-zero startup overhead for small jobs.
2. **Parallel swarm**: allow many sub-jobs to execute concurrently.
3. **Keep safety**: preserve isolation boundaries (project/env) and sandboxing.
4. **Deploy-safe**: job execution should not be killed by app deployments.
5. **Simple config**: one obvious manifest knob, no complex operator workflows.

## Proposal: Runner Pools (Warm Slots)

Introduce **persistent runner pools** that keep a set of runner pods warm and ready.
Each pool is scoped to a project or project+environment, with a configurable size.

### Pool Model

- **Pool** = N long-lived runner pods.
- **Slot** = a single runner pod + its bound workspace PVC.
- **Lease** = a short-lived claim that assigns a job attempt to a slot.

Each slot runs **one job at a time** (max_concurrency=1). Parallelism comes from pool size.

### Execution Flow

1. Worker claims an idle slot (lease with TTL/heartbeat).
2. Worker calls `/invoke` on the runner pod with the normal invocation payload.
3. Runner executes the job inside its workspace root (new attempt subdir).
4. Worker releases the slot and returns it to idle.

No pod creation per job. If the pool is warm, startup is immediate.

### K8s Shape (Simple)

Use a StatefulSet per pool to keep stable pod identities and PVCs:

```
runner-pool (StatefulSet)
  - eve-runner-<project>-<env>-0  (PVC: ws-0)
  - eve-runner-<project>-<env>-1  (PVC: ws-1)
  - ...
```

### Scheduling + Leases

Extend the workspace pool model to track runner slots:

- `runner_slots` table (or extend `workspaces`) with:
  - `slot_id`, `project_id`, `env_name` (optional)
  - `pod_name`, `namespace`, `state` (idle|busy|draining|error)
  - `lease_job_id`, `lease_attempt_id`, `lease_expires_at`, `heartbeat_at`

Leases behave like gates:
- Atomic claim on idle slot.
- TTL safety to recover from crashes.
- Reaper resets stale slots or deletes pods for restart.

## Manifest / Job Configuration

Add a minimal, intuitive extension to the manifest defaults:

```yaml
x-eve:
  defaults:
    execution:
      runner_pool:
        scope: project-env   # project|project-env
        size: 4              # warm slots
        max_size: 8          # optional burst ceiling
        allow_burst: true    # fall back to ephemeral pods if pool is full
        worker_type: default-worker
        max_concurrency: 1   # per slot
```

Job-level override (for swarm jobs):

```json
{
  "hints": {
    "runner_pool": { "min": 8 }
  }
}
```

Notes:
- `worker_type` continues to select the runner image via existing routing.
- If `execution.runner_pool` is omitted, current per-job runner pods remain.

## Workspace Reuse and Swarm Semantics

Runner pools pair naturally with workspace reuse:

- Default `workspace.mode=job` keeps per-attempt isolation.
- `workspace.mode=session` + `workspace.key` can pin related jobs to the same slot
  for hot caches and faster repo reuse.
- Swarm jobs can request a larger pool size to run sub-jobs in parallel.

See `docs/system/job-git-controls.md` for workspace mode semantics.

## Deployment Safety

We must avoid redeploying the runner that is orchestrating the deployment.

Proposed rules:
- Runner pools live in a **system namespace** (e.g., `eve-runners`), not inside
  application environment namespaces.
- App deploys only touch app resources (deployments/services/ingress), never runner pools.
- Deploy jobs should run on a **control-plane runner pool** that is separate from
  per-project pools and never managed by app deploys.
- Worker image upgrades use drain + replace: mark slots `draining`, finish in-flight
  jobs, then roll new pods.

## Isolation and Security

- Pools are scoped per project or project+env to avoid cross-tenant mixing.
- Runner pods only accept jobs for their scope (label-based allow list).
- Keep harness sandbox flags and per-attempt workspace paths.
- If strict isolation is required, jobs can opt into the existing per-job pod mode.

## Fallbacks and Complements

- **Burst mode**: if pool is exhausted, spawn an ephemeral runner pod (current path).
- **Image pre-pull**: DaemonSet to pre-pull runner images on nodes to reduce cold starts.
- **In-job swarm**: for ultra-short tasks, allow a single runner to spawn local sub-agents
  without creating child jobs (optional future feature).

## Open Questions

1. Should pool state live in `workspaces` or a new `runner_slots` table?
2. Where do we keep pool size defaults (manifest vs project settings)?
3. How do we handle env-specific secrets and service discovery without running in the env namespace?
4. What metrics define success (p95 job start time, queue time, pool utilization)?

## Why This Is Elegant

- It reuses existing primitives (worker + runner + workspace) with minimal new surface area.
- It preserves the security model while giving fast parallelism where it matters.
- It keeps deployment safety by separating app deploys from job execution pools.
- It scales naturally: pool size equals parallel capacity, no new scheduler.
