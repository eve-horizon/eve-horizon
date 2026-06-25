# Worker Architecture

> **What**: Executes jobs by running selected agent harnesses against a repo workspace.
> **Why**: Execution is isolated from scheduling and API concerns, reducing risk and complexity.

## Overview

The worker prepares a JobWorkspace, resolves repo contents (including `file://`), loads OpenSkills, and invokes the
selected harness. It streams logs and artifacts back to the system of record.

The worker is a single cluster-scoped service per Eve instance (not per environment). It deploys and executes against
env namespaces but does not live inside them.

## Core Responsibilities

- Materialize repo workspaces (clone or local copy).
- Install skills from `skills.txt` into `.agents/skills/` and resolve them for the harness.
- Invoke harnesses and stream structured logs.

## Execution Modes

The worker supports two execution modes:

| Mode | Config | Use Case |
|------|--------|----------|
| Docker | `EVE_RUNTIME=docker` | Local development, docker-compose |
| K8s | `EVE_RUNTIME=k8s` | Kubernetes deployments, integration/E2E |

## K8s Runner Architecture

When running in Kubernetes mode (`EVE_RUNTIME=k8s`), the worker spawns ephemeral runner pods for isolated job execution. This is the **primary mode for integration testing, E2E validation, and production**.

```
Worker Service (in-cluster)
     │
     ├─ execute()
     │       │
     │       ├─ EVE_RUNTIME=k8s?
     │       │    ↓
     │       └─ runInvocationInK8s()
     │            │
     │            ├─ Build runner pod + PVC manifests
     │            ├─ Apply manifests to cluster (kubectl apply)
     │            ├─ Wait for pod ready (readiness probe)
     │            ├─ Get pod IP (in-cluster networking)
     │            ├─ HTTP POST /invoke to runner pod
     │            ├─ Receive result
     │            └─ Cleanup pod + PVC (kubectl delete)
     │
     └─ Return result to orchestrator
```

### Runner Pod Lifecycle

1. **Pod Creation**: Worker creates a pod with:
   - Base image: `EVE_RUNNER_IMAGE` (typically `eve-horizon/worker:local`)
   - Mounted workspace volume (PVC, configurable via `EVE_K8S_WORKSPACE_SIZE`, default 10Gi)
   - Service account: `EVE_RUNNER_SERVICE_ACCOUNT` (for RBAC)
   - Environment: secrets, API URL, job context, database URL, harness auth tokens

2. **Execution**: Runner pod starts an HTTP server:
   - Exposes `/health` readiness probe (initial delay 5s, period 2s, 15 retries)
   - Accepts `/invoke` POST with HarnessInvocation payload
   - Clones repo (using git credentials from secrets API)
   - Invokes harness (mclaude, zai, code, etc.)
   - Streams JSONL logs to database

3. **Cleanup**: Pod and PVC are deleted after completion (success or failure)

### K8s Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `EVE_RUNTIME` | Execution mode (`docker` or `k8s`) | `docker` |
| `EVE_RUNNER_IMAGE` | Docker image for runner pods | Required |
| `EVE_K8S_NAMESPACE` | Namespace for runner pods | `eve` |
| `EVE_K8S_WORKSPACE_SIZE` | PVC size for workspace | `10Gi` |
| `EVE_K8S_POD_READY_TIMEOUT` | Pod readiness timeout | `120s` |
| `EVE_K8S_RUNNER_RETRIES` | HTTP health check retries | `20` |
| `EVE_RUNNER_SERVICE_ACCOUNT` | Service account for runner pods | - |

### In-Cluster Service Discovery

Runner pods communicate with services using k8s DNS:
- API: `http://eve-api.eve.svc.cluster.local:4701`
- Database: `postgres://eve:eve@postgres.eve.svc.cluster.local:5432/eve`

### Local Port Forwarding

For local k3d development, port forwarding provides localhost access:
```bash
kubectl port-forward svc/eve-api 4701:4701
kubectl port-forward svc/eve-worker 4749:4749
```
Use `./bin/eh k8s pf` to set up local port-forwarding for the stack.

### Load Balancer Recovery

k3d's load balancer can become stale after sleep/wake. The `k8s.sh` script auto-recovers by restarting `k3d-eve-local-serverlb` on EOF errors.

### Git Authentication

The runner resolves git credentials via the secrets API:

1. Worker calls `prepareGitAuth()` before spawning pod
2. Checks project secrets for `github_token` or `ssh_key`
3. Creates authenticated clone URL or SSH config
4. Runner uses credentials for `git clone`

### Harness Resolution

The worker uses a registry pattern to map harness names to adapters:

- Registry maintained in `harnesses/index.ts`
- Each adapter (`mclaude`, `code`, `zai`, `gemini`, etc.) implements `WorkerHarnessAdapter`
- Supports aliases (e.g., `claude` → `mclaude`)
- Adapters build harness-specific options (auth, model, variant)

### Key Files

- `invoke.service.ts` - Main invocation orchestration, workspace prep, secret resolution
- `k8s-runner.ts` - Runner pod creation and lifecycle management
- `harnesses/index.ts` - Registry for resolving harness names to adapters
- `harnesses/*.ts` - Adapter implementations for each harness

## Deployer Service

The worker includes a deployer service for Kubernetes deployments via pipeline actions.

### Container Registry Authentication

When deploying components, the deployer creates `imagePullSecrets` using credentials from the manifest's `registry` section:

```yaml
registry:
  host: ghcr.io
  namespace: example
  auth:
    username_secret: GHCR_USERNAME
    token_secret: GHCR_TOKEN
```

1. Resolves `username_secret` and `token_secret` from the secrets system
2. Creates Docker config JSON with registry auth
3. Creates/updates a Kubernetes Secret of type `kubernetes.io/dockerconfigjson`
4. Attaches the secret to deployment's `imagePullSecrets`

See [container-registry.md](../../docs/system/container-registry.md) for full details.

### Key Files

- `deployer/deployer.service.ts` - Deployment orchestration, imagePullSecret creation
- `pipeline-runner/pipeline-runner.service.ts` - Pipeline step execution

## Key Decisions (Why)

- **Isolated execution** prevents orchestration from inheriting execution risk.
- **Repo-local skills** keep skill resolution deterministic and portable.
- **Registry auth via secrets** allows flexible credential management without hardcoding.

## Navigation

- Skills system: [docs/system/skills.md](../../docs/system/skills.md)
- Harness design: [docs/system/agent-harness-design.md](../../docs/system/agent-harness-design.md)
- Container registry: [docs/system/container-registry.md](../../docs/system/container-registry.md)
- Secrets: [docs/system/secrets.md](../../docs/system/secrets.md)
