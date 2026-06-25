# Default Deploy Flow (Deterministic Pipelines)

> Plan (Proposed)
> Last Updated: 2026-01-20
> Legacy note: examples reference `tests` and pipeline `actions`. v2 pipelines
> use `steps`. See `docs/system/manifest.md` for the current spec.

## Goals

- Single-command deploy flow for test, staging, production.
- Fast iteration for test env via build + deploy + auto tests.
- No dev runtime; use deterministic actions for integration tests and checks.
- Default flow is defined as an explicit pipeline in the manifest.
- Pipelines run without an agent; workflows are optional and agent-run.

## Non-goals

- Long-lived dev processes (pnpm dev) inside the platform.
- Hidden implicit deploy flows without a visible pipeline definition.

## Proposed UX

- `eve project sync` parses the manifest and upserts env metadata + pipelines.
- `eve env deploy <env>` is a shortcut for `eve pipeline run <env.pipeline> --env <env>`.
- The pipeline is visible via `eve pipeline show <name>` and runs deterministically.
- Workflows (agent-run skills) are optional and separate from pipelines.

Manual overrides:
- `--no-build`
- `--no-tests`
- `--release <id>`

## Manifest additions (proposed)

```yaml
name: fullstack-example

registry:
  host: ghcr.io
  namespace: eve-horizon
  auth:
    username_secret: GHCR_USERNAME
    token_secret: GITHUB_TOKEN

services:
  api:
    image: ghcr.io/eve-horizon/fullstack-example-api
    build:
      context: ./apps/api
      dockerfile: ./apps/api/Dockerfile
      target: production
      args:
        NODE_ENV: production
    ports: [3000]
    x-eve:
      ingress:
        public: true
        port: 3000

  web:
    image: ghcr.io/eve-horizon/fullstack-example-web
    build:
      context: ./apps/web
      dockerfile: ./apps/web/Dockerfile
    ports: [80]
    x-eve:
      ingress:
        public: true
        port: 80

tests:
  integration:
    command: "./bin/eh test integration"

pipelines:
  deploy-test:
    steps:
      - name: build
        action: { type: build }
      - name: release
        depends_on: [build]
        action: { type: release }
      - name: deploy
        depends_on: [release]
        action: { type: deploy }
      - name: test
        depends_on: [deploy]
        action:
          type: run
          command_ref: integration

  deploy-staging:
    steps:
      - name: build
        action: { type: build }
      - name: release
        depends_on: [build]
        action: { type: release }
      - name: deploy
        depends_on: [release]
        action: { type: deploy }

  deploy-production:
    steps:
      - name: build
        action: { type: build }
      - name: release
        depends_on: [build]
        action: { type: release }
      - name: deploy
        depends_on: [release]
        action: { type: deploy }

environments:
  test:
    pipeline: deploy-test
  staging:
    pipeline: deploy-staging
  production:
    pipeline: deploy-production
    approval: required
```

Notes:
- `services.*.image` is a repository base, not a tag.
- Builds tag images as `:<git_sha>` and capture digests for releases.
- Pipelines reference tests by name via `command_ref`.

## Pipeline Action Spec (internal)

This is the deterministic action graph the pipeline expands into jobs:

```yaml
version: 1
actions:
  - name: build-images
    type: build
    # Inputs: EVE_PROJECT_ID, EVE_GIT_SHA, EVE_MANIFEST_HASH
    #         EVE_REGISTRY_HOST, EVE_REGISTRY_NAMESPACE
    #         EVE_REGISTRY_USERNAME, EVE_REGISTRY_TOKEN
    # Outputs: writes image_digests to EVE_PIPELINE_CONTEXT_PATH
  - name: create-release
    type: release
    # Inputs: EVE_PROJECT_ID, EVE_GIT_SHA, EVE_MANIFEST_HASH
    #         image_digests from EVE_PIPELINE_CONTEXT_PATH
    # Outputs: writes release_id to EVE_PIPELINE_CONTEXT_PATH
  - name: deploy-env
    type: deploy
    # Inputs: EVE_ENV_NAME, release_id from EVE_PIPELINE_CONTEXT_PATH
  - name: integration-tests
    type: run
    command: "./bin/eh test integration"
    # Inputs: EVE_ENV_NAME, EVE_PROJECT_ID, EVE_API_URL (if needed by tests)
```

## Pipeline Action Env Contract (proposed)

All pipeline runs set a small, stable env surface:

- `EVE_PROJECT_ID` - owning project
- `EVE_ENV_NAME` - target env (if provided)
- `EVE_GIT_SHA` - ref to deploy/test
- `EVE_MANIFEST_HASH` - manifest hash synced to API
- `EVE_PIPELINE_INPUTS_JSON` - raw inputs as JSON
- `EVE_PIPELINE_CONTEXT_PATH` - file path for action outputs

Action outputs are persisted in a shared JSON context file to make sequencing obvious:

```json
{
  "image_digests": { "api": "sha256:...", "web": "sha256:..." },
  "release_id": "rel_abc123"
}
```

## Deterministic Execution (expanded commands)

Each action job executes explicit worker-cli commands (or equivalent internal handlers):

```bash
# Build images (writes image_digests to context)
eve-worker action build \
  --project "$EVE_PROJECT_ID" \
  --ref "$EVE_GIT_SHA" \
  --manifest-hash "$EVE_MANIFEST_HASH" \
  --context "$EVE_PIPELINE_CONTEXT_PATH"

# Create release (reads image_digests, writes release_id)
eve-worker action release \
  --project "$EVE_PROJECT_ID" \
  --ref "$EVE_GIT_SHA" \
  --manifest-hash "$EVE_MANIFEST_HASH" \
  --context "$EVE_PIPELINE_CONTEXT_PATH"

# Deploy (reads release_id)
eve-worker action deploy \
  --env "$EVE_ENV_NAME" \
  --context "$EVE_PIPELINE_CONTEXT_PATH"

# Run integration tests
eve-worker action run \
  --command "./bin/eh test integration" \
  --env "$EVE_ENV_NAME"
```

This makes each step deterministic and auditable.

## Pipeline Run Mapping (proposed)

Pipeline runs are recorded as lightweight run records, and step jobs reference `run_id` + `pipeline_step_id`:

```json
{
  "pipeline": "deploy-test",
  "env_name": "test",
  "git_sha": "<git_sha>",
  "manifest_hash": "<hash>"
}
```

## Workflow Skills (optional)

Workflow skills are agent-run and can call pipelines for deterministic execution:

`skills/eve-deploy-test/SKILL.md`:

```markdown
---
name: eve-deploy-test
description: Run the deploy-test pipeline (deterministic)
kind: workflow
runner: agent
inputs:
  env: string
  ref: string
---

# Deploy Test Workflow

## Agent Instructions

- Read inputs from `EVE_WORKFLOW_INPUTS_JSON`.
- Execute the pipeline: `eve pipeline run deploy-test --env "$EVE_ENV_NAME" --ref "$EVE_GIT_SHA"`.
- Summarize the outcome and fail if the pipeline fails.
```

## Worker CLI Hook (proposed)

Add deterministic actions to `worker-cli` (used by action jobs):

```
eve-worker action <build|release|deploy|run> ...
```

## Registry setup (GHCR for example)

1) Use existing `GITHUB_TOKEN` if available
   - `GITHUB_TOKEN` can authenticate to GHCR as the password
   - You still need the username that owns the token (store as `GHCR_USERNAME`)
2) If no `GITHUB_TOKEN` exists, create a GitHub token for GHCR
   - Owner: example
   - Scopes: `read:packages`, `write:packages` (`delete:packages` optional)
   - Add `repo` scope if images are private
3) Choose image names
   - `ghcr.io/eve-horizon/<project-slug>-<component>`
4) Store registry credentials in Eve secrets (org scope recommended)
   - `eve secrets set GHCR_USERNAME <github-username> --org <org-id>`
   - `eve secrets set GITHUB_TOKEN <token> --org <org-id>`
5) Local dev option (host env)
  - Add to `system-secrets.env.local`:
    - `GHCR_USERNAME=...`
    - `GITHUB_TOKEN=...`
  - Restart the API to load system secrets.

## Implementation checklist

- Manifest schema: add `registry`, `services.*.build`, `tests`, `pipelines`, and `environments.*.pipeline`.
- Sync: parse and persist registry + component metadata (or store parsed manifest in cache).
- Pipeline visibility: add `eve pipeline list|show|run` and store pipelines from manifest.
- Build service: worker builds per component using Docker/Buildx and pushes to registry, returning digests.
- Release flow: `eve env deploy` builds (if needed), stores digests, and deploys from digests.
- Post-deploy tests: include a `run` action referencing `tests.<name>.command`.
- Worker CLI: add `action` command handlers (`build`, `release`, `deploy`, `run`).

## Open questions

- Should `tests` be renamed to `commands` for broader use?
