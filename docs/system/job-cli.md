# Job CLI Reference

> Status: Current
> Last Updated: 2026-06-03

Complete reference for the Eve CLI job commands.

## Job Lifecycle

**Phases:** `idea` → `backlog` → `ready` → `active` → `review` → `done` (or `cancelled`)

Jobs default to the `ready` phase, making them immediately schedulable by the orchestrator.

## Command Reference

### Creating Jobs

```bash
eve job create --description "Fix the authentication bug in login.ts"

# With options
eve job create \
  --project proj_xxx \
  --description "Add dark mode support" \
  --priority 1 \
  --phase backlog \
  --labels ui,feature

# Create sub-jobs (hierarchical)
eve job create --parent myproj-a3f2dd12 --description "Implement color tokens"

# Create with resource refs
eve job create \
  --project proj_xxx \
  --description "Review approved plan" \
  --resource-refs='[{"uri":"org_docs:/pm/features/FEAT-123.md@v3","label":"Plan","mount_path":"pm/plan.md"}]'

# Create with app API awareness
eve job create \
  --description "Triage intake item" \
  --with-apis coordinator,analytics

# Job token resource scope is resolved from workflow scope blocks.
# There is no eve job create --scope-* or eve workflow run --scope-* flag yet.

# Create with git controls
eve job create \
  --description "Fix checkout bug" \
  --git-ref main \
  --git-branch job/fix-checkout \
  --git-create-branch if_missing \
  --git-commit auto \
  --git-push on_success
```

**Full options:**
```
eve job create    --project=X --description="..." [--title="..."] [--parent=X]
                  [--type=task] [--priority=0-4] [--phase=ready] [--review=none|human|agent]
                  [--labels=a,b,c] [--assignee=X] [--defer-until=ISO] [--due-at=ISO]
                  [--harness=X] [--profile=X] [--variant=X] [--model=X] [--reasoning=X]
                  [--worker-type=X] [--permission=X] [--timeout=N]
                  [--resource-class=X] [--max-cost=N] [--max-cost-currency=usd] [--max-tokens=N]   # hints
                  [--env=X] [--execution-mode=persistent|ephemeral]
                  [--git-ref=X] [--git-ref-policy=auto|env|project_default|explicit]
                  [--git-branch=X] [--git-create-branch=never|if_missing|always]
                  [--git-commit=never|manual|auto|required] [--git-commit-message=X]
                  [--git-push=never|on_success|required] [--git-remote=origin]
                  [--workspace-mode=job|session|isolated] [--workspace-key=X]
                  [--resource-refs=<json>] [--with-apis=<names>]
                  [--claim] [--agent=X]                                           # inline exec
```

### Listing and Viewing Jobs

```bash
eve job list                              # All jobs in default project
eve job list --project proj_xxx           # All jobs in specific project
eve job list --phase active               # Filter by phase
eve job list --since 1h --stuck           # Stuck jobs created in last hour
eve job list --all --org org_xxx          # Admin: all jobs across projects
eve job ready                             # Schedulable jobs (phase=ready, not blocked)
eve job blocked                           # Jobs waiting on dependencies
eve job show myproj-a3f2dd12              # Full details
eve job current                           # Current job from EVE_JOB_ID
eve job tree myproj-a3f2dd12              # Hierarchical view
eve job diagnose myproj-a3f2dd12          # Debug details + latest attempt
```

**Full options:**
```
eve job list      --project=X [--phase=X] [--assignee=X] [--priority=X]
                  [--since=1h] [--stuck] [--stuck-minutes=5]
                  [--limit=50] [--offset=0]
eve job list      --all [--org=X] [--project=X] [--phase=X] [--limit=50] [--offset=0]
eve job ready     --project=X [--limit=10]
eve job blocked   --project=X
eve job show      <job-id>
eve job current   [<job-id>] [--tree]
eve job tree      <job-id>
eve job diagnose  <job-id>
```

`eve job diagnose` renders `result_json.error_code` when present. Current
classified runtime codes include `toolchain_unavailable`,
`attempt_init_timeout`, `attempt_startup_timeout`, `attempt_timeout`, and
`attempt_stale`. For toolchain-backed jobs, diagnose also renders
`runtime_meta.toolchains` with requested, resolved, missing, execution mode, and
source.

### Updating Jobs

```bash
eve job update myproj-a3f2dd12 --phase active
eve job update myproj-a3f2dd12 --priority 0 --assignee agent-123
eve job update myproj-a3f2dd12 --title "New title" --labels bug,urgent
```

**Full options:**
```
eve job update    <job-id> [--phase=X] [--priority=X] [--assignee=X] [--title=X]
                  [--description=X] [--labels=X] [--defer-until=X] [--due-at=X] [--review=X]
                  [--git-ref=X] [--git-ref-policy=auto|env|project_default|explicit]
                  [--git-branch=X] [--git-create-branch=never|if_missing|always]
                  [--git-commit=never|manual|auto|required] [--git-commit-message=X]
                  [--git-push=never|on_success|required] [--git-remote=origin]
                  [--workspace-mode=job|session|isolated] [--workspace-key=X]
```

### Completing Jobs

```bash
eve job close myproj-a3f2dd12 --reason "Work completed"
eve job cancel myproj-a3f2dd12 --reason "No longer needed"
```

### Monitoring Execution

```bash
eve job follow myproj-a3f2dd12           # Stream logs in real-time (SSE)
eve job wait myproj-a3f2dd12             # Wait for completion (default: 300s)
eve job wait myproj-a3f2dd12 --timeout 60 --json
eve job watch myproj-a3f2dd12            # Combine status polling + log streaming
eve job result myproj-a3f2dd12           # Get job result
eve job result myproj-a3f2dd12 --format text --attempt 2
eve job receipt myproj-a3f2dd12          # Execution receipt + cost breakdown
eve job compare myproj-a3f2dd12 1 2      # Compare attempt receipts
eve job runner-logs myproj-a3f2dd12      # Stream runner pod logs (kubectl)
```

**Notes:**
- `runner-logs` shells out to `kubectl` and only works when you have cluster access.
- `job follow` shows live cost totals when `llm.call` events are emitted by the harness.
- `job diagnose` renders `result_json.error_code` for classified failures such
  as `toolchain_unavailable`, `attempt_init_timeout`, and
  `attempt_startup_timeout`, plus `runtime_meta.toolchains` for declared
  toolchains.

### Attachments

Jobs can store named attachments (metadata + content) for artifacts and summaries.

```bash
eve job attach myproj-a3f2dd12 --name result.json --content '{"ok":true}'
eve job attachments myproj-a3f2dd12           # List attachment metadata
eve job attachment myproj-a3f2dd12 result.json --out ./result.json
```

**Full options:**
```
eve job attach        <job-id> --name <name> [--content <text>] [--file <path>] [--content-type <type>]
eve job attachments   <job-id>
eve job attachment    <job-id> <name-or-id> [--out <path>]
```

### Batch Jobs (Graph Execution)

Create a batch job graph from a JSON spec, then validate it before execution:

```bash
eve job batch --project proj_xxx --file ./job-graph.json
eve job batch-validate --file ./job-graph.json
```

**Notes:**
- `batch` posts the JSON to `/projects/{project_id}/jobs/batch` and returns
  a `batch_id` plus the created job IDs.
- `batch-validate` checks the JSON without creating jobs.

### Coordination and Supervision

Lead agents can supervise child events and inspect coordination threads created
for team dispatches.

```bash
# Long-poll child events (lead agent coordination)
eve supervise
eve supervise myproj-a3f2dd12 --timeout 60

# Inspect coordination thread messages
eve thread messages thr_xxx --since 10m
eve thread post thr_xxx --body '{"kind":"directive","body":"focus on auth"}'
eve thread follow thr_xxx
```

See [Threads](./threads.md) for coordination thread details.

### Providers + Models

Use these commands to inspect the provider registry:

```bash
eve providers list
eve providers show openai
eve providers models openrouter
```

### Analytics

Org-wide summaries and health snapshots:

```bash
eve analytics summary --org org_xxx
eve analytics jobs --org org_xxx --window 7d
eve analytics pipelines --org org_xxx --window 30d
eve analytics env-health --org org_xxx
```

### Webhooks

Manage webhook subscriptions and replays:

```bash
eve webhooks list --org org_xxx
eve webhooks create --org org_xxx --url https://example.com/hook --events job.completed,job.failed --secret <secret>
eve webhooks deliveries wh_xxx --org org_xxx --limit 50
eve webhooks replay wh_xxx --org org_xxx --from-event evt_xxx --dry-run
```

### Claim/Release Workflow (for agents)

```bash
eve job claim myproj-a3f2dd12 --agent my-agent --harness mclaude
eve job release myproj-a3f2dd12 --reason "Need more info"
eve job attempts myproj-a3f2dd12         # View execution history
eve job logs myproj-a3f2dd12 --attempt 2 # View attempt logs
```

**Full options:**
```
eve job claim     <job-id> [--agent=X] [--harness=X]
eve job release   <job-id> [--agent=X] [--reason="..."]
eve job attempts  <job-id>
eve job logs      <job-id> [--attempt=N] [--after=N]
```

### Review Workflow

```bash
eve job submit myproj-a3f2dd12 --summary "Implemented fix, added tests"
eve job approve myproj-a3f2dd12 --comment "LGTM"
eve job reject myproj-a3f2dd12 --reason "Missing tests"
```

### Job Dependencies

```bash
# Add dependency: myproj-a3f2dd12 depends on myproj-b4c3ee56
eve job dep add myproj-a3f2dd12 myproj-b4c3ee56

# Remove dependency
eve job dep remove myproj-a3f2dd12 myproj-b4c3ee56

# List dependencies
eve job dep list myproj-a3f2dd12
```

## Harness Selection

Jobs can target a harness directly or via a project profile (from `x-eve.agents`).

```bash
eve job create --description "Investigate flaky test" \
  --harness mclaude \
  --model opus-4.5 \
  --reasoning high

eve job create --description "Deep review" \
  --profile primary-reviewer \
  --reasoning x-high
```

| Field | Description |
|------|-------------|
| `--harness` | Preferred harness name (e.g., `mclaude`, `codex`) |
| `--profile` | Harness profile name from `x-eve.agents` |
| `--variant` | Harness variant preset (config overlay) |
| `--model` | Model override for the selected harness |
| `--reasoning` | Reasoning effort: `low`, `medium`, `high`, `x-high` |

## Scheduling Hints

Jobs can include optional hints that the scheduler uses when claiming:

```bash
eve job create --description "Heavy computation task" \
  --worker-type gpu \
  --permission auto_edit \
  --timeout 7200
```

| Hint | Description |
|------|-------------|
| `--worker-type` | Worker type preference (e.g., `default`, `gpu`) |
| `--permission` | Permission policy: `default`, `auto_edit`, `yolo` |
| `--timeout` | Execution timeout in seconds |
| `--resource-class` | Compute SKU for runner sizing + compute accounting |
| `--max-cost` | Budget cap (numeric). Use `--max-cost-currency` to override (default `usd`) |
| `--max-tokens` | Budget cap in total tokens (integer) |

Hints are preferences, not requirements - the scheduler may override based on availability.

## Agent Context (Sub-Jobs)

When an agent is executing a job, it can create sub-jobs using context from environment variables:

```bash
# Create a sub-job under the current job
eve job create --parent $EVE_JOB_ID --description "Implement feature X"

# Create and immediately claim (inline execution)
eve job create --parent $EVE_JOB_ID --description "Quick sub-task" --claim
```

**Environment variables** injected by the worker:
- `EVE_PROJECT_ID` - Current project ID
- `EVE_JOB_ID` - Current job being executed
- `EVE_ATTEMPT_ID` - Current attempt UUID
- `EVE_AGENT_ID` - Agent identifier

## Profile Shortcuts

Set defaults to avoid repeating `--org` and `--project`:

```bash
# Set defaults
eve profile set --org org_MyCompany --project proj_abc123

# View current profile
eve profile show

# Now these work without specifying org/project:
eve job create --description "Fix the bug"
eve job list
eve job ready
```

**Tip:** Job IDs use the project slug (e.g., `EveH-a3f2dd12`), making them easy to read and share.

## Related Commands (Events, Pipelines, Workflows)

```bash
# Events
eve event list [project]
eve event show <event_id>
eve event emit --type=<type> --source=<source> [--payload <json>]

# Pipelines
eve pipeline list [project]
eve pipeline run <name> --ref <sha> [--env <env>] [--inputs <json>]
eve pipeline runs [project]
eve pipeline show-run <pipeline> <run-id>

# Workflows
eve workflow list [project]
eve workflow run [project] <workflow-name> --input '{"k":"v"}' --env-override KEY=VALUE
eve workflow invoke [project] <workflow-name> --input '{"k":"v"}' --env-override KEY=VALUE
eve workflow retry <root-job-id> --failed
eve workflow retry <root-job-id> --from <step-name>
eve workflow logs <job-id>

# Harness preflight
eve harness validate --project <project> --workflow <workflow-name> --env-override KEY=VALUE

# Environment Deploy
eve env deploy <env> --ref <sha> [--inputs <json>] [--direct]
eve env diagnose <project> <env> [--events <n>]
eve env show <project> <env>

# Release Management
eve release resolve <tag> [--project <id>]

# Manifest Validation
eve manifest validate [--project <id>] [--path <path>] [--latest]
```

## Environment Deploy and Promotion

`eve env deploy` runs the environment's configured pipeline when `environments.<env>.pipeline` is set in the manifest. The `--ref` flag is required.

`--ref` must be a 40-character SHA, or a ref that can be resolved against the repo in `--repo-dir` or the current working directory.

`eve env show` now includes deployment health summary. Use `eve env diagnose` for a fuller k8s view (deployments, pods, and recent events) without kubectl.

### Basic Deploy

```bash
# Deploy to test environment (runs pipeline from manifest)
eve env deploy test --ref 0123456789abcdef0123456789abcdef01234567

# Direct deploy (bypass pipeline)
eve env deploy test --ref 0123456789abcdef0123456789abcdef01234567 --direct

# Skip watch/polling
eve env deploy test --ref 0123456789abcdef0123456789abcdef01234567 --watch=false
```

### Promotion Flow

To promote the same release across environments without rebuilding:

```bash
# 1) Deploy to test (build + test + release)
eve env deploy test --ref 0123456789abcdef0123456789abcdef01234567

# 2) Resolve the release created in test
eve release resolve v1.2.3 --project proj_xxx

# Output:
# release_id: rel_xxx
# git_sha: 0123456789abcdef0123456789abcdef01234567
# tag: v1.2.3

# 3) Promote to staging using the same release
eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --inputs '{"release_id":"rel_xxx"}'

# 4) Promote to production (requires approval if configured)
eve env deploy production --ref 0123456789abcdef0123456789abcdef01234567 --inputs '{"release_id":"rel_xxx"}'
```

### Pipeline Inputs

Pipeline inputs can come from:

1. **Manifest** (`environments.<env>.pipeline_inputs`)
2. **CLI** (`--inputs` flag)

CLI inputs override manifest inputs for matching keys.

Example manifest:

```yaml
environments:
  staging:
    pipeline: deploy
    pipeline_inputs:
      smoke_test: true
      timeout: 1800
```

CLI override:

```bash
eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --inputs '{"smoke_test":false}'
```
