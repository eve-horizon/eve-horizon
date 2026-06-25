# Deterministic Pipelines vs Agent Workflows

> Status: Idea
> Last Updated: 2026-01-20
> Legacy note: examples use pipeline `actions` and `tests`. v2 manifests should
> use `pipelines.<name>.steps` (see `docs/system/manifest.md`).

## Summary

Separate **pipelines** (deterministic, request/response friendly) from **workflows** (agent-run skills).
Pipelines are defined in the manifest and execute built-in actions. Workflows are OpenSkills SKILL.md
and always run as agent jobs. Pipelines can be called directly by customers via API, while workflows
remain a flexible agent orchestration tool.

## Goals

- Make deploy/test flows obvious and deterministic by default.
- Use jobs as the universal execution unit (deterministic + agent).
- Allow repo-specific customization via manifest parameters, not custom skills.
- Expose the same pipeline interfaces to CLI and external clients.
- Keep workflows runnable by any agent with clear instructions.

## Non-goals

- Agent-driven pipelines as the default.
- Implicit deploy behavior that is not visible in the manifest.

## Concepts

**Pipeline**
- Deterministic execution plan defined in the manifest.
- Runs built-in actions (`build`, `release`, `deploy`, `run`).
- Expanded into a job graph and executed by the worker (no LLM).

**Workflow**
- Agent-run skill (`SKILL.md`) with human-readable instructions.
- Optional; can call pipelines if needed.
- Implemented as a regular job with `issue_type=workflow`.

## Naming

- Standard Eve-provided skills use the `eve-` prefix.
- Project-specific names are free-form.

## Manifest Model (proposed)

```yaml
tests:
  integration:
    command: "./bin/eh test integration"

pipelines:
  deploy-test:
    actions:
      - type: build
      - type: release
      - type: deploy
      - type: run
        command_ref: integration

  deploy-staging:
    actions:
      - type: build
      - type: release
      - type: deploy

workflows:
  release-audit:
    workflow: eve-release-audit
    inputs:
      env: production

environments:
  test:
    pipeline: deploy-test
  staging:
    pipeline: deploy-staging
```

Notes:
- `tests.*.command` is repo-specific; pipelines reference tests by name.
- Workflows are optional and agent-run only.

## Custom Pipelines (client-defined)

Pipelines are defined explicitly with action lists:

```yaml
pipelines:
  custom-deploy:
    actions:
      - type: build
      - type: release
      - type: deploy
      - type: run
        command_ref: integration
```

Actions are validated against the action schema and executed in order.

## Execution Model

### Pipeline Run (deterministic)

1) `eve pipeline run deploy-test --env test --ref <sha>`
2) API creates a run record and expands the pipeline into a job graph.
3) Orchestrator schedules step jobs via the existing job loop.
4) Worker executes each action job via `worker-cli action <type>`:
   - Uses manifest + inputs + stable env vars.
5) Logs and outputs are stored in the job log stream and context file.

### Workflow Run (agent)

1) `eve workflow run release-audit --env production --ref <sha>`
2) API creates a job with `issue_type=workflow` and `hints.workflow`.
3) Orchestrator claims and worker invokes the agent harness.
4) Skill instructions guide the agent. It may call pipelines as needed.

## Workflow HTTP Endpoints (optional)

Workflows can expose request/response endpoints when declared in SKILL.md frontmatter.
This allows external clients to call agent-run workflows directly with optional JSON schema validation.

Frontmatter example:

```markdown
---
name: eve-release-audit
description: Review a release request and return an approval payload
kind: workflow
runner: agent
endpoint:
  method: POST
  path: /workflows/release-audit
  request_schema: request.schema.json
  response_schema: response.schema.json
  timeout_seconds: 300
  wait: true
---
```

Supporting files (co-located with SKILL.md):
- `request.schema.json` (optional)
- `response.schema.json` (optional)
- `request.example.json` (optional, docs only)

Request handling:
- If `request_schema` is present, the API validates the incoming JSON (400 on failure).
- The request body is injected into the job as `EVE_WORKFLOW_REQUEST_JSON` and written to `EVE_WORKFLOW_REQUEST_PATH`.
- The agent returns JSON via `json-result` (captured as `job_attempts.result_json`).
- If `response_schema` is present, the API validates the response JSON (422 on failure).

Schema examples:

`request.schema.json`:
```json
{
  "type": "object",
  "required": ["env", "ref"],
  "properties": {
    "env": { "type": "string" },
    "ref": { "type": "string" }
  },
  "additionalProperties": false
}
```

`response.schema.json`:
```json
{
  "type": "object",
  "required": ["status", "release_id"],
  "properties": {
    "status": { "type": "string", "enum": ["approved", "rejected"] },
    "release_id": { "type": "string" },
    "notes": { "type": "string" }
  },
  "additionalProperties": false
}
```

Response capture convention:
- **Preferred**: agent returns `json-result` so `job_attempts.result_json` is filled.
- **Optional**: agent writes JSON to `EVE_WORKFLOW_RESPONSE_PATH` (if set); API reads and validates it.

Stable env vars for agent workflows:
- `EVE_WORKFLOW_REQUEST_JSON`
- `EVE_WORKFLOW_REQUEST_PATH`
- `EVE_WORKFLOW_RESPONSE_SCHEMA_PATH`
- `EVE_WORKFLOW_RESPONSE_PATH` (optional output file)

## Pipeline Action Env Contract (proposed)

- `EVE_PROJECT_ID`
- `EVE_ENV_NAME`
- `EVE_GIT_SHA`
- `EVE_MANIFEST_HASH`
- `EVE_PIPELINE_INPUTS_JSON`
- `EVE_PIPELINE_CONTEXT_PATH`

Context file example:

```json
{
  "image_digests": { "api": "sha256:...", "web": "sha256:..." },
  "release_id": "rel_abc123"
}
```

## CLI Surface (proposed)

- `eve pipeline list|show|run|wait|logs`
- `eve workflow list|show|run|wait|logs`
- `eve env deploy <env>` -> `eve pipeline run <env.pipeline>`

## API Surface (proposed)

Pipelines:
- `GET /projects/:id/pipelines`
- `GET /projects/:id/pipelines/:name`
- `POST /projects/:id/pipelines/:name/run`
- `POST /projects/:id/pipelines/:name/run?wait=true&timeout=300`

Workflows:
- `GET /projects/:id/workflows`
- `GET /projects/:id/workflows/:name`
- `POST /projects/:id/workflows/:name/run`
- `POST /projects/:id/workflows/:name/invoke?wait=true&timeout=300`
- Optional alias when `endpoint.path` is set:
  - `POST /projects/:id/endpoints/<path>`

External clients can call pipelines for deterministic request/response or workflows for agent-driven request/response
when endpoints are declared.

## Why This Is More Obvious

- Pipelines are deterministic and parameterized in the manifest.
- Tests/commands are referenced by name instead of buried in skills.
- Workflows remain flexible without pretending to be deterministic.

## Phase Impact (summary)

- Phase 1: pipeline definitions + job graph expansion + `deploy` action (uses existing deployer).
- Phase 2: build/release/run actions + wait mode.
- Phase 3: workflow skills + workflow run endpoints + optional request/response validation.

## Open Questions

- Should workflows be allowed to call pipelines directly via API, or only via CLI?
