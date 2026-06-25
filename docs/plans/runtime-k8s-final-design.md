# Runtime K8s Final Design (Git-Only)

> **Plan (Historical)**: This plan may be partially or fully implemented.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.
> Note: `project.yaml` defaults are deprecated; use `x-eve.defaults` in `.eve/manifest.yaml`.
> Legacy note: examples may use `components` or pipeline `actions`. v2 manifests
> use `services` and `pipelines.<name>.steps`.

> Status: Plan
> Last Updated: 2026-01-17

This document consolidates `docs/ideas/runtime-core-design.md`
into one final runtime design and MVP plan.
Pre-MVP rules apply: simplify aggressively, no external orchestrators.

---

## Principles

1. **K8s is canonical**: k3d locally, k3s/staging, k8s/prod. No compose.
2. **Git-only repos**: no `file://` mounts; always clone/fetch from git.
3. **Repo-owned contract**: small `.eve/` directory defines runtime needs.
4. **Reuse-first**: pooled workspaces with PVCs, runner pod per job.
5. **Single concurrency primitive**: atomic gates with TTL, no queues.
6. **Workflows are jobs**: OpenSkills `SKILL.md`, optional triggers.

---

## Architecture (Core Loop)

```
CLI -> API -> Orchestrator -> Worker -> K8s
                |                 |
             Postgres        Runner Pod + PVC
```

- Orchestrator schedules jobs based on DB state only.
- Worker provisions K8s objects, runs job, streams logs.
- K8s resources are labeled with `workspace_id` for traceability.

---

## Repo Contract (MVP)

```
.eve/
  project.yaml
  manifest.yaml        # services + envs
  hooks/
    on-clone           # optional
    on-reuse           # optional
    on-acquire         # optional
    on-release         # optional
  workflows/
    <name>/SKILL.md
```

### project.yaml (minimal)

```yaml
name: my-service

defaults:
  harness: mclaude
  worker_type: standard
  timeout: 30m

pool:
  size: 1

environments:
  staging:
    gate: env:staging
    vars_from_secret: my-service-staging

triggers:
  - event: cron
    schedule: "0 * * * *"
    workflow: deploy-staging
```

### manifest.yaml (services)

```yaml
services:
  - name: db
    image: postgres:16-alpine
    env:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: test
      POSTGRES_DB: app_test
    ready: pg_isready
    provides:
      DATABASE_URL: postgres://app:test@$HOST:$PORT/app_test
```

### Hook Order

1. `on-clone` (fresh env only)
2. `on-reuse` (reused env only)
3. `on-acquire` (always)
4. `on-release` (always)

---

## Environment Model (Pooled + Named)

### Pooled Environments

- Per-project pool of workspaces.
- Each workspace = PVC + metadata row in DB.
- Runner pod mounts PVC and runs jobs.
- Default pool size = 1.

### Named Environments

- Defined in `project.yaml` under `environments`.
- Implemented as **gates + secrets**, not dedicated namespaces (MVP).
- Jobs target named envs via `--env staging`.

---

## Source of Truth (Option B)

**Workspaces table is authoritative**. K8s resources are derived from it.

Minimal schema:

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL,             -- idle | acquired | teardown
  last_job_id TEXT,
  last_used_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  UNIQUE(project_id, id)
);
```

Drift mitigation (MVP): worker reconcile on startup:
- `idle` + missing PVC => recreate PVC.
- `acquired` + stale heartbeat + no runner pod => reset to `idle`.

---

## Gates (Atomic Locks)

Single primitive for all concurrency control.

```sql
CREATE TABLE job_gates (
  gate_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  ttl_expires_at TIMESTAMPTZ NOT NULL
);
```

- Acquire: `INSERT ... ON CONFLICT DO NOTHING`.
- If any gate held, job remains `ready` with `blocked_on_gates`.
- Release on completion or TTL expiry.

---

## Services

- Parse `.eve/manifest.yaml` services.
- Launch pods inside job namespace.
- Inject `provides` env vars into runner pod.
- If env var already set, skip service (simple override).
- Cleanup on job completion.

---

## Workflows

- Workflow = job with `SKILL.md`.
- Triggers defined in `project.yaml` (manual + cron only in MVP).
- Trigger => create job with workflow skill + gates.

---

## Dogfooding Flow (Git-Only)

1. Start k3d cluster and deploy Eve.
2. Ensure project with git repo URL.
3. Run integration tests as a job.

```bash
eve project ensure --repo-url https://github.com/eve-horizon/eve-horizon
eve job create --project proj_x --description "Run integration tests"
eve job logs <job-id> --follow
```

---

## MVP Phases

### Phase 1: Core Job Execution
- Runner pod + PVC workspace
- Git clone/fetch (no file://)
- Log streaming

### Phase 2: Workspace Reuse + Hooks
- Hook execution model
- Reuse vs fresh handling
- Workspace pool size

### Phase 3: Services Provisioning
- `manifest.yaml` parser (services)
- Service pods + readiness + env injection

### Phase 4: Gates
- `job_gates` table
- Acquire/release + TTL
- `blocked_on_gates` surfaced in API/CLI

### Phase 5: Workflows (Manual + Cron)
- `.eve/workflows/*/SKILL.md` discovery
- `project.yaml` triggers

### Phase 6: Dogfooding
- Run Eve tests in Eve via git repo
- Iterate on hooks and services

---

## Out of Scope (MVP)

- External orchestrators (Argo/Tekton)
- Queueing lock semantics
- Approval UX
- RBAC
- Multi-cluster
- Autoscaling pools
