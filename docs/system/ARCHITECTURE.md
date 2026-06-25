# System Docs Architecture

> **What**: Canonical documentation describing how the system works today.
> **Why**: This is the single source of architectural truth for the repo.

## Overview

System docs are authoritative. When behavior changes, update these docs first and link from `AGENTS.md` and
relevant `ARCHITECTURE.md` files.

## Key Decisions (Why)

- **Single source of truth** avoids contradictions between docs.
- **Linked, not duplicated** keeps details in one place.

## Navigation (key system docs)

- Unified architecture: [unified-architecture.md](./unified-architecture.md)
- Eve manifest: [manifest.md](./manifest.md)
- Builds: [builds.md](./builds.md)
- Job API + lifecycle: [job-api.md](./job-api.md)
- API philosophy: [api-philosophy.md](./api-philosophy.md)
- OpenAPI: [openapi.md](./openapi.md)
- Skills system: [skills.md](./skills.md)
- Agent harness: [agent-harness-design.md](./agent-harness-design.md)
- Secrets: [secrets.md](./secrets.md)
- Container registry: [container-registry.md](./container-registry.md)
- Deployment: [deployment.md](./deployment.md)
