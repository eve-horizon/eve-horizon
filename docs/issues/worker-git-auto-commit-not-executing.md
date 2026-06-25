# Bug: Worker post-execution git auto-commit and push never executes

## Summary

When a job is created with `git.commit: auto` and `git.push: on_success` (or `required`), the worker never runs the post-execution git flow. The agent creates/edits files successfully, the job completes with `subtype: "success"`, but `resolved_git.pushed` is always `false` and no `commits` array is present. The uncommitted changes are lost when the workspace is cleaned up.

## Impact

Any workflow relying on the worker to commit and push agent-produced code is broken. This forces the agent itself to run `git add`, `git commit`, and `git push` — which is unreliable because agents sometimes skip steps or stop early.

## Environment

- **API**: `https://api.eve.example.com` (cloud staging)
- **Project**: `proj_example` (reference-app)
- **Observed**: 2026-02-23, across 4+ jobs with different configurations

## Reproduction steps (for local k3d stack)

### 1. Create a job with auto-commit + push

```bash
eve job create \
  --description "Simple test: add a comment '# Worker git test' to the top of README.md using the Edit tool. Do NOT run any git commands yourself." \
  --git-ref main \
  --git-commit auto \
  --git-push on_success \
  --git-commit-message 'test: worker auto-commit verification' \
  --model glm-4.7 \
  --labels "test" \
  --timeout 120
```

### 2. Wait for completion

```bash
eve job wait <job-id> --timeout 180
```

### 3. Check resolved_git

```bash
eve job show <job-id> --json | jq '.resolved_git'
```

**Expected:**
```json
{
  "pushed": true,
  "ref_source": "explicit",
  "resolved_ref": "main",
  "resolved_sha": "<original-sha>",
  "commits": ["<new-commit-sha>"]
}
```

**Actual:**
```json
{
  "pushed": false,
  "ref_source": "explicit",
  "resolved_ref": "main",
  "resolved_sha": "<original-sha>"
}
```

No `commits` array. `pushed: false`. The file edit made by the agent is lost.

### 4. Verify the agent DID make changes

```bash
eve job logs <job-id> --attempt 1
```

Look for the `Edit` tool call — it will show the file was modified successfully. The agent did its job; the worker didn't do its part.

## Evidence from cloud staging

### Job 1: `proj_example-69cf6d33`
- **Config**: `commit: auto, push: on_success`
- **Model**: glm-4.7, ran 7 min, created 4 files, 37 tests passing
- **Agent**: wrote sentinel plugin, spec file, edited index.ts and test-scenarios.ts — all left uncommitted
- **Result**: `pushed: false`, no `commits` array
- **Worker should have**: `git add -A` (finds 2 new files + 2 modified), committed, pushed

### Job 2: `proj_example-3c7733b6`
- **Config**: `commit: auto, push: required`
- **Model**: glm-4.7, ran ~20s, edited README.md
- **Result**: `pushed: false`, no `commits` array

### Job 3: `proj_example-ffe2f5d6`
- **Config**: `commit: auto, push: on_success`
- **Model**: glm-4.7, ran ~10s, edited README.md
- **Result**: `pushed: false`, no `commits` array

### Job 4: `proj_example-2822b952` (different failure mode)
- **Config**: `commit: auto, push: on_success`
- **Model**: glm-5, ran 9 min
- **Agent committed manually** (git add + git commit), but did NOT push
- **Worker**: found clean tree after agent's commit → no worker commit → `push: on_success` skipped because no worker commits
- **Result**: `pushed: false`, no `commits` array
- **Note**: This is a separate issue — even if the worker's auto-commit ran, `push: on_success` only pushes **worker-created** commits, not agent-created ones

## What to investigate in the worker code

1. **Is the post-execution git flow actually running?** Add logging before/after the `git add -A`, `git commit`, and `git push` steps in the worker's post-execution handler.

2. **Is `commit: auto` triggering the code path?** Check the conditional that gates on `job.git.commit === 'auto'`. It may not be matching.

3. **Is the workspace still available when post-execution runs?** The worker might be cleaning up the workspace before the git flow executes.

4. **Is `push: on_success` correctly scoped?** The docs say "Push only when worker created commits in this attempt." If the agent commits manually, this policy skips the push. Consider whether `push: on_success` should push ANY unpushed commits (including agent-created ones), not just worker-created ones.

5. **Does the attempt result callback run before or after git post-processing?** The attempt shows `status: succeeded` and `subtype: "success"` — if the result is written first and the git step runs after, a race condition or early-exit could skip git.

## Workaround (current)

The reference-app skill instructs the agent to run `git add`, `git commit`, and `git push origin main` explicitly. This works when the agent follows instructions, but fails when the agent stops early or skips the commit step (observed with weaker models like glm-5).

## Desired behavior

When `git.commit: auto` is set:
1. Worker runs `git add -A` in the workspace after agent execution completes
2. If there are staged changes, worker runs `git commit -m "<commit_message>"`
3. If `push: on_success` and a commit was created, worker runs `git push`
4. `resolved_git.commits` array is populated with the new commit SHA
5. `resolved_git.pushed` is set to `true`

This should work regardless of whether the agent also committed manually (worker commit would be a no-op on clean tree, but push should still happen if there are unpushed commits).
