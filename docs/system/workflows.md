# Workflows

> Status: Current
> Last Updated: 2026-05-19
> Purpose: Describe manifest-defined workflows, multi-step job DAG expansion, and the event-driven model.

## Overview

Workflows are defined in `.eve/manifest.yaml` and compile to a **job DAG** at
invocation time. A single workflow invocation produces one root container job
plus one child job per step. Dependencies between steps are expressed via
`depends_on` and wired through the job relation system (`blocks` type), so the
scheduler automatically respects ordering.

## Definition (Manifest)

```yaml
workflows:
  ingestion-pipeline:
    with_apis:
      - coordinator
    steps:
      - name: prepare
        script:
          run: "eve job list --json"
          timeout_seconds: 60
      - name: ingest
        depends_on: [prepare]
        agent:
          name: ingestion
      - name: extract
        depends_on: [ingest]
        agent:
          name: extraction
      - name: review
        depends_on: [extract]
        agent:
          name: reviewer
```

### Workflow Files

Large workflows can live in repo-local files and be referenced from the
manifest. The recommended layout is one directory per workflow:

```text
.eve/workflows/
  acme-make-plan/
    workflow.yaml
    prompts/
      plan.md
      review.md
```

Reference the workflow directory from `.eve/manifest.yaml`:

```yaml
workflows:
  acme-make-plan:
    $ref: .eve/workflows/acme-make-plan
```

When `$ref` points to a directory, `eve project sync` and
`eve manifest validate` load `<directory>/workflow.yaml` (or
`workflow.yml`). `$ref` may also point directly to a `.yaml` or `.yml` file.
References are resolved by the CLI before manifest sync; the API stores only
the expanded workflow definition and rejects unresolved `$ref` values.

Workflow files can keep long prompts in Markdown files with `agent.prompt_file`:

```yaml
# .eve/workflows/acme-make-plan/workflow.yaml
description: Plan -> review -> publish.
steps:
  - name: plan
    agent:
      name: acme-planner
      prompt_file: prompts/plan.md
```

Prompt files are read verbatim and expanded into `agent.prompt` during sync.
`prompt_file` paths are resolved relative to the workflow file directory and
must stay inside the repository.

### Step Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique name within the workflow |
| `agent` / `script` / `run` | Yes | Exactly one execution kind. `agent` creates an agent job. `script` or shorthand `run` creates a worker-executed script job with `script_command` and optional `script_timeout_seconds`; the worker executes it asynchronously and streams output to attempt logs |
| `depends_on` | No | List of step names that must complete before this step runs |
| `git` | No | Job git controls for this step (`ref`, `ref_policy`, `branch`, `create_branch`, `commit`, `push`, `remote`) |
| `resource_refs` | No | Step resource policy: `inherit`, `none`, or selected resource names/labels. Overrides workflow-level policy |
| `env_overrides` | No | Secret-backed or literal environment overrides for this step job. Merged over workflow-level defaults |
| `toolchains` | No | Valid toolchain names (`python`, `media`, `rust`, `java`, `kotlin`). Valid on `agent`, `script`, and shorthand `run` steps |

### Workflow-Level Fields

| Field | Description |
|-------|-------------|
| `with_apis` | App APIs available to all steps (see [agent-app-api-access.md](./agent-app-api-access.md)) |
| `git` | Default job git controls inherited by steps unless overridden |
| `resource_refs` | Default invocation resource policy for steps (`inherit` by default, `none`, or selected refs) |
| `env_overrides` | Default environment overrides applied to every step job |
| `toolchains` | Default toolchains for steps that do not declare their own. Agent steps use this only when neither the step nor the agent config declares toolchains |
| `db_access` | Database access level (`read_only` / `read_write`) |
| `hints` | Merged into the root job at invocation time (gates, timeouts, harness prefs) |
| `trigger` | Event trigger for automatic invocation |

## Multi-Step Job DAG Expansion

When a workflow is invoked, the API compiles it into a job tree:

1. A **root container job** is created with workflow metadata in `hints`
2. One **child job per step** is created as a child of the root
3. `depends_on` references are wired as `blocks`-type job relations
4. The scheduler moves child jobs to `ready` only when all blockers are `done`

### Job Tree

```
[*] proj-abc12345 [Workflow] ingestion-pipeline
 |- [-] proj-abc12345.1 [ingestion-pipeline] ingest
 |- [-] proj-abc12345.2 [ingestion-pipeline] extract
 |- [-] proj-abc12345.3 [ingestion-pipeline] review
```

### Response

The invocation response includes `step_jobs` mapping step names to child job IDs:

```json
{
  "job_id": "proj-abc12345",
  "status": "active",
  "step_jobs": [
    { "job_id": "proj-abc12345.1", "step_name": "ingest" },
    { "job_id": "proj-abc12345.2", "step_name": "extract", "depends_on": ["ingest"] },
    { "job_id": "proj-abc12345.3", "step_name": "review", "depends_on": ["extract"] }
  ]
}
```

### Per-Step Resolution

Each step resolves its own execution context independently:

- **Agent**: resolved from the project's agent registry by name
- **Script**: `script.run`, `script.command`, or top-level `run` becomes a
  child job with `execution_type: script`. Script steps skip harness and
  assignee resolution, preserve `permissions`/`scope`, and are dispatched to
  the worker script executor. The worker accepts the dispatch quickly, runs the
  bash command in the background, streams stdout/stderr into execution logs, and
  emits runner events when the command finishes. `script.timeout` /
  `script.timeout_seconds` is the command timeout, so long-running scripts can
  cross ingress/request timeout boundaries without failing the parent workflow
  step.
- **Harness**: step-level `harness` overrides the agent's default
- **Harness profile**: step-level `harness_profile` overrides the agent's default
- **Toolchains**: valid values are `python`, `media`, `rust`, `java`, and
  `kotlin`. Script and shorthand `run` steps resolve `step.toolchains >
  workflow.toolchains > []`. Agent steps resolve `step.toolchains > agent
  config toolchains > workflow.toolchains > []`. Resolved toolchains are
  persisted on the child job as `hints.toolchains`. Empty arrays behave like
  omission. Workflow `action` steps remain unsupported and cannot declare
  toolchains. Worker script/run jobs and inline agent-runtime jobs provision
  declared toolchains before launching the shell or harness. If provisioning
  fails, the attempt fails with `result_json.error_code =
  "toolchain_unavailable"`.
- **Resource refs**: invocation refs are inherited by every step by default,
  including dependent steps. Workflow-level `resource_refs` sets a default
  policy for all steps; step-level `resource_refs` overrides it. Use `none` to
  opt out, or a selector array to pass only refs whose `name`, `label`,
  `mount_path`, `uri`, or `metadata.name` matches.
- **Env overrides**: workflow-level, step-level, and invocation-level
  `env_overrides` are merged by key for each executable step job. Invocation
  request overrides win, then step-level overrides, then workflow defaults.
  `${secret.KEY}` placeholders are resolved only inside the worker or
  agent-runtime before launching the harness or script shell. Workflow `script`
  and shorthand `run` steps receive the resolved values as bash environment
  variables, the same way agent steps receive them in the harness env.
- **Token scope**: workflow-level, step-level, and invocation-level `scope`
  blocks are intersected for each executable step job and persisted as
  `jobs.token_scope`. The orchestrator uses that same scope for the `.org`
  mount and the minted job token.
- **Git controls**: workflow-level `git` is inherited, step-level `git` overrides
  individual fields, and string fields such as `ref`, `branch`, and
  `commit_message` can reference workflow inputs with `${inputs.name}` or event
  payload fields with `${event.payload.path}`

### Resource Ref Access

```yaml
workflows:
  create-design:
    resource_refs: inherit  # optional default
    steps:
      - name: read-sources
        agent: { name: designer }
      - name: publish
        depends_on: [read-sources]
        resource_refs: none
        agent: { name: publisher }

  scoped-design:
    resource_refs: [brief, design-system]
    steps:
      - name: review
        agent: { name: reviewer }
```

The root workflow job records the full invocation resource list for audit.
Every child step receives the effective subset, and `step_jobs[].resource_refs`
reports the mode, source, selector list, and selected count.

### Env Overrides

Use workflow `env_overrides` for defaults that every step needs and step
`env_overrides` for narrower secrets:

```yaml
workflows:
  research:
    env_overrides:
      WEB_SEARCH_API_KEY: ${secret.WEB_SEARCH_API_KEY}
    steps:
      - name: search
        agent: { name: researcher }
      - name: publish
        depends_on: [search]
        env_overrides:
          PUBLISH_API_KEY: ${secret.PUBLISH_API_KEY}
        agent: { name: publisher }
```

Callers can add or override keys per invocation:

```bash
eve workflow run research --env-override WEB_SEARCH_API_KEY='${secret.WEB_SEARCH_API_KEY}'
eve workflow invoke research --env-override MODE=diagnostic
```

Request-supplied overrides require `jobs:harness_override`, and `${secret.KEY}`
placeholders also require `secrets:read`. Manifest-declared workflow overrides
are validated during manifest parse/sync and are applied to internal
event-triggered workflows as well.

### Workflow Token Scope

Use workflow or step `scope` to narrow a step job's API authority and org
filesystem mount:

```yaml
workflows:
  scoped-review:
    scope:
      orgfs:
        allow_prefixes: [/groups/projects/proj-a/**]
    steps:
      - name: review
        agent: { name: reviewer }
        scope:
          cloud_fs:
            allow_mount_ids: [mount_a]
```

Supported axes match access binding scopes: `orgfs`, `orgdocs`, `envdb`, and
`cloud_fs`. Workflow, step, and invocation scopes are intersected; empty
intersections fail closed. Request-supplied scope requires `jobs:harness_override`.
The CLI does not expose `--scope-*` flags yet.

## Validation

`eve manifest validate` checks workflow graphs at sync time:

| Check | Error |
|-------|-------|
| Duplicate step names | `Duplicate step name '{name}' in workflow '{workflow}'` |
| Missing or ambiguous execution kind | `Workflow step must define exactly one of action, script, agent, or run` |
| Cyclic dependencies | `Cycle detected in workflow '{workflow}': {step_a} -> {step_b} -> ... -> {step_a}` |
| Invalid `depends_on` references | `Step '{name}' depends on unknown step '{ref}' in workflow '{workflow}'` |
| Invalid `env_overrides` | Uses job `env_overrides` validation: uppercase keys, no reserved runtime env vars, only `${secret.KEY}` expressions, and 4 KB merged payload limit |
| Invalid `scope` | Uses access binding scope validation: arrays for path prefixes, env DB identifiers, and Cloud FS mount ids |

## Invocation

Invoking a workflow creates the job DAG. See
[workflow-invocation.md](./workflow-invocation.md) for API endpoints, CLI
commands, and `wait` behavior.

```bash
eve workflow run myproject ingestion-pipeline --input '{"source": "s3://bucket/data"}'
eve harness validate --project myproject --workflow ingestion-pipeline
```

If a terminal workflow failed after successful predecessor steps, retry only the
tail instead of invoking the whole workflow again:

```bash
eve workflow retry <root-job-id> --failed
eve workflow retry <root-job-id> --from review
```

Retry creates fresh replacement child jobs, marks the replaced current steps as
superseded in their hints, preserves the original materialized inputs/git
controls/resource refs, and rewires dependencies so downstream prior-step
result injection reads from the replacement attempts.

## Non-Chat Notifications

Workflow steps that need to notify a Slack channel should use the first-class
notifications API instead of reading integrations or handling raw Slack tokens:

```bash
eve notifications send \
  --project <project_id_or_slug> \
  --channel eve-horizon-notifications \
  --message "Plan published: https://github.com/org/repo/pull/123"
```

The command requires `notifications:send`. Grant it only to the publishing agent
or service that needs outbound notifications:

```yaml
agents:
  publisher:
    access:
      permissions:
        - notifications:send
```

Eve resolves the org Slack integration server-side and posts to Slack without
exposing the bot token in the job environment. See
[integrations.md](./integrations.md#channel-notifications-for-non-chat-workflows).

## Workflow Hints

Workflow definitions may include a `hints` block. These hints are merged into
the root job at invocation time (API, CLI, or event triggers). Use this for
remediation gates, timeouts, or harness preferences.

```yaml
workflows:
  fix-ci-failure:
    hints:
      gates: ["remediate:proj_abc123:staging"]
```

## Triggers (Manifest)

Workflows may include a `trigger` block. The orchestrator matches triggers and
creates workflow jobs when events match.

```yaml
workflows:
  nightly-audit:
    trigger:
      github:
        event: pull_request
        branch: main
```

## Planned (Not Implemented)

- Request/response schema validation
- Skill-based workflows (OpenSkills with workflow metadata). See `docs/system/skills-workflows.md`.
