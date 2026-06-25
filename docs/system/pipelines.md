# Pipelines

> Status: Current
> Last Updated: 2026-05-19
> Purpose: Document pipeline definitions, runs, and job-graph expansion.

## Current (Implemented)

### Definition (Manifest)

Pipelines are defined in `.eve/manifest.yaml` and consist of ordered steps. Each
step becomes a job when expanded by the pipeline expander. A legacy `actions`
list is still supported by the pipeline runner endpoint.

```yaml
pipelines:
  deploy-test:
    toolchains: [python]
    trigger:
      github:
        event: push
        branch: main
    steps:
      - name: build
        action:
          type: build
      - name: unit-tests
        toolchains: [python]
        script:
          run: "pnpm test"
          timeout: 1800
      - name: deploy
        depends_on: [build, unit-tests]
        action:
          type: deploy
```

### Step Types

- **action**: Built-in actions (`build`, `release`, `deploy`, `run`, `job`, `create-pr`, `notify`, `env-ensure`, `env-delete`)
- **script**: Shell command executed by the worker (`run` or `command` + `timeout`)
- **agent**: AI agent job (prompt-driven)
- **run**: Shorthand for `script.run`

Script steps and `action: { type: run }` commands execute durably in the
worker. The orchestrator submits the job with a short HTTP request and then
polls runner events for completion, while the worker streams stdout/stderr to
attempt logs. Script steps use the persisted `script_timeout_seconds`; action
run steps use `action.timeout_seconds` or `action.timeout` before falling back
to job hints.

Pipeline definitions and individual steps can declare `toolchains` with valid
values `python`, `media`, `rust`, `java`, and `kotlin`. Script, shorthand
`run`, agent, and `action: { type: run }` steps resolve `step.toolchains >
pipeline.toolchains > []` and persist the result on `jobs.hints.toolchains`.
Other action types cannot declare step-level toolchains. Do not nest
`toolchains` inside `action`; use the top-level step field.

Pipeline definitions and steps can also declare `env_overrides`. Today the
pipeline expander persists merged `env_overrides` only for `action: { type:
run }` jobs; step-level keys override pipeline-level defaults. The action-run
executor resolves `${secret.KEY}` placeholders immediately before launching
bash, strips Eve-reserved keys defensively, and leaves the persisted job row
unresolved for audit/debugging. Other action types are platform operations and
continue to ignore `env_overrides`.

Workflow step jobs may also declare `scope` blocks. These narrow the job token
and org filesystem mount for orgfs/orgdocs/envdb/cloud_fs resources. See
[workflows.md](./workflows.md#workflow-token-scope) for the scope grammar and
merge semantics.

### Job Graph Expansion

The pipeline expander converts steps into a job graph using job-based execution:

- Creates a pipeline run (`prun_xxx`)
- Creates one job per step
- Adds job dependencies for `depends_on`
- Sets `execution_type` to `action`, `script`, or `agent`
- All pipeline runs now execute via job-based engine for consistent execution

**Build Outputs:**
- Build actions create BuildSpecs + BuildRuns and emit `build_id` in step outputs
- BuildRuns produce BuildArtifacts (image digests) that releases reference as source of truth
- Release actions persist `build_id` and `image_digests_json` derived from artifacts
- Deploy actions reference images by digest for immutable deployments

See [builds.md](./builds.md) for the build primitive definitions and API/CLI details.

### API Endpoints

```
GET  /projects/{project_id}/pipelines
GET  /projects/{project_id}/pipelines/{name}

# Pipeline runs
POST /projects/{project_id}/pipelines/{name}/run
GET  /projects/{project_id}/pipelines/{name}/runs
GET  /projects/{project_id}/pipelines/{name}/runs/{run_id}
POST /pipeline-runs/{run_id}/approve
POST /pipeline-runs/{run_id}/cancel
GET  /pipeline-runs/{run_id}/stream
GET  /pipeline-runs/{run_id}/steps/{name}/stream

# Pipeline expander (job graph)
POST /projects/{project_id}/pipelines/{name}/runs
GET  /projects/{project_id}/runs/{run_id}
GET  /projects/{project_id}/runs/{run_id}/jobs
```

### CLI

```bash
eve pipeline list [project]
eve pipeline show <project> <name>
eve pipeline run <name> --ref <sha> [--env <env>] [--inputs <json>] [--repo-dir <path>]
eve pipeline runs [project] [--status <status>]
eve pipeline show-run <pipeline> <run-id>
eve pipeline approve <run-id>
eve pipeline cancel <run-id> [--reason <text>]
eve pipeline logs <pipeline> <run-id> [--step <name>]
```

Notes:
- Pipeline runs use the job-based engine by default.
- `eve pipeline run --only <step>` builds a job graph from `steps` and runs a subset.
- `--ref` must be a 40-character SHA, or a ref resolved against `--repo-dir`/cwd.

### Run Status & Cancellation

- Pipeline runs transition to `running` when child jobs start.
- A failed job marks the run as failed and cascades cancellation to dependents.
- Cancelled jobs are terminal and unblock downstream jobs.

## Environment Deploy as Pipeline Alias

When an environment has a `pipeline` configured in the manifest, `eve env deploy` becomes a pipeline alias that triggers a pipeline run instead of performing a direct deployment.

### Behavior

```bash
# If environments.test.pipeline is "deploy-test", this runs that pipeline:
eve env deploy test --ref 0123456789abcdef0123456789abcdef01234567

# Direct deploy (bypass pipeline):
eve env deploy test --ref 0123456789abcdef0123456789abcdef01234567 --direct
```

### Pipeline Inputs

Pipeline inputs can be specified in two ways:

1. **Manifest-level** via `environments.<env>.pipeline_inputs`:

```yaml
environments:
  staging:
    pipeline: deploy
    pipeline_inputs:
      smoke_test: true
      timeout: 1800
```

2. **CLI-level** via `--inputs` flag:

```bash
eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --inputs '{"release_id":"rel_xxx"}'
```

**Merge behavior:** CLI inputs override manifest inputs for matching keys.

### Promotion Flow

To promote the same release from test → staging → production:

```bash
# 1) Deploy to test (builds and creates release)
eve env deploy test --ref 0123456789abcdef0123456789abcdef01234567

# 2) Get release from test deployment
eve release resolve v1.2.3

# 3) Promote to staging using same release (no rebuild)
eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --inputs '{"release_id":"rel_xxx"}'

# 4) Promote to production (with approval gate)
eve env deploy production --ref 0123456789abcdef0123456789abcdef01234567 --inputs '{"release_id":"rel_xxx"}'
```

This pattern enables build-once, deploy-many promotion workflows without rebuilding images.

## Current (Trigger Execution)

Pipelines may define a `trigger` block in the manifest. The orchestrator event
router matches incoming events and creates pipeline runs when triggers match.

### GitHub Triggers

#### Pull Request Events

The `pull_request` event type allows triggering pipelines on PR lifecycle events with fine-grained filtering.

**Trigger schema:**

```yaml
trigger:
  github:
    event: pull_request          # Event type: "pull_request"
    action: <string|string[]>    # PR actions: opened, synchronize, reopened, closed
    base_branch: <string>        # Target branch pattern (supports wildcards)
```

**Supported Actions:**
- `opened` - PR is created
- `synchronize` - New commits pushed to PR
- `reopened` - Previously closed PR is reopened
- `closed` - PR is closed or merged

**Branch Patterns:**
Base branch filtering supports wildcard patterns:
- `main` - Exact match
- `release/*` - Suffix wildcard (matches `release/v1.0`, `release/v2.0`, etc.)
- `*-prod` - Prefix wildcard (matches `staging-prod`, `main-prod`, etc.)

#### Example: PR Preview Deployment

Deploy a preview environment when PR is opened or updated on main:

```yaml
pipelines:
  pr-preview:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize]
        base_branch: main
    steps:
      - name: create-preview-env
        action:
          type: env-ensure
          with:
            env_name: ${{ env.pr_${{ github.pull_request.number }} }}
            kind: preview
      - name: deploy
        depends_on: [create-preview-env]
        action:
          type: deploy
          with:
            env_name: ${{ env.pr_${{ github.pull_request.number }} }}
      - name: notify
        action:
          type: notify
          with:
            channel: pr
            message: "Preview deployed at https://preview-${{ github.pull_request.number }}.example.com"
```

#### Example: PR Cleanup on Close

Clean up preview environment when PR is closed:

```yaml
pipelines:
  pr-cleanup:
    trigger:
      github:
        event: pull_request
        action: closed
        base_branch: main
    steps:
      - name: cleanup-env
        action:
          type: env-delete
          with:
            env_name: ${{ env.pr_${{ github.pull_request.number }} }}
```

#### Example: Release Branch PRs Only

Trigger only for PRs to release branches:

```yaml
pipelines:
  release-pr-build:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: release/*
    steps:
      - name: build
        action:
          type: build
      - name: test
        script:
          run: "pnpm test"
          timeout: 1800
```

#### Example: Different Actions on Different Branches

Use separate pipelines for different base branch behaviors:

```yaml
pipelines:
  pr-main-build:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize]
        base_branch: main
    steps:
      - name: full-test
        action:
          type: build
      - name: e2e-test
        script:
          run: "pnpm test:e2e"
          timeout: 3600

  pr-develop-build:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize]
        base_branch: develop
    steps:
      - name: unit-test
        script:
          run: "pnpm test:unit"
          timeout: 1800
```

### Push Events

Pipelines can also trigger on repository pushes (commits):

```yaml
pipelines:
  deploy-main:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - name: deploy
        action:
          type: deploy
          with:
            env_name: production
```

Branch patterns in push triggers support the same wildcard matching as PR base branches.

## Pipeline Logs & Streaming

### Snapshot Logs

```bash
eve pipeline logs <pipeline> <run-id>                  # All step logs
eve pipeline logs <pipeline> <run-id> --step <name>    # Single step
```

Shows actual build/execution logs (not just metadata), with timestamps and step name prefixes.

### Live Streaming

```bash
eve pipeline logs <pipeline> <run-id> --follow         # Real-time SSE streaming
eve pipeline logs <pipeline> <run-id> --follow --step <name>  # Single step
```

Output format:
```
[14:23:07] [build] Cloning repository...
[14:23:09] [build] buildkit addr: tcp://buildkitd.eve.svc:1234
[14:23:15] [build] [api] #5 [dependencies 1/4] COPY pnpm-lock.yaml ...
[14:24:01] [deploy] Deployment started; waiting up to 180s
[14:24:12] [deploy] Deployment status: 1/1 ready
```

### Failure Hints

When a build step fails, the CLI automatically shows:
- The error type and classification
- An actionable hint (e.g., `Run 'eve build diagnose bld_xxx'`)
- The build ID for cross-referencing

### Pipeline-to-Build Linkage

Pipeline steps of type `build` create build specs and runs. On failure:
1. The pipeline step error includes the build ID
2. The CLI prints a hint to run `eve build diagnose <build_id>`
3. Build diagnosis shows the full buildkit output and failed stage

## Planned (Not Implemented)

- More robust step-level status propagation from job execution
- Pipeline graph visualization in the CLI/UI
