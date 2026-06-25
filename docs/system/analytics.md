# Org Analytics

> Status: Current
> Last Updated: 2026-02-12
> Purpose: Document org-wide analytics endpoints and CLI usage.

## Overview

Org analytics provide summary metrics across jobs, pipelines, and environments
for a time window. These endpoints are read-only and intended for dashboards,
health checks, and operational reporting.

## Metric Definitions

- **jobs.created/completed/failed/active**: counts within the window.
- **pipelines.success_rate**: `succeeded / total` for runs in window.
- **pipelines.avg_duration_seconds**: mean duration from `started_at` to `completed_at`.
- **environments status**: `healthy`, `degraded`, or `unknown` based on latest health snapshot.

## API Endpoints

```
GET /orgs/{org_id}/analytics/summary?window=7d
GET /orgs/{org_id}/analytics/jobs?window=7d
GET /orgs/{org_id}/analytics/pipelines?window=7d
GET /orgs/{org_id}/analytics/env-health
```

## Response Shapes

Summary:

```json
{
  "as_of": "2026-02-12T12:00:00Z",
  "window": "7d",
  "projects": 3,
  "jobs": { "created": 12, "completed": 9, "failed": 1, "active": 2 },
  "pipelines": { "runs": 4, "success_rate": 75, "avg_duration_seconds": 420 },
  "environments": { "total": 5, "healthy": 4, "degraded": 1, "unknown": 0 }
}
```

Jobs:

```json
{
  "window": "7d",
  "jobs": [{ "id": "myproj-a3f2dd12", "phase": "done", "duration_seconds": 123 }]
}
```

Pipelines:

```json
{
  "window": "7d",
  "pipelines": [{ "name": "deploy", "runs": 2, "success_rate": 50, "avg_duration_seconds": 900 }]
}
```

Env health:

```json
{
  "environments": [{ "name": "staging", "project_id": "proj_xxx", "status": "healthy" }]
}
```

## CLI Reference

```
eve analytics summary --org org_xxx [--window 7d]
eve analytics jobs --org org_xxx [--window 7d]
eve analytics pipelines --org org_xxx [--window 30d]
eve analytics env-health --org org_xxx
```

## Notes

- `window` accepts `1d`, `7d`, `30d`, or `90d`.
- Analytics require `orgs:read` permission.
- Empty orgs return zeroed summaries (not 404).
- `env-health` reports the latest known deploy/health snapshot per environment.
