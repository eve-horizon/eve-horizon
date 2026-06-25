# Starter CI/CD + Self-Healing Automation (Idea)

> Status: Draft
> Last Updated: 2026-01-27
> Purpose: Define how the `eve-horizon-starter` repo should ship with CI/CD and remediation automation using Eve pipelines, workflows, and the event spine.

## Desired Behavior (User Request)

1) Every commit to `main` runs integration tests. If they pass, staging is updated automatically.
2) If integration tests fail, an automated job fixes them and opens a PR (no direct pushes to `main`).
3) Every hour, a cron job scans **k8s app logs**; if errors are found, a job analyzes them, fixes the issue, and opens a PR.

## Current Building Blocks (Eve Horizon)

- Pipelines are defined in `.eve/manifest.yaml` and can run deterministic steps (`script`, `action`, `agent`).
- Workflow invocation creates a job with workflow metadata (`workflow-invocation.md`).
- Event spine exists with GitHub webhooks and system failure events (`system.job.failed`, `system.pipeline.failed`).
- Job git controls allow branch selection, commit policies, and push policies (`job-git-controls.md`).
- Pipeline `create-pr` action exists and uses `GITHUB_TOKEN` (`manifest.md`, `secrets.md`).
- `api_spec` registration supports OpenAPI via `spec_url` on services (`manifest.md`).

## Gaps / Blockers (As of 2026-01-27)

1) **Trigger-driven execution is incomplete/ambiguous**
   - `pipelines.md` and `workflows.md` list trigger execution as planned, while `events.md` claims job creation occurs.
   - `system-overview.md` states that triggers are matched but job creation is next on the roadmap.
   - Net: we cannot rely on triggers for push/cron/system events yet.

2) **Cron scheduling is not implemented**
   - `events.md` lists cron as planned; there is no scheduler emitting `cron.tick` events.

3) **No app log query surface (k8s-only required)**
   - CLI exposes job logs and system logs, but not deployed app logs for a project/env.
   - For now we only need a k8s log source (per-env, per-service), not cloud log aggregation.

4) **Starter repo lacks tests + v2 manifest + OpenAPI spec**
   - The starter uses legacy `components` and has no integration test script.
   - A CI pipeline needs a real test command and a staging environment definition.
   - The starter should ship a small REST API (notes/todos), expose OpenAPI, and register it via `api_spec`.

5) **Auto-fix governance and race control**
   - Direct pushes to `main` are possible via git controls, but branch-level gating and auto-merge policy are not defined.
   - Without guardrails, remediation loops or concurrent jobs could clash.

6) **GitHub integration bootstrapping**
   - GitHub webhooks and write credentials must be configured for the starter repo.
   - We need a documented, repeatable setup (token or deploy key) for automation to push/PR.

## Proposed Design (Target State)

### Pipelines

- `ci-main`:
  - Run integration tests against the repo.
- `deploy-staging`:
  - Deploy to staging environment.
- `ci-cd-main`:
  - Runs integration tests, then deploys staging on success.

### Event Triggers

- `github.push` on `main` -> run `ci-cd-main`.
- `system.pipeline.failed` for `ci-main` -> run `fix-ci-failure` workflow.
- `cron.tick` hourly -> run `log-audit` workflow.

### Remediation Workflows

- `fix-ci-failure` workflow (PR-only):
  - Analyze failure logs.
  - Fix tests (agent job).
  - Update git on a branch: `git.branch=job/${job_id}`, `commit=auto`, `push=on_success`.
  - Open PR via `create-pr` action (required).

- `log-audit` workflow (PR-only):
  - Fetch app logs for `staging`.
  - Detect errors (regex, known signatures, or anomaly heuristics).
  - Fix and open PR (preferred).

### Starter App Requirements

- Provide a tiny REST API for **notes/todos** with in-memory storage (no DB).
- Expose OpenAPI at `/openapi.json` and register via `api_spec`.
- Include minimal integration tests that hit the API endpoints (create/list/update/delete).

### Log Sources (k8s-only for now)

- **K8s log proxy**: Add an API/CLI to fetch logs for `env+service` with time bounds.

### Manifest Sketch (v2 + planned triggers)

```yaml
services:
  api:
    build:
      context: apps/api
    ports:
      - "3000"
    x-eve:
      api_spec:
        type: openapi
        spec_url: /openapi.json

environments:
  staging:
    type: persistent
    pipeline: ci-cd-main

pipelines:
  ci-cd-main:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - name: integration-tests
        script:
          run: "./scripts/integration-test.sh"
          timeout: 1800
      - name: deploy-staging
        depends_on: [integration-tests]
        action: { type: deploy }

workflows:
  fix-ci-failure:
    trigger:
      system:
        event: pipeline.failed
        pipeline: ci-cd-main
    steps:
      - agent:
          prompt: "Fix failing integration tests and update main"

  log-audit:
    trigger:
      cron:
        schedule: "0 * * * *"
    steps:
      - agent:
          prompt: "Scan staging logs for errors and open a PR with fixes"
```

> Note: `trigger` and `cron` blocks are planned; the manifest syntax above reflects the intended direction.

## Plan to Close Gaps

### Phase 1: Starter Repo Changes (No platform changes)

- Update starter manifest to v2 `services` + add `staging` env.
- Implement a small REST API (notes/todos) with in-memory storage.
- Generate and serve OpenAPI at `/openapi.json` and register via `api_spec`.
- Add `scripts/integration-test.sh` and minimal integration tests for the API.
- Add a default pipeline (`ci-cd-main`) runnable via CLI.
- Document required secrets (`EVE_SECRET_GITHUB_TOKEN`, registry creds).

### Phase 2: Trigger-Driven Pipeline/Workflow Runs

- Implement trigger-driven pipeline run creation from events.
- Implement trigger-driven workflow job creation.
- Add CLI visibility for triggers and matched events.

### Phase 3: Cron Scheduler

- Add internal cron scheduler that emits `cron.tick` events.
- Support manifest schedules with guardrails (min interval, idempotency keys).

### Phase 4: App Log Access (k8s-only)

- Add `eve env logs <project> <env> <service>` API/CLI.
- Provide query filters (since, grep, level) with bounded retention.
- Defer external log integrations.

### Phase 5: Remediation Governance

- Add branch-level gating for jobs that push.
- Define auto-merge policy (optional) or require PR approvals.
- Add cooldown/backoff to prevent remediation loops.

## Open Questions

- What log source should we use for non-k8s environments (future)?
- Should remediation jobs be limited to one active per pipeline/env?

## Related Docs

- `docs/system/pipelines.md`
- `docs/system/workflows.md`
- `docs/system/events.md`
- `docs/system/job-git-controls.md`
- `docs/ideas/event-driven-pipelines.md`
- `docs/plans/event-driven-pipelines-platform-plan.md`
