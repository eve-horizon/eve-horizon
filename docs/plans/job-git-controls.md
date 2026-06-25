# Job Git Controls - Plan

> Status: Draft
> Last Updated: 2026-01-27

## Purpose

Add job-level git controls so a job can target a specific ref, create a branch, and push updates
without relying on implicit worker behavior. This enables PRD-driven workflows, per-job branches,
and safe review flows while keeping default behavior unchanged.

This plan aligns workspace semantics with git controls:
- job-scoped worktrees for typical jobs (reset/clean each attempt)
- session-scoped workspaces for chat sessions (persist across turns)
- isolated workspaces for actions/scripts that require clean state

## Source Docs

- `docs/system/job-git-controls.md`
- `docs/ideas/prd-to-epic-workflow.md`
- `docs/ideas/chat-client-integrations.md`
- `docs/plans/workspace-reuse-and-harness-optout.md`

## Goals

- Allow a job to select a ref or derive a ref from an environment.
- Support creating a new branch per job and optionally pushing it.
- Preserve current behavior when no git controls are set.
- Keep scheduling hints separate from git execution semantics.
- Record resolved git values on the attempt for auditability.
- Align review semantics: if a branch exists, review is a git diff; otherwise review uses result payload.
- Support session-scoped workspaces for chat workflows without requiring push per turn.

## Non-goals

- Auto-merge or auto-rebase flows.
- Replacement for `create-pr` actions.
- New git auth mechanisms beyond existing secrets.
- Scheduler fairness changes (tracked separately).
- Mandatory pushes for all jobs (only enforced when explicitly requested).

## Decisions (Resolved)

1) **Push timing with review**
- Default: if `git.push=on_success` (or `required`), push happens on success **before** review submission.
- Rationale: review is strongest with a real git diff and CI; review gates prevent merge, not branch creation.

2) **Default git policy location**
- Defaults are set at the **manifest level** with a **project-level fallback**.
- Precedence: `job.git` → `manifest defaults` → `project defaults`.
- Rationale: manifest defaults are versioned + env-specific; project fallback handles unsynced manifests.

3) **Auto-commit**
- Default is **no**.
- Auto-commit only when explicitly requested (`commit=auto` or `commit=required`).
- Rationale: avoid committing junk or secrets by default; still support strict workflows when needed.

4) **Session-scoped remote for chat**
- Supported as **optional**, not default.
- Rationale: enables diff-based review for chat-driven changes without forcing extra infra for all sessions.

## Proposed Model

Introduce first-class `git` and `workspace` objects on the job. These are not scheduling hints;
they are execution metadata that is stored and audited.

### Job Git + Workspace Schema (Draft)

```json
{
  "git": {
    "ref": "main",
    "ref_policy": "auto|env|project_default|explicit",
    "branch": "job/${job_id}",
    "create_branch": "never|if_missing|always",
    "commit": "never|manual|auto|required",
    "commit_message": "job/${job_id}: ${summary}",
    "push": "never|on_success|required",
    "remote": "origin"
  },
  "workspace": {
    "mode": "job|session|isolated",
    "key": "session:${session_id}"
  }
}
```

Defaults:
- `ref_policy: auto`
- `create_branch: if_missing` when `branch` is set
- `commit: manual`
- `push: never`
- `remote: origin`
- `workspace.mode: job`

### Ref Resolution Order

If `git.ref` is not provided and `ref_policy` is `auto`:
1) If `env_name` is set and the env has a current release SHA, use it.
2) Else if a manifest has a synced `git_sha` or `branch`, use that.
3) Else use `project.branch`.

`ref_policy=explicit` means `git.ref` must be supplied.

`ref_policy=env` means `env_name` must be set and the env must have a current release SHA.
If not, fail fast.

`ref_policy=project_default` always uses `project.branch`.

### Branch Behavior

- If `branch` is unset: checkout `ref` (detached or branch).
- If `branch` is set:
  - `create_branch=never`: checkout existing branch, fail if missing.
  - `create_branch=if_missing`: create only if missing, else checkout existing.
  - `create_branch=always`: create/reset branch from `ref`.

### Commit + Push Behavior

- `commit=manual`: agent decides if/when to commit.
- `commit=auto`: worker auto-commits staged changes at end (optional, future).
- `commit=required`: fail attempt if no commits are produced.
- `push=on_success`: after a successful attempt, push the working branch if it has commits.
- `push=required`: fail attempt if push cannot be performed.
- Requires `branch` to be set.
- If push is requested but credentials are missing, fail the attempt (no silent skip).

### Workspace Modes

Workspace mode governs reuse:

- `job`: per-job worktree; reset/clean to `resolved_ref` each attempt.
- `isolated`: new worktree per attempt; no reuse.
- `session`: persistent worktree for session continuity (no reset between turns unless explicit).

For `session`, `workspace.key` is required (e.g., `session:${session_id}`).

### Review Semantics

- If a job has `git.branch`, review is a git diff between base ref and branch.
- If no branch exists, review uses the job’s result payload (text/json/logs).

### Attempt Metadata (Audit)

Store resolved values on the attempt for traceability:

```json
{
  "git": {
    "resolved_ref": "refs/heads/main",
    "resolved_sha": "abc123",
    "resolved_branch": "job/myproj-a3f2dd12",
    "ref_source": "env_release|manifest|project_default|explicit",
    "pushed": true
  }
}
```

## Data + API Changes

### DB
- Add `jobs.git_json` (JSONB)
- Add `jobs.workspace_json` (JSONB)
- Add `job_attempts.git_json` (JSONB)

### API / Shared Schemas
- `CreateJobRequest.git` + `CreateJobRequest.workspace`
- `UpdateJobRequest.git` + `UpdateJobRequest.workspace`
- `JobResponse.git` + `JobResponse.workspace`
- `JobAttempt.git` (resolved values)

### CLI
Add flags to `eve job create` (and `eve job update`):

- `--git-ref <ref>`
- `--git-ref-policy <auto|env|project_default|explicit>`
- `--git-branch <branch>`
- `--git-create-branch <never|if_missing|always>`
- `--git-commit <never|manual|auto|required>`
- `--git-commit-message <template>`
- `--git-push <never|on_success|required>`
- `--git-remote <remote>`
- `--workspace-mode <job|session|isolated>`
- `--workspace-key <key>`

## Runtime Changes (Detailed)

### Orchestrator
- Pass `job.git` + `job.workspace` to worker invocation.
- When `git.branch` is set and push/commit is enabled, acquire a gate like `git:branch:<branch>`
  to prevent concurrent writes.

### Worker
- Introduce a **GitWorkspace** helper that supports:
  - mirror + worktree creation
  - fetch-based checkout for branch/tag/sha
  - create/reset branch from base ref
  - commit + push policies
  - reset/clean based on workspace mode
- Replace shallow clone logic in:
  - `apps/worker/src/invoke/invoke.service.ts`
  - `apps/worker/src/script-executor/script-executor.service.ts`
  - Optional: `apps/worker/src/action-executor/action-executor.service.ts`
  - Optional: `apps/worker/src/pipeline-runner/pipeline-runner.service.ts`
- Record resolved git metadata in `job_attempts.git_json`.

### Auth + Secrets
- Use existing `github_token` or `ssh_key` secrets for push.
- Push over HTTPS or SSH depending on `repo_url`.
- For local `file://` repos, disallow push by default unless a remote exists (dev/test only).

## Disk Management (Safety)

Operator knobs (suggested env vars):
- `EVE_WORKSPACE_MAX_GB`
- `EVE_WORKSPACE_MIN_FREE_GB`
- `EVE_WORKSPACE_TTL_HOURS`
- `EVE_SESSION_TTL_HOURS`
- `EVE_MIRROR_MAX_GB`

Policies:
- LRU eviction of worktrees when over budget.
- TTL cleanup for idle job/session worktrees.
- Mirror maintenance via `git fetch --prune` + periodic `git gc --prune=now`.
- Fail-fast on low disk (emit system event; do not start new attempts).

## Implementation Plan (Work Breakdown)

Phase 0 — Spec + Defaults
- Update shared schemas for `git` + `workspace`.
- Add manifest defaults: `x-eve.defaults.git` and `x-eve.defaults.workspace`.

Phase 1 — DB + API
- Migrations: add `jobs.git_json`, `jobs.workspace_json`, `job_attempts.git_json`.
- API create/update/store/echo for `git` + `workspace`.

Phase 2 — Worker GitWorkspace
- Implement helper for mirror/worktree, ref checkout, branch creation, commit/push.
- Replace shallow clone paths in worker/script executor.

Phase 3 — Orchestrator + Gates
- Pass `git` + `workspace` through to worker.
- Add branch-level gating when push/commit enabled.

Phase 4 — CLI + UX
- Add CLI flags and display in `eve job show/diagnose`.
- Update user/system docs.

Phase 5 — Tests
- Ref override: branch/tag/sha.
- Branch create behavior.
- Push on success with credentials.
- Push required without credentials fails fast.
- `commit=required` with no commits fails.
- Workspace modes: job resets, session persists.
- k8s: file:// repos fail fast.

## Risks + Mitigations

- **Disk growth**: LRU + TTL + mirror GC + hard free space floor.
- **Credential leaks**: reuse existing secret isolation; avoid auto-commit by default.
- **Branch races**: gate per branch when push/commit is enabled.
- **Unexpected pushes**: push requires explicit `git.push`.

## Remaining Questions

- Define the exact schema for `x-eve.defaults.git` and `x-eve.defaults.workspace`.
- If we add an Eve-managed session remote, decide its lifecycle + cleanup policy.
