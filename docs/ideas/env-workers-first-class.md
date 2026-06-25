# Env-Scoped Workers (First-Class) for Jobs

> **Idea / Draft**: Allow environments to host persistent worker services that execute
> jobs directly, without runner pods.
> Status: Idea
> Last Updated: 2026-01-29

## Problem

Runner pods are created per job attempt in k8s. The 20+ second startup cost makes
swarm-style job trees painfully slow. We want **fast, persistent workers** that live
inside an environment so any job targeting that env can run immediately, in parallel.

Key requirement: **deployment jobs must never use env workers**.

## Current Behavior (Baseline)

- Orchestrator routes jobs to worker URLs from `EVE_WORKER_URLS`.
- In k8s runtime, the worker creates a **runner pod per attempt**
  (`apps/worker/src/invoke/k8s-runner.ts`).
- Env config already supports `environments.<env>.workers` and
  `services[].x-eve.role: worker`, but these are **deployment-only** and
  **not used for job routing**.

## Proposal (Opt-In)

Treat **workers as first-class services inside an environment**. When a job targets
`env_name`, it runs on the env’s worker service directly (no runner pod). This gives
instant start times and parallelism via worker replicas.

**Opt-in only**: if the manifest does **not** define an env worker service for that
environment, jobs fall back to **system workers** (current behavior).

### Routing Rules

1. **Agent jobs targeting an env** → use that env’s worker service.
2. **Deployment/pipeline jobs** → always use **system workers** (control plane).
3. **Jobs with no env** → use system workers (current behavior).
4. **Explicit override** via job hints (e.g., `hints.worker_scope=system`).
5. **No env workers defined** → use system workers.

### Execution Model (Env Workers)

- Worker runs harness **directly in the worker container** (same as docker runtime).
- Workspaces are **ephemeral in-container** (or `emptyDir`) and cleaned per attempt.
- Parallelism comes from **k8s Service load balancing** across worker replicas.
- Optional per-worker concurrency cap (to prevent resource exhaustion).

### Deployment Safety

- **Env workers never handle deployment jobs.**
- Deployment jobs always route to **system/control-plane workers** in `eve` namespace.
- Env workers can be restarted during app deploys without breaking deploy flows.

## Manifest Sketch

```yaml
services:
  app:
    image: ghcr.io/org/app
    ports: [3000]

  env-worker:
    image: ghcr.io/eve-horizon/worker-full:0.1.0
    x-eve:
      role: worker
      worker_type: env-default

environments:
  staging:
    workers:
      - type: env-default
        service: env-worker
        replicas: 3
        default: true
```

Notes:
- `x-eve.role: worker` already exists and is deployable.
- `environments.<env>.workers` already exists and can set replicas.
- We add **routing semantics** for env jobs + worker scope hints.

## Required Work

### 1) Orchestrator Routing
- Add `worker_scope` resolution:
  - If `job.env_name` and `job.kind=agent` → resolve env worker service URL.
  - If pipeline/deploy action → force system worker.
- Build env worker URL from namespace + service name:
  - `http://<service>.<env-namespace>.svc.cluster.local:<port>`
- Fallback: if no env worker configured, use system worker.

### 2) Worker Runtime (Direct Execution in K8s)
- Allow **direct harness execution** in k8s for env workers.
- Add mode flag (e.g., `EVE_EXECUTION_MODE=direct|runner`), default `runner`.
- Ensure per-attempt workspace isolation + cleanup under `/opt/eve/workspaces`.

### 2b) Observability + Workspaces
We need full debuggability for env-worker jobs (logs, lifecycle, continue).
This **does not strictly require PVCs**, but we should pick one:

Option A — **PVC per env worker** (recommended for robustness):
- Mount a persistent volume to each env worker pod.
- Workspaces survive worker restarts; `continue` is reliable.
- Slightly more storage + provisioning complexity.

Option B — **Ephemeral workspace** (container FS or `emptyDir`):
- Simpler, faster startup.
- If worker restarts, workspace is lost; `continue` requires reconstruction
  from git + stored invocation context.
- Add a **diagnostic bundle** capture at attempt end
  (git status/diff, key logs) for post‑mortem debugging.

### 3) API / Job Model
- Add optional `hints.worker_scope = env|system` for explicit overrides.
- Ensure pipeline/deploy job types set `worker_scope=system` automatically.

### 4) Deployment + Secrets
- Ensure env worker services get system-level secrets required by harnesses
  (CLAUDE_CODE_OAUTH_TOKEN, etc.).
- Validate that env worker images are **trusted** (same base as platform worker).

### 5) Observability
- Report which worker scope was used (system vs env) in attempt metadata.
- Extend `eve system pods` / debug output to include env worker pods.

### 6) Tests
- Integration test: env job routes to env worker service URL.
- Deployment test: deploy job still uses system worker.

## Pros vs Runner Pools

### Pros (Env Workers)
- **Simpler mental model**: workers are just services in the env.
- **No runner pod creation** for env jobs → fast start.
- **Parallelism via replicas** (native K8s scaling).
- **Natural env coupling**: jobs can see env services by DNS.

### Cons (Env Workers)
- **Security surface**: jobs and app pods share the same namespace/network.
- **Worker image trust**: env worker must run the platform worker image.
- **Resource contention**: env jobs compete with app pods on the same nodes.
- **Operational coupling**: env worker lifecycle tied to app deploys.

### Runner Pools (Comparison)

Runner pools keep workers in system namespace with persistent runner pods.
They preserve isolation but require:
- A new pool/lease system
- Slot management + reapers
- Pool sizing + burst logic

Env workers are less complex, but trade isolation for simplicity.

## Open Questions

1. Should env workers **always** use direct execution (no runner pods)?
2. Do we need a dedicated worker image whitelist for env workers?
3. How do we expose env worker health and queue depth to the API/CLI?
4. Should env workers support workspace reuse/session mode for faster swarms?

## Recommendation

If the priority is **simplicity and speed**, env workers are the smaller lift.
If the priority is **strong isolation**, runner pools are safer but more complex.
