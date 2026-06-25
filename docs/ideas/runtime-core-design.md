# Eve Runtime Core (K8s-First + Workflows)

> **Idea / Draft**: This is a brainstorming document and may not reflect current behavior.
> Note: `.eve/services.yaml` references are deprecated; use `.eve/manifest.yaml` with `services`.
> Pipelines should be expressed as `pipelines.<name>.steps` (v2). See `docs/system/manifest.md`.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Idea
> Last Updated: 2026-01-18

## Goal

Design the simplest possible runtime that:
- Runs jobs for any repo that follows the Eve spec.
- Works the same for self-validation and client projects.
- Supports ephemeral job environments and persistent envs (staging/prod).
- Prevents resource clashes with atomic, project-scoped gates.
- Allows agent-powered GitOps workflows defined as OpenSkills.

No external orchestrators (Argo/Tekton). We implement the minimal primitives ourselves.

---

## Core Principles

1. **K8s is canonical** for all environments (local, staging, prod).
2. **Repo-owned contract** is small and obvious.
3. **Reuse over rebuild** for job workspaces by default.
4. **Atomic gates** are the only concurrency control.
5. **Workflows are jobs** (no separate pipeline engine).

---

## Repo Runtime Contract

```
.eve/
  runtime.yaml           # legacy (deprecated)
  services.yaml          # legacy (deprecated)
  workflows/
    deploy-to-staging/
      SKILL.md
      workflow.yaml      # optional (triggers)
```

### runtime.yaml (minimal) [legacy]

```yaml
project:
  name: eve-horizon

workspaces:
  reuse: true
  pool_size: 1
  hooks:
    fresh: ./bin/eve/workspace-fresh.sh
    reuse: ./bin/eve/workspace-reuse.sh
    cleanup: ./bin/eve/workspace-cleanup.sh

tasks:
  integration: ./bin/eh test integration

workflows:
  deploy-to-staging:
    skill: .eve/workflows/deploy-to-staging/SKILL.md
    gates: ["env:staging"]
    trigger:
      event: git.push
      branch: main
```

### services.yaml (optional) [legacy]

```yaml
services:
  - name: db
    image: postgres:16-alpine
    env:
      POSTGRES_USER: eve
      POSTGRES_PASSWORD: eve
      POSTGRES_DB: eve_test
    ready: pg_isready
    provides:
      DATABASE_URL: postgres://eve:eve@$HOST:$PORT/eve_test
```

### compose.yaml (dev-only adapter)

In local dev, projects can provide a compose adapter while keeping K8s as canonical:

```
/.eve/runtime/compose.yaml
```

The compose adapter mirrors service definitions for fast local loops but is not a source of truth.

### workflow.yaml (optional)

```yaml
trigger:
  event: cron
  schedule: "0 * * * *"
gates:
  - env:staging
```

If `workflow.yaml` is missing, the workflow is manual-only.

---

## Runtime Model (K8s-First)

### Project Defaults (DB-Resident)

Projects must define default **harness** and **worker type** in the main DB,
so the orchestrator can schedule without reading repo metadata.

Minimal fields:

```yaml
project:
  default_worker_type: standard
  default_harness: mclaude
```

Jobs inherit `x-eve.defaults` unless explicitly overridden in the job request.

---

### 1) Workspace Pool (Ephemeral, Reusable)

Each project has a small pool of **workspaces**. A workspace is:
- A **PVC** that holds the repo checkout and caches.
- A short-lived **runner pod** created per job, mounting the PVC.

Default: `pool_size: 1` to keep it simple and avoid conflicts.

**Reuse flow**:
1. Job requests workspace for project.
2. Worker picks an idle workspace or creates one.
3. Runner pod mounts PVC and runs hooks.

**Hooks**:
- `fresh`: clone repo and run any first-time setup.
- `reuse`: fetch/reset/clean repo, reset state.
- `cleanup`: optional cleanup; workspace stays warm unless told to delete.

The worker sets:
- `EVE_WORKSPACE_STATE=fresh|reuse`
- `EVE_WORKSPACE_ID=<id>`
- `EVE_RUNTIME=true`

### 2) Services Provisioning

If `.eve/services.yaml` exists, the worker provisions services in K8s
and injects env vars into the job. If an env var is already set, the
service is skipped (simple override model).

Services are labeled by job ID and cleaned up at job end by default.

### 3) Job Execution

Jobs run as K8s pods created by the worker:
- Mount workspace PVC.
- Inject service env vars.
- Run the task or workflow skill.
- Stream logs back to Eve API.

---

## Atomic Gates (No Clashes)

Gates are named, project-scoped locks that jobs must acquire before running.

Examples:
- `env:staging` (persistent environment lock)
- `env:production`
- `workspace:proj_123` (ephemeral pool lock)

**Rule**: A job only starts when it holds all required gates.

**Implementation (minimal)**:
- Table `job_gates` with unique `gate_key`.
- Acquire via `INSERT ... ON CONFLICT DO NOTHING`.
- If any gate is held, job stays in `ready` with `blocked_on_gates`.
- Release on job completion or timeout (TTL safety).

This keeps concurrency control centralized and auditable.

---

## Persistent Environments

Persistent environments are named targets with pre-provided variables
and a gate. No deploy engine is required for MVP.

```yaml
# .eve/environments.yaml
environments:
  staging:
    gate: env:staging
    vars_from_secret: example-env
  production:
    gate: env:production
    vars_from_secret: eve-production-env
```

Jobs can target an env with `--env staging`. The worker:
- Injects env vars from the secret.
- Skips provisioning services already provided.
- Acquires the env gate to prevent clashes.

---

## Workflows (Agent-Powered GitOps)

Workflows are just jobs with a skill file and optional trigger:
- **Skill**: `SKILL.md` (OpenSkills format).
- **Trigger**: cron or webhook (optional).

Trigger events create a job with the workflow skill. The job inherits
gates from the workflow definition.

No pipeline engine. No DSL. Just: "create a job when an event happens."

---

## Dogfooding Scenario (MVP Target)

### A) Stand up stack on macOS
- Use k3d to run a local k3s cluster.
- Start Eve Horizon in-cluster.
- Mount local repo into the cluster for `file://` access (fast dev loop).

### B) Run integration tests in a job
```
eve project ensure --repo-url file:///workspaces/eve-horizon
eve job create --project proj_x --task integration
```

The job:
- Reuses or creates a workspace.
- Provisions Postgres from `.eve/services.yaml`.
- Runs `./bin/eh test integration`.

### C) Monitor and debug
```
eve job show <job-id>
eve job logs <job-id> --follow
eve job describe <job-id>   # pod + service info
```

Optional later: `eve job exec <job-id> -- /bin/sh` for live debugging.

---

## MVP Delivery Plan (Core Only)

1. **K8s Runtime Core**
   - Workspace PVC + runner pod creation.
   - Repo checkout with fresh/reuse hooks.
   - Log streaming to API.

2. **Services Provisioning**
   - `.eve/services.yaml` parser.
   - K8s service pods and env injection.
   - Cleanup on completion.

3. **Atomic Gates**
   - DB table + acquisition/release.
   - Gate-aware scheduling in orchestrator.
   - `blocked_on_gates` surfaced in API/CLI.

4. **Workflow Jobs (Manual + Cron)**
   - `.eve/workflows/*/SKILL.md` discovery.
   - Manual run via CLI (`eve workflow run`).
   - Optional cron triggers (single scheduler loop).

This MVP is enough to run integration tests on a local k8s stack.

---

## Why This Is Simple

- One runtime (K8s) for everything.
- One concurrency primitive (gates).
- One execution model (job pods + PVC workspace).
- One workflow model (skills + optional triggers).
- Reuse by default to keep iteration fast.

---

## See Also

- `docs/ideas/integration-testing-strategy.md`
