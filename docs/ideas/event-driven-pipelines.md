# Event-Driven Pipeline Architecture

> Status: Superseded by `docs/plans/event-driven-pipelines-platform-plan.md`
> Last Updated: 2026-01-22

## Summary

Note: The current direction is pipelines as job graphs (no separate pipeline runner or step-run tables).
See `docs/plans/event-driven-pipelines-platform-plan.md` for the authoritative plan.

Unify triggers, pipelines, and jobs into a coherent event-driven architecture where:

1. **Triggers** produce events (GitHub webhook, schedule, manual)
2. **Pipelines** are templates that expand into job graphs
3. **Jobs** are the universal execution unit (both deterministic and agent)
4. **Events** connect everything and enable observability

The key insight: **a pipeline is a job graph template**. We already have job orchestration with dependencies and gating. Pipelines just need to create linked jobs when triggered.

## Goals

- GitHub integration (webhook + poll) triggers CI/CD flows
- Deterministic pipelines for standard deploy flows
- Agent steps fit naturally alongside deterministic steps
- Event-based architecture enables observability and extensibility
- Reuse existing job orchestration (no parallel execution engine)

## Non-Goals

- Replacing the existing job model
- Complex DAG execution engine (jobs already handle this)
- Real-time streaming pipelines (this is CI/CD, not data pipelines)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              EVENT BUS                                  │
│  (trigger.received, step.started, step.completed, pipeline.completed)   │
└─────────────────────────────────────────────────────────────────────────┘
        ▲                    │                    │                    │
        │                    ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   Triggers    │   │   Pipeline    │   │ Notifications │   │   Audit Log   │
│               │   │   Service     │   │   (Slack)     │   │               │
│ - GitHub      │   │               │   └───────────────┘   └───────────────┘
│ - Schedule    │   │ Template →    │
│ - Manual      │   │ Job Graph     │
└───────────────┘   └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │  Job Graph    │
                    │  (existing    │
                    │  orchestrator)│
                    └───────────────┘
```

## Pipeline Definition

Pipelines are defined in `.eve/manifest.yaml` or `.eve/pipelines/*.yaml`:

```yaml
# .eve/pipelines/deploy-to-prod.yaml
name: deploy-to-prod
description: Full deployment pipeline with testing gates

trigger:
  - github:
      event: push
      branch: main
  - manual: true

steps:
  # Deterministic steps
  - id: build
    type: script
    run: pnpm build

  - id: deploy-test
    type: deploy
    env: test
    needs: [build]

  - id: integration-tests
    type: script
    run: pnpm test:integration
    env: test
    needs: [deploy-test]
    on_failure: [investigate-failure]

  - id: deploy-staging
    type: deploy
    env: staging
    needs: [integration-tests]

  - id: e2e-tests
    type: script
    run: pnpm test:e2e
    env: staging
    needs: [deploy-staging]

  - id: notify-ready
    type: notify
    channel: slack
    message: "Ready for production deployment"
    needs: [e2e-tests]

  - id: deploy-prod
    type: deploy
    env: production
    needs: [e2e-tests]
    approval: manual

  - id: smoke-tests
    type: script
    run: pnpm test:smoke
    env: production
    needs: [deploy-prod]
    on_failure: [investigate-failure, auto-rollback]

  # Agent steps
  - id: investigate-failure
    type: agent
    prompt: |
      Tests failed. Analyze the output and identify root cause.
      Use `eve job logs` to get test output.
      Suggest fixes or workarounds.
    triggered_by: on_failure  # Only runs when triggered

  - id: security-review
    type: agent
    prompt: |
      Review the changes being deployed for security issues.
      Check for: exposed secrets, injection vulnerabilities,
      insecure configurations, OWASP top 10.
    parallel_with: [deploy-staging]  # Advisory, doesn't block

  - id: auto-rollback
    type: script
    run: eve env rollback production
    triggered_by: on_failure
```

## Step Types

### Deterministic Steps (No LLM)

Executed by the worker directly. Predictable, fast, auditable.

| Type | Description | Key Fields |
|------|-------------|------------|
| `script` | Run a shell command | `run`, `env`, `timeout` |
| `deploy` | Deploy to environment | `env`, `approval` |
| `build` | Build artifacts | `dockerfile`, `tags` |
| `notify` | Send notification | `channel`, `message` |

### Agent Steps (LLM-Driven)

Executed by the agent harness. Flexible, reasoning-capable, can use tools.

| Type | Description | Key Fields |
|------|-------------|------------|
| `agent` | Run agent with prompt | `prompt`, `skills`, `timeout` |

## Job API Changes

### New Fields on Job

```typescript
interface CreateJobRequest {
  // Existing fields...
  description: string;
  hints?: JobHints;

  // New fields for pipeline integration
  execution_type?: 'agent' | 'script';  // Default: 'agent'
  script?: {
    run: string;                         // Shell command
    working_dir?: string;                // Defaults to repo root
    timeout_seconds?: number;            // Default: 300
  };

  // Pipeline context (set by pipeline service)
  pipeline_run_id?: string;              // Links job to pipeline run
  pipeline_step_id?: string;             // Which step this job represents

  // Conditional execution
  triggered_by?: 'normal' | 'on_failure' | 'on_success';
  trigger_source_job_id?: string;        // Which job's outcome triggered this
}
```

### execution_type Field

```typescript
type ExecutionType = 'agent' | 'script';
```

**`agent`** (default, current behavior):
- Job claimed by orchestrator
- Worker spawns agent harness (Claude Code)
- Agent executes using description as prompt
- Can use tools, make decisions, handle ambiguity
- Results captured as conversation + artifacts

**`script`** (new):
- Job claimed by orchestrator
- Worker executes `script.run` directly (no LLM)
- Deterministic execution
- Results captured as stdout/stderr + exit code
- Much faster and cheaper than agent execution

### Example: Agent Job

```json
{
  "description": "Investigate why integration tests are failing. Check test logs, identify root cause, suggest fixes.",
  "execution_type": "agent",
  "hints": {
    "harness": "claude-code",
    "timeout_seconds": 600
  },
  "pipeline_run_id": "run_abc123",
  "pipeline_step_id": "investigate-failure",
  "triggered_by": "on_failure",
  "trigger_source_job_id": "myproj-def456"
}
```

### Example: Script Job

```json
{
  "description": "Run integration tests",
  "execution_type": "script",
  "script": {
    "run": "pnpm test:integration",
    "timeout_seconds": 300
  },
  "env_name": "test",
  "pipeline_run_id": "run_abc123",
  "pipeline_step_id": "integration-tests"
}
```

## Pipeline Expansion to Job Graph

When a pipeline is triggered, the pipeline service creates a job graph:

### Input: Pipeline Trigger

```json
{
  "pipeline": "deploy-to-prod",
  "project_id": "proj_abc123",
  "trigger": {
    "type": "github",
    "event": "push",
    "ref": "refs/heads/main",
    "sha": "a1b2c3d4"
  }
}
```

### Output: Job Graph

```
Pipeline Run: run_xyz789
├── Job: myproj-001 (build)           [execution_type: script]
├── Job: myproj-002 (deploy-test)     [execution_type: script, blocked_by: 001]
├── Job: myproj-003 (integration)     [execution_type: script, blocked_by: 002]
├── Job: myproj-004 (deploy-staging)  [execution_type: script, blocked_by: 003]
├── Job: myproj-005 (security-review) [execution_type: agent,  parallel with 004]
├── Job: myproj-006 (e2e-tests)       [execution_type: script, blocked_by: 004]
├── Job: myproj-007 (notify-ready)    [execution_type: script, blocked_by: 006]
├── Job: myproj-008 (deploy-prod)     [execution_type: script, blocked_by: 006, approval: manual]
├── Job: myproj-009 (smoke-tests)     [execution_type: script, blocked_by: 008]
│
│  Conditional (created but dormant):
├── Job: myproj-010 (investigate)     [execution_type: agent,  triggered_by: on_failure]
└── Job: myproj-011 (auto-rollback)   [execution_type: script, triggered_by: on_failure]
```

The orchestrator handles this like any other job graph. No special pipeline execution engine needed.

## Conditional Steps

### triggered_by: on_failure

Steps with `triggered_by: on_failure` are created as jobs but remain in `backlog` phase until their trigger source fails.

```typescript
// When job myproj-003 (integration-tests) fails:
// 1. Mark myproj-003 as failed
// 2. Find jobs where trigger_source_job_id === myproj-003 AND triggered_by === 'on_failure'
// 3. Transition those jobs from backlog → ready
```

### triggered_by: on_success

Same pattern, but triggered on success.

### parallel_with

Steps with `parallel_with` have no blocking dependency on those steps — they run concurrently. Useful for advisory agents that provide insights without blocking the pipeline.

```yaml
- id: security-review
  type: agent
  prompt: "Review for security issues..."
  parallel_with: [deploy-staging]  # Runs alongside deploy-staging
```

This creates a job with no `blocked_by` relationship to `deploy-staging`.

## Approval Gates

Steps with `approval: manual` create jobs that require human approval before execution.

```yaml
- id: deploy-prod
  type: deploy
  env: production
  approval: manual
```

This maps to existing job review workflow:
- Job created in `ready` phase
- Requires `eve job approve <id>` before worker claims it
- Can integrate with Slack for approval notifications

## Event System

### Event Types

```typescript
type PipelineEvent =
  | { type: 'trigger.received'; source: TriggerSource; pipeline: string; }
  | { type: 'pipeline.started'; run_id: string; job_count: number; }
  | { type: 'step.started'; run_id: string; step_id: string; job_id: string; }
  | { type: 'step.completed'; run_id: string; step_id: string; job_id: string; result: 'success' | 'failure'; }
  | { type: 'step.skipped'; run_id: string; step_id: string; reason: string; }
  | { type: 'approval.required'; run_id: string; step_id: string; job_id: string; approvers: string[]; }
  | { type: 'approval.granted'; run_id: string; step_id: string; job_id: string; by: string; }
  | { type: 'pipeline.completed'; run_id: string; result: 'success' | 'failure' | 'cancelled'; }
```

### Event Sources

| Source | Event |
|--------|-------|
| GitHub webhook | `trigger.received` |
| Poll service | `trigger.received` |
| Manual CLI | `trigger.received` |
| Pipeline service | `pipeline.started` |
| Job orchestrator | `step.started`, `step.completed` |
| Approval service | `approval.required`, `approval.granted` |

### Event Consumers

| Consumer | Subscribes To |
|----------|---------------|
| Pipeline service | `trigger.received` |
| Notification service | `step.completed`, `approval.required`, `pipeline.completed` |
| Audit log | All events |
| Metrics | All events |

## GitHub Integration

### Webhook Receiver

```typescript
// POST /webhooks/github
app.post('/webhooks/github', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  if (event === 'push') {
    const branch = payload.ref.replace('refs/heads/', '');
    const sha = payload.after;

    // Find pipelines triggered by this event
    const pipelines = await findPipelinesForTrigger({
      type: 'github',
      event: 'push',
      branch,
      project_id: resolveProjectFromRepo(payload.repository)
    });

    // Emit trigger events
    for (const pipeline of pipelines) {
      await eventBus.emit({
        type: 'trigger.received',
        source: { type: 'github', event: 'push', ref: payload.ref, sha },
        pipeline: pipeline.name,
        project_id: pipeline.project_id
      });
    }
  }

  res.status(200).send('OK');
});
```

### Poll Service (Fallback)

For environments where webhooks aren't possible:

```typescript
// Runs every 30 seconds
async function pollForChanges() {
  for (const project of await getProjectsWithPolling()) {
    const lastKnownSha = await getLastKnownSha(project.id);
    const currentSha = await github.getLatestSha(project.repo, project.branch);

    if (currentSha !== lastKnownSha) {
      await eventBus.emit({
        type: 'trigger.received',
        source: { type: 'poll', event: 'push', ref: `refs/heads/${project.branch}`, sha: currentSha },
        pipeline: project.default_pipeline,
        project_id: project.id
      });

      await setLastKnownSha(project.id, currentSha);
    }
  }
}
```

## Worker Execution

### Script Execution

When a worker claims a job with `execution_type: 'script'`:

```typescript
async function executeScriptJob(job: Job): Promise<JobResult> {
  const { run, working_dir, timeout_seconds } = job.script;

  // Set up environment
  const env = {
    ...process.env,
    EVE_PROJECT_ID: job.project_id,
    EVE_JOB_ID: job.id,
    EVE_ENV_NAME: job.env_name,
    EVE_GIT_SHA: job.git_sha,
    EVE_PIPELINE_RUN_ID: job.pipeline_run_id,
  };

  // Execute
  const result = await exec(run, {
    cwd: working_dir || job.workspace_path,
    env,
    timeout: (timeout_seconds || 300) * 1000,
  });

  return {
    success: result.exitCode === 0,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    duration_ms: result.duration,
  };
}
```

### Agent Execution

When a worker claims a job with `execution_type: 'agent'`:

```typescript
async function executeAgentJob(job: Job): Promise<JobResult> {
  // Existing agent harness flow
  const harness = await spawnHarness(job.hints?.harness || 'claude-code');

  // Inject pipeline context into prompt
  const enrichedPrompt = job.pipeline_run_id
    ? `${job.description}\n\nContext: This is step "${job.pipeline_step_id}" in pipeline run ${job.pipeline_run_id}.`
    : job.description;

  const result = await harness.execute(enrichedPrompt, {
    workspace: job.workspace_path,
    env_name: job.env_name,
    timeout_seconds: job.hints?.timeout_seconds,
  });

  return {
    success: result.success,
    summary: result.summary,
    artifacts: result.artifacts,
    conversation_id: result.conversation_id,
  };
}
```

## CLI Commands

### Pipeline Commands

```bash
# List pipelines
eve pipeline list

# Show pipeline definition
eve pipeline show deploy-to-prod

# Trigger pipeline manually
eve pipeline run deploy-to-prod
eve pipeline run deploy-to-prod --ref feature-branch
eve pipeline run deploy-to-prod --wait

# View pipeline run
eve pipeline status run_xyz789
eve pipeline status run_xyz789 --follow

# List runs
eve pipeline runs
eve pipeline runs --pipeline deploy-to-prod
eve pipeline runs --status running

# Cancel
eve pipeline cancel run_xyz789
```

### Enhanced Job Commands

```bash
# Create script job directly
eve job create --description "Run tests" --script "pnpm test"

# Create agent job (default, existing behavior)
eve job create --description "Investigate test failure"

# View job with execution type
eve job show myproj-abc123
# Output includes: execution_type: script, script.run: "pnpm test"
```

## Database Schema

### New Tables

```sql
-- Pipeline runs
CREATE TABLE pipeline_runs (
  id VARCHAR(32) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id),
  pipeline_name VARCHAR(128) NOT NULL,
  trigger_source JSONB NOT NULL,  -- { type, event, ref, sha, ... }
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  result VARCHAR(32),  -- success, failure, cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pipeline events (for audit and replay)
CREATE TABLE pipeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id VARCHAR(32) REFERENCES pipeline_runs(id),
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pipeline_events_run ON pipeline_events(pipeline_run_id);
CREATE INDEX idx_pipeline_events_type ON pipeline_events(event_type);
```

### Job Table Changes

```sql
ALTER TABLE jobs ADD COLUMN execution_type VARCHAR(16) DEFAULT 'agent';
ALTER TABLE jobs ADD COLUMN script_config JSONB;  -- { run, working_dir, timeout_seconds }
ALTER TABLE jobs ADD COLUMN pipeline_run_id VARCHAR(32) REFERENCES pipeline_runs(id);
ALTER TABLE jobs ADD COLUMN pipeline_step_id VARCHAR(128);
ALTER TABLE jobs ADD COLUMN triggered_by VARCHAR(32);  -- normal, on_failure, on_success
ALTER TABLE jobs ADD COLUMN trigger_source_job_id VARCHAR(64);
```

## Implementation Phases

### Phase 1: Script Jobs
- Add `execution_type` and `script` fields to job API
- Worker executes script jobs directly
- CLI `eve job create --script "..."` support

### Phase 2: Pipeline Templates
- Pipeline YAML schema and parser
- Pipeline run creation (expands to job graph)
- Basic CLI: `eve pipeline run|status|list`

### Phase 3: Triggers
- GitHub webhook endpoint
- Poll service fallback
- Manual trigger via CLI

### Phase 4: Events
- Event bus implementation
- Event persistence for audit
- Notification service integration (Slack)

### Phase 5: Conditional Steps
- `on_failure` / `on_success` handling
- `parallel_with` for advisory agents
- Approval gates integration

## Relationship to Existing Docs

| Document | Relationship |
|----------|--------------|
| [cd-pipelines.md](./cd-pipelines.md) | Detailed CLI and env design — complements this |
| [pipelines-vs-workflows.md](./pipelines-vs-workflows.md) | Distinguishes deterministic vs agent — aligns with `execution_type` |
| [job-api.md](../system/job-api.md) | Current job spec — this extends it with new fields |
| [environment-gating.md](../system/environment-gating.md) | Gate semantics — deploy steps use `env_name` for gating |

## Open Questions

1. **Pipeline storage**: In manifest only, or also in database for versioning?
2. **Cross-pipeline dependencies**: Can one pipeline trigger another?
3. **Partial reruns**: Can you rerun from a failed step without starting over?
4. **Agent step context**: How much pipeline context should agents receive?
5. **Secrets in script steps**: How do scripts access secrets securely?

## Summary

The elegant insight is that **pipelines are job graph templates**. We don't need a separate execution engine — the existing job orchestrator handles dependencies, gating, and scheduling. Pipelines just need to:

1. Parse the YAML template
2. Create linked jobs with proper `blocked_by` relationships
3. Set `execution_type` based on step type
4. Let the orchestrator do its job

Agent steps fit naturally because they're just jobs with `execution_type: 'agent'`. The orchestrator treats them the same as script jobs — it just dispatches to a different executor.
