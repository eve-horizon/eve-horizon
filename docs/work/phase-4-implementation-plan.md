# Phase 4 Implementation Plan (Historical)

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Historical plan
> Last Updated: 2026-01-15
> Purpose: Preserve review/logging intent while reflecting current Jobs V2 endpoints.

## Current Logging Endpoint

```
GET /jobs/{job_id}/attempts/{attempt_num}/logs
GET /projects/{project_id}/jobs/{job_id}/attempts/{attempt_num}/logs
```

## Current Review Workflow

- Submit: `POST /jobs/{job_id}/submit` with `summary`
- Approve: `POST /jobs/{job_id}/approve` (optional `comment`)
- Reject: `POST /jobs/{job_id}/reject` with `reason`
