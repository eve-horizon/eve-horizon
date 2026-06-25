# Event-Driven Pipelines Platform Plan

> Status: Draft
> Last Updated: 2026-01-22
> Legacy note: references to `.eve/services.yaml` are historical; v2 uses `.eve/manifest.yaml` with `services`.
> This plan consolidates event-driven pipelines with the persistent environments platform and ties together
> Note: Manifest terminology now uses `services` + `x-eve.*`; migration flow is job services.
> manifests, jobs, workflows, and triggers into one coherent spine.

## Inputs

- docs/ideas/event-driven-pipelines.md
- docs/ideas/persistent-environments-platform.md
- docs/ideas/pipelines-vs-workflows.md
- docs/plans/persistent-environments-platform-plan.md
- docs/plans/persistent-environments-platform-phase-2.md
- docs/plans/persistent-environments-platform-phase-3-db-api.md
- docs/plans/persistent-environments-platform-phase-3-workflows.md
- docs/plans/default-deploy-flow.md
- docs/system/manifest.md
- docs/system/environment-gating.md
- docs/system/job-control-signals.md
- docs/system/workflow-invocation.md

## Goal

Build a single event-driven core where every trigger becomes a normalized event, every event expands
into deterministic pipelines or agent workflows, and everything executes as jobs with shared gates,
logs, and audit trails.

## Non-goals

- External message bus (Kafka, NATS, etc.).
- Data stream processing or long-running ETL pipelines.
- A second orchestration engine separate from the job system.

## Core Primitives (Minimal + Reused)

1) Manifest (.eve/manifest.yaml)
- Single source of truth: services, environments, pipelines, workflows, triggers, APIs.
- Cached by `eve project sync` and required for scheduling `x-eve.defaults`.

2) Events (normalized + stored)
- Every trigger is an event: manual, cron, webhook, app, or system.
- Events are stored in a DB table and processed by a lightweight router.

3) Jobs (universal execution)
- One execution model for both deterministic and agent work.
- Jobs already provide phases, dependencies, gates, logs, and review.

4) Runs (thin metadata)
- A run is a lightweight record that groups jobs created from a pipeline/workflow.
- Runs have no separate execution engine; they summarize the job graph.

5) Environments + Releases (persistent deployment state)
- Environment = long-lived namespace with a gate.
- Release = git ref + image digests + manifest hash.

6) Gates + Approvals (existing job gates + review)
- Environment gates prevent concurrent deploys.
- Approval gates/reviews apply at deploy boundaries.

## Core Job API (Deterministic + Agent)

The Job API remains the universal execution contract. We extend jobs with a small execution
type switch so the same lifecycle, gates, logs, and review apply to both deterministic and agent work.

Job execution types:
- `execution_type=agent` (default): current LLM-harness jobs.
- `execution_type=script`: deterministic shell command.
- `execution_type=action`: deterministic built-in action (build/release/deploy/run/notify).

The pipeline layer does not replace jobs; it expands into a job graph that uses the same Job API
internally. External clients can still create ad-hoc agent jobs via `POST /jobs`, and may optionally
create deterministic jobs directly when they need a single step without a pipeline.

Proposed Job API fields (additive):
- `execution_type` (agent | script | action)
- `action` payload (for action jobs)
- `script` payload (for script jobs)
- `run_id` + `pipeline_step_id` (linkage when created from pipelines)

## Execution Flows (Diagrams)

1) Direct Job (agent, current behavior)

```
Client/CLI
  |  POST /projects/:id/jobs { description, hints }
  v
API -> jobs table
  v
Orchestrator -> claims job (gates)
  v
Worker -> agent harness -> logs/json-result
  v
API -> job status + logs
```

2) Pipeline Run (deterministic via job graph)

```
Client/CLI
  |  POST /projects/:id/pipelines/:name/run
  v
API
  |  create run + expand pipeline into jobs (deps + steps)
  v
jobs table (execution_type=action|script, run_id, pipeline_step_id)
  v
Orchestrator -> claims step jobs (gates)
  v
Worker -> executes action/script -> logs
  v
Run status = derived from job graph completion
```

3) Workflow Invoke (agent with request/response)

```
Client/CLI
  |  POST /projects/:id/workflows/:name/invoke?wait=true
  v
API -> validate request schema -> create job (execution_type=agent)
  v
Worker -> agent runs SKILL.md -> json-result
  v
API -> validate response schema -> return payload
```

4) Event Trigger (webhook/cron/app)

```
Event Source -> /integrations/* or /projects/:id/events
  v
Events table -> trigger matcher
  v
Run/pipeline/workflow/job created (all use jobs under the hood)
```

## Current State (Already Implemented)

- API sources + env DB endpoints exist in the API.
- `eve api` and `eve db` CLI commands exist.
- E2E tests cover API sources and env DB.
- Migrations run as job services defined in the manifest (no CLI path parsing).
- Manifest service schemas/docs are present; worker deployer orders services by dependencies.

## Normalized Event Envelope

All sources produce the same event shape:

```json
{
  "id": "evt_...",
  "type": "github.push | cron.tick | manual.pipeline.run | app.event",
  "source": "github | cron | manual | app | system",
  "project_id": "proj_...",
  "env_name": "staging",
  "ref": { "sha": "abc123", "branch": "main" },
  "actor": { "type": "user | system | app", "id": "usr_..." },
  "payload": { "...": "..." }
}
```

Minimal DB fields:
- `id`, `project_id`, `type`, `source`, `env_name`, `ref_sha`, `ref_branch`
- `payload_json`, `received_at`, `processed_at`, `status`, `dedupe_key`

## Event Ingestion (Small + Obvious)

- Manual: CLI and API requests emit events (`manual.pipeline.run`, `manual.workflow.run`).
- Webhooks: GitHub/Slack endpoints normalize into events.
- Cron: internal scheduler emits `cron.tick` events.
- App: Eve-conforming apps emit events via a simple HTTP endpoint.

API surface:
- `POST /projects/:id/events` (manual + app events)
- `/integrations/*/events` for provider webhooks

## Trigger Matching and Dispatch

- Manifest `triggers` define event filters and actions.
- Router scans new events, matches triggers, and emits run requests.

Example manifest trigger:

```yaml
triggers:
  deploy-main:
    source: github
    event: push
    branch: main
    run:
      pipeline: deploy-staging
      env: staging
```

Dispatch actions:
- `pipeline` -> create a pipeline run + job graph
- `workflow` -> create a workflow job
- `job` -> create a standalone job

## Pipeline Model (Deterministic)

Pipelines are job-graph templates.

- Each step becomes a job with explicit dependencies.
- Steps can be deterministic actions or scripts.
- No separate pipeline runner; orchestration reuses the existing job scheduler.

Supported step types:
- `action` (build, release, deploy, run, notify)
- `script` (explicit command)
- `agent` (optional, but should stay rare inside pipelines)

Job execution types (proposed):
- `execution_type: action | script | agent`
- `action.type: build | release | deploy | run | notify`
- `script.run`, `script.timeout_seconds`, `script.working_dir`

Pipeline run grouping:
- Create a lightweight `runs` record (`kind=pipeline`, `name=<pipeline>`, `root_job_id`).
- Step jobs reference `run_id` for summary and log grouping.

Approvals + gates:
- Deploy steps always acquire env gates (`env:<project>:<env>`).
- If env or pipeline requires approval, add `review_required` to the deploy step
  (or a named approval gate released by `eve pipeline approve`).

## Workflow Model (Agent)

- Workflows are skills (`SKILL.md`) executed as jobs.
- Request/response uses `json-result` from job output.
- Workflows can call pipelines by emitting a manual pipeline event or via CLI.

Required contract:
- `EVE_WORKFLOW_REQUEST_JSON` and `EVE_WORKFLOW_REQUEST_PATH` injected.
- Responses must be in `json-result` when invoked with `wait=true`.

## Observability (Event + Job Unified)

- Events are the single audit trail of what triggered what.
- Jobs already provide streaming logs; pipeline steps are just jobs.
- Runs provide a stable summary view for API/CLI.

Suggested CLI surface:
- `eve event list|show|replay`
- `eve pipeline run|show|logs` (reads run + step jobs)
- `eve workflow run|invoke|logs`

## Eve-Conforming App Integration (Bonus)

Make apps emit and consume the same event system with minimal wiring.

1) Simple event emitter
- Inject `EVE_EVENT_URL` and `EVE_EVENT_TOKEN` into app environments.
- App sends `POST $EVE_EVENT_URL` with the normalized envelope.

2) Manifest declares app events

```yaml
events:
  app.note.created:
    source: app
    schema: events/note.created.schema.json

triggers:
  auto-backfill:
    source: app
    event: app.note.created
    run:
      workflow: eve-backfill-notes
```

3) Reliability + clarity
- Event schema lives in-repo (simple JSON Schema).
- Events are stored and visible via `eve event list`.
- Deduplication via `dedupe_key` for retries.

## Simplifications vs Prior Plans

- No separate pipeline runner engine; pipelines expand to jobs and use existing orchestration.
- No step-run log store; step logs are job logs.
- One run table for both pipelines and workflows (optional but simple).
- Triggers are only event filters; no hidden automation.

## Phased Delivery (Aligns with Persistent Environments Plan)

Phase 0 (carryover, in progress)
- Finish manifest sync, env deploy, list/show endpoints, env gates, system endpoints.
- Ensure deterministic deploy flow in `docs/plans/default-deploy-flow.md` is usable.

Phase 1 (event spine)
- Add `events` table + normalized envelope.
- Add `POST /projects/:id/events` and simple router loop.
- Update CLI to emit events for pipeline/workflow runs (manual triggers).

Phase 2 (deterministic pipelines as job graphs)
- Expand pipelines into job graphs on run creation.
- Add `execution_type` + `action` jobs to worker.
- Add run grouping (`runs` table) and CLI show/logs.

Phase 3 (workflow invoke + json-result)
- Implement request/response workflows with schema validation.
- Preserve user context end-to-end (job token -> API -> DB).

Phase 4 (external triggers + app events)
- GitHub + Slack webhooks -> events -> pipelines/workflows.
- Cron scheduler emits `cron.tick` events.
- App event emitter contract + manifest schemas.

Phase 5 (API sources + DB ergonomics)
- Remaining items from Phase 3A (auth propagation, RLS-safe SQL, db.write gating, and workflow integration).
- Expand API source caching/refresh and discovery UX as needed.

## Cleanup Policy

- Remove any old pipeline runner code if added.
- Keep only one source of truth for pipelines (manifest).
- Delete legacy `.eve/services.yaml` references as manifest services mature.
