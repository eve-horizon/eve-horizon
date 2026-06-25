# Agent Learning Loop — Test Plan

Date: 2026-03-30
Owner: Eve Horizon
Status: Active
Spec: [AGENT_LEARNING_LOOP.md](../ideas/AGENT_LEARNING_LOOP.md)
PR: eve-horizon/eve-horizon#26
AgentPack: [eve-horizon/learning-loop-agentpack](https://github.com/eve-horizon/learning-loop-agentpack)

---

## What Was Tested During Implementation

The following was verified when the platform changes and agentpack were built:

| Area | What Was Verified | Method |
|------|------------------|--------|
| Compilation | All packages build cleanly with changes | `pnpm build` |
| Unit tests | 702+ tests pass (shared: 321, API: 132, orchestrator: 250) | `pnpm test` per package |
| Trigger matching | `system.job.attempt.completed` events match workflow triggers | New unit test in `trigger-matcher.service.spec.ts` |
| User category schema | `user` accepted by `AgentContextMemorySchema` zod enum | Schema change in `agent-config.ts` |
| User category API | `user` accepted by memory service (reaches RBAC, not 400) | `eve memory set --category user` against k3d API |
| Invalid category rejection | Unknown categories still return 400 | `curl` with `invalid_category` |
| K8s deployment | Orchestrator and API deploy and roll out successfully | `kubectl rollout status` |
| AgentPack structure | All files present, pushed to GitHub | `ls -R`, `gh repo view` |

Unless noted otherwise, use the CLI as the primary verification surface. Prefer concrete IDs returned by the previous command (`org_...`, `proj_...`, `job_...`, `evt_...`) over hand-written placeholders or slugs once the test is running.

### What Was NOT Tested

These are the gaps. The sections below define how to close them.

| Gap | Risk | Why It Matters |
|-----|------|----------------|
| Completion event actually fires on job finish | High | Core trigger for the entire learning loop |
| Event router dispatches review workflow from completion event | High | Without this, the reviewer never runs |
| Carryover context materializes `user` category into `.eve/context/memory/` | Medium | Agents won't see user preferences if materialization is broken |
| Session reviewer agent runs end-to-end | High | The whole inward/outward review is untested |
| Memory written in session N is loaded in session N+1 | Critical | The fundamental promise of the learning loop |
| Reviewer idempotency (no duplicates on re-run) | Medium | Memory pollution over time |
| Skill creation by reviewer | Medium | Part of the loop but less critical than memory |
| Platform improver opening PRs | Low | Requires git credentials; defer to manual pilot |
| Cron workflows (heartbeat, batch) | Low | Standard cron trigger; trust existing tests |
| Pack resolution for learning-loop-agentpack | Medium | Pack import is tested elsewhere, but not this specific pack |

---

## Test Layers

### Layer 1: Contract Tests (Automated, No Stack Needed)

These run with `pnpm test` and require no external services.

#### 1.1 Carryover Context — `user` Category Materialization

**File**: `packages/shared/src/invoke/__tests__/carryover-context.spec.ts` (new)

**Setup**: Mock `CarryoverContextDb` with in-memory data.

**Steps**:

```
1. Create a mock DB with org docs at:
   /agents/test-agent/memory/user/prefs.md     → "User prefers terse output"
   /agents/test-agent/memory/learnings/k8s.md   → "DNS fails before CNI"

2. Create a HarnessInvocation with:
   jobId: "job_test"
   projectId: "proj_test"

3. Set up job hints:
   agent_context:
     memory:
       agent: test-agent
       categories: [user, learnings]
       max_items: 5

4. Call writeCarryoverContext(invocation, tmpDir, mockDb)

5. Assert:
   - File exists: {tmpDir}/.eve/context/memory/prefs.md
   - File exists: {tmpDir}/.eve/context/memory/k8s.md
   - Content matches source docs
```

**Why**: Proves that the `user` category is materialized alongside existing categories. This is the contract between agent config and runtime context.

#### 1.2 Carryover Context — `max_items` and `max_age` Enforcement

**Steps**:

```
1. Create mock DB with 15 docs under /agents/test-agent/memory/learnings/
2. Set max_items: 5
3. Call writeCarryoverContext
4. Assert: exactly 5 files materialized (most recent)

5. Create mock DB with docs of varying ages
6. Set max_age: "7d", current time = now
7. Include docs from 3 days ago, 10 days ago, 30 days ago
8. Call writeCarryoverContext
9. Assert: only the 3-day-old doc materialized
```

#### 1.3 Trigger Matching — Completion Event (Already Done)

**File**: `apps/orchestrator/src/events/trigger-matcher.service.spec.ts`

**Status**: DONE. Test added in PR #26. Confirms `system.job.attempt.completed` event matches workflow with `system: { event: job.attempt.completed }`.

#### 1.4 Trigger Matching — Cron Review Heartbeat

**Status**: PARTIALLY DONE. `trigger-matcher.service.spec.ts` already has generic cron + `trigger_name` coverage. Add this pack-specific smoke test only if the learning-loop workflow wiring changes.

**Steps**:

```
1. Create manifest with:
   workflows:
     skill-review-heartbeat:
       trigger:
         cron:
           schedule: "0 */6 * * *"

2. Create a cron event with trigger_name: "skill-review-heartbeat"
3. Assert: matches the workflow
```

**Why**: Validates the heartbeat trigger path for periodic skill review.

---

### Layer 2: Integration Tests (Requires Local Stack)

These use `./bin/eh test integration` or direct CLI commands against the k3d stack.

#### 2.1 Completion Event Fires on Job Success

**Prerequisites**: k3d stack running, authenticated as system admin, and at least one runnable execution path for the test project.

Use `./bin/eh status` first and take the local API URL from there rather than assuming ports.

**Steps**:

```bash
# 1. Set up
./bin/eh status
export EVE_API_URL=http://api.eve.lvh.me
eve profile use local
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519

# 2. Ensure test org and project exist
eve org ensure "learning-test" --slug learning-test --json
# Note the org_id from output as <org_id>

# 3. Ensure a test project exists
eve project ensure --org <org_id> --name "learning-test" --slug learning-test \
  --repo-url file://$PWD --branch main --json
# Note the project_id from output as <project_id>

# 4. Run a minimal successful execution path for that project.
# Pick ONE supported route:
#
# Route A: a real agent job if the project has working harness/secrets
eve job create --project <project_id> \
  --description "Print a one-line success message, then stop." \
  --json
#
# Route B: a deterministic manifest-driven run if you want to avoid LLM dependency.
# Create a temporary repo dir with .eve/manifest.yaml, sync it with
#   eve project sync --project <project_id> --dir <repo_dir>
# then invoke a one-step workflow or pipeline that succeeds quickly.

# Note the resulting job_id from the chosen route as <job_id>

# 5. Wait for job to complete
eve job follow <job_id>
# OR: eve job wait <job_id> --timeout 300

# 6. Check for completion event through the CLI first
eve event list --project <project_id> \
  --type system.job.attempt.completed \
  --source system --json

# 7. Inspect the matching event if needed
eve event show <event_id> --project <project_id> --json

# 8. Assert:
#    - Event exists with type "system.job.attempt.completed"
#    - payload_json.job_id matches the job we created
#    - payload_json.status is "succeeded"
#    - payload_json.duration_ms is a positive number
```

**Fallback if you need to bypass the CLI**: query the public events API directly:
```bash
curl -s "$EVE_API_URL/projects/<project_id>/events?type=system.job.attempt.completed" \
  -H "Authorization: Bearer $(eve auth token)" | jq .
```

**Fallback if the event never appears**: Check orchestrator logs:
```bash
kubectl -n eve logs deployment/eve-orchestrator --tail=100 | grep "attempt.completed"
```

**Why**: Proves the event emission path works in a real deployment. This is the most critical gap.

#### 2.2 Completion Event Fires on Job Failure

**Steps**:

```bash
# 1. Trigger a failing execution path for the same project.
# Again, use a supported route rather than --execution-type:
#
# Route A: a real agent job that is expected to fail
eve job create --project <project_id> \
  --description "Exit with a clear failure result." \
  --json
#
# Route B: a manifest-driven workflow/pipeline step that fails deterministically
# after `eve project sync --project <project_id> --dir <repo_dir>`.

# 2. Wait for failure
eve job follow <job_id>

# 3. Check for BOTH events:
#    - system.job.failed (existing)
#    - system.job.attempt.completed (new, with status=failed)

# 4. Assert:
#    - Both events exist for the same job
#    - Completion event has status "failed"
```

**Why**: Failures are important for learning — the reviewer should see them.

#### 2.3 Memory CRUD with `user` Category

**Prerequisites**: RBAC grants for the test user on the test org's orgdocs.

**Steps**:

```bash
# 1. Grant orgdocs access (if not already)
# This may require syncing an access.yaml with the test project

# 2. Write a user memory entry
eve memory set --org <org_id> --agent test-agent --category user \
  --key comm-style \
  --content "User prefers short answers. No emojis. No summaries." \
  --confidence 0.9 --tags preferences --json

# 3. Read it back
eve memory get --org <org_id> --agent test-agent \
  --category user --key comm-style --json

# 4. Assert:
#    - content matches what was written
#    - metadata.memory.category is "user"
#    - confidence is 0.9

# 5. Search for it
eve memory search --org <org_id> --agent test-agent \
  --query "emojis" --json

# 6. Assert: result includes the comm-style entry

# 7. List by category
eve memory list --org <org_id> --agent test-agent --category user --json

# 8. Assert: exactly 1 entry

# 9. Delete it
eve memory delete --org <org_id> --agent test-agent \
  --category user --key comm-style

# 10. Assert: memory get returns 404
```

**Why**: Full CRUD verification for the new category. Memory is the foundation of learning.

#### 2.4 Event Router Dispatches Workflow from Completion Event

**Prerequisites**: A project with a synced manifest that includes a workflow triggered by `job.attempt.completed`.

**Steps**:

```bash
# 1. Create a temp repo dir containing .eve/manifest.yaml
mkdir -p /tmp/learning-loop-test/.eve
cat > /tmp/learning-loop-test/.eve/manifest.yaml <<'EOF'
workflows:
  test-review:
    trigger:
      system:
        event: job.attempt.completed
    steps:
      - agent:
          prompt: "Review the completed job and echo the triggering job id."
EOF

# 2. Sync the manifest to the project
eve project sync --project <project_id> --dir /tmp/learning-loop-test

# 3. Run any supported job/workflow path that will complete and emit
#    system.job.attempt.completed for this project
eve job create --project <project_id> \
  --description "Trigger the review workflow with a successful completion." \
  --json

# 4. Wait for it to complete
eve job follow <job_id>

# 5. Wait ~10 seconds for the event router tick (5s interval)

# 6. Check whether the event was processed and linked to a workflow job
eve event list --project <project_id> \
  --type system.job.attempt.completed --source system --json
eve event show <event_id> --project <project_id> --json

# 7. Check if a workflow job was created
eve job list --project <project_id> --json | \
  jq '.jobs[] | select(.labels[]? == "workflow:test-review")'

# 8. Assert:
#    - A new job exists triggered by the test-review workflow
#    - The event status is "completed"
#    - event.job_id points at the workflow root job (or the job list shows the workflow label)
```

**Why**: This proves the full chain: job completes → event emitted → event router ticks → trigger matches → workflow job dispatched. Without this, the learning loop is dead.

---

### Layer 3: End-to-End Behavior Tests (Manual Pilot)

These require a real agent session with an LLM. They prove the *learning behavior*, not just the plumbing.

#### 3.1 Preference Retention (The Acid Test)

**Time**: ~15 minutes
**Prerequisites**: k3d stack, test org with secrets (ANTHROPIC_API_KEY or equivalent), learning-loop-agentpack installed on the project.

**Steps**:

```
SESSION 1 — Establish a preference

1. Create an agent job with context.memory configured:
   eve job create --project <project_id> \
     --assignee my-agent \
     --description "List the files in the current directory. Use whatever tool you prefer."

2. Wait for completion. The agent will likely use `ls` or `find`.

3. Correct the agent via a follow-up message (or create a new job):
   "Always use 'rg' instead of 'grep' and 'fd' instead of 'find'. I strongly prefer ripgrep and fd."

4. Wait for the session to complete.

5. Wait for the reviewer to run (triggered by completion event).

6. Verify memory was written:
   eve memory list --org <org_id> --agent my-agent --category user --json
   # OR
   eve memory search --org <org_id> --agent my-agent --query "ripgrep" --json

   Assert: An entry exists about the rg/fd preference.

SESSION 2 — Verify retention

7. Create a new job with the same agent:
   eve job create --project <project_id> \
     --assignee my-agent \
     --description "Search for all TypeScript files that contain the word 'async'."

8. Wait for completion. Read the logs:
   eve job logs <job_id>

9. Assert: The agent uses `rg` and/or `fd`, NOT `grep` or `find`.
   The agent's behavior changed because it loaded the preference from memory.
```

**What success looks like**: The agent remembers the preference without being told again. The memory entry is visible in `eve memory list`.

**What failure looks like**: The agent uses `grep`/`find` again. Check:
- Was memory written after session 1? (reviewer ran?)
- Was memory loaded in session 2? (context.memory configured?)
- Did the agent read `.eve/context/memory/`? (learning-brain skill loaded?)

#### 3.2 Convention Retention

**Steps**:

```
SESSION 1 — Establish a convention

1. Job: "Create a new API endpoint for user profiles."
2. Agent creates something.
3. Correct: "In this project, all API endpoints must use kebab-case URLs
   and return responses wrapped in { data: T, meta: { page, total } }.
   Remember this for all future work."
4. Wait for completion + review.
5. Verify: eve memory list --org <org_id> --agent my-agent --category conventions --json

SESSION 2 — Verify convention

6. Job: "Create a new API endpoint for user notifications."
7. Assert: Agent uses kebab-case URLs and the response envelope without being told.
```

#### 3.3 Runbook Formation (Skill Creation)

**Steps**:

```
SESSION 1 — Debug a problem for the first time

1. Job: "The K8s pod eve-api-xxx is in CrashLoopBackOff. Debug it."
2. Agent debugs (checks logs, describes pod, etc.)
3. Session completes. Reviewer runs.
4. Check: eve docs search --org <org_id> --query "CrashLoopBackOff" --json
   and/or eve docs list --org <org_id> --path /agents/my-agent/skills/ --json
   Likely: no skill yet (first occurrence)

SESSION 2 — Debug the same class of problem

5. Job: "The K8s pod eve-worker-yyy is in CrashLoopBackOff. Debug it."
6. Agent debugs again.
7. After reviewer runs, check skills again.
   May see a skill doc forming.

SESSION 3 — Same class again

8. Job: "Pod eve-gateway-zzz is in CrashLoopBackOff."
9. After reviewer: A skill doc should now exist at:
   /agents/my-agent/skills/debug-crashloopbackoff.md (or similar)

10. Verify skill content describes the debugging steps the agent discovered.
```

**What success looks like**: After 2-3 similar sessions, a skill doc exists that captures the debugging procedure.

#### 3.4 Reviewer Idempotency

**Steps**:

```
1. Run a normal agent session. Wait for it to complete.
2. Note the memory entries after the first review:
   eve memory list --org <org_id> --agent my-agent --json
   # Record the number of entries returned in the response payload

3. Manually trigger the reviewer again for the same job:
   # Prefer re-emitting the completion event into the same project if your test
   # environment allows it, or invoke the review workflow directly with the same job_id.

4. Check memory count again:
   eve memory list --org <org_id> --agent my-agent --json

5. Assert: the number of entries is unchanged from step 2.
   The reviewer should detect the KV marker and skip the already-reviewed job.

6. Check the KV marker:
   eve kv get --org <org_id> --agent session-reviewer \
     --namespace reviewed --key <job_id> --json
   Assert: marker exists with reviewed_at timestamp
```

#### 3.5 Staleness Handling

**Steps**:

```
1. Write a memory entry with a past review_due date:
   eve memory set --org <org_id> --agent my-agent --category learnings \
     --key old-fact \
     --content "The staging API is at api.staging.example.com" \
     --review-due "2026-03-01T00:00:00Z"

2. List stale entries:
   eve docs stale --org <org_id> --prefix /agents/my-agent/memory/ --json
   Assert: old-fact appears

3. Run the skill-review-heartbeat workflow (or wait for the 6h cron).

4. After review, check the entry:
   eve memory get --org <org_id> --agent my-agent \
     --category learnings --key old-fact --json

5. Assert one of:
   - Entry has lifecycle_status: "archived" (reviewer decided it's stale)
   - Entry has updated review_due in the future (reviewer refreshed it)
   - Entry was superseded by a newer entry
```

---

## Acceptance Criteria

The learning loop is working if ALL of the following pass:

| # | Criterion | Test |
|---|-----------|------|
| AC-1 | `system.job.attempt.completed` event emitted on success and failure | Layer 2, tests 2.1 + 2.2 |
| AC-2 | Event router dispatches workflow from completion event | Layer 2, test 2.4 |
| AC-3 | `user` memory category works end-to-end (write, read, search, delete) | Layer 2, test 2.3 |
| AC-4 | Carryover context materializes `user` category | Layer 1, test 1.1 |
| AC-5 | After correction in session N, session N+1 behaves differently | Layer 3, test 3.1 |
| AC-6 | Memory is bounded — no unbounded duplicates | Layer 3, test 3.4 |
| AC-7 | Reviewer is idempotent | Layer 3, test 3.4 |
| AC-8 | Skills created after repeated similar sessions | Layer 3, test 3.3 |

### Minimum Viable Test Sequence

For the fastest path to confidence before wider rollout:

```
1. Layer 1, test 1.1  — carryover context unit test     [~30 min to write]
2. Layer 2, test 2.1  — completion event fires           [~15 min to run]
3. Layer 2, test 2.4  — event router dispatches workflow [~20 min to run]
4. Layer 3, test 3.1  — preference retention e2e         [~15 min to run]
```

That sequence proves: event → trigger → workflow → memory → behavior change. If those four pass, the loop is real.

---

## Running This Plan

### As a Human

Follow the steps in each test section. The CLI commands are intended to be copy-pasteable once you substitute the concrete IDs returned by earlier commands. Check the assertions manually.

### As an Agent

This plan is designed to be executable by a Claude agent. Each step is:
- A CLI command to run
- An assertion to check against the output
- Clear success/failure criteria

An agent executing this plan should:
1. Start with Layer 1 (no stack needed, fastest feedback)
2. Move to Layer 2 (requires k3d stack — check `./bin/eh status` first)
3. Move to Layer 3 only after Layer 2 passes (requires LLM API keys)
4. Report results as a checklist with pass/fail per test
5. On failure, capture the error output and relevant logs for diagnosis

### Prerequisites Checklist

```bash
# Before starting any tests:
./bin/eh status                                    # Stack running?
eve system health --json                           # API healthy?
eve auth login --email admin@example.com \
  --ssh-key ~/.ssh/id_ed25519                      # Authenticated?
eve org ensure "learning-test" --slug learning-test --json
# Capture <org_id>, then:
eve secrets list --org <org_id> --json            # Secrets present if using real agent jobs
```

---

## Deferred Tests (Post-Pilot)

These are intentionally excluded from the first validation pass:

| Test | Why Deferred |
|------|-------------|
| Platform improver opening PRs | Requires git credentials and target repo setup |
| Slack notification delivery | Requires configured Slack gateway |
| Skill promotion to repo (git commit) | Requires git push policy and multiple sessions |
| Cross-agent memory sharing | Design question still open |
| Thread message search | Optional platform gap (Phase 7) |
| Pack resolution for learning-loop-agentpack | Covered by existing pack resolution tests |
| Weekly batch-improvements cron | Standard cron; trust existing trigger tests |
