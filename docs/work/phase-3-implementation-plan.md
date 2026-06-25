# Phase 3 Implementation Plan (Historical)

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Historical plan
> Last Updated: 2026-01-15
> Purpose: Preserve scheduler intent while reflecting current Jobs V2 semantics.

## Current Scheduler Signals

- Ready jobs: `phase = 'ready'`, not blocked, not deferred
- Blocked jobs: derived from dependency relations
- Priority: numeric 0-4 (lower is higher priority)

## Workspace Path Convention (Current)

```
$WORKSPACE_ROOT/{projectSlug}/{jobId}/{attemptNum}/
```
