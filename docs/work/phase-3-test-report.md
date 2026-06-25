# Phase 3 Test Report (Historical)

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Historical report
> Last Updated: 2026-01-15
> Purpose: Record validation intent while reflecting current Jobs V2 paths.

## Current Workspace Layout

```
$WORKSPACE_ROOT/{projectSlug}/{jobId}/{attemptNum}/
```

## Current Validation Targets

- Create job → `POST /projects/{project_id}/jobs`
- Claim job → `POST /jobs/{job_id}/claim`
- Logs → `GET /jobs/{job_id}/attempts/{attempt_num}/logs`
