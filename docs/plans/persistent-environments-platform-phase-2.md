# Persistent Environments Platform - Phase 2 Plan (Deterministic Pipelines as Job Graphs)

> Status: Draft
> Last Updated: 2026-01-22
> Breaking changes are expected and encouraged. Delete or refactor any code that does not conform to this plan.

Phase 2 focuses on deterministic pipelines that expand into job graphs, with request/response execution,
while explicitly carrying any unfinished Phase 1 prerequisites into Phase 2 so they’re closed before pipeline work proceeds.

## Requirements

- Deterministic pipelines only (no agent execution); actions are explicit build/release/deploy/run steps.
- Pipeline runs are persisted as lightweight run records; steps are jobs with dependencies.
- Request/response mode via `?wait=true` with bounded timeout and summary result.
- Env policy gates apply to deploy steps; approval handled at deploy boundary.
- CLI-first: all actions via API; no direct DB access from CLI/tests.
- Integration tests cover run creation, job graph ordering, wait mode, and approvals.

## Scope

- In: pipeline run records + job graph expansion (API → jobs); approvals/gates; CLI commands to run/inspect pipelines; example repo pipelines; integration tests.
- Out: workflows (Phase 3), triggers (Phase 4), DB/service provisioning (Phase 5+), auth rework.

## Phase 1 carryover (must be complete before Phase 2)

- Manifest sync endpoint + CLI `eve project sync` (cache manifest + git sha).
- Environments table + `GET /projects/:id/envs` and `GET /projects/:id/envs/:name`.
- Jobs default env selection from `x-eve.defaults`.
- `POST /projects/:id/envs/:name/deploy` wired to minimal k8s deployer.
- Pipeline/workflow list/show endpoints (read-only).
- `eve system` API endpoints with RBAC; removal of `eve k8s` CLI.
- K8s labeling for org scoping: `eve.org_id`, `eve.project_id`, `eve.env`, `eve.component` (+ job labels).
- Env concurrency via job gates (`env:<project_id>:<env>`).
- Integration tests for manifest sync + env deploy + list/show endpoints.
- Example repo manifest + smoke deploys.

## Files and entry points

- API: `apps/api/src/pipelines/*` (controller/service for runs) + job graph expansion.
- DB: `packages/db/migrations/0000X_add_runs.sql` + job columns for run/step metadata.
- Orchestrator: existing job loop (`apps/orchestrator/src/loop/loop.service.ts`).
- Worker: action/script execution handlers (no pipeline runner).
- CLI: `packages/cli/src/commands/pipeline.ts` (run/runs/show/approve/cancel).

## Data model / API changes

- Add tables:
  - `runs` (project_id, kind, name, env_name, git_sha, manifest_hash, inputs_json, status, started_at, completed_at, error_message, requested_by/run_mode, root_job_id).
- Add job fields:
  - `jobs.run_id`, `jobs.pipeline_step_id`, `jobs.execution_type`, `jobs.action_json`, `jobs.script_json`.
- API endpoints:
  - `POST /projects/:id/pipelines/:name/run` (body includes `ref`, `env`, `inputs`; query `wait=true` + optional timeout).
  - `GET /projects/:id/pipelines/:name/runs`
  - `GET /projects/:id/pipelines/:name/runs/:runId`
- Approval endpoints (if gate blocks deploy): `POST /pipeline-runs/:runId/approve`, `POST /pipeline-runs/:runId/cancel`.

## Action items

[ ] Finish Phase 1 carryover items (manifest sync, env deploy, list/show endpoints, system endpoints, labels, gates, tests, example repo).
[ ] Add DB migrations + queries for `runs` + job run/step fields.
[ ] Implement pipeline run create + job graph expansion + wait mode in API services/controllers.
[ ] Implement deterministic action/script job execution in the worker.
[ ] Wire run status updates based on job graph completion.
[ ] Add CLI commands: `eve pipeline run|runs|show-run|approve|cancel`.
[ ] Update example repo with deploy-test/staging/prod pipelines and README usage.
[ ] Add integration tests for run creation, step ordering, wait mode, approval flow, cancel flow.

## Testing and validation

- `./bin/eh test integration` only.
- New integration tests in `apps/api/test/integration/`:
  - pipeline run creation and list/show.
  - wait mode returns terminal state with job graph status.
  - approval blocks deploy step and resumes after approve.
  - cancel marks run + jobs terminal.
- Example repo pipeline smoke (deploy test env + run action).

## Risks and edge cases

- Wait mode timeouts: enforce default max wait and return partial status cleanly.
- Worker failure mid-run: ensure final status = failed with last completed job preserved.
- Gate deadlocks: enforce approval/cancel endpoints and clear CLI messaging.
- Action determinism drift: keep action inputs/outputs explicit and immutable.

## Design decisions

### Step retries: Rerun whole pipeline only

Step-level retry is deferred to Phase 3+. For Phase 2:
- Failed pipelines are rerun from scratch via `POST /projects/:id/pipelines/:name/run`
- Each run creates fresh state — no partial rollback semantics
- Deterministic pipelines should be idempotent; rerunning from scratch is clean
- Matches the existing job pattern where each attempt creates a new workspace

### Log storage: Reuse job logs

Pipeline steps are jobs, so logs are stored in the existing job log stream.
Run log endpoints aggregate step job logs for a unified view.

### Wait timeout: 60s default, 300s max

Configuration surface:
- Query param: `?wait=true&timeout=120` (default 60s, clamped to 5-300s)
- Manifest: `pipelines.<name>.wait_timeout` for per-pipeline default
- Env var: `EVE_PIPELINE_WAIT_MAX` for system-level cap (default 300s)

This matches the existing job wait pattern but with a longer default (60s vs 30s) since pipelines typically run longer than single job claims.
