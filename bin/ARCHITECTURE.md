# Bin Architecture

> **What**: Developer tooling and orchestration scripts.
> **Why**: Standard entrypoints keep environments consistent and reduce manual steps.

## Overview

`./bin/eh` is the primary wrapper for starting/stopping services, running tests, and managing local config.
These scripts encode the correct order of operations (auth, migrations, startup).

## Key Decisions (Why)

- **Single entrypoint** reduces onboarding time and avoids bespoke commands.
- **Scripted order of operations** prevents subtle setup errors.

## Commands Reference

The `./bin/eh` wrapper provides these command groups:

### Docker Commands (`eh start docker`)

Docker Compose is optimized for **fast local iteration** during development.

| Command | Description |
|---------|-------------|
| `./bin/eh start docker` | Start Docker Compose stack (auto-migrates DB) |
| `./bin/eh stop` | Stop the current stack |

Start options:
- `--no-build` - Skip rebuilding images (faster restart)
- `--reset-db` - Wipe database and start fresh

**When to use Docker Compose**: Daily development with frequent code changes. For integration testing and production-like validation, use `eh k8s start` + `eh k8s deploy`.

### K8s Commands (`eh k8s`)

K8s is the **primary deployment target** for integration testing, E2E validation, and production.

| Command | Description |
|---------|-------------|
| `start` | Create k3d cluster (if needed), apply local overlay |
| `deploy` | Build/import images and deploy stack |
| `stop` | Delete local overlay resources |
| `status` | Show namespace resources and PVCs |

Typical flow:
1. `eh k8s start` (create cluster + apply local overlay)
2. `eh k8s deploy` (build/import images + apply stack)
3. `eh test e2e --env stack` (E2E validation)

**Secrets**: Platform infra keys (EVE_INTERNAL_API_KEY, etc.) are set via `eve secrets set --system`.
Provider keys (LLM APIs, GitHub tokens) are set via `eve secrets set --org <id>`.

### K8s Image Commands (`eh k8s-image`)

| Command | Description |
|---------|-------------|
| `build` | Build local Docker images (api, orchestrator, worker) |
| `import` | Import local images into k3d cluster |
| `push` | Build + import (one command) |

Options:
- `--base-image-tar <path>` - Use offline base image tarball for Node.js base

The build process:
- Resolves Node base image (supports offline tarball, env var, or pulls `node:22-slim`)
- Builds production images with tag `eve-horizon/{service}:local`
- Can import into k3d cluster `eve-local`

### Test Commands (`eh test`)

Eve Horizon uses a three-tier test architecture:

| Test Type | Docker Compose | K8s Stack | What It Tests |
|-----------|---------------|-----------|---------------|
| Integration | ✅ | ✅ | API endpoints, job flow, secrets (direct HTTP calls) |
| E2E (k8s-only) | ⏭️ skip | ✅ | Full job with real harness running integration tests |

| Command | Description |
|---------|-------------|
| `integration` | Run integration tests (API validation via direct HTTP) |
| `integration --env dev` | Run against local dev servers (default, stub harness) |
| `integration --env docker` | Run against Docker Compose stack (real harness) |
| `integration --env stack` | Run against K8s stack (real harness) |
| `integration --real` | Use real harnesses instead of stubs (dev mode only) |
| `integration --reset-db` | Reset test database before running |
| `integration --target <pattern>` | Filter which tests to run |
| `e2e` | Run E2E tests (k8s-only, full job flow) |
| `e2e --env stack` | Run against K8s stack |

Test environments:
- `dev` - Starts local dev servers, uses stub harnesses by default
- `docker` - Spins up full Docker Compose stack, uses real harnesses
- `stack` - Uses existing K8s stack (expects port-forwards on 4701/4749)

### Dev Commands (`eh dev`)

| Command | Description |
|---------|-------------|
| `start` | Start local dev servers with watch mode |
| `start --foreground` | Run in foreground (Ctrl+C to stop all) |
| `start --test` | Use test database instead of dev database |
| `stop` | Stop dev servers (kills processes on Eve ports) |
| `stop --all` | Also stop Postgres container |
| `kill` | Kill orphaned Node processes from previous sessions |
| `status` | Show running eve-horizon processes |

Dev start sequence:
1. Stops existing processes
2. Ensures Postgres is running
3. Creates/verifies database
4. Runs migrations
5. Builds shared packages
6. Starts API (4701), Orchestrator (4702), Worker (4749)

Logs are written to `/tmp/eve-*.log` in background mode.

## File Structure

```
bin/
├── eh                    # Main entrypoint
├── eh-commands/
│   ├── _common.sh       # Shared utilities (colors, helpers)
│   ├── _config.sh       # Environment configuration
│   ├── auth.sh          # Credential extraction helpers
│   ├── configure.sh     # Instance configuration
│   ├── db.sh            # Database helpers
│   ├── dev.sh           # Local dev server management
│   ├── docker.sh        # Docker Compose orchestration
│   ├── k8s.sh           # K8s cluster management
│   ├── k8s-image.sh     # K8s image build/push
│   ├── project.sh       # Project management helpers
│   └── test.sh          # E2E test runner
└── ARCHITECTURE.md      # This file
```

## Navigation

- Developer workflow: [../AGENTS.md](../AGENTS.md)
