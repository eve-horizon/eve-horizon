# Job API Specification

> Status: Current
> Last Updated: 2026-02-12
> Purpose: Define the primary Job API as the unified interface for all work in Eve Horizon.

## Overview

The Job API is the primary interface for creating, executing, and reviewing work in Eve Horizon. It provides:

- Job creation with a required description (the work prompt)
- Phase-based lifecycle (`idea → backlog → ready → active → review → done/cancelled`)
- Hierarchical jobs and dependency tracking
- Claim/release workflow for execution attempts
- Review workflow (submit, approve, reject)

**Note**: "Job" refers to Eve Horizon's user-facing work unit. "Task" refers to cc-mirror sub-agent coordination within a job.

## Current (Implemented)

- Project-scoped job endpoints (create, list, ready, blocked)
- Job-scoped endpoints (get, update, tree, dependencies)
- Claim/release workflow and attempts
- Review workflow (submit/approve/reject)
- Attempt creation, continuation, and logs
- Execution receipts (per-attempt cost + timing)
- Durable script/action-run execution: worker script and `action: { type: run }`
  jobs quick-ack submission, stream output into attempt logs, and complete via
  `runner.completed` / `runner.failed` events.

## Planned (Not Implemented)

- Automated scheduling decisions in the orchestrator (beyond manual phase transitions)
- UI for review and execution monitoring
- Workspace reuse/session modes (see `docs/system/job-git-controls.md`)
- Job harness options (model, variant, reasoning effort) and project harness policies. See `docs/system/harness-policy.md`.

## Legacy (Removed)

- Workflow-first APIs and workflow-scoped job definitions
- Numeric, project-scoped job IDs

## Identifiers

Eve Horizon uses a hybrid ID scheme:
- **Global entities** (org, project): TypeIDs for uniqueness and sortability
- **Jobs**: slug-based hierarchical IDs for readability
- **Attempts**: UUIDs plus per-job attempt numbers

### TypeID Format

```
{type}_{base32_timestamp_random}
```

Example: `proj_01abc...`

### Organization ID

```
org_01xyz...
```

### Project ID + Slug

```
proj_01abc...
```

- Projects also have a `slug` (4-8 chars, e.g., `MyProj`) used for job IDs.

### Job ID

Jobs use slug-based hierarchical IDs:

| Context | Format | Example |
| --- | --- | --- |
| Root job | `{slug}-{hash8}` | `myproj-a3f2dd12` |
| Child job | `{parent}.{n}` | `myproj-a3f2dd12.1` |

- Root IDs include the project slug plus an 8-char hash.
- Child IDs append a numeric suffix to the parent.
- Max depth: 3 levels.

### Attempt ID

- Attempts have a UUID `id` plus a job-scoped `attempt_number` (1, 2, 3...).
- API/CLI reference attempts by job ID + `attempt_number`.

## API Endpoints

```
# Project-scoped jobs
POST /projects/{project_id}/jobs             # Create job
GET  /projects/{project_id}/jobs             # List jobs
GET  /projects/{project_id}/jobs/ready       # Ready/schedulable jobs
GET  /projects/{project_id}/jobs/blocked     # Blocked jobs

# Admin jobs (cross-project)
GET  /jobs                                    # List jobs (admin view)

# Job-scoped operations
GET   /jobs/{job_id}                         # Get job
PATCH /jobs/{job_id}                         # Update job
GET   /jobs/{job_id}/tree                    # Job hierarchy
GET   /jobs/{job_id}/context                 # Job context + derived status
GET   /jobs/{job_id}/dependencies            # Dependencies
POST  /jobs/{job_id}/dependencies            # Add dependency
DELETE /jobs/{job_id}/dependencies/{related_job_id}

# Claim/release + attempts (job-scoped)
POST /jobs/{job_id}/claim                     # Claim (creates attempt)
POST /jobs/{job_id}/release                   # Release attempt
GET  /jobs/{job_id}/attempts                  # List attempts
GET  /jobs/{job_id}/attempts/{attempt_num}/logs
GET  /jobs/{job_id}/attempts/{attempt_num}/stream  # SSE logs for attempt

# Review workflow
POST /jobs/{job_id}/submit                    # Submit for review
POST /jobs/{job_id}/approve                   # Approve review
POST /jobs/{job_id}/reject                    # Reject review

# Job execution helpers (job-scoped)
GET  /jobs/{job_id}/result                   # Latest or attempt-specific result
GET  /jobs/{job_id}/wait                     # Wait for completion
GET  /jobs/{job_id}/stream                   # SSE logs for job
GET  /jobs/{job_id}/receipt                  # Latest or attempt-specific receipt
GET  /jobs/{job_id}/attempts/{attempt_id}/receipt
GET  /jobs/{job_id}/compare                  # Compare two attempts (a,b)
```

## Core Entities

```
Job -> JobAttempt -> Session -> ExecutionProcess
```

- **Job**: The logical unit of work (ID: `myproj-a3f2dd12`)
- **JobAttempt**: An isolated execution run (UUID + `attempt_number`)
- **Session**: Tracks executor and allows follow-up within an attempt
- **ExecutionProcess**: A single harness invocation within a session

## Execution Durability

Agent, script, and pipeline `action: { type: run }` jobs do not hold one
orchestrator-to-worker HTTP request open for the full command duration. The
orchestrator submits the job, receives a short `202 Accepted`, then polls runner
events for the terminal result.

For workflow/pipeline script jobs, `script_timeout_seconds` is the
authoritative execution ceiling. For pipeline `action: { type: run }`, the
action input `timeout_seconds` or `timeout` is used first, then
`hints.timeout_seconds`, then the platform default. Bash stdout/stderr are
written incrementally to execution logs, so `eve job follow` can show output
while the command is still running.

## Create Job

### Request

```typescript
interface CreateJobRequest {
  // Required
  description: string;             // Work prompt

  // Optional
  title?: string;                  // Auto-generated from description if omitted
  issue_type?: string;             // task, bug, feature, epic, chore
  labels?: string[];
  phase?: 'idea' | 'backlog' | 'ready' | 'active' | 'review' | 'done' | 'cancelled';
  priority?: number;               // 0-4 (default: 2)
  assignee?: string | null;
  review_required?: 'none' | 'human' | 'agent';
  parent_id?: string | null;
  defer_until?: string | null;     // ISO 8601
  due_at?: string | null;          // ISO 8601

  // Scheduling hints
  hints?: {
    harness?: string;              // e.g., "mclaude:fast"
    worker_type?: string;          // e.g., "default", "gpu"
    permission_policy?: string;    // yolo (default), auto_edit, never
    timeout_seconds?: number;
    resource_class?: string;       // compute SKU (runner sizing + accounting)
    max_cost?: { currency: string; amount: number }; // budget cap
    max_tokens?: number;           // token budget cap
  };

  // Git + workspace controls
  git?: {
    ref?: string;                   // Branch, tag, or SHA
    ref_policy?: 'auto' | 'env' | 'project_default' | 'explicit';
    branch?: string;
    create_branch?: 'never' | 'if_missing' | 'always';
    commit?: 'never' | 'manual' | 'auto' | 'required';
    commit_message?: string;
    push?: 'never' | 'on_success' | 'required';
    remote?: string;
  };
  workspace?: {
    mode?: 'job' | 'session' | 'isolated';
    key?: string;
  };

  // Execution targeting
  env_name?: string | null;         // Target environment (for env-based ref resolution)
  execution_mode?: 'persistent' | 'ephemeral';
}
```

### Response

```typescript
interface JobResponse {
  id: string;                       // Job ID (e.g., myproj-a3f2dd12)
  project_id: string;               // TypeID
  parent_id?: string | null;
  depth: number;
  title: string;
  description: string | null;
  issue_type: string;
  labels: string[];
  phase: string;
  priority: number;
  assignee?: string | null;
  review_required: string;
  review_status?: string | null;
  reviewer?: string | null;
  defer_until?: string | null;
  due_at?: string | null;
  hints?: Record<string, unknown>;
  git?: Record<string, unknown> | null;
  resolved_git?: {                    // Resolved git metadata from latest successful attempt
    resolved_ref?: string;             // e.g., "refs/heads/main"
    resolved_sha?: string;             // 40-char commit SHA that was checked out
    resolved_branch?: string;          // Branch name used
    ref_source?: string;               // How ref was resolved: env_release|manifest|project_default|explicit
    pushed?: boolean;                  // Whether changes were pushed back
    commits?: string[];                // Commit SHAs created during execution
  };
  workspace?: Record<string, unknown> | null;
  env_name?: string | null;
  execution_mode?: 'persistent' | 'ephemeral';
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  close_reason?: string | null;
}
```

**Budget hints:** When job admission is blocked by budget or suspension checks,
the API may populate `hints.budget_blocked` and `hints.budget_blocked_reason`.

### Minimal Example

```json
{
  "description": "Fix the login bug on mobile"
}
```

**Manifest defaults**: If the project has a synced manifest, `x-eve.defaults` is merged on create (env/hints/git/workspace). Explicit job fields override defaults.

## Update Job

Jobs are updated via `PATCH /jobs/{job_id}` with any subset of updatable fields.
Phase transitions are validated server-side.

```typescript
interface UpdateJobRequest {
  title?: string;
  description?: string | null;
  labels?: string[];
  phase?: 'idea' | 'backlog' | 'ready' | 'active' | 'review' | 'done' | 'cancelled';
  priority?: number;
  assignee?: string | null;
  review_required?: 'none' | 'human' | 'agent';
  defer_until?: string | null;
  due_at?: string | null;
  close_reason?: string | null;
  hints?: {
    harness?: string;
    worker_type?: string;
    permission_policy?: string;
    timeout_seconds?: number;
    resource_class?: string;
    max_cost?: { currency: string; amount: number };
    max_tokens?: number;
  };
  git?: {
    ref?: string;
    ref_policy?: 'auto' | 'env' | 'project_default' | 'explicit';
    branch?: string;
    create_branch?: 'never' | 'if_missing' | 'always';
    commit?: 'never' | 'manual' | 'auto' | 'required';
    commit_message?: string;
    push?: 'never' | 'on_success' | 'required';
    remote?: string;
  };
  workspace?: {
    mode?: 'job' | 'session' | 'isolated';
    key?: string;
  };
  env_name?: string | null;
  execution_mode?: 'persistent' | 'ephemeral';
}
```

## Review Workflow

- `submit`: requires `summary`
- `approve`: optional `comment`
- `reject`: requires `reason`

## Dependency Model

Dependencies are stored as relations between jobs (`blocks`, `conditional_blocks`, `waits_for`, etc.).
The CLI uses `job dep add|remove|list` to manage these relations.

Jobs can have blocking dependencies:

- `blocked_by[]`: Job IDs that must complete before this can start
- `blocks[]`: Convenience to set reverse relationship (updates blocking jobs)
- Scheduler respects `blocked_by` when selecting ready jobs

Example:
```json
{
  "description": "Deploy to staging",
  "blocked_by": ["myproj-a3f2dd12", "myproj-b4e3cc21"]
}
```

The new job cannot start until both blocking jobs are Done.

## Review Workflow Examples

Approval:
```json
{
  "comment": "Approved, please proceed with the implementation"
}
```

Rejection:
```json
{
  "reason": "Please add error handling for the network timeout case"
}
```

## Execution Receipts

Each job attempt can include a persisted receipt with timing and cost details.
Receipts are assembled from `execution_logs` events (including `llm.call` usage)
and stored on the attempt.

Endpoints:

```
GET /jobs/{job_id}/receipt                         # Latest or attempt-specific (via ?attempt=N)
GET /jobs/{job_id}/attempts/{attempt_id}/receipt   # Receipt by attempt id
GET /jobs/{job_id}/compare?a=1&b=2                 # Compare two attempts
```

Receipts include:

- `timing` (billable ms, phase durations)
- `llm` usage totals (input/output/cache/reasoning tokens)
- `base_cost_usd` and `billed_cost` totals

## Job Hierarchy

Jobs can form parent-child relationships via `parent_id`:

- Child jobs use `{parent}.{n}` ID format (e.g., `myproj-a3f2dd12.1`)
- Max depth: 3 levels
- Enables "spawn sub-job from current work" pattern

Example:
```json
{
  "description": "Implement the authentication module",
  "parent_id": "myproj-a3f2dd12"
}
```

## Scheduling Behavior

Selection order for ready jobs:

```
1. Filter: phase = ready AND blocked_by all done
2. Sort: priority (0 highest, 4 lowest)
3. Sort: created_at (FIFO within priority)
```

## Session Continuity

1. **attempt\_id** is the stable identifier for job work
2. **session\_id** is the harness-level session (may change on reconstruction)
3. Continue endpoint routes to correct workspace via `attempt_id`
4. System auto-detects initial vs follow-up based on existing `agent_session_id`
5. Each new attempt creates a new workspace (isolated git branch/container)

If a worker is recycled:
- Workspace can be reconstructed from stored invocations
- Session ID may change, but attempt_id remains stable
- Prompts are replayable for reconstruction

## Attempt Git Metadata

Attempt responses include a `git` object when git controls are used, populated from `job_attempts.git_json`:

```json
{
  "git": {
    "resolved_ref": "refs/heads/main",
    "resolved_sha": "abc123",
    "resolved_branch": "job/myproj-a3f2dd12",
    "ref_source": "env_release|manifest|project_default|explicit",
    "pushed": true,
    "commits": ["def456"]
  }
}
```

## Job Result API

### Get Job Result

Fetch the result of a completed job.

**Endpoint:** `GET /jobs/{job_id}/result`

**Query Parameters:**
- `attempt` (optional): Specific attempt number. If omitted, returns the latest attempt's result.
- `format` (optional): Output format - `text`, `json`, or `full` (default: `full`)

**CLI Example:**
```bash
# Get latest result with full formatting
eve job result myproj-a3f2dd12

# Get text-only output
eve job result myproj-a3f2dd12 --format text

# Get result from specific attempt
eve job result myproj-a3f2dd12 --attempt 2 --format json
```

### Wait for Job Completion

Block until a job completes or times out. Uses Server-Sent Events (SSE) to stream status updates.

**Endpoint:** `GET /jobs/{job_id}/wait`

**Query Parameters:**
- `timeout` (optional): Timeout in seconds (default: 300, max: 300)
- `quiet` (optional): Suppress progress output
- `json` (optional): Return JSON output format

**CLI Example:**
```bash
# Wait for job to complete (default 300s timeout)
eve job wait myproj-a3f2dd12

# Wait with custom timeout
eve job wait myproj-a3f2dd12 --timeout 120

# Wait quietly with JSON output (useful in scripts)
eve job wait myproj-a3f2dd12 --quiet --json
```

**Exit Codes:**
- `0`: Job completed successfully
- `1`: Job failed
- `124`: Timeout reached
- `125`: Job was cancelled

### Stream Job Logs

Stream job logs in real-time using Server-Sent Events (SSE).

**Endpoint:** `GET /jobs/{job_id}/stream`

**Query Parameters:**
- `raw` (optional): Return raw JSON lines instead of formatted output
- `no-result` (optional): Don't include final result when job completes

**CLI Example:**
```bash
# Stream logs with formatted output
eve job follow myproj-a3f2dd12

# Stream raw JSON (for parsing)
eve job follow myproj-a3f2dd12 --raw | jq '.tool'

# Filter logs by tool using raw mode
eve job follow myproj-a3f2dd12 --raw | jq 'select(.tool == "bash")'
```
