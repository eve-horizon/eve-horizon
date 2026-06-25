# Phase 2 Implementation Plan (Historical)

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Historical plan
> Last Updated: 2026-01-15
> Purpose: Preserve API intent while reflecting current Jobs V2 endpoints.

## Current API Surface (Jobs V2)

```text
POST /projects/{project_id}/jobs
GET  /projects/{project_id}/jobs
GET  /projects/{project_id}/jobs/ready
GET  /projects/{project_id}/jobs/blocked

GET   /jobs/{job_id}
PATCH /jobs/{job_id}
GET   /jobs/{job_id}/tree
GET   /jobs/{job_id}/dependencies
POST  /jobs/{job_id}/dependencies
DELETE /jobs/{job_id}/dependencies/{related_job_id}

POST /jobs/{job_id}/claim
POST /jobs/{job_id}/release
GET  /jobs/{job_id}/attempts
GET  /jobs/{job_id}/attempts/{attempt_num}/logs

POST /jobs/{job_id}/submit
POST /jobs/{job_id}/approve
POST /jobs/{job_id}/reject

POST /projects/{project_id}/jobs/{job_id}/attempts
GET  /projects/{project_id}/jobs/{job_id}/attempts
GET  /projects/{project_id}/jobs/{job_id}/attempts/{attempt_num}
POST /projects/{project_id}/jobs/{job_id}/attempts/{attempt_num}/continue
GET  /projects/{project_id}/jobs/{job_id}/attempts/{attempt_num}/logs
```

## Current Create Job Example

```json
{
  "description": "Review this PR for correctness",
  "harness": "mclaude",
  "harness_options": {
    "variant": "fast"
  },
  "hints": {
    "permission_policy": "auto_edit"
  }
}
```
