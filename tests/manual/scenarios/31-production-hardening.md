# Scenario 31: Production Hardening Smoke Tests

**Time:** ~5 minutes
**Parallel Safe:** Yes
**LLM Required:** No

Validates the 8 production hardening quick wins: content dedup, dead letters, per-phase latency, routing logs, cost-by-agent analytics, created_by consistency, auto-retry policy hints, and document expiration.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| F1: Content dedup at ingest | Phase 1 |
| F2: Dead letter disposition + CLI filter | Phase 2 |
| F3: Per-phase latency waterfall in diagnose | Phase 3 |
| F4: Routing decision in execution logs | Phase 3 |
| F5: Cost breakdown by agent analytics | Phase 4 |
| F6: `actor_user_id` on job creation paths | Phase 5 |
| F7: Retry policy hints accepted on create | Phase 6 |
| F8: Document expiry timer running | Phase 7 |

## Prerequisites

- Local k3d stack running (`./bin/eh k8s deploy`)
- `export EVE_API_URL=http://api.eve.lvh.me`
- Authenticated: `eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519`
- Secrets imported: `eve secrets import --org org_manualtestorg --file ./manual-tests.secrets`
- Local CLI built: `pnpm build` (uses `node packages/cli/dist/index.js` as `EVE`)
- `jq` installed

## Setup

```bash
export EVE_API_URL=${EVE_API_URL:-http://api.eve.lvh.me}
export ORG_SLUG=mto

# Use local CLI build for new features not yet in npm
eve_local() { node "$(pwd)/packages/cli/dist/index.js" "$@"; }
EVE=eve_local

# Auth token for raw API calls
TOKEN=$(eve auth token --raw)
api() {
  curl -sf -H "Authorization: Bearer $TOKEN" "$@"
}

# Ensure test project with a real repo
PROJECT_ID=$(eve project ensure \
  --org org_ManualTestOrg \
  --name "hardening-test" \
  --slug htest \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json | jq -r '.id')
echo "Project: $PROJECT_ID"
```

## Phase 1: Content Dedup at Ingest (F1)

### 1a) Schema: content_fingerprint column exists

```bash
api "$EVE_API_URL/projects/$PROJECT_ID/ingest?limit=1" | jq .
# API responds (schema is valid)
```

**Expected:** API returns valid JSON (no 500 from missing column).

### 1b) Ingest a file

```bash
cat > /tmp/scenario-31-dedup.md <<'EOF'
# Dedup Test Document
This document tests content deduplication at ingest.
EOF

$EVE ingest /tmp/scenario-31-dedup.md --project "$PROJECT_ID" --json | tee /tmp/s31-ingest1.json
INGEST1_ID=$(jq -r '.ingest_id' /tmp/s31-ingest1.json)
INGEST1_STATUS=$(jq -r '.status' /tmp/s31-ingest1.json)
echo "First ingest: $INGEST1_ID status=$INGEST1_STATUS"
```

**Expected:** Returns `ingest_id` and `status` (processing or done).

### 1c) Ingest the same file again — dedup should fire

```bash
$EVE ingest /tmp/scenario-31-dedup.md --project "$PROJECT_ID" --json | tee /tmp/s31-ingest2.json
INGEST2_ID=$(jq -r '.ingest_id' /tmp/s31-ingest2.json)
INGEST2_DEDUP=$(jq -r '.deduplicated // false' /tmp/s31-ingest2.json)
INGEST2_ORIG=$(jq -r '.original_id // empty' /tmp/s31-ingest2.json)
echo "Second ingest: $INGEST2_ID deduplicated=$INGEST2_DEDUP original=$INGEST2_ORIG"
```

**Expected:**
- `deduplicated: true`
- `original_id` matches `INGEST1_ID`
- No new processing event fired

### 1d) Ingest with --force skips dedup

```bash
# Use raw API with ?force=true
api -X POST "$EVE_API_URL/projects/$PROJECT_ID/ingest/$INGEST2_ID/confirm?force=true" | \
  jq '{status, deduplicated}'
```

**Expected:** Returns without `deduplicated: true` (force bypasses dedup check).

## Phase 2: Dead Letter Handling (F2)

### 2a) Query dead letters via CLI

```bash
$EVE job list --all --dead-letters --limit 5
```

**Expected:** Returns list of jobs (may be empty). No errors. Column headers include disposition info.

### 2b) Query with --disposition filter

```bash
$EVE job list --all --disposition cancelled --limit 5 --json | jq '.jobs | length'
```

**Expected:** Returns valid JSON with a `jobs` array.

### 2c) Verify failure_disposition column via API

```bash
api "$EVE_API_URL/jobs?phase=cancelled&failure_disposition=failed&limit=1" | jq '.jobs | length'
```

**Expected:** Returns 0 or more (no 500 error = column exists and is queryable).

### 2d) Verify disposition in diagnose

```bash
# Find a cancelled job to diagnose
CANCELLED_JOB=$(api "$EVE_API_URL/jobs?phase=cancelled&limit=1" | jq -r '.jobs[0].id // empty')
if [ -n "$CANCELLED_JOB" ]; then
  $EVE job diagnose "$CANCELLED_JOB" 2>&1 | head -15
  echo "---"
  echo "Check: Disposition line should appear for cancelled jobs with failure_disposition"
fi
```

**Expected:** Diagnose output shows `Disposition: cancelled` or `Disposition: failed` line.

## Phase 3: Latency Waterfall + Routing Log (F3 + F4)

### 3a) Diagnose a completed job — check latency breakdown

```bash
# Find a completed job with execution logs
DONE_JOB=$(api "$EVE_API_URL/jobs?phase=done&limit=1" | jq -r '.jobs[0].id // empty')
if [ -n "$DONE_JOB" ]; then
  echo "Diagnosing: $DONE_JOB"
  $EVE job diagnose "$DONE_JOB" 2>&1
fi
```

**Expected:**
- "Latency Breakdown:" section appears with phases (e.g., secrets, harness)
- Duration in ms with visual bar chart (block chars)
- Total line at bottom

### 3b) Check for routing log entry

```bash
if [ -n "$DONE_JOB" ]; then
  # Get latest attempt
  ATTEMPT_NUM=$(api "$EVE_API_URL/jobs/$DONE_JOB/attempts" | jq -r '.attempts[-1].attempt_number')
  # Check logs for routing type
  api "$EVE_API_URL/jobs/$DONE_JOB/attempts/$ATTEMPT_NUM/logs?limit=100" | \
    jq '[.logs[] | select(.type == "routing")] | length'
fi
```

**Expected:**
- For jobs executed AFTER the deploy: 1 routing log entry
- For older jobs: 0 (routing logs didn't exist before)
- If "Routing:" section appears in diagnose output, F4 is working

## Phase 4: Cost by Agent Analytics (F5)

### 4a) Query cost-by-agent via CLI

```bash
$EVE analytics cost-by-agent --org $ORG_SLUG --window 30d
```

**Expected:**
- "Agent Cost Breakdown (30d window)" header
- Table of agents with cost, attempts, and input tokens
- Total row at bottom

### 4b) Query cost-by-agent via API

```bash
ORG_ID=$(api "$EVE_API_URL/orgs" | jq -r '.data[] | select(.slug == "'$ORG_SLUG'") | .id')
api "$EVE_API_URL/orgs/$ORG_ID/analytics/cost-by-agent?window=7d" | \
  jq '{as_of, window, agent_count: (.agents | length)}'
```

**Expected:**
- Returns JSON with `as_of`, `window`, `agents` array
- Each agent has `agent`, `attempts`, `total_cost_usd`, `total_input_tokens`, `total_output_tokens`

### 4c) JSON output mode

```bash
$EVE analytics cost-by-agent --org $ORG_SLUG --window 7d --json | jq '.agents[:3]'
```

**Expected:** Returns structured JSON with first 3 agents.

## Phase 5: Created By Consistency (F6)

### 5a) Create a job and verify actor_user_id

```bash
$EVE job create \
  --project "$PROJECT_ID" \
  --title "F6 created_by test" \
  --description "Test that actor_user_id is populated on CLI-created jobs" \
  --phase backlog \
  --json | tee /tmp/s31-f6-job.json

F6_JOB_ID=$(jq -r '.id' /tmp/s31-f6-job.json)
ACTOR=$(jq -r '.actor_user_id // "null"' /tmp/s31-f6-job.json)
echo "Job: $F6_JOB_ID  actor_user_id: $ACTOR"
```

**Expected:** `actor_user_id` is populated with the authenticated user ID (not null).

### 5b) Verify in diagnose

```bash
$EVE job diagnose "$F6_JOB_ID" 2>&1 | grep "Created by"
```

**Expected:** Shows `Created by: user_01kh...` line.

### 5c) Cleanup

```bash
$EVE job cancel "$F6_JOB_ID" 2>/dev/null
```

## Phase 6: Auto-Retry Policy Hints (F7)

### 6a) Create a job with retry policy

```bash
$EVE job create \
  --project "$PROJECT_ID" \
  --title "F7 retry policy test" \
  --description "Test retry policy hints on job creation" \
  --phase backlog \
  --retry-max 3 \
  --retry-backoff 30 \
  --json | tee /tmp/s31-f7-job.json

F7_JOB_ID=$(jq -r '.id' /tmp/s31-f7-job.json)
RETRY_HINTS=$(jq '.hints.retry' /tmp/s31-f7-job.json)
echo "Job: $F7_JOB_ID"
echo "Retry hints: $RETRY_HINTS"
```

**Expected:**
- `hints.retry.max_attempts: 3`
- `hints.retry.backoff_seconds: 30`
- `hints.retry.backoff_multiplier: 2`

### 6b) Verify retry policy in diagnose

```bash
$EVE job diagnose "$F7_JOB_ID" 2>&1 | grep -A4 "Retry Policy"
```

**Expected:**
- "Retry Policy:" section appears
- Shows `Max Attempts: 3`, `Backoff: 30s x2`

### 6c) Cleanup

```bash
$EVE job cancel "$F7_JOB_ID" 2>/dev/null
```

## Phase 7: Document Expiry Timer (F8)

### 7a) Verify expiry timer is running

```bash
kubectl -n eve logs deployment/eve-api --tail=50 2>&1 | grep -i "expiry"
```

**Expected:** Log line containing "Document expiry timer started (15m interval)".

### 7b) Create a document with expiration (via API)

```bash
# Create a document that expires in the past
ORG_ID=$(api "$EVE_API_URL/orgs" | jq -r '.data[] | select(.slug == "'$ORG_SLUG'") | .id')
api -X POST "$EVE_API_URL/orgs/$ORG_ID/docs" \
  -H "Content-Type: application/json" \
  -d '{"path": "test/expired-doc", "content": "This should expire", "expires_at": "2020-01-01T00:00:00Z"}' | \
  jq '{path, lifecycle_status, expires_at}'
```

**Expected:** Document created with `lifecycle_status: "active"` and past `expires_at`.

### 7c) Trigger expiry manually (wait or check next cycle)

The timer runs every 15 minutes. To verify immediately:

```bash
# Check document status after the next expiry cycle
# For immediate verification, check API logs for "Marked N document(s) as expired"
kubectl -n eve logs deployment/eve-api --tail=200 2>&1 | grep "expired\|archived" | tail -5
```

**Expected:** On next cycle, the document should be marked as expired.

## Cleanup

```bash
rm -f /tmp/scenario-31-dedup.md /tmp/s31-ingest1.json /tmp/s31-ingest2.json
rm -f /tmp/s31-f6-job.json /tmp/s31-f7-job.json
```

## Success Criteria

- [ ] F1: Second ingest of same file returns `deduplicated: true` with `original_id`
- [ ] F1: `--force` bypasses dedup check
- [ ] F2: `--dead-letters` CLI filter returns jobs without errors
- [ ] F2: `?failure_disposition=failed` API filter works
- [ ] F2: Cancelled jobs show `Disposition:` in diagnose output
- [ ] F3: Latency Breakdown section in diagnose with visual bar chart
- [ ] F3: Total line with aggregate duration
- [ ] F4: Routing log entries appear for newly executed jobs
- [ ] F5: `cost-by-agent` CLI shows agent breakdown with costs
- [ ] F5: API returns structured JSON with per-agent cost data
- [ ] F6: `actor_user_id` populated on CLI-created jobs
- [ ] F6: `Created by:` appears in diagnose output
- [ ] F7: Job created with `--retry-max` has `hints.retry` in response
- [ ] F7: Diagnose shows Retry Policy section
- [ ] F8: API logs show "Document expiry timer started"
- [ ] F8: Document with past `expires_at` transitions to expired on next cycle
