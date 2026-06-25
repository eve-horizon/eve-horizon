# Phase 1 Implementation Plan (Historical)

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Historical plan
> Last Updated: 2026-01-15
> Purpose: Preserve intent while reflecting current Jobs V2 schema.

## Current Schema Snapshot (Jobs V2)

- **projects**: `id`, `org_id`, `name`, `slug`, `repo_url`, `branch`, timestamps
- **jobs**: `id`, `project_id`, `parent_id`, `depth`, `title`, `description`, `issue_type`, `labels`, `phase`, `priority`, `assignee`, review fields, scheduling fields, hints, timestamps
- **job_attempts**: UUID id + `attempt_number`, status, trigger_type, harness, agent_id, timestamps

## Current Job ID Rules

- Root: `{slug}-{hash8}`
- Child: `{parent}.{n}`
- Max depth: 3

For full details, see `docs/system/job-api.md`.
