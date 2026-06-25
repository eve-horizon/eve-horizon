# Docker Architecture

> **What**: Container definitions and compose wiring for fast local development.
> **Why**: Reproducible, multi-service setup with minimal overhead for quick iteration.

## Overview

Docker Compose is optimized for **fast local iteration** during development. For integration testing, E2E validation, and production, use [Kubernetes](../k8s/README.md) instead.

Docker artifacts define the API, orchestrator, worker, and database services with stable ports and volumes.
This keeps local setups consistent across machines.

## Quick Start

```bash
# Start the stack
./bin/eh start docker
```

## When to Use

| Scenario | Use |
|----------|-----|
| Daily development, frequent code changes | Docker Compose |
| Integration testing, E2E validation | K8s (`eh k8s deploy`) |
| Production deployment | K8s |

## Comparison with K8s

| Aspect | Docker Compose | K8s (k3d) |
|--------|----------------|-----------|
| Startup time | ~10s | ~60s |
| Resource usage | Lower | Higher |
| Production parity | Moderate | High |
| Runner pods | No (local process) | Yes (ephemeral pods) |
| `EVE_RUNTIME` | `docker` (default) | `k8s` |

## Key Decisions (Why)

- **Compose-based topology** mirrors runtime services and simplifies start/stop.
- **Explicit ports** align with the multi-instance config system.
- **Quick dev focus**: Optimized for sub-10-second restarts during development.

## Worker Image: Dual Environment Compatibility

The worker Dockerfile must work in both Docker Compose (development) and K8s (production/E2E).

### Constraints

| Constraint | K8s | Docker Compose | Solution |
|------------|-----|----------------|----------|
| User | Non-root required (uid 1000) | Permissive | Use `node` user (uid 1000) |
| Home dirs | Must pre-exist with correct ownership | Created on demand | Pre-create ALL in Dockerfile |
| Volume mounts | May override ownership | Inherits host ownership | `chown` dirs before `USER node` |

### Pre-created Directories

The worker Dockerfile pre-creates these directories owned by `node:node`:

```
/opt/eve/workspaces      # Workspace root (volume mount point)
/home/node/.npm          # npm cache
/home/node/.cache        # General cache (pnpm, etc)
/home/node/.local/bin    # cc-mirror installs CLI tools here
/home/node/.local/share  # XDG data directory
/home/node/.claude       # Claude Code credentials
/home/node/.cc-mirror    # cc-mirror config
/home/node/.code         # Every Code auth
/home/node/.codex        # OpenAI Codex auth
/home/node/.config       # XDG config directory
```

### Adding New Directories

When adding tools that write to new paths:

1. **Add to Dockerfile** in BOTH production and development stages
2. **Update this doc** with the directory purpose
3. **Test both environments**:
   - `pnpm docker:up` (Docker Compose)
   - `./bin/eh k8s deploy` (K8s)

### Common Pitfalls

- **Don't use `mkdir -p` in entrypoint** — K8s may run read-only or with restricted permissions
- **Don't assume directories exist** — Always pre-create in Dockerfile
- **Test K8s after Docker changes** — Docker Compose is more permissive

## Navigation

- K8s manifests: [../k8s/README.md](../k8s/README.md)
- Dev workflow: [../AGENTS.md](../AGENTS.md)
- Deployment overview: [../docs/system/deployment.md](../docs/system/deployment.md)
