# Apps Architecture

> **What**: Deployable services that make up the runtime system.
> **Why**: Clear service boundaries make orchestration, execution, and API concerns independently evolvable.

## Overview

Apps are long-running services. Each owns a distinct responsibility and communicates through the database and API calls.
This separation keeps operational concerns (worker execution) from user-facing concerns (API).

## Components

- **api**: HTTP surface and system of record for job state.
- **orchestrator**: Schedules and claims ready work.
- **worker**: Executes jobs in isolated workspaces.

## Key Decisions (Why)

- **Isolation by responsibility** reduces blast radius and simplifies scaling.
- **DB as source of truth** avoids cross-service in-memory coupling.

## Navigation

- API: [api/ARCHITECTURE.md](./api/ARCHITECTURE.md)
- Orchestrator: [orchestrator/ARCHITECTURE.md](./orchestrator/ARCHITECTURE.md)
- Worker: [worker/ARCHITECTURE.md](./worker/ARCHITECTURE.md)
