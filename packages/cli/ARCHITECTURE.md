# CLI Architecture

> **What**: The primary user interface (`eve`) for managing orgs, projects, and jobs.
> **Why**: CLI-first keeps workflows scriptable and makes the API the single source of truth.

## Overview

The CLI is a thin REST wrapper. It handles parsing, formatting, and profile defaults, but avoids business logic.
All actions flow through API endpoints.

## Key Decisions (Why)

- **No DB bypass**: CLI cannot mutate state directly.
- **Defaults via profile**: reduces repetitive flags and mirrors human workflows.

## Navigation

- API philosophy: [docs/system/api-philosophy.md](../../docs/system/api-philosophy.md)
- OpenAPI: [docs/system/openapi.md](../../docs/system/openapi.md)
