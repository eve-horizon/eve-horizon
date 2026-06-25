# Scenario 02: Job Execution

**Time:** ~3-4 minutes
**Parallel Safe:** Yes
**LLM Required:** Yes (agent job)

End-to-end test of the job execution flow: create project, job, wait for completion.

## Prerequisites

- Smoke tests pass (scenario 01)
- Secrets imported to test org (Z_AI_API_KEY required for zai harness)

## Setup

Use the stable manual test org:

```bash
export ORG_ID=org_manualtestorg
```

## Steps

### 1. Create Test Project

```bash
eve project ensure \
  --org $ORG_ID \
  --name "job-test-project" \
  --slug jtest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
```

**Expected:**
- Returns JSON with `id` field
- Save the project ID

```bash
export PROJECT_ID=<id_from_output>
```

### 2. Create Job

```bash
eve job create \
  --project $PROJECT_ID \
  --description "List the top-level files in the repository and report what you find." \
  --harness zai \
  --json
```

**Expected:**
- Returns JSON with `id` field
- Job phase is `ready` or `active`

```bash
export JOB_ID=<id_from_output>
```

### 3. Follow Job (Real-time)

```bash
eve job follow $JOB_ID
```

**Expected:**
- Streams job output in real-time
- Shows agent executing the prompt
- Completes with exit code 0

**Alternative:** Wait without streaming:
```bash
eve job wait $JOB_ID --timeout 300
```

### 4. Verify Completion

```bash
eve job show $JOB_ID --json
```

**Expected:**
- `phase: "done"`
- `close_reason` is null or success-related

## Success Criteria

- [ ] Project created and linked to repo
- [ ] Job created and entered active phase
- [ ] Job completed with phase "done"
- [ ] Job output shows agent executed the task

## Active Monitoring (Use Eve CLI)

While job is running, use these CLI commands (not kubectl):

### Primary: Real-Time Streaming

```bash
# Stream job output as it happens
eve job follow $JOB_ID
```

This is the **preferred** method - shows exactly what the agent is doing.

### If Job Seems Stuck

```bash
# Comprehensive diagnostics with recommendations
eve job diagnose $JOB_ID
```

This shows:
- Current job state and phase
- Execution attempts and their status
- Timeline of events
- Actionable recommendations

### Check Execution Attempts

```bash
# List all attempts (a stuck job may have failed attempts)
eve job attempts $JOB_ID --json
```

### System-Level Check (Admin)

If multiple jobs are failing, check system health:

```bash
# Overall system status
eve system status

# Worker logs (is it dispatching jobs?)
eve system logs worker --tail 50
```

### When to Use kubectl (Infrastructure Only)

Only if `eve system status` shows infrastructure issues:

```bash
# Check if k8s cluster is healthy
kubectl get nodes
kubectl get events -n eve --sort-by='.lastTimestamp' | tail -20
```

## Cleanup (Optional)

```bash
# Projects are reused across runs (ensure is idempotent)
# To fully clean up: eve org delete org_manualtestorg
```
