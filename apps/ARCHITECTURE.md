# Apps Architecture

> **What**: Deployable services that make up the runtime system.
> **Why**: Clear service boundaries make orchestration, execution, and API concerns independently evolvable.

## Overview

Apps are long-running services. Each owns a distinct responsibility and communicates through the database and API calls.
This separation keeps operational concerns (execution) from user-facing concerns (API).

## Components

- **api**: HTTP surface and system of record for job state.
- **orchestrator**: Schedules and claims ready work; routes agent jobs to agent-runtime and action/script/build work to the worker.
- **agent-runtime**: Executes ALL agent jobs (chat, manual, scheduled) via harnesses. See the CRITICAL routing rule in [CLAUDE.md](../CLAUDE.md).
- **worker**: Executes builds, deploys, pipeline actions, and script steps.
- **gateway**: Chat ingress/egress (Slack, webchat, Nostr, API providers) bridging channels to jobs and threads.
- **sso**: GoTrue-backed web auth broker (login, magic links, sessions) for platform and tenant apps.
- **dashboard**: Read-only "Horizon" operator UI (jobs, apps, costs, system).

## Key Decisions (Why)

- **Isolation by responsibility** reduces blast radius and simplifies scaling.
- **DB as source of truth** avoids cross-service in-memory coupling.
- **Agent execution lives in agent-runtime, not the worker** — see [docs/system/agent-runtime.md](../docs/system/agent-runtime.md).

## Navigation

- API: [api/ARCHITECTURE.md](./api/ARCHITECTURE.md)
- Orchestrator: [orchestrator/ARCHITECTURE.md](./orchestrator/ARCHITECTURE.md)
- Agent Runtime: [agent-runtime/ARCHITECTURE.md](./agent-runtime/ARCHITECTURE.md)
- Worker: [worker/ARCHITECTURE.md](./worker/ARCHITECTURE.md)
- Gateway: [gateway/ARCHITECTURE.md](./gateway/ARCHITECTURE.md)
- SSO: [sso/ARCHITECTURE.md](./sso/ARCHITECTURE.md)
- Dashboard: [dashboard/ARCHITECTURE.md](./dashboard/ARCHITECTURE.md)
