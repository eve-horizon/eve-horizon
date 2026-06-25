# Agent Runtime (Org-Scoped) Implementation Plan

> Status: Completed
> Last Updated: 2026-02-04
> Purpose: Add a warm, org-scoped Agent Runtime service with sharded execution and org FS support.
> Order: 2 (runtime layer)

## Dependencies
- v3 plan: docs/ideas/channel-integrations-unified-plan-v3.md
- Agent/Team/Thread primitives plan (see: agents-teams-threads-primitives-plan.md)
- Existing worker + harness sandbox model

## Goals
- Low-latency execution for hundreds of agents per org (no per-message pods).
- Preserve job-as-audit-trail while executing in-process.
- Keep sandboxing intact while exposing org filesystem.

## Non-goals
- UI for agent runtime management (future).
- Per-agent pods (runtime uses pooled pods).

## Core Design
- New service: `agent-runtime`
- Deployed per org (control-plane namespace), 3..10 replicas.
- Sharded by consistent hash on `agent_id`.
- Jobs are still created by orchestrator; runtime executes them in-process.
- Explicitly replaces **runner pod per job** for chat/agent workloads (warm pods only).

## Org FS + Sandbox Compatibility
- Org RWX volume mounted at `/org` in runtime pods.
- For each job workspace, bind-mount org volume into `{workspace}/.org`.
- Set `EVE_ORG_ROOT={workspace}/.org` in job env.
- Keep sandbox root as workspace (no global allow-dirs).

## Work Breakdown

### Phase 1: Runtime Service Skeleton
- [x] Create `apps/agent-runtime` service with health endpoint.
- [x] Wire to Eve API auth + org context.
- [x] Add runtime registration heartbeat (`agent_runtime_pods`).

### Phase 2: Sharding + Placement
- [x] Implement consistent hashing on `agent_id`.
- [x] Store placements in `agent_placements` table.
- [x] Add failover on pod loss (rehash + migrate).

### Phase 3: Job Execution Path
- [x] Add runtime job executor (pull jobs from API / orchestrator request).
- [x] Execute using existing harness wrappers (eve-agent-cli).
- [x] Emit logs + results back to API.

### Phase 4: Org FS Mounts
- [x] Bind-mount org FS into `{workspace}/.org`.
- [x] Inject `EVE_ORG_ROOT` env var.
- [x] Update sandbox tests (read/write inside `.org`).

### Phase 5: Observability
- [x] Add runtime status endpoint (pod, shard, capacity).
- [x] Expose in `eve system status` (optional).

## API / DB Changes
- DB tables:
  - `agent_runtime_pods` (org_id, pod_name, status, capacity)
  - `agent_placements` (agent_id, pod_id, shard_key)
- API endpoints:
  - `GET /orgs/:id/agent-runtime/status`
  - `POST /orgs/:id/agent-runtime/claim` (optional)

## Tests
- Unit: hashing + placement logic.
- Integration: runtime executes a job and posts logs.
- Sandbox: `.org` is accessible, parent dirs are not.

## Risks
- Misconfigured mount breaks sandbox assumptions.
- Shard rebalancing could thrash without limits.

## Spec Appendix

### Runtime Job Invocation (payload sketch)
```json
{
  "job_id": "projx-abc12345",
  "attempt_id": "1",
  "project_id": "proj_xxx",
  "org_id": "org_xxx",
  "agent_id": "agent_main",
  "workflow": "assistant",
  "workspace_path": "/workspaces/proj_xxx/projx-abc12345/1",
  "env_name": "staging",
  "identity": { "provider": "slack", "external_id": "U123", "eve_user_id": "user_abc" }
}
```

### Workspace + Org FS Layout
```
/workspaces/{projectId}/{jobId}/{attemptNum}/
  repo/
  .org/          # bind-mounted org RWX volume
```

Env vars:
- `EVE_ORG_ROOT={workspace}/.org`
- `EVE_THREAD_ID`, `EVE_AGENT_ID` (optional)

### Concurrency / Backpressure
- Per-pod max concurrent agents (configurable).
- Reject or queue when capacity exceeded.

### Failure Behavior
- If runtime pod dies, orchestrator re-dispatches to another shard.
- Placement table updated on migration.
