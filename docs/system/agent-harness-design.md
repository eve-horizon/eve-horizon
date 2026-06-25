# Agent Harness Design

> Status: Current
> Last Updated: 2026-01-27
> Purpose: Define harness invocation semantics, context injection, and single-repo workspace layout.
> See also: [job-api.md](./job-api.md) for Job/Attempt ID formats

## Current (Implemented)

## Goals

- Standardize how every agent harness is invoked (initial vs follow-up).
- Default to **mclaude** (via cc-mirror) as the primary harness.
- Support alternate harnesses (e.g., **zai**, **codex**, **code**, **gemini**) via per-job selection.
- Ensure Skill Packs + AGENTS.md are injected consistently.
- Enforce a single-repo workspace model.

## Terminology

- **Job**: Eve Horizon's user-facing work unit (HITL, persistence, lifecycle)
- **Task**: cc-mirror's sub-agent coordination unit (Task* tools within a job execution)

## Core Entities

Project
- `repo_url`: git repository URL for the project
- `branch`: default branch for jobs

Job
- `description` (required): work prompt
- `harness` (optional): harness name override
- `harness_profile` (optional): profile name from `x-eve.agents`
- `harness_options` (optional): variant/model/reasoning controls
- `hints` (optional): worker_type/permission/timeout preferences
- `review_required` (optional): review gate (none, human, agent)

JobWorkspace
- Per-attempt working directory that contains the cloned repo
- Owns the config directory shared by all harnesses

## Workspace Layout

JobWorkspace root (example using job ID `myproj-a3f2dd12`):

```
workspace/proj_01H455.../myproj-a3f2dd12/1/    # {project_id}/{job_id}/{attempt_num}
  repo/                            # Cloned repo (single)
  .skills/                         # Resolved Skill Packs
  .eve-harness/                    # Optional: job-specific config
```

Notes:
- Claude Code reads `AGENTS.md` from the CWD automatically (no need to copy it)
- Prompt text (job description) instructs which skill to load (e.g., `eve-se/pr-review`)
- Skills are read directly from `.agents/skills/` in the cloned repo

## Harness Invocation Contract

The worker receives a minimal invocation envelope:

```
HarnessInvocation
  attemptId: AttemptId
  jobId: JobId
  projectId: ProjectId
  description: string
  workspacePath: string
  repoUrl?: string
  repoBranch?: string
  harness?: 'mclaude' | 'zai' | 'codex' | 'code' | 'gemini'
  harness_profile?: string
  harness_options?: {
    variant?: string
    model?: string
    reasoning_effort?: 'low' | 'medium' | 'high' | 'x-high'
  }
  hints?: Record<string, unknown>
```

Example payload:

```json
{
  "attemptId": "1",
  "jobId": "myproj-a3f2dd12",
  "projectId": "proj_01H455...",
  "description": "Use eve-se/pr-review to review PR #123",
  "workspacePath": "/tmp/eve/workspaces/proj_01H455.../myproj-a3f2dd12/1",
  "repoUrl": "https://github.com/org/repo",
  "repoBranch": "main",
  "harness": "mclaude",
  "harness_options": {"variant": "fast", "reasoning_effort": "high"}
}
```

## Environment

- `EVE_DEFAULT_HARNESS`: fallback when a job does not specify `harness`.
- `CLAUDE_CODE_OAUTH_TOKEN`: required for real mclaude runs.
- `CLAUDE_MODEL`: optional default for the mclaude/claude model (overridden by `harness_options.model`).
- `Z_AI_API_KEY`: required for zai runs.
- `ZAI_MODEL`: optional default for the zai model (overridden by `harness_options.model`).

## Security

Agent CLI processes are sandboxed to prevent directory traversal and cross-job data access. Each harness adapter applies CLI-specific sandbox flags:

- **claude/mclaude/zai**: `--add-dir <workspace>` restricts tool access
- **code/codex**: `--sandbox workspace-write` restricts writes
- **gemini**: `--sandbox` enables sandbox mode

See [agent-sandbox-security.md](./agent-sandbox-security.md) for the complete security model.

## Planned (Not Implemented)

- Additional harness variants beyond existing preset overlays.

## Legacy / Removed

- Workflow-specific harness hooks (workflows removed).

## Skill Pack Resolution

- Skills are read directly from `.agents/skills/` in the cloned repo
- No syncing or copying to harness config directories
