# Configuration Model Implementation Plan (Historical)

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Historical plan
> Last Updated: 2026-01-15
> Purpose: Preserve plan intent while reflecting current configuration model.

## Current Configuration Model

- Single repo per project (`repo_url` + `branch`)
- Repo-only skills under `.agents/skills/` (optional `.claude/skills/` overrides)
- Jobs use slug-based hierarchical IDs
- Scheduling preferences are `hints` on jobs (harness, worker_type, permission, timeout)

For the authoritative model, see `docs/system/configuration-model-refactor.md`.
