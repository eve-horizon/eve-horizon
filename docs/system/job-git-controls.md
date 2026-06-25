# Job Git Controls

> Status: Current (Implemented)
> Last Updated: 2026-01-27
> Purpose: Document job-level git controls for ref selection, branch creation, commit/push behavior, and workspace configuration.

## Current (Implemented)

- Jobs accept `git` and `workspace` fields at create/update time and persist them on the job record (`jobs.git_json`, `jobs.workspace_json`).
- Manifest defaults (`x-eve.defaults.git` / `x-eve.defaults.workspace`) are merged on job creation; explicit job values override defaults.
- The worker resolves refs based on `git.ref_policy`, creates branches, and applies commit/push policies after execution.
- Resolved git metadata is stored on each attempt (`job_attempts.git_json`) for audit/debugging.

## Job Git + Workspace Object

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
- `create_branch: if_missing` (when `branch` is set)
- `commit: manual`
- `push: never`
- `remote: origin`
- `workspace.mode: job`

Precedence:
1) `job.git` / `job.workspace` (explicit)
2) `x-eve.defaults.git` / `x-eve.defaults.workspace` (manifest)
3) project defaults (`project.branch`)

## Ref Resolution (Current)

If `git.ref` is not provided and `ref_policy=auto`:
1) Use the environment release SHA when `env_name` is set.
2) Else use manifest defaults (`x-eve.defaults.git.ref` or `.branch`).
3) Else fall back to the project default branch.

`ref_policy=explicit` requires `git.ref`.
`ref_policy=env` requires `env_name` and a current release SHA.
`ref_policy=project_default` always uses `project.branch`.

## Repo URL Formats + Auth (Current)

Accepted `repo_url` formats:
- HTTPS: `https://github.com/org/repo`
- SSH: `git@github.com:org/repo.git`
- File: `file:///absolute/path` (local/dev only)

Auth behavior:
- HTTPS clones use `github_token` secrets (e.g., `GITHUB_TOKEN`).
- SSH clones use `ssh_key` secrets via `GIT_SSH_COMMAND`.
- Missing auth fails fast with remediation hints (`eve secrets set`).

## Branch Creation (Current)

- If `branch` is unset, the worker checks out `ref` directly.
- If `branch` is set:
  - `create_branch=never`: checkout must already exist.
  - `create_branch=if_missing`: create only when missing.
  - `create_branch=always`: reset branch to `ref`.

## Commit + Push Policy (Current)

- `commit=manual`: agent decides if/when to commit (manual commits are not tracked for push).
- `commit=auto`: after execution, worker runs `git add -A` and commits any uncommitted changes (staged or unstaged), even on failed attempts.
- `commit=required`: on success, fail the attempt if the working tree is clean (does not auto-commit or check for existing commits).
- `push=on_success`: on success, push only when the worker created commits in this attempt.
- `push=required`: always attempts to push, but no-ops if the worker did not create commits.
- If push is requested without git credentials, the attempt fails fast.

If commit or push fails under a `required` policy, the worker marks the attempt as failed.

## Workspace Configuration (Current)

- `workspace` values are accepted and persisted but **not yet enforced** by the worker.
- Today, every attempt uses a fresh per-attempt workspace (no reuse).

## Audit Fields (Attempt)

Resolved values are stored on the attempt for debugging/audit:

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

This metadata is also promoted to the job response (`JobResponse.resolved_git`) for easy client access, using the git metadata from the latest successful attempt.

## Planned (Not Implemented)

- Workspace reuse with `workspace.mode=job|session|isolated` and `workspace.key`.
- Disk management enforcement (LRU/TTL cleanup, mirror GC, low-disk fail-fast).
- Review semantics that compute diffs for branch-based jobs.

See `docs/system/harness-execution.md` for environment knobs used by the planned disk management work.

## Related Plan

- `docs/plans/job-git-controls.md`
