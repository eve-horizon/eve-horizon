# Phase 3B Plan - Agent Workflows (Request/Response)

> Status: Draft
> Last Updated: 2026-01-21
> Breaking changes are expected and encouraged. Delete or refactor any code that does not conform to this plan.

## Purpose

Make workflows a first-class, callable surface with request/response semantics that return structured
outputs using `json-result`. Workflows always run as jobs and inherit the initiating user context.

## Goals

- Workflow skills run as jobs (`issue_type=workflow`).
- Request/response mode with JSON schema validation.
- Response payloads use `json-result` (canonical).
- User context is preserved end-to-end (JWT -> job -> API/DB).

## Non-goals

- Deterministic pipelines (Phase 2).
- Trigger system (Phase 4).
- Workflow engine beyond the existing job lifecycle.

## Design Overview

### 1) Workflow Definition

Workflows are skills defined by `SKILL.md` with optional request/response schemas.

Frontmatter example:

```markdown
---
name: eve-release-audit
description: Review a release request and return approval
kind: workflow
runner: agent
db_access: read_write
endpoint:
  method: POST
  path: /workflows/release-audit
  request_schema: request.schema.json
  response_schema: response.schema.json
  timeout_seconds: 300
  wait: true
---
```

### 2) Execution Flow

1) User calls `POST /projects/:id/workflows/:name/invoke` with JWT.
2) API validates request against schema (if present).
3) API creates a job with `issue_type=workflow` and stores `actor_user_id`.
   - If `db_access: read_write`, API adds `db.write` scope to the job token.
4) Worker injects request JSON and context files into the workspace.
5) Agent executes the skill and returns `json-result` with the response payload.
6) API validates the response schema (if present) and returns the payload.

### 3) Auth Propagation

- `EVE_JOB_TOKEN` embeds user claims (user_id, org_id, scopes/roles).
- DB writes require `db.write` scope, granted only when the workflow declares `db_access: read_write`.
- API calls use this context for RLS enforcement.
- Agents should call app APIs using standard REST (curl/OpenAPI) with Eve auth.

## API Surface

- `GET /projects/:id/workflows`
- `GET /projects/:id/workflows/:name`
- `POST /projects/:id/workflows/:name/run`
- `POST /projects/:id/workflows/:name/invoke?wait=true&timeout=300`
- Optional alias when `endpoint.path` is set:
  - `POST /projects/:id/endpoints/<path>`

## CLI

- `eve workflow list|show|run|invoke|wait|logs`

## Data Model

- `workflow_runs` (optional) for external tracking:
  - `id`, `project_id`, `workflow_name`, `job_id`, `env_name`, `status`, `created_at`, `completed_at`.
- Jobs store `actor_user_id` for user context propagation.

## Worker Contract

- Provide `EVE_WORKFLOW_REQUEST_JSON` and `EVE_WORKFLOW_REQUEST_PATH`.
- Provide `EVE_WORKFLOW_RESPONSE_SCHEMA_PATH` (if present).
- Require `json-result` for responses in invoke mode.
- Persist response to `job_attempts.result_json`.

## Example Repo

- Add a workflow skill with request/response schemas.
- Workflow calls app APIs (OpenAPI/PostgREST/GraphQL) and returns `json-result` output.
- README example: `eve workflow invoke ... --json ...`.

## Tests

- Workflow run creation + execution.
- Workflow invoke validates request schema and enforces `json-result` output.
- Response schema validation (valid + invalid).
- User context preserved for API and DB access.

## Risks + Open Questions

- Should `json-result` be required for all workflows or only invoke mode?
- Do we need a stable `workflow_run_id`, or can clients rely on job IDs?
- What is the default wait timeout for invoke requests?
