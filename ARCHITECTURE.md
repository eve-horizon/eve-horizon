# Eve Horizon Architecture

> **What**: A job-first platform for running AI-powered skills against Git repositories.
> **Why**: To make agent work reliable and repeatable by separating orchestration, execution, and API concerns.

## The Architecture Doc System (read this first)

This repo uses **hierarchical `ARCHITECTURE.md` files** as a core memory system for agents.

- Each important node in the tree has an `ARCHITECTURE.md` explaining **what it is** and **why it exists**.
- The docs are **progressive**: start here, then read deeper files only when relevant.
- **Keep them current**. If you change architecture, update the nearest `ARCHITECTURE.md` immediately.

**How to find them:** search for `ARCHITECTURE.md` files (e.g., `rg --files -g 'ARCHITECTURE.md'`, `grep -R "ARCHITECTURE.md" -n .`, or `find . -name ARCHITECTURE.md`).

## System Overview

```
User/External -> API -> Event Spine -> Orchestrator -> Worker -> Agent/Script/Action
Chat (Slack/WebChat) -> Gateway ┘        |              |
                                Postgres   JobWorkspace
                                |
                           Agent Runtime (warm pods)
```

Eve Horizon manages jobs (lifecycle, dependencies, review) and executes them against a single repo per project.
The platform is now **event-driven**: external and internal sources emit events into a central event log; the
orchestrator matches triggers and will launch pipelines/workflows that expand into job graphs.
The CLI is the primary interface; the REST API is the single source of truth.

### Web Auth Stack (Supabase + SSO)

When web auth is enabled, the platform adds two public-facing services:

- **GoTrue (Supabase Auth)** for email/password and invite flows.
- **SSO broker** (`apps/sso`) for shared browser sessions and token exchange.

Browser clients discover auth config via `GET /auth/config` and exchange Supabase
access tokens for Eve RS256 tokens via `POST /auth/exchange`.

## Event Spine (Core)

The event spine is a project-scoped event log in Postgres. Events are created via:

- External sources (GitHub webhooks, Slack gateway)
- Internal sources (cron ticks, app/system events)
- Manual testing (`eve event emit`)

The orchestrator polls pending events, matches them against manifest triggers, and launches pipeline
runs or workflow jobs. This keeps all automation observable and debuggable.

### Identity Providers

Non-web auth flows (SSH, Nostr) are implemented via a pluggable identity provider
registry. See `docs/system/identity-providers.md` for the current provider list
and auth-chain behavior.

## Pipelines and Workflows

- **Pipelines**: Deterministic sequences defined in `.eve/manifest.yaml` that expand into job graphs.
  Steps can be `action`, `script`, or `agent` jobs.
- **Workflows**: Manifest-defined, invoked on demand (or by triggers), creating a job that can return JSON
  results (wait mode).

## Runtime Environments

Eve Horizon supports two runtime modes controlled by `EVE_RUNTIME`:

```
                    EVE_RUNTIME=docker              EVE_RUNTIME=k8s
                    ──────────────────              ───────────────
                    Docker Compose                  Kubernetes
                         ↓                              ↓
                    Fast iteration               Integration testing
                    Quick dev loop              E2E + staging/prod
                    ~10s startup                   Production
                                                   ~60s startup
```

**K8s is the primary deployment target** for integration testing, E2E validation, and production.
Docker Compose is for fast local iteration during development.

### K8s Architecture

When running in Kubernetes:

```
┌─────────────────────────────────────────────────────────────┐
│  k8s cluster (k3d local / k3s staging / k8s prod)          │
├─────────────────────────────────────────────────────────────┤
│  Deployments:                                                │
│  ┌─────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────┐ │
│  │   API   │  │ Orchestrator │  │  Worker  │  │ Postgres │ │
│  └─────────┘  └──────────────┘  └────┬─────┘  └──────────┘ │
│  ┌──────────┐  ┌───────────────┐                           │
│  │ Gateway  │  │ Agent Runtime │                           │
│  └──────────┘  └───────────────┘                           │
│                                      │                       │
│  Runner Pods (ephemeral):            ↓                       │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Runner Pod (per job attempt)                           ││
│  │  - Clones repo                                          ││
│  │  - Runs harness (mclaude/zai/etc)                       ││
│  │  - Streams logs back to worker                          ││
│  │  - Auto-cleaned after completion                        ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Key K8s Decisions

- **Runner pods for isolation**: Each job attempt runs in its own pod, preventing cross-contamination
- **k3d for local**: Mirrors production topology without cloud dependencies
- **Localhost API binding**: k3d uses `--api-port 127.0.0.1:6443` to avoid DNS/TLS issues
- **Ingress for local access**: k3d stack uses Ingress (`http://api.eve.lvh.me`) without port-forwarding
- **Auto-recovery**: Load balancer auto-restarts on connection EOF errors (common after sleep/wake)

### Token Provisioning

Provision secrets via `system-secrets.env.local` and sync with:

```bash
./bin/eh k8s secrets
```

Use `./bin/eh k8s deploy` to apply stack changes after image updates.

## Key Decisions (Why)

- **CLI-first, API as substrate**: one source of truth, no bypass paths.
- **Event spine in Postgres**: all triggers flow through an observable log.
- **Pipelines expand to job graphs**: deterministic execution + dependency tracking.
- **Split services**: API handles state, orchestrator schedules, worker executes.
- **Single repo per project**: simpler config, predictable execution.
- **Repo-local OpenSkills**: portable, deterministic skill discovery.
- **Hierarchical job IDs + phases**: readable, composable work structure.

## Core Architecture Principle: API as Single Gateway

> **CRITICAL**: This is a fundamental architectural constraint that MUST be followed.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   CLI  ──────────────────►  API  ──────────►  Internal Services    │
│    │                         │                                      │
│    │  ONE URL only           │  API handles ALL internal routing   │
│    │  (EVE_API_URL)          │  - Orchestrator                     │
│    │                         │  - Worker                           │
│    │                         │  - Database                         │
│    │                         │  - Future services                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### The Principle

1. **CLI knows ONE URL**: The CLI only ever communicates with the API via `EVE_API_URL`
2. **API is the gateway**: ALL other services (orchestrator, worker, etc.) are internal to the API
3. **No direct access**: CLI NEVER talks directly to orchestrator, worker, or any other service
4. **Uniform across deployments**: This works identically in k8s (default runtime) and the Docker Compose dev loop

### Why This Matters

**Deployment flexibility**: The API can discover internal services however is appropriate:
- **Dev**: `localhost:4702` for orchestrator, `localhost:4711` for worker
- **Docker**: `eve-orchestrator:4702`, `eve-worker:4711` (container names)
- **K8s**: `eve-orchestrator.eve.svc.cluster.local` (k8s service names)

The CLI doesn't care - it just talks to the API.

**Single source of truth**: All operations flow through the API. No bypass paths, no direct DB access from CLI, no split brain scenarios.

**Simpler client code**: CLI stays thin and simple. Complexity lives in the API where it can be properly tested and maintained.

### Implementation Rules

When adding new features:

1. **CLI commands** MUST only call API endpoints
2. **System status/health** endpoints MUST be on the API, aggregating internal service health
3. **Internal service URLs** are configured via API environment variables, NOT CLI
4. **New services** are accessed through the API, never directly from CLI

### Environment Variables

| Variable | Where Set | Purpose |
|----------|-----------|---------|
| `EVE_API_URL` | CLI/Client | Only URL clients ever need |
| `EVE_ORCHESTRATOR_URL` | API only | API's internal routing |
| `EVE_WORKER_URL` | API only | API's internal routing |
| `DATABASE_URL` | API/Services | Internal database access |

Clients (CLI, future UI) ONLY need `EVE_API_URL`. Everything else is internal.

## Navigation (next docs)

- Apps (runtime services): [apps/ARCHITECTURE.md](./apps/ARCHITECTURE.md)
- Packages (shared libraries): [packages/ARCHITECTURE.md](./packages/ARCHITECTURE.md)
- Docs taxonomy: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- Dev tooling: [bin/ARCHITECTURE.md](./bin/ARCHITECTURE.md)
- Containers: [docker/ARCHITECTURE.md](./docker/ARCHITECTURE.md)
- K8s manifests: [k8s/](./k8s/)
- Tests + fixtures: [tests/ARCHITECTURE.md](./tests/ARCHITECTURE.md)
- Repo-local skills: [docs/system/skills.md](./docs/system/skills.md)
- Skillpacks repo: https://github.com/eve-horizon/eve-skillpacks
- Eve manifest: [docs/system/manifest.md](./docs/system/manifest.md)
- Events: [docs/system/events.md](./docs/system/events.md)
- Pipelines: [docs/system/pipelines.md](./docs/system/pipelines.md)
- Workflows: [docs/system/workflows.md](./docs/system/workflows.md)
- Container registry: [docs/system/container-registry.md](./docs/system/container-registry.md)
- Secrets: [docs/system/secrets.md](./docs/system/secrets.md)
