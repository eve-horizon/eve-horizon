# API Architecture

> **What**: The REST API that backs the CLI and any future UI.
> **Why**: A single source of truth prevents divergent behavior across clients.

## Overview

The API owns job lifecycle state, validation, and persistence. The CLI is a thin wrapper over these endpoints.
Code-first OpenAPI documents the surface area for both humans and tools.

## Core Responsibilities

- Validate and persist orgs, projects, jobs, attempts, and dependencies.
- Enforce job lifecycle transitions and review actions.
- Expose a stable REST surface consumed by CLI and orchestrator.

## Key Decisions (Why)

- **CLI as REST wrapper**: avoids DB bypass and duplicated logic.
- **Code-first OpenAPI**: keeps docs and contracts in sync with code.

## Dependencies

- `packages/db` for schema and persistence.
- `packages/shared` for shared types and validation.

## Navigation

- OpenAPI: [docs/system/openapi.md](../../docs/system/openapi.md)
- API philosophy: [docs/system/api-philosophy.md](../../docs/system/api-philosophy.md)
- Job model: [docs/system/job-api.md](../../docs/system/job-api.md)
