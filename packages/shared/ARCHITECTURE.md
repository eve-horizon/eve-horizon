# Shared Package Architecture

> **What**: Common types, validation, and utilities shared across apps and CLI.
> **Why**: Keeps contracts consistent and prevents drift between services.

## Overview

Shared code is used by API, orchestrator, worker, and CLI to keep behavior aligned.
It should avoid pulling in service-specific dependencies.

## Key Decisions (Why)

- **Single source for types**: reduces duplication and mismatched expectations.
- **No app dependencies**: preserves layering and reuse.

## Navigation

- API contracts: [docs/system/openapi.md](../../docs/system/openapi.md)
