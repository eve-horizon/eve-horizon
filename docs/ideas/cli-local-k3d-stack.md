# CLI Local k3d Stack Management

> **Purpose**: Add first-class local k3d stack management to the published `eve` CLI so any developer (or coding agent) can stand up, operate, and tear down a local Eve environment with one prerequisite and zero guesswork.

## Problem

Today, local k3d management lives in `./bin/eh` — an internal dev helper that requires a checkout of the `eve-horizon` monorepo. Developers building apps **on** Eve don't have access to it. They face a wall:

1. **No way to run Eve locally** without cloning the platform repo
2. **Manual k3d/kubectl dance** — cluster creation, image imports, manifest application, migration jobs, secret generation, health checks — all done by hand or by reading internal scripts
3. **Agent-hostile** — coding agents (Claude, Codex, etc.) can't discover or use `./bin/eh` commands because they're not in the published CLI's help system
4. **Prerequisite sprawl** — current setup assumes k3d, kubectl, kustomize, node, openssl all pre-installed

## Vision

```
# The entire local Eve experience:
eve local up        # One command. Docker Desktop is the only prerequisite.
eve local status    # What's running, what's healthy, what URLs to use.
eve local down      # Clean shutdown.
```

A developer clones their project repo, runs `eve local up`, and has a fully operational Eve platform running locally. An agent reads `eve local --help` and knows exactly what to do. No tribal knowledge required.

## Design Principles

1. **One prerequisite**: Docker Desktop (or compatible Docker runtime). Everything else (`k3d`, `kubectl`) is managed automatically.
2. **Self-describing**: Every command has `--help` with examples. An agent should be able to discover the full local workflow from `eve local --help` alone.
3. **Idempotent**: Running `eve local up` twice is safe. Running `eve local down` when nothing is running is safe.
4. **Observable**: `eve local status` shows everything — cluster state, service health, URLs, versions, resource usage — in both human and `--json` formats.
5. **Progressive disclosure**: Simple commands for common cases, flags for power users. `eve local up` does the right thing; `eve local up --skip-deploy` exists for those who need it.

## Command Design

### `eve local` — Top-Level Help

```
eve local --help

Local development environment management.

Manages a local k3d Kubernetes cluster running the full Eve platform.
Requires: Docker Desktop (all other tools are managed automatically).

Commands:
  up        Create cluster, deploy Eve platform, verify health
  down      Stop and optionally destroy the local cluster
  status    Show cluster state, service health, and access URLs
  reset     Destroy and recreate from scratch
  logs      Stream or dump service logs
  health    Quick health check (exit code 0 = healthy)

Run 'eve local <command> --help' for details on any command.
```

### `eve local up`

The main event. One command to go from zero to running.

```
eve local up [--skip-deploy] [--skip-health] [--verbose] [--timeout <seconds>]

Starts a local Eve platform on k3d.

What it does (in order):
  1. Checks Docker is running
  2. Installs k3d and kubectl if missing (to ~/.eve/bin, added to PATH)
  3. Creates k3d cluster 'eve-local' (ports 80/443 exposed for Ingress)
  4. Pulls and imports Eve platform images (versioned, from GHCR)
  5. Applies K8s manifests (postgres, API, orchestrator, worker, gateway, auth)
  6. Runs database migrations
  7. Generates auth secrets and bootstraps auth DB
  8. Waits for all services to be healthy
  9. Prints access URLs and next steps

Options:
  --skip-deploy    Create cluster only, don't deploy Eve services
  --skip-health    Don't wait for health checks after deploy
  --verbose        Show detailed progress for each step
  --timeout <s>    Max seconds to wait for readiness (default: 300)
  --version <tag>  Eve platform version to deploy (default: latest stable)

Examples:
  eve local up                  # Full setup, latest stable
  eve local up --verbose        # See every step
  eve local up --version 0.1.50 # Pin to specific version

Output:
  ✓ Docker running
  ✓ k3d installed (v5.7.5)
  ✓ kubectl installed (v1.31.0)
  ✓ Cluster 'eve-local' created
  ✓ Eve platform images imported (v0.1.50)
  ✓ Manifests applied
  ✓ Database migrated
  ✓ Auth secrets configured
  ✓ All services healthy (8/8)

  Eve is running locally:
    API:      http://api.eve.lvh.me
    Auth:     http://auth.eve.lvh.me
    Mail:     http://mail.eve.lvh.me

  Next steps:
    export EVE_API_URL=http://api.eve.lvh.me
    eve org ensure "my-org" --slug my-org
    eve project ensure --name "my-app" --repo-url <your-repo>
```

### `eve local down`

```
eve local down [--destroy] [--force]

Stops the local Eve cluster.

Without --destroy, the cluster is stopped but state (database, volumes)
is preserved. Run 'eve local up' to resume where you left off.

Options:
  --destroy    Delete cluster and all persistent data (volumes, images)
  --force      Skip confirmation prompt for --destroy

Examples:
  eve local down              # Stop cluster, keep data
  eve local down --destroy    # Full cleanup
```

### `eve local status`

```
eve local status [--json] [--watch]

Shows the state of the local Eve environment.

Sections:
  Cluster    - Running/stopped/missing, k3d version, resource usage
  Services   - Each Eve service with status (ready/starting/failed)
  URLs       - All accessible endpoints
  Storage    - Persistent volumes and disk usage
  Images     - Deployed image versions

Options:
  --json     Machine-readable output
  --watch    Refresh every 5 seconds (Ctrl+C to stop)

Examples:
  eve local status             # Human-readable overview
  eve local status --json      # For scripts and agents
```

**Sample output:**

```
Local Eve Environment
─────────────────────
Cluster:    eve-local (running)
k3d:        v5.7.5
Platform:   v0.1.50
Uptime:     2h 34m

Services (8/8 healthy):
  ✓ postgres          Running   (1/1 ready)
  ✓ eve-api           Running   (1/1 ready)
  ✓ eve-orchestrator  Running   (1/1 ready)
  ✓ eve-worker        Running   (1/1 ready)
  ✓ eve-gateway       Running   (1/1 ready)
  ✓ eve-agent-runtime Running   (1/1 ready)
  ✓ supabase-auth     Running   (1/1 ready)
  ✓ mailpit           Running   (1/1 ready)

URLs:
  API:      http://api.eve.lvh.me      ← EVE_API_URL
  Auth:     http://auth.eve.lvh.me
  Mail:     http://mail.eve.lvh.me

Storage:
  postgres-data   1.2 GB
  buildkit-cache  340 MB
```

### `eve local reset`

```
eve local reset [--force]

Destroys and recreates the local environment from scratch.
Equivalent to 'eve local down --destroy && eve local up'.

Use when the environment is in a bad state and you want a clean start.

Options:
  --force    Skip confirmation prompt
```

### `eve local logs`

```
eve local logs [service] [--follow] [--tail <n>] [--since <duration>]

Stream or view logs from Eve services.

Without a service name, shows interleaved logs from all services.

Services:
  api, orchestrator, worker, gateway, agent-runtime, auth, postgres

Options:
  --follow       Stream logs in real-time (Ctrl+C to stop)
  --tail <n>     Show last n lines (default: 50)
  --since <dur>  Show logs since duration (e.g. '5m', '1h')

Examples:
  eve local logs                       # Recent logs from all services
  eve local logs api --follow          # Stream API logs
  eve local logs worker --tail 100     # Last 100 worker log lines
```

### `eve local health`

```
eve local health [--json]

Quick health check. Returns exit code 0 if all services are healthy.

Designed for scripts, CI, and agents:
  eve local health && echo "Ready" || echo "Not ready"

Options:
  --json    Output health details as JSON
```

## Tool Management

The CLI should not assume `k3d` or `kubectl` are pre-installed. Instead:

```
~/.eve/
  bin/
    k3d          # Managed binary
    kubectl      # Managed binary
  images/
    cache/       # Pulled platform images (avoids re-downloading)
  local/
    config.yaml  # Local cluster configuration
```

**Installation flow** (inside `eve local up`):

1. Check `~/.eve/bin/k3d` exists and is correct version → skip if so
2. Download platform-appropriate binary (macOS arm64/amd64, Linux amd64/arm64)
3. Verify checksum
4. Place in `~/.eve/bin/`
5. Same for `kubectl`

The CLI adds `~/.eve/bin` to `PATH` for the duration of the command. Users never need to know these tools exist.

## Image Distribution

The `eve local up` command needs Eve platform images without requiring users to build from source.

**Strategy**: Pull pre-built **public** images from GHCR (same images used for staging) and import them into k3d. No authentication required.

```
ghcr.io/eve-horizon/api:v0.1.50
ghcr.io/eve-horizon/orchestrator:v0.1.50
ghcr.io/eve-horizon/worker:v0.1.50
ghcr.io/eve-horizon/gateway:v0.1.50
ghcr.io/eve-horizon/agent-runtime:v0.1.50
ghcr.io/eve-horizon/sso:v0.1.50
```

**Prerequisite**: GHCR package visibility must be set to **public** for each image in the `eve-horizon` GitHub org. This is a one-time setting per package under GitHub → Packages → Package Settings → Danger Zone → Change visibility. The images contain compiled NestJS services, no secrets — public visibility is fine.

**Version resolution**:
- `--version latest` (default): Fetch latest stable tag from GHCR
- `--version 0.1.50`: Pin to exact version
- Cache pulled images in `~/.eve/images/cache/` to avoid re-downloading on `reset`

## K8s Manifests

The published CLI needs a self-contained set of K8s manifests. Two options:

### Option A: Embed in CLI package (recommended)

Bundle a `local-stack/` directory into the CLI npm package containing:
- Base manifests (deployments, services, ingress, PVCs)
- Local overlay (dev-friendly defaults, resource limits)
- Migration job template
- Auth bootstrap job template

Pros: Zero external dependencies, version-locked to CLI version.
Cons: Increases CLI package size (~50KB of YAML).

### Option B: Download manifests from GHCR/GitHub

Fetch versioned manifest tarballs at runtime.

Pros: Smaller CLI package.
Cons: Network dependency, version mismatch risk.

**Recommendation**: Option A. The manifests are small and version coupling is a feature, not a bug.

## Agent Experience

This is the north star. An agent working on a developer's project should be able to:

```
# 1. Discover what's available
eve local --help

# 2. Stand up the environment
eve local up

# 3. Verify it's working
eve local health --json

# 4. Get the API URL programmatically
EVE_API_URL=$(eve local status --json | jq -r '.urls.api')

# 5. Create org, project, deploy
eve org ensure "dev-org" --slug dev-org --json
eve project ensure --name "my-app" --repo-url https://github.com/... --json
eve env deploy proj_xxx dev --tag latest

# 6. Debug if something goes wrong
eve local logs api --tail 50
eve local status --json

# 7. Clean up
eve local down
```

Every command returns structured JSON with `--json`. Every error includes actionable next steps. No command requires interactive input (all prompts have `--force` or `--yes` equivalents).

### Agent-Readable Error Messages

```
# Bad:
Error: Connection refused

# Good:
Error: Cannot connect to local Eve cluster.

The cluster may not be running. To check:
  eve local status

To start the cluster:
  eve local up

If Docker Desktop is not running, start it first.
```

## Relationship to `./bin/eh`

The internal `./bin/eh` dev helper remains for platform developers working on Eve itself. The new `eve local` commands are for **app developers using Eve**.

| Capability | `./bin/eh` (internal) | `eve local` (published) |
| --- | --- | --- |
| **Audience** | Eve platform developers | App developers & agents |
| **Prerequisite** | Eve monorepo checkout | Docker Desktop only |
| **Images** | Built from source | Pulled from GHCR |
| **Manifests** | From repo `k8s/` dir | Bundled in CLI |
| **k3d/kubectl** | Must be pre-installed | Auto-managed |
| **Multi-instance** | Yes (port isolation) | No (single local stack) |
| **Source rebuild** | `eh k8s-image push` | N/A (use published images) |

Over time, `./bin/eh k8s` commands could delegate to `eve local` internally, reducing duplication.

## Implementation Phases

### Phase 1: Core Lifecycle

- `eve local up` (create cluster, import images, deploy, health check)
- `eve local down` (stop, optional destroy)
- `eve local status` (cluster + service state)
- `eve local health` (quick check, exit code)
- Auto-install k3d and kubectl to `~/.eve/bin/`
- Embed K8s manifests in CLI package
- Image pull from GHCR with local cache

### Phase 2: Observability

- `eve local logs` (per-service and aggregated)
- `eve local reset` (destroy + recreate)
- `eve local status --watch`
- Rich error messages with recovery suggestions

### Phase 3: Developer Experience Polish

- `eve local up` detects existing cluster and resumes (not recreate)
- Version management (upgrade/downgrade platform version)
- Diagnostic bundle export (`eve local diagnose > bundle.tar.gz`)
- Integration with `eve init` (auto-detect local stack, set profile)

## Decisions

1. **Image access**: Public GHCR images. No auth needed for `eve local up`. The images are compiled services, not secrets.

## Open Questions

1. **Resource limits**: Default Docker Desktop memory is often 2GB. Eve needs ~4GB. Should `eve local up` check and warn?
2. **Port conflicts**: If port 80/443 is taken (another k3d cluster, nginx, etc.), should we auto-pick alternatives or fail with guidance?
3. **Platform updates**: When a new Eve version is released, should `eve local up` auto-upgrade, prompt, or stay pinned?
4. **Windows support**: k3d works on Windows via WSL2. Do we officially support this path or document it as community-supported?
