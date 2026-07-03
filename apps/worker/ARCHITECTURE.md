# Worker Architecture

> **What**: Executes builds, deploys, pipeline actions, and script steps.
> **Why**: Execution is isolated from scheduling and API concerns, reducing risk and complexity.

## Overview

The worker handles the platform's build/deploy plane: image builds (BuildKit-first), K8s environment
deploys, pipeline action steps (`build`, `release`, `deploy`, `job`, `run`, `notify`, `create-pr`,
`env-ensure`, `env-delete`), and `execution_type='script'` steps with on-demand toolchains.

> **CRITICAL — agent jobs do NOT run here.** All agent jobs (chat, manual, scheduled) route to
> **agent-runtime** because `EVE_AGENT_RUNTIME_URL` is set in every shipped environment. The worker
> retains a legacy `/invoke` fallback path (`src/invoke/`), which is unreachable in practice and slated
> for removal — see `docs/plans/platform-slim-down-plan.md` (G1). Harness adapters live in
> `packages/eve-agent-cli` and `packages/shared/src/harnesses/`, not in the worker.

The worker is a single cluster-scoped service per Eve instance (not per environment). It deploys and
executes against env namespaces but does not live inside them.

## Core Responsibilities

- Build images from manifest `services.*.build` (BuildKit in K8s, docker-buildx locally).
- Deploy releases to env namespaces: manifest interpolation, ingress (aliases, custom domains,
  timeouts), managed Postgres tenants, object-store buckets, app-link env injection.
- Execute pipeline action steps and script steps (with toolchain init-container injection).
- Reap orphaned runner pods (`src/reaper/`).

## Execution Modes

| Mode | Config | Use Case |
|------|--------|----------|
| Docker | `EVE_RUNTIME=docker` | Local development, docker-compose |
| K8s | `EVE_RUNTIME=k8s` | Kubernetes deployments, integration/E2E, production |

## K8s Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `EVE_RUNTIME` | Execution mode (`docker` or `k8s`) | `docker` |
| `EVE_RUNNER_IMAGE` | Docker image for runner pods | Required |
| `EVE_K8S_NAMESPACE` | Namespace for runner pods | `eve` |
| `EVE_K8S_WORKSPACE_SIZE` | PVC size for workspace | `10Gi` |
| `EVE_K8S_POD_READY_TIMEOUT` | Pod readiness timeout | `120s` |
| `EVE_RUNNER_SERVICE_ACCOUNT` | Service account for runner pods | - |
| `EVE_BUILD_BACKEND` | Image build backend (`buildkit`/`buildx`) | buildkit in K8s |

## Deployer Service

The deployer applies manifest-declared services to env namespaces via pipeline `deploy` actions.

### Container Registry Authentication

When deploying components, the deployer creates `imagePullSecrets` using credentials from the
manifest's `registry` section:

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

- `deployer/deployer.service.ts` — deployment orchestration, interpolation, ingress, managed DB, buckets
- `builder/` — image build backends (BuildKit-first) and registry auth
- `action-executor/action-executor.service.ts` — pipeline action steps
- `script-executor/script-executor.service.ts` — script steps + toolchains
- `src/invoke/` — legacy agent-invoke fallback (unreachable; removal planned)

## Key Decisions (Why)

- **Isolated execution** prevents orchestration from inheriting execution risk.
- **Agent execution lives in agent-runtime** — worker is builds/pipelines/scripts only
  ([docs/system/agent-runtime.md](../../docs/system/agent-runtime.md)).
- **Registry auth via secrets** allows flexible credential management without hardcoding.

## Navigation

- Builds: [docs/system/builds.md](../../docs/system/builds.md)
- Deployment: [docs/system/deployment.md](../../docs/system/deployment.md)
- Pipelines: [docs/system/pipelines.md](../../docs/system/pipelines.md)
- Container registry: [docs/system/container-registry.md](../../docs/system/container-registry.md)
- Secrets: [docs/system/secrets.md](../../docs/system/secrets.md)
