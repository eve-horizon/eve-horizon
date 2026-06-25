# Workflows as Skills (Pipelines without Steps)

> Status: Superseded (see `docs/ideas/pipelines-vs-workflows.md`)
> Last Updated: 2026-01-20

## Summary

Replace explicit pipeline step graphs with **workflow skills** (OpenSkills SKILL.md + optional spec).
Workflows are executed by an agent in a regular job. The workflow remains visible and callable via API/CLI,
and can optionally be made deterministic via a workflow spec that the worker-cli can execute.

Every workflow skill must include agent instructions so it is always runnable by an agent. Deterministic
execution is an optional upgrade that uses `workflow.yaml` when invoked via workflow commands.

This keeps "job" reserved for agent-harness work while still giving customers a clear, self-describing
deploy/test flow they can call directly.

## Goals

- Workflows are visible, named, and easy to call.
- One execution primitive: agent jobs (no new pipeline runner required in Phase 1).
- Optional deterministic mode without changing the external interface.
- Same workflows exposed to CLI and external API clients.

## Concepts

**Workflow**
- A named skill with `kind: workflow`.
- Defined by `SKILL.md` plus optional `workflow.yaml` for deterministic steps.

**Workflow Run**
- The act of running a workflow.
- Exposed as `workflow_run` to clients, implemented as a job internally.

**Pipeline**
- Alias for workflow (optional for backwards naming).

## Naming

- Standard Eve-provided skills should be prefixed with `eve-`.
- Project-specific workflows can choose their own prefixes.

## Manifest Shape (proposed)

```yaml
workflows:
  deploy-test:
    workflow: eve-deploy-test
  deploy-staging:
    workflow: eve-deploy-staging

environments:
  test:
    workflow: deploy-test
  staging:
    workflow: deploy-staging
```

## Workflow Skill Format (proposed)

`skills/eve-deploy-test/SKILL.md`:

```markdown
---
name: eve-deploy-test
description: Build, release, deploy, then run integration tests
kind: workflow
runner: agent   # agent | deterministic
spec: workflow.yaml
inputs:
  env: string
  ref: string
outputs:
  release_id: string
---

# Deploy Test

Run the standard deploy flow for the test environment.

## Agent Instructions

- Read inputs from `EVE_WORKFLOW_INPUTS_JSON` (expects `env` and `ref`).
- If `workflow.yaml` exists, follow it step-by-step.
- Do not call `eve env deploy` or `eve workflow run` from inside the workflow (avoid recursion).
- When `workflow.yaml` exists, invoke the deterministic runner directly:
  - `eve-worker workflow run --skill eve-deploy-test --runner deterministic --inputs-json "$EVE_WORKFLOW_INPUTS_JSON" --env "$EVE_ENV_NAME" --ref "$EVE_GIT_SHA"`
- The deterministic runner uses the same workflow env vars (`EVE_*`) and writes outputs to `EVE_WORKFLOW_CONTEXT_PATH`.
- Emit a concise summary and exit non-zero on failure.
```

Optional `workflow.yaml`:

```yaml
version: 1
actions:
  - name: build-images
    type: build
    # Inputs: EVE_PROJECT_ID, EVE_GIT_SHA, EVE_MANIFEST_HASH
    # Outputs: image_digests -> EVE_WORKFLOW_CONTEXT_PATH
  - name: create-release
    type: release
    # Inputs: image_digests -> EVE_WORKFLOW_CONTEXT_PATH
    # Outputs: release_id -> EVE_WORKFLOW_CONTEXT_PATH
  - name: deploy-env
    type: deploy
    # Inputs: EVE_ENV_NAME, release_id -> EVE_WORKFLOW_CONTEXT_PATH
  - name: integration-tests
    type: run
    command: "./bin/eh test integration"
    # Inputs: EVE_ENV_NAME
```

## Execution Flow (Phase 1)

1) `eve workflow run deploy-test --env test --ref <sha>`
2) API resolves the workflow from the manifest and creates a job:
   - `issue_type = "workflow"`
   - `env_name = test`
   - `hints.workflow = { name, inputs, runner }`
3) Orchestrator claims the job (env gate applies as usual).
4) Worker invokes the agent harness with a standard wrapper prompt:
   - Reads the workflow skill by name
   - Passes inputs via env (e.g., `EVE_WORKFLOW_INPUTS_JSON`)
5) Logs, status, and gating use the existing job pipeline.

## Deterministic Mode (Phase 2+)

If `runner: deterministic` and `workflow.yaml` exists:
- Worker runs `eve-worker workflow run` to execute actions directly.
- No LLM is required; the job remains agent-less but still logged as a workflow run.

This keeps the API/CLI contract unchanged while enabling safe, repeatable flows.

## API Surface (proposed)

List/show workflows (from manifest + skills):
- `GET /projects/:id/workflows`
- `GET /projects/:id/workflows/:name`

Run a workflow:
- `POST /projects/:id/workflows/:name/run`
  - body: `{ env, ref, inputs }`
  - response: `{ workflow_run_id, job_id, status }`

Request/response mode:
- `POST /projects/:id/workflows/:name/run?wait=true&timeout=300`
  - response: `{ status, outputs, logs_url }`

Status/logs:
- `GET /workflow-runs/:id`
- `GET /workflow-runs/:id/logs`

Note: `job_id` is internal; external clients can treat `workflow_run_id` as the stable handle.

## CLI Surface (proposed)

- `eve workflow list|show|run|wait|logs`
- `eve pipeline` as alias (optional)
- `eve env deploy <env>` -> `eve workflow run <env.workflow>`

## Policy & Approval

Environment policies (e.g., `approval: required`) apply to workflow runs:
- The workflow job is created with `review_required` when needed.
- Approval happens at the job boundary (no step-level approval in Phase 1).

## Why This Is Elegant

- No new pipeline engine or custom runner required to ship Phase 1.
- Workflows are self-describing and live with the repo.
- Customers can call the same workflow via CLI or API.
- Determinism is an optional upgrade, not a rewrite.

## Phase 1 Fit (minimum viable)

- Parse `workflows` from manifest and expose list/show/run endpoints.
- Add `issue_type=workflow` and `hints.workflow` to job creation.
- Add a workflow wrapper prompt in worker for consistent skill execution.
- Example repo adds workflow skills for deploy/test.

## Open Questions

- Do we keep `pipelines` as an alias to `workflows` or rename outright?
- Should env gating apply to the whole workflow job or only deploy actions?
- Should deterministic workflows create a distinct run type or still use jobs?
