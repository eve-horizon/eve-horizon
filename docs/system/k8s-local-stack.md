# K8s Local Stack

Run Eve Horizon in a production-like Kubernetes environment using k3d for development and manual testing.

## Prerequisites

### Required Tools

- **Docker Desktop**: 8GB+ memory, 4+ CPUs allocated
- **Published CLI path**: `eve local up` auto-installs/manages `k3d` and `kubectl` in `~/.eve/bin`
- **Contributor path (`./bin/eh ...`)**: install `k3d` + `kubectl` yourself

### Resource Allocation

Open Docker Desktop → Settings → Resources:
- Memory: 8GB minimum (12GB recommended)
- CPUs: 4 minimum
- Disk: 50GB+

## Quick Start

Preferred path (published CLI):

```bash
# 1. Create cluster and deploy stack
eve local up

# 2. Check health/status
eve local health
eve local status

# 3. Stop when done
eve local down
```

Contributor path (monorepo helper):

```bash
# 1. Create cluster and apply manifests
./bin/eh k8s start

# Optional: expose raw TCP ingress ports for device/protocol tests
./bin/eh k8s start --tcp-ports 33400,33500 --recreate

# 2. Build images and deploy
./bin/eh k8s deploy

# 3. Check status
./bin/eh k8s status

# 4. Stop when done
./bin/eh k8s stop
```

## Kube Context Safety

Local k8s operations in this repo are locked to:
- **Expected local context**: `k3d-eve-local`
- **Forbidden staging context**: `<explicit-eks-context>`

Use the safe wrapper for local operations:

```bash
./bin/eh kubectl get pods -n eve
```

Do not run raw `kubectl` for local cluster operations.

Recovery commands:

```bash
# See active vs expected context
./bin/eh kctx

# Switch back to local context
kubectl config use-context k3d-eve-local
```

## Commands Reference

### eh k8s

| Command | Description |
|---------|-------------|
| `start` | Create k3d cluster if needed, apply local overlay manifests |
| `deploy` | Build images, push to k3d, apply stack, run migration |
| `stop` | Delete local overlay resources (keeps cluster) |
| `status` | Show namespace resources and PVCs |

`eh k8s start` options:
- `--tcp-ports <ports>`: Comma-separated TCP ports to bind through the k3d
  load balancer for `x-eve.tcp_ingress` tests.
- `--recreate`: Delete and recreate the cluster. Required when adding TCP
  port mappings to an existing k3d cluster.

### eh k8s-image

| Command | Description |
|---------|-------------|
| `build` | Build api/orchestrator/worker Docker images locally |
| `import` | Import local images into k3d cluster |
| `push` | Build + import (most common) |
| `build-toolchains` | Build per-toolchain payload images (`python`, `media`, `rust`, `java`, `kotlin`) |
| `import-toolchains` | Import toolchain images into k3d node cache |
| `publish-toolchains` | Push toolchain images to the in-cluster registry for worker-side `crane export` |
| `push-toolchains` | Build + import + publish toolchain images |

Options:
- `--base-image-tar <path>`: Load Node base image from tarball (offline builds)
- `--toolchains <list>`: Comma-separated toolchain filter for toolchain commands

`publish-toolchains` uses a temporary host port-forward to the in-cluster
registry. The host port defaults to `5050`; override with
`EVE_LOCAL_REGISTRY_PORT` if needed.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  k3d cluster "eve-local"                        │
├─────────────────────────────────────────────────┤
│  Namespace: eve                                 │
│                                                 │
│  Deployments:                                   │
│  ┌─────────┐ ┌──────────────┐ ┌──────────┐    │
│  │   API   │ │ Orchestrator │ │  Worker  │    │
│  │  :4801  │ │    :4802     │ │  :4811   │    │
│  └─────────┘ └──────────────┘ └──────────┘    │
│                                                 │
│  StatefulSet:                                   │
│  ┌──────────┐                                  │
│  │ Postgres │                                  │
│  │  :5432   │                                  │
│  └──────────┘                                  │
│                                                 │
│  Jobs:                                         │
│  ┌────────────────┐                            │
│  │ eve-db-migrate │ (runs before deployments)  │
│  └────────────────┘                            │
└─────────────────────────────────────────────────┘
```

## Development Workflow

The typical development workflow combines deploy and test commands:

1. **Ensure cluster**: Creates k3d cluster if missing (`eh k8s start`)
2. **Build images**: `docker build` for api, orchestrator, worker
3. **Import to k3d**: `k3d image import` for all images
4. **Apply manifests**: `kubectl apply -k k8s/overlays/local`
5. **Restart deployments**: Force image pull
6. **Run migration**: Apply db-migrate job, wait for completion
7. **Wait for rollout**: All deployments must be ready
8. **Port-forward**: API (4801) and Worker (4811) forwarded to localhost (automatic via ingress)
9. **Run manual tests**: See `tests/manual/README.md` for test scenarios

## Multi-Project App-Link Meshes

Use `eve local mesh` when a local test spans multiple Eve projects connected by
`x-eve.app_links`.

```bash
export EVE_API_URL=http://api.eve.lvh.me
eve local mesh init obs --org org_manualtestorg --env local
eve local mesh add prod --path ../producer
eve local mesh add cons --path ../consumer
eve local mesh up
eve local mesh status
eve local mesh diagnose --probe
eve local mesh down
```

Every project in the workspace must declare the same environment name, normally
`environments.local`. The workspace project names are Eve project slugs and must
match the `x-eve.app_links.*.project` references in manifests. The mesh only
touches tenant namespaces (`eve-<org>-<project>-<env>`); it leaves the platform
namespace and cluster lifecycle to `eve local up` or `./bin/eh k8s deploy`.

See [Local App-Link Mesh](./local-app-link-mesh.md) for workspace files,
producer-first ordering, local CLI image import, and diagnostics.

## What Gets Tested

Eve Horizon uses a three-tier test architecture:

| Test Type | Docker Compose | K8s Stack | What It Tests |
|-----------|---------------|-----------|---------------|
| Integration | ✅ | ✅ | API endpoints, job flow, secrets (direct HTTP calls) |
| Manual (k8s) | ⏭️ skip | ✅ | Full job flow using example repo + real harness |

### Integration Test Suite (`apps/api/test/integration/`)

The integration test suite validates API functionality via direct HTTP calls:

### Core Functionality Tests

| Test | What It Verifies |
|------|------------------|
| `job-flow.integration.test.ts` | Full job lifecycle: create org → create project → create job → verify CRUD |
| `org-ensure.integration.test.ts` | Organization creation and idempotent ensure |
| `secrets.integration.test.ts` | Secrets API: create, read (masked), delete |

### Harness Tests

| Test | What It Verifies |
|------|------------------|
| `harness-variants.integration.test.ts` | Harness variant configuration loading |
| `harness-matrix.integration.test.ts` | Harness auth status detection |
| `harness-invocation.integration.test.ts` | **Real harness execution** (only with `EVE_INTEGRATION_USE_REAL_MCLAUDE=true`) |

### Auth Tests

| Test | What It Verifies |
|------|------------------|
| `auth-error-utils.integration.test.ts` | Auth error message detection |
| `oauth-refresh.integration.test.ts` | OAuth token refresh flow (skipped by default) |

### What `harness-invocation` Tests (Real Harness Mode)

When `EVE_INTEGRATION_USE_REAL_MCLAUDE=true`, the harness invocation test:

1. Creates a test project pointing to `EVE_INTEGRATION_REPO_URL` (default: local repo path)
2. For each available harness (mclaude, claude, zai, gemini, code, codex):
   - Checks if auth credentials are available (skips if not)
   - Creates a job with a simple prompt: "Say hello and exit"
   - Claims the job and creates an attempt
   - Invokes the worker's `/invoke` endpoint
   - Verifies the harness completes successfully with exit code 0
3. Closes the job

This validates the complete flow: API → Worker → Runner Pod → Harness → Git Clone → Execution.

### Manual Test Suite (K8s Only)

Manual tests are **observable** tests that validate complete workflows using the Eve CLI and public APIs, with real-time visibility into job execution. Tests are located in `tests/manual/` and run against a real K8s stack.

```bash
# 1. Set up test org and secrets
eve org ensure "manual-test-org" --json
eve secrets import --org org_manualtestorg --file manual-tests.secrets

# 2. Run scenarios (see tests/manual/scenarios/)
# Ask Claude: "Run manual test scenarios 01-04 in parallel"

# 3. Watch jobs in real-time
eve job follow <job-id>
```

**What the manual test suite validates**:
1. **Harness authentication**: Validates zai auth is available via org secrets
2. **Full job lifecycle**: Create org → project → job → execute → complete (via CLI)
3. **Real repository cloning**: Tests with `eve-horizon-fullstack-example` repo
4. **Real harness invocation**: Uses zai harness to execute jobs
5. **Workspace provisioning**: Verifies git clone and workspace setup
6. **Job completion**: Validates job reaches `done` phase successfully

**Observable approach**: Tests use `eve job follow` for real-time visibility, with secrets on org (not system-level).

See `tests/manual/README.md` for full documentation and scenarios.

### Test Configuration

| Env Var | Purpose |
|---------|---------|
| `EVE_INTEGRATION_REPO_URL` | Repo to clone in integration tests (default: local repo path) |
| `EVE_INTEGRATION_REPO_BRANCH` | Branch to use for integration tests (default: `main`) |
| `EVE_INTEGRATION_USE_REAL_MCLAUDE` | Use real harnesses in integration tests (`true`/`false`) |
| `EVE_API_URL` | API endpoint (default: `http://localhost:4801`) |
| `WORKER_URL` | Worker endpoint (default: `http://localhost:4811`) |

## Troubleshooting

### Connection EOF / Load Balancer Issues

If kubectl returns `Unable to connect to the server: EOF`:

```bash
# Restart the k3d load balancer
docker restart k3d-eve-local-serverlb

# Verify connectivity
kubectl --context k3d-eve-local get nodes
```

This can happen after the machine wakes from sleep or after long idle periods.

### TLS Handshake Timeout

If you see `net/http: TLS handshake timeout`:

```bash
# Delete and recreate cluster with explicit localhost binding
k3d cluster delete eve-local
k3d cluster create eve-local --api-port 127.0.0.1:6443
```

The k8s.sh script now does this automatically.

### Port Already in Use

```bash
# Check what's using the port
lsof -i :4801

# Kill orphaned port-forwards
pkill -f "port-forward.*4801"
```

For TCP ingress tests, also check that no host process already owns the raw
listener port, such as `33400`.

### TCP Ingress Port Not Reachable

`x-eve.tcp_ingress` uses a Kubernetes `LoadBalancer` Service and the local
overlay sets `EVE_TCP_INGRESS_PROVIDER=klipper`. k3d only exposes arbitrary
TCP ports if they were mapped when the cluster was created.

```bash
# Recreate the cluster with all needed public TCP ports
./bin/eh k8s start --tcp-ports 33400,33500 --recreate
./bin/eh k8s deploy

# After deploying an app with tcp_ingress
eve env diagnose <project> <env> --json | jq '.tcp_ingress'
eve tcp-ingress test <project> <env> --listener a1-gt06
./bin/eh kubectl get svc -A -l eve.tcp_ingress=true
```

If the listener remains `pending`, the LoadBalancer Service was not created.
If it remains `provisioning`, check klipper service-lb pods and host port
availability. If it is `ready` but the probe fails, confirm the app listens on
the declared port and the port is listed under service `ports`.

### Image Pull Errors

```bash
# Verify images are in k3d
docker images | grep eve-horizon

# Re-import images
./bin/eh k8s-image push
```

### Pod Stuck in Pending

```bash
# Check events
kubectl --context k3d-eve-local -n eve describe pod <pod-name>

# Common causes:
# - Insufficient resources (increase Docker Desktop allocation)
# - PVC not bound (check storage class)
```

### View Logs

```bash
# API logs
kubectl --context k3d-eve-local -n eve logs -l app=eve-api -f

# Worker logs
kubectl --context k3d-eve-local -n eve logs -l app=eve-worker -f

# Migration logs
kubectl --context k3d-eve-local -n eve logs job/eve-db-migrate
```

## Environment Variables

The k8s manifests use these environment sources:

| Source | Description |
|--------|-------------|
| `k8s/base/configmap.yaml` | Non-sensitive config |
| `k8s/overlays/local/secrets.yaml` | Local secrets (gitignored) |
| `system-secrets.env.local` | Auth keys for JWT signing |

## Comparison: Docker vs K8s

| Aspect | Docker Compose | K8s (k3d) |
|--------|----------------|-----------|
| Startup time | Fast (~10s) | Slower (~60s) |
| Resource usage | Lower | Higher |
| Production parity | Moderate | High |
| Runner pods | No | Yes |
| Use case | Daily dev | Integration, manual validation |

## Related Docs

- [Agent Harness Design](./agent-harness-design.md)
- [Deployment](./deployment.md)
- [Worker Types](./worker-types.md)
