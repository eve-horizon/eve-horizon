# Deploy Polling

> Status: Current
> Last Updated: 2026-02-01

## Purpose

How API clients start a deployment and poll until it completes, detecting success or failure. Covers both deploy paths (direct and pipeline) and the health endpoint's pipeline-awareness overlay.

## Current (Implemented)

### Starting a Deploy

```
POST /projects/{projectId}/envs/{envName}/deploy
```

Body requires either `release_tag` **or** both `git_sha` and `manifest_hash`:

```json
{
  "git_sha": "ef05a4c...",
  "manifest_hash": "abc123...",
  "image_tag": "sha-ef05a4c"
}
```

Optional fields:
- `image_digests` — map of service name to image digest for pinned deploys
- `image_tag` — tag to use for image references (e.g., `"local"`, `"sha-abc123"`)
- `direct` — `true` to bypass pipeline and deploy immediately via worker
- `inputs` — additional key-value inputs forwarded to the pipeline

Schema: `DeployRequestSchema` in `packages/shared/src/schemas/release.ts`

### Response: Two Shapes

The deploy response is a union type. The client must check which shape it received to determine the polling strategy.

**Discriminator:** If the response contains `pipeline_run`, it's a pipeline deploy. Otherwise it's a direct deploy.

#### Direct Deploy Response

Returned when `direct: true` or no pipeline is configured for the environment.

```json
{
  "release": { "id": "rel_...", "tag": "v1.2.3", ... },
  "environment": { "id": "env_...", "name": "production", ... },
  "deployment_status": {
    "env_id": "env_...",
    "state": "deploying",
    "namespace": "org-project-production"
  },
  "warnings": []
}
```

`deployment_status.state` values: `pending`, `deploying`, `ready`, `failed`, `unknown`

Schema: `DirectDeployResponseSchema` in `packages/shared/src/schemas/deploy.ts`

#### Pipeline Deploy Response

Returned when the environment has a pipeline configured (the common case).

```json
{
  "pipeline_run": {
    "run": {
      "id": "prun_01kgdhz...",
      "pipeline_name": "deploy",
      "status": "pending",
      "env_name": "production",
      "git_sha": "ef05a4c...",
      ...
    },
    "steps": [
      { "step_name": "build", "status": "pending", ... },
      { "step_name": "deploy", "status": "pending", ... }
    ]
  },
  "environment": { "id": "env_...", "name": "production", ... },
  "poll_url": "/pipeline-runs/prun_01kgdhz...",
  "warnings": []
}
```

Key fields for polling:
- `pipeline_run.run.id` — the run ID to poll
- `pipeline_run.run.pipeline_name` — needed for the poll endpoint path
- `poll_url` — convenience URL for the pipeline run detail endpoint

Schema: `PipelineDeployResponseSchema` in `packages/shared/src/schemas/deploy.ts`

### Polling: Pipeline Path

Poll the pipeline run until it reaches a terminal status.

```
GET /projects/{projectId}/pipelines/{pipelineName}/runs/{runId}
```

Response:

```json
{
  "run": {
    "id": "prun_01kgdhz...",
    "status": "running",
    "error_message": null,
    "started_at": "2026-02-01T12:00:00Z",
    "completed_at": null,
    ...
  },
  "steps": [
    {
      "step_name": "build",
      "status": "succeeded",
      "exit_code": 0,
      "duration_ms": 45000,
      "error_message": null
    },
    {
      "step_name": "deploy",
      "status": "running",
      "exit_code": null,
      "duration_ms": null,
      "error_message": null
    }
  ]
}
```

#### Pipeline Run Terminal Statuses

| Status | Meaning | Action |
|--------|---------|--------|
| `succeeded` | All steps completed | Proceed to health check |
| `failed` | A step failed | Read `run.error_message` and failed steps |
| `cancelled` | Run was cancelled | Deploy aborted, no further polling |

Non-terminal statuses: `pending`, `running`, `awaiting_approval`

#### Detecting Step-Level Failures

When `run.status` is `failed`, inspect individual steps for details:

```
for step in response.steps:
    if step.status == "failed":
        # step.error_message — human-readable error
        # step.exit_code — process exit code (if applicable)
        # step.logs_ref — reference to full build/deploy logs
```

Step statuses: `pending`, `running`, `succeeded`, `failed`, `cancelled`, `blocked`

#### Recommended Poll Interval

- Poll every **3–5 seconds**
- Timeout after **300 seconds** for typical build+deploy pipelines
- On timeout, the pipeline run is still active server-side — the client can resume polling later

### Polling: Direct Deploy Path

For direct deploys, skip pipeline polling and go straight to the health check below.

### Health Check: Confirming Pod Readiness

After the pipeline run succeeds (or immediately for direct deploys), poll the health endpoint to confirm pods are live.

```
GET /projects/{projectId}/envs/{envName}/health
```

Response:

```json
{
  "project_id": "proj_...",
  "env_name": "production",
  "namespace": "org-project-production",
  "status": "ready",
  "ready": true,
  "k8s_available": true,
  "active_pipeline_run": null,
  "deployment": {
    "ready": true,
    "available_replicas": 3,
    "desired_replicas": 3,
    "conditions": [...]
  },
  "warnings": [],
  "checked_at": "2026-02-01T12:01:30Z"
}
```

#### Health Status Values

| Status | Meaning |
|--------|---------|
| `ready` | All pods healthy, no in-flight pipeline |
| `deploying` | Pods rolling out or a pipeline run is active |
| `degraded` | Some pods unhealthy |
| `unknown` | K8s not available or cannot determine state |

#### Pipeline-Aware Health

The health endpoint checks for in-flight pipeline runs. Even if old pods appear healthy, the endpoint will report `deploying` while a pipeline run is `pending` or `running`. This prevents false-positive "ready" results during the gap between pipeline creation and pod rollout.

When a pipeline run is active, the response includes:

```json
{
  "status": "deploying",
  "ready": false,
  "active_pipeline_run": {
    "id": "prun_01kgdhz...",
    "pipeline_name": "deploy",
    "status": "running",
    "git_sha": "ef05a4c...",
    "created_at": "2026-02-01T12:00:00Z"
  },
  "warnings": ["Pipeline run prun_01kgdhz... is running (deploy)"]
}
```

#### Deploy Complete Condition

A deploy is fully complete when **all** of these are true:
- `ready === true`
- `active_pipeline_run === null`
- `status === "ready"`

Poll every **3–5 seconds**, timeout after **120 seconds** (pods should roll quickly after a pipeline succeeds).

### Complete Pseudocode

```
response = POST /projects/{id}/envs/{env}/deploy { ... }

if response.pipeline_run:
    # ── Pipeline path ──
    run_id  = response.pipeline_run.run.id
    pipeline = response.pipeline_run.run.pipeline_name

    loop every 3s, timeout 300s:
        detail = GET /projects/{id}/pipelines/{pipeline}/runs/{run_id}

        if detail.run.status == "succeeded":
            break
        if detail.run.status in ("failed", "cancelled"):
            FAIL → detail.run.error_message, step errors
        # else: keep polling

    # ── Pipeline done — confirm pods ──
    loop every 3s, timeout 120s:
        health = GET /projects/{id}/envs/{env}/health
        if health.ready and not health.active_pipeline_run:
            SUCCESS
        if health.status == "degraded":
            WARN

else:
    # ── Direct path — watch health only ──
    loop every 3s, timeout 120s:
        health = GET /projects/{id}/envs/{env}/health
        if health.ready:
            SUCCESS
        if health.status == "degraded":
            WARN
```

### API Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/projects/{id}/envs/{env}/deploy` | POST | Start a deploy |
| `/projects/{id}/pipelines/{pipeline}/runs/{runId}` | GET | Poll pipeline run status |
| `/projects/{id}/envs/{env}/health` | GET | Check pod readiness |
| `/projects/{id}/envs/{env}/diagnose` | GET | Deep diagnostics (pods, events, conditions) |

### Key Schemas

- `DeployRequestSchema` — `packages/shared/src/schemas/release.ts`
- `DeployResponseSchema` (union) — `packages/shared/src/schemas/deploy.ts`
- `PipelineRunDetailResponseSchema` — `packages/shared/src/schemas/pipeline-run.ts`
- `EnvHealthResponseSchema` — `packages/shared/src/schemas/environment.ts`

## Planned (Not Implemented)

- SSE/WebSocket streaming for real-time pipeline step progress (the pipeline runs controller has an SSE `follow` endpoint but it is not yet surfaced in the deploy flow)
- Webhook callbacks on deploy completion for push-based notification instead of polling

## Legacy / Removed

- Before the pipeline-awareness fix, the health endpoint had no knowledge of in-flight pipeline runs. A client polling only the health endpoint during a pipeline deploy could receive a false `ready` from stale pods. This was fixed in commit `9d5cb8c`.
