# Workflow Invocation

> Status: Current
> Last Updated: 2026-05-07
> Purpose: Define how manifest-defined workflows are invoked and executed.
> See also: [job-api.md](./job-api.md) and [manifest.md](./manifest.md)

## Current (Implemented)

- Workflows are defined in `.eve/manifest.yaml` under `workflows`.
- The API exposes list/show endpoints for workflow definitions.
- Invoking a workflow creates a **job** with workflow context in `hints`.
- Invocations can be fire-and-forget or wait for JSON results (60s timeout).
- Invocation `resource_refs` are inherited by every workflow step by default,
  including dependent steps. Workflows and individual steps can opt out or scope
  access with `resource_refs` in the manifest.
- Invocation `env_overrides` are merged with workflow-level and step-level
  manifest overrides before child step jobs are created.

## Workflow Invocation (API)

```
GET  /projects/{project_id}/workflows
GET  /projects/{project_id}/workflows/{name}
POST /projects/{project_id}/workflows/{name}/invoke?wait=true|false
```

### Request (summary)

```json
{
  "input": {
    "env": "staging",
    "ticket": "INC-1234"
  },
  "env_overrides": {
    "WEB_SEARCH_API_KEY": "${secret.WEB_SEARCH_API_KEY}"
  }
}
```

### Behavior

- A job is created with:
  - `labels`: `workflow:{name}`
  - `hints.workflow_name`: workflow name
  - `hints.request_json`: JSON-encoded input (if provided)
  - `hints.db_access`: `read_only` / `read_write` if present in workflow definition
  - `hints` merged from the workflow definition (e.g., `hints.gates`, timeouts)
- The root workflow job stores the full invocation `resource_refs` for audit.
- Each step job receives resource refs according to its effective policy:
  - default: `inherit` all invocation refs
  - workflow-level `resource_refs`: applies to every step unless overridden
  - step-level `resource_refs`: overrides workflow-level policy
- Each step job persists the merged `env_overrides` object:
  - workflow-level `env_overrides`: default for every step
  - step-level `env_overrides`: overrides or adds keys for that step
  - invocation request `env_overrides`: overrides both YAML layers
- The job runs through the standard lifecycle (ready → active → done/review).
- `wait=true` blocks (up to 60s) and returns `result_json` from the latest attempt.

### Resource Access Policy

Use `resource_refs` on the workflow or on a step:

```yaml
workflows:
  create-design:
    # Default is inherit; this field is optional.
    resource_refs: inherit
    steps:
      - name: read-sources
        agent: { name: designer }
      - name: publish-summary
        depends_on: [read-sources]
        resource_refs: none
        agent: { name: publisher }

  scoped-review:
    # Only refs whose name, label, mount_path, uri, or metadata.name matches.
    resource_refs: [brief, design-system]
    steps:
      - name: review
        agent: { name: reviewer }
```

Supported values:

| Value | Meaning |
|-------|---------|
| `inherit` / `all` | Pass all invocation refs to the step |
| `none` | Pass no invocation refs to the step |
| string array | Pass only refs matching one of the selectors |
| `{ mode: selected, include: [...] }` | Object form of selector scoping |

Invocation responses include `step_jobs[].resource_refs` metadata with the
effective mode, source (`default`, `workflow`, or `step`), selected count, and
any selectors. Step jobs also record the same policy in `hints` for inspection.

### Env Override Policy

Workflow env overrides use the same validation and runtime interpolation as
direct job `env_overrides`:

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

Effective precedence is invocation request > step YAML > workflow YAML. Values
may be literals or `${secret.KEY}` placeholders; unsupported `${env.X}` style
expressions and reserved Eve runtime variables are rejected. Missing referenced
secrets fail fast at runtime with `missing_secret_override`.

Request-supplied workflow overrides are privileged input: they require
`jobs:harness_override`, plus `secrets:read` when any value references
`${secret.KEY}`. Internal event-triggered workflow invocations do not accept
request-supplied overrides, but manifest-declared workflow and step overrides
still apply.

## CLI

```bash
eve workflow list [project]
eve workflow show <project> <name>
eve workflow run [project] <workflow-name> --input '{"k":"v"}' --env-override KEY=VALUE
eve workflow invoke [project] <workflow-name> --input '{"k":"v"}' --env-override KEY=VALUE
eve workflow retry <root-job-id> --failed
eve workflow retry <root-job-id> --from <step-name>
eve workflow logs <job-id>
eve harness validate --project <project> --workflow <workflow-name> --env-override KEY=VALUE
```

`eve harness validate --workflow` fetches the workflow definition, merges
workflow/step/invocation env overrides per step, and calls harness validation
for each step without creating jobs.

`workflow retry` is for terminal workflow roots where a transient failure
cancelled the tail of the step DAG. `--failed` clones failed and
upstream-failed current steps; `--from <step-name>` clones that step and its
downstream dependents. Successful predecessors stay in place, dependency edges
are rewired to the replacement jobs, and superseded step jobs remain visible in
the job tree/audit trail.

## Legacy / Removed

- Workflow IDs and workflow-only API paths (jobs remain the execution unit)
