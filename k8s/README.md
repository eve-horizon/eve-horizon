# Kubernetes Manifests

K8s is the **primary deployment target** for Eve Horizon integration testing, E2E validation, and production workloads.

## Quick Start

```bash
# Start k3d cluster and apply manifests
./bin/eh k8s start

# Build images and deploy stack
./bin/eh k8s deploy

# Run E2E tests against the stack
./bin/eh test e2e --env stack

# Check status
./bin/eh k8s status
```

## Directory Structure

```
k8s/
├── base/                    # Base manifests
│   ├── kustomization.yaml   # Kustomize config
│   ├── namespace.yaml       # eve namespace
│   ├── api.yaml             # API deployment + service
│   ├── orchestrator.yaml    # Orchestrator deployment + service
│   ├── worker.yaml          # Worker deployment + service
│   ├── postgres.yaml        # Postgres StatefulSet + service
│   ├── configmap.yaml       # Non-sensitive config
│   ├── secrets.yaml         # Base secrets template
│   ├── rbac.yaml            # Worker service account, role, binding
│   └── db-migrate-job.yaml  # Database migration job
└── overlays/
    └── local/               # k3d local development overlay
        ├── kustomization.yaml
        ├── secrets.yaml                    # Local secrets (gitignored)
        ├── agent-runtime-pvc.patch.yaml    # PVC config for agent runtime
        └── agent-runtime-org-id.patch.yaml # Local agent-runtime config (multi-org + hot-path defaults)
    └── aws/                 # AWS overlay (external DB, registry, domain)
        ├── kustomization.yaml
        └── *-patch.yaml
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  k3d cluster "eve-local" (namespace: eve)                   │
├─────────────────────────────────────────────────────────────┤
│  Deployments:                                               │
│  ┌─────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────┐ │
│  │   API   │  │ Orchestrator │  │  Worker  │  │ Postgres │ │
│  │  :4701  │  │    :4702     │  │  :4749   │  │  :5432   │ │
│  └─────────┘  └──────────────┘  └────┬─────┘  └──────────┘ │
│                                      │                      │
│  Runner Pods (ephemeral, per job):   ↓                      │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Runner Pod (spawned by worker)                         │
│  │  - Image: eve-horizon/worker:local                      │
│  │  - PVC for workspace (10Gi default)                     │
│  │  - Clones repo, runs harness, streams logs              │
│  │  - Auto-deleted after completion                        ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Applying Manifests

Local overlay (recommended):

```bash
kubectl apply -k k8s/overlays/local
```

AWS overlay (expects external database + registry images):

```bash
kubectl apply -k k8s/overlays/aws
```

Integration tests (run against existing K8s stack, validate API via HTTP):

```bash
EVE_E2E_EXAMPLE_REPO_URL=https://github.com/eve-horizon/eve-horizon-fullstack-example \
EVE_E2E_EXAMPLE_REPO_BRANCH=main \
./bin/eh test integration --env stack
```

E2E tests (k8s-only, create real Eve job that runs integration tests):

```bash
EVE_E2E_EXAMPLE_REPO_URL=https://github.com/eve-horizon/eve-horizon-fullstack-example \
EVE_E2E_EXAMPLE_REPO_BRANCH=main \
./bin/eh test e2e --env stack
```

Full cycle (build/import images, apply stack, run tests):

```bash
./bin/eh k8s deploy
./bin/eh test integration --env stack
./bin/eh test e2e --env stack
```

## Secrets Provisioning

Secrets are split into two tiers:

1. **Platform secrets** (`eve-app` K8s Secret): Infrastructure keys only — `EVE_INTERNAL_API_KEY`, `EVE_SECRETS_MASTER_KEY`, `EVE_BOOTSTRAP_TOKEN`, webhook/signing secrets. Synced from `system-secrets.env.local` via `./bin/eh k8s secrets`.
2. **Provider secrets** (Eve org/project-level): LLM API keys, GitHub tokens, GHCR credentials, etc. Stored via `eve secrets set` and resolved at runtime by the secrets API. Never placed in the K8s secret.

## Notes

- The worker deployment expects a `postgres` service in the `eve` namespace
- The stack uses local images: `eve-horizon/api:local`, `eve-horizon/orchestrator:local`, `eve-horizon/worker:local`
- The `agent-runtime-org-id.patch.yaml` overlay enables multi-org runtime heartbeats and inline hot-path execution for local dev, plus runner image/service account fallback settings
- k3d cluster is created with `--api-port 127.0.0.1:6443` to avoid TLS/DNS issues
- The AWS overlay patches image names, DB connection, and Ingress host placeholders that must be updated before use
- OTEL collector manifest (AWS) lives in `k8s/addons/otel-collector-aws.yaml`

## Database Migrations

Local k3d:

```bash
kubectl apply -f k8s/base/db-migrate-job.yaml
kubectl -n eve logs job/eve-db-migrate
```

Building/importing images for k3d:

```bash
./bin/eh k8s-image build
./bin/eh k8s-image import
```

If Docker Hub is blocked, set a mirror base image:

```bash
EVE_NODE_BASE_IMAGE=public.ecr.aws/docker/library/node:22-slim \
./bin/eh k8s-image build
```

Offline base image tarball:

```bash
EVE_NODE_BASE_IMAGE_TAR=/path/to/node-22-slim.tar \
./bin/eh k8s-image build

## Troubleshooting

### Connection EOF / Load Balancer Issues

If kubectl returns `Unable to connect to the server: EOF`:

```bash
# Restart the k3d load balancer
docker restart k3d-eve-local-serverlb
```

The `k8s.sh` script auto-recovers from this automatically.

### TLS Handshake Timeout

```bash
# Delete and recreate cluster with explicit localhost binding
k3d cluster delete eve-local
k3d cluster create eve-local --api-port 127.0.0.1:6443
```

## Related Docs

- [K8s Local Stack (detailed guide)](../docs/system/k8s-local-stack.md)
- [Worker Architecture (runner pods)](../apps/worker/ARCHITECTURE.md)
- [Deployment](../docs/system/deployment.md)
- [AWS Deployment (P0 baseline)](../docs/deploy/aws.md)
```
