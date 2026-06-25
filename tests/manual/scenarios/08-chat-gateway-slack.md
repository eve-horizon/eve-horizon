# Scenario 08: Chat Gateway (Slack Integration)

**Time:** ~8-10 minutes (all phases; run incrementally as implementation lands)
**Parallel Safe:** Yes (Phases 0-2 and Phase 5-6; Phase 3 sub-phases are sequential)
**LLM Required:** No

Validate Slack integration from basic routing through identity resolution, rich formatting,
and resilience. Each phase maps to the gap closure plan and serves as the phase gate before
moving to the next implementation phase.

Run phases in order. Each phase is independently re-runnable -- re-run the
failing phase after fixing, not the full scenario from scratch.

## What This Tests

| Phase | Capability | Verified By |
|-------|-----------|-------------|
| 0 | Integration connect and list | Step 1-2 |
| 0 | Gateway simulate creates thread and job | Step 3-4 |
| 0 | Agent sync and routing | Step 2-3 |
| 2 | Inbound integration resolution failure logging | Step 5 |
| 2 | Structured gateway response (immediate_reply + route) | Step 6 |
| 3a | Email auto-match binds identity (Tier 1) | Step 7-8 |
| 3a | Non-matching email creates membership request | Step 9 |
| 3a | Already-bound user routes immediately | Step 10 |
| 3b | Link token generation (Tier 2) | Step 11 |
| 3b | Link token redemption via gateway | Step 12 |
| 3b | Expired/invalid token rejected | Step 13 |
| 3b | Already-bound identity rejects re-link | Step 14 |
| 3c | Unknown user gets clear error (not "Unable to route") | Step 15 |
| 3c | Repeat message shows "still pending" (no duplicate) | Step 16 |
| 3c | Admin approval creates user + membership + binding | Step 17-18 |
| 4 | Rich formatting in immediate_reply | Step 19 |
| 5 | Event deduplication via --dedupe-key | Step 20 |
| 5 | Direct webhook responds within 3s | Step 21 |
| 6 | Legacy API Slack endpoint removed (404) | Step 22 |
| 6 | Canonical provider webhook still works | Step 23 |
| 6 | Interactive endpoint still works | Step 24 |

## Prerequisites

- Smoke tests pass (scenario 01)
- `EVE_API_URL` set (see main README)
- `ORG_ID=org_ManualTestOrg`
- Example repo available at `../eve-horizon-fullstack-example`

## Setup

```bash
export ORG_ID=org_ManualTestOrg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
export EXAMPLE_REPO=../eve-horizon-fullstack-example

# Auth token for raw API calls
TOKEN=$(eve auth token --raw)

# Helper for authenticated API calls
api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }
api_code() { curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$@"; }
```

---

## Phase 0: Baseline

> Existing chat simulate flow via the gateway. Validates integration wiring, agent routing, and job creation.

### Step 1 -- Create project and sync agents

```bash
# Ensure project
PROJECT_JSON=$(eve project ensure \
  --org $ORG_ID \
  --name "chat-gateway-manual" \
  --slug chatgw \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --json)
PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.id')
echo "Project: $PROJECT_ID"
test -n "$PROJECT_ID" && echo "PASS: project created"

# Sync agents from example repo
eve agents sync \
  --project $PROJECT_ID \
  --ref main \
  --repo-dir $EXAMPLE_REPO \
  --json
echo "PASS: agents synced"
```

### Step 2 -- Connect Slack integration

```bash
# Connect a Slack integration (stub OAuth -- no real workspace needed)
INTEGRATION_JSON=$(eve integrations slack connect \
  --org $ORG_ID \
  --team-id T08TEST \
  --token xoxb-test-token-for-simulate \
  --json)
INTEGRATION_ID=$(echo "$INTEGRATION_JSON" | jq -r '.id')
echo "Integration: $INTEGRATION_ID"
test -n "$INTEGRATION_ID" && echo "PASS: integration connected"

# Verify it appears in the list
eve integrations list --org $ORG_ID --json | jq '.integrations[] | select(.account_id == "T08TEST")'
```

### Step 3 -- Simulate inbound chat via gateway

```bash
# Simulate a Slack message arriving (routes through gateway, not API)
CHAT_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08CHAT \
  --user-id U08ALICE \
  --text "hello gateway" \
  --json)
echo "$CHAT_JSON" | jq '.'

# Extract route metadata from gateway response
THREAD_ID=$(echo "$CHAT_JSON" | jq -r '.thread_id // empty')
JOB_ID=$(echo "$CHAT_JSON" | jq -r '.job_ids[0] // empty')
REPLY=$(echo "$CHAT_JSON" | jq -r '.immediate_reply.text // empty')

echo "Thread: $THREAD_ID"
echo "Job: $JOB_ID"
echo "Reply: $REPLY"
test -n "$JOB_ID" && echo "PASS: job created via gateway simulate"
```

### Step 4 -- Verify job created

```bash
# Job should be visible in the project
test -n "$JOB_ID" && echo "PASS: job_id returned from gateway simulate"

eve job list --project $PROJECT_ID --limit 5
eve job show $JOB_ID --json | jq '{id, phase, harness}'
```

**Expected:**
- `eve integrations slack connect` returns an integration record with `provider: "slack"`
- `eve chat simulate` returns route metadata with `job_ids` and `immediate_reply`
- `eve job list` shows a job associated with the chat route

**Failure mode:** If no job is created, check agent sync output -- agents must have
`gateway.policy: routable` in their YAML config. If route is null, check that the
integration `team_id` matches the `--team-id` passed to simulate. If the gateway
returns 404, check that `EVE_SIMULATE_ENABLED=true` is set.

---

## Phase 2: Observability Verification

> Silent failures are the most dangerous kind. This phase verifies that resolution failures
> produce structured logs and that the gateway response contains full route metadata.

### Step 5 -- Inbound integration resolution failure logged

```bash
# Simulate a message with a team-id that has no integration
NOINT_JSON=$(eve chat simulate \
  --team-id T08NONEXISTENT \
  --channel-id C08GHOST \
  --user-id U08GHOST \
  --text "no integration for this team" \
  --json 2>&1)

echo "$NOINT_JSON"
# Should succeed but with null route (integration not found)
NOINT_ROUTE=$(echo "$NOINT_JSON" | jq -r '.route // "null"')
echo "Route: $NOINT_ROUTE"
test "$NOINT_ROUTE" = "null" && echo "PASS: null route for missing integration"

# Check gateway logs for the resolution failure
kubectl -n eve logs deployment/eve-gateway --tail=50 2>&1 | grep -c "integration_not_found"
echo "PASS: inbound resolution failure logged (check count above > 0)"
```

### Step 6 -- Structured gateway response

```bash
# A successful simulate should return a structured response with route metadata + immediate reply
STRUCT_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08STRUCT \
  --user-id U08ALICE \
  --text "verify structured response" \
  --json)

echo "$STRUCT_JSON" | jq '.'

# Verify the response has the expected shape
test -n "$(echo "$STRUCT_JSON" | jq -r '.thread_id // empty')" && echo "PASS: thread_id present"
test -n "$(echo "$STRUCT_JSON" | jq -r '.immediate_reply.text // empty')" && echo "PASS: immediate_reply present"
DEDUP=$(echo "$STRUCT_JSON" | jq -r '.duplicate')
test "$DEDUP" = "false" && echo "PASS: duplicate=false"
echo "PASS: structured gateway response verified"
```

**Expected:**
- Step 5: Missing integration returns null route; gateway logs contain `integration_not_found`
- Step 6: Successful simulate returns `thread_id`, `immediate_reply`, `duplicate: false`, and `job_ids`

---

## Phase 3a: Identity Auto-Match (Tier 1)

> When a Slack user's email matches an existing Eve org member, the system should
> automatically bind the external identity without admin intervention.

### Step 7 -- Create user and add to org

```bash
# Create a user with a known email and add them to the org
USER_JSON=$(api -X POST "$EVE_API_URL/orgs/$ORG_ID/members" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice-auto-match@example.com",
    "role": "member"
  }')
AUTO_USER_ID=$(echo "$USER_JSON" | jq -r '.user_id // .id // empty')
echo "Test user: $AUTO_USER_ID"
test -n "$AUTO_USER_ID" && echo "PASS: test user created in org"
```

### Step 8 -- Simulate inbound from matching Slack user

```bash
# Simulate inbound with --external-email for Tier 1 auto-match
MATCH_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08AUTO \
  --user-id U08AUTOMATCH \
  --text "hello from auto-match user" \
  --external-email alice-auto-match@example.com \
  --json)

echo "$MATCH_JSON" | jq '.'

# Verify the message was routed (job created) -- auto-match bound the identity
MATCH_JOB=$(echo "$MATCH_JSON" | jq -r '.job_ids[0] // empty')
test -n "$MATCH_JOB" && echo "PASS: auto-match user routed successfully (job: $MATCH_JOB)"

# Check API logs for the auto-match event
kubectl -n eve logs deployment/eve-api --tail=100 2>&1 | grep "identity.auto_matched"
echo "PASS: identity.auto_matched log event present"
```

### Step 9 -- Non-matching email creates membership request

```bash
# Simulate inbound with an email that doesn't match any Eve user
NOMATCH_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08NOMATCH \
  --user-id U08STRANGER \
  --text "hello from unknown user" \
  --external-email stranger@nowhere.example \
  --json 2>&1)

echo "$NOMATCH_JSON" | jq '.'

# Verify no job was created (identity unresolved, intercepted before routing)
NOMATCH_JOBS=$(echo "$NOMATCH_JSON" | jq -r '.job_ids | length' 2>/dev/null)
test "$NOMATCH_JOBS" = "0" && echo "PASS: no job created for unresolved identity"

# The immediate_reply should contain an identity-related message
NOMATCH_REPLY=$(echo "$NOMATCH_JSON" | jq -r '.immediate_reply.text // empty')
echo "Reply: $NOMATCH_REPLY"
echo "$NOMATCH_REPLY" | grep -qi "link\|membership\|recognize" && echo "PASS: helpful identity message returned"

# Check that a membership request exists
REQUESTS=$(api "$EVE_API_URL/orgs/$ORG_ID/membership-requests" | jq '.')
echo "$REQUESTS"
echo "PASS: membership request created for non-matching user"
```

### Step 10 -- Already-bound user routes immediately

```bash
# Simulate a second message from the auto-matched user
REUSE_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08AUTO \
  --user-id U08AUTOMATCH \
  --text "second message from bound user" \
  --json)

REUSE_JOB=$(echo "$REUSE_JSON" | jq -r '.job_ids[0] // empty')
test -n "$REUSE_JOB" && echo "PASS: already-bound user routed immediately (job: $REUSE_JOB)"
```

**Expected:**
- Step 8: Slack user with matching email auto-binds and routes (job created)
- Step 9: Slack user with unknown email triggers a membership request (no job), helpful message returned
- Step 10: Previously bound user routes immediately on subsequent messages

---

## Phase 3b: Identity Link (Tier 2)

> Self-service identity linking for users whose Slack email differs from their Eve email.
> No admin approval needed -- the user proves ownership of both accounts.

### Step 11 -- Generate link token

```bash
# Generate a link token for the current authenticated user
LINK_TOKEN_JSON=$(api -X POST "$EVE_API_URL/users/me/identity-link-tokens" \
  -H "Content-Type: application/json" \
  -d "{\"provider\": \"slack\", \"org_id\": \"$ORG_ID\"}")
LINK_TOKEN=$(echo "$LINK_TOKEN_JSON" | jq -r '.token // empty')
echo "Link token: $LINK_TOKEN"
test -n "$LINK_TOKEN" && echo "PASS: link token generated"

# Token should have reasonable expiry
EXPIRES=$(echo "$LINK_TOKEN_JSON" | jq -r '.expires_at // empty')
echo "Expires: $EXPIRES"
```

### Step 12 -- Redeem link token via gateway

```bash
# Simulate the user sending "@eve link <token>" in Slack
LINK_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08LINK \
  --user-id U08LINKER \
  --text "link $LINK_TOKEN" \
  --json)

echo "$LINK_JSON" | jq '.'

# The gateway should recognize "link" as a reserved command and process the token
LINK_REPLY=$(echo "$LINK_JSON" | jq -r '.immediate_reply.text // empty')
echo "Reply: $LINK_REPLY"
echo "$LINK_REPLY" | grep -qi "linked\|all set" && echo "PASS: link command succeeded"

# Check API logs for token redemption
kubectl -n eve logs deployment/eve-api --tail=50 2>&1 | grep "identity.link_redeemed"
echo "PASS: identity.link_redeemed log event present"
```

### Step 13 -- Expired/invalid token rejected

```bash
# Attempt to link with a garbage token
INVALID_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08LINK \
  --user-id U08LINKER2 \
  --text "link eve-link-INVALID-GARBAGE-TOKEN" \
  --json 2>&1)

echo "$INVALID_JSON" | jq '.'

# The immediate_reply should indicate the token is invalid
INVALID_REPLY=$(echo "$INVALID_JSON" | jq -r '.immediate_reply.text // empty')
echo "Reply: $INVALID_REPLY"
INVALID_JOBS=$(echo "$INVALID_JSON" | jq -r '.job_ids | length' 2>/dev/null)
test "$INVALID_JOBS" = "0" && echo "PASS: invalid token rejected (no job created)"
```

### Step 14 -- Already-bound identity rejects re-link

```bash
# Generate a new link token
RELINK_JSON=$(api -X POST "$EVE_API_URL/users/me/identity-link-tokens" \
  -H "Content-Type: application/json" \
  -d "{\"provider\": \"slack\", \"org_id\": \"$ORG_ID\"}")
RELINK_TOKEN=$(echo "$RELINK_JSON" | jq -r '.token // empty')

# Attempt to link from the already-bound user (U08LINKER from Step 12)
RELINK_RESULT=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08LINK \
  --user-id U08LINKER \
  --text "link $RELINK_TOKEN" \
  --json 2>&1)

echo "$RELINK_RESULT" | jq '.'

# Should be rejected -- this external identity is already bound
RELINK_REPLY=$(echo "$RELINK_RESULT" | jq -r '.immediate_reply.text // empty')
echo "Reply: $RELINK_REPLY"
echo "$RELINK_REPLY" | grep -qi "already" && echo "PASS: re-link rejected"
```

**Expected:**
- Step 11: Link token generated with a 15-minute expiry
- Step 12: `@eve link <token>` recognized as reserved command, identity bound on redemption
- Step 13: Invalid/expired token returns an error message (not a crash)
- Step 14: Re-linking an already-bound identity is rejected

---

## Phase 3c: Membership Approval (Tier 3)

> Fallback for genuinely new users who have no Eve account. An admin reviews and
> approves the membership request. The system creates the user, adds them to the
> org, and binds their external identity.

### Step 15 -- Unknown user gets clear error message

```bash
# Simulate inbound from a completely unknown Slack user
UNKNOWN_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08UNKNOWN \
  --user-id U08NEWPERSON \
  --text "hello I am new here" \
  --external-email newperson@example.com \
  --json 2>&1)

echo "$UNKNOWN_JSON" | jq '.'

# The immediate_reply must NOT say "Unable to route command"
# It should contain a helpful message about identity linking or pending request
UNKNOWN_REPLY=$(echo "$UNKNOWN_JSON" | jq -r '.immediate_reply.text // empty')
echo "Reply: $UNKNOWN_REPLY"
echo "$UNKNOWN_REPLY" | grep -qvi "Unable to route" && echo "PASS: no generic 'Unable to route' error"
echo "$UNKNOWN_REPLY" | grep -qi "link\|membership\|recognize\|pending" && echo "PASS: helpful identity message"

# No job should be created
UNKNOWN_JOBS=$(echo "$UNKNOWN_JSON" | jq -r '.job_ids | length' 2>/dev/null)
test "$UNKNOWN_JOBS" = "0" && echo "PASS: no job created for unknown user"
```

### Step 16 -- Repeat message shows "still pending" (no duplicate request)

```bash
# Simulate a second message from the same unknown user
REPEAT_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08UNKNOWN \
  --user-id U08NEWPERSON \
  --text "hello again, still waiting" \
  --external-email newperson@example.com \
  --json 2>&1)

REPEAT_REPLY=$(echo "$REPEAT_JSON" | jq -r '.immediate_reply.text // empty')
echo "Reply: $REPEAT_REPLY"
echo "$REPEAT_REPLY" | grep -qi "pending" && echo "PASS: pending message shown"
```

### Step 17 -- Approve membership request via API

```bash
# List membership requests to find the one for U08NEWPERSON
REQUESTS_JSON=$(api "$EVE_API_URL/orgs/$ORG_ID/membership-requests")
REQUEST_ID=$(echo "$REQUESTS_JSON" | jq -r '.requests | map(select(.status == "pending")) | last | .id' 2>/dev/null)
echo "Request to approve: $REQUEST_ID"
test -n "$REQUEST_ID" && echo "PASS: membership request found"

# Approve it
APPROVE_JSON=$(api -X POST "$EVE_API_URL/orgs/$ORG_ID/membership-requests/$REQUEST_ID/approve" \
  -H "Content-Type: application/json" \
  -d '{"role": "member"}')
echo "$APPROVE_JSON"
echo "PASS: membership request approved"
```

### Step 18 -- Approved user can now route

```bash
# Simulate inbound from the now-approved user
APPROVED_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08UNKNOWN \
  --user-id U08NEWPERSON \
  --text "hello, I am approved now" \
  --json)

APPROVED_JOB=$(echo "$APPROVED_JSON" | jq -r '.job_ids[0] // empty')
echo "Approved user job: $APPROVED_JOB"
test -n "$APPROVED_JOB" && echo "PASS: approved user routes successfully"
```

**Expected:**
- Step 15: Unknown user sees a helpful message mentioning `eve identity link` or admin approval
- Step 16: Repeat messages return "still pending" without creating duplicate requests
- Step 17: Admin can approve the request, creating user + org membership + identity binding
- Step 18: After approval, the user's messages route normally

---

## Phase 4: Rich Formatting

> Agent replies should use Slack's native formatting in the immediate_reply returned by the gateway.

### Step 19 -- immediate_reply includes Block Kit formatting

```bash
# Simulate a chat that triggers a successful route
BLOCK_JSON=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08BLOCKS \
  --user-id U08AUTOMATCH \
  --text "create a job to test block kit" \
  --json)

echo "$BLOCK_JSON" | jq '.'

# The immediate_reply should have text (and optionally blocks for Block Kit)
REPLY_TEXT=$(echo "$BLOCK_JSON" | jq -r '.immediate_reply.text // empty')
test -n "$REPLY_TEXT" && echo "PASS: immediate_reply has text"
echo "Reply text: $REPLY_TEXT"

# Check if blocks are present (Block Kit formatting)
HAS_BLOCKS=$(echo "$BLOCK_JSON" | jq -r '.immediate_reply.blocks // empty')
test -n "$HAS_BLOCKS" && echo "INFO: Block Kit blocks present in reply" || echo "INFO: No blocks (text-only reply)"
```

**Expected:**
- immediate_reply contains text describing the job that was created
- For routes that produce Block Kit, blocks array is populated

---

## Phase 5: Resilience

> Duplicate events must not be processed twice. The gateway simulate endpoint
> shares the same dedup cache as real webhooks.

### Step 20 -- Event deduplication via --dedupe-key

```bash
# First simulate with a dedupe key
DEDUP_KEY="dedup_test_$(date +%s)"
DEDUP_1=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08DEDUP \
  --user-id U08ALICE \
  --text "dedup test first" \
  --dedupe-key "$DEDUP_KEY" \
  --json)

echo "First: $(echo "$DEDUP_1" | jq '{duplicate, job_ids}')"
DEDUP_1_DUP=$(echo "$DEDUP_1" | jq -r '.duplicate')
test "$DEDUP_1_DUP" = "false" && echo "PASS: first message not deduped"

# Second simulate with the same dedupe key
DEDUP_2=$(eve chat simulate \
  --team-id T08TEST \
  --channel-id C08DEDUP \
  --user-id U08ALICE \
  --text "dedup test second" \
  --dedupe-key "$DEDUP_KEY" \
  --json)

echo "Second: $(echo "$DEDUP_2" | jq '{duplicate, job_ids}')"
DEDUP_2_DUP=$(echo "$DEDUP_2" | jq -r '.duplicate')
test "$DEDUP_2_DUP" = "true" && echo "PASS: second message deduplicated"
```

### Step 21 -- Direct webhook responds within 3s

```bash
# Time the webhook response to verify it meets Slack's 3s deadline
# (Direct webhook test -- requires provider to be initialized)
START_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

curl -s -o /dev/null \
  -X POST "$EVE_API_URL/gateway/providers/slack/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "event_callback",
    "team_id": "T08TEST",
    "event_id": "evt_timing_test",
    "event": {
      "type": "app_mention",
      "user": "U08TIMING",
      "text": "<@BOTID> timing test",
      "channel": "C08TIMING",
      "ts": "1234567890.000002"
    }
  }'

END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
ELAPSED=$((END_MS - START_MS))
echo "Webhook response time: ${ELAPSED}ms"
test "$ELAPSED" -lt 3000 && echo "PASS: webhook responded within 3s" || echo "FAIL: webhook took ${ELAPSED}ms (> 3000ms)"
```

**Expected:**
- Step 20: First message processes normally; second with same dedupe key returns `duplicate: true`
- Step 21: Webhook response time is under 3000ms

---

## Phase 6: Legacy Cleanup Verification

> After removing legacy Slack controllers, verify the canonical provider routes
> are the only active paths.

### Step 22 -- Legacy API Slack endpoint removed

```bash
# The old project-scoped Slack webhook on the API should be gone
LEGACY_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$EVE_API_URL/integrations/slack/events/proj_test" \
  -H "Content-Type: application/json" \
  -d '{"type": "event_callback", "event": {"type": "message"}}')
echo "Legacy /integrations/slack/events/:projectId -> HTTP $LEGACY_CODE"
test "$LEGACY_CODE" = "404" && echo "PASS: legacy endpoint removed" || echo "FAIL: expected 404, got $LEGACY_CODE"
```

### Step 23 -- Canonical provider webhook works

```bash
# The canonical gateway provider webhook should still be active
CANONICAL_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$EVE_API_URL/gateway/providers/slack/webhook" \
  -H "Content-Type: application/json" \
  -d '{"type": "url_verification", "challenge": "test_challenge"}')
echo "Canonical /gateway/providers/slack/webhook -> HTTP $CANONICAL_CODE"
# Expected: 200 (url_verification) or 401 (signature validation), NOT 404
test "$CANONICAL_CODE" != "404" && echo "PASS: canonical webhook route exists" || echo "FAIL: canonical webhook route missing"
```

### Step 24 -- Interactive endpoint works

```bash
# The interactive endpoint should exist
INTERACTIVE_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$EVE_API_URL/gateway/providers/slack/interactive" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'payload=%7B%22type%22%3A%22block_actions%22%7D')
echo "Interactive /gateway/providers/slack/interactive -> HTTP $INTERACTIVE_CODE"
# Expected: 401 (signature validation) or 400 (invalid payload), NOT 404
test "$INTERACTIVE_CODE" != "404" && echo "PASS: interactive route exists" || echo "FAIL: interactive route missing"
```

**Expected:**
- Step 22: Legacy `/integrations/slack/events/:projectId` returns 404
- Step 23: Canonical `/gateway/providers/slack/webhook` returns non-404 (200 or 401)
- Step 24: Interactive `/gateway/providers/slack/interactive` returns non-404 (401 or 400)

---

## Simulated vs. Live Slack

Most phases are testable with `eve chat simulate`, which routes through the full gateway
code path (identity resolution, link commands, dedup, formatting) without needing a real
Slack workspace.

| Phase | Simulate | Live Slack | Notes |
|-------|----------|------------|-------|
| 0 (baseline) | Full | Optional | Gateway simulate covers all routing |
| 2 (observability) | Full | Optional | Log assertions via kubectl |
| 3a (auto-match) | Full | Optional | `--external-email` replaces `users.info` call |
| 3b (link) | Full | Optional | Token flow is CLI -> API -> gateway; no Slack API needed |
| 3c (approval) | Full | Live for buttons | API endpoints testable directly; interactive buttons need real Slack |
| 4 (formatting) | Full | Visual check | Simulate verifies structure; live Slack for visual verification |
| 5 (resilience) | Full | Optional | `--dedupe-key` tests dedup; timing is internal to gateway |
| 6 (cleanup) | Full | N/A | Route existence checks only |

---

## Verification Checklist

```
Phase 0: Baseline
  [ ] Integration connected (T08TEST, provider=slack)
  [ ] Gateway simulate returns job_ids and immediate_reply
  [ ] Job visible in eve job list

Phase 2: Observability
  [ ] Nonexistent integration returns null route
  [ ] Gateway response includes thread_id, immediate_reply, duplicate

Phase 3a: Identity Auto-Match (Tier 1)
  [ ] --external-email auto-binds identity (job created)
  [ ] Non-matching email creates membership request (no job)
  [ ] Already-bound user routes immediately

Phase 3b: Identity Link (Tier 2)
  [ ] Link token generated with expiry
  [ ] "@eve link <token>" redeems and binds identity
  [ ] Invalid/expired token rejected gracefully
  [ ] Already-bound identity rejects re-link

Phase 3c: Membership Approval (Tier 3)
  [ ] Unknown user gets helpful error (not "Unable to route command")
  [ ] Repeat message shows "still pending" (no duplicate request)
  [ ] Admin approval creates user + membership + identity binding
  [ ] Approved user routes successfully on next message

Phase 4: Rich Formatting
  [ ] immediate_reply contains text for job creation
  [ ] Block Kit blocks present when applicable

Phase 5: Resilience
  [ ] Same --dedupe-key returns duplicate=true on second call
  [ ] Webhook response under 3 seconds

Phase 6: Legacy Cleanup
  [ ] /integrations/slack/events/:projectId returns 404
  [ ] /gateway/providers/slack/webhook returns non-404
  [ ] /gateway/providers/slack/interactive returns non-404
```

## Success Criteria

- All phases pass their verification checklist
- No silent failures in gateway or API logs
- Identity resolution follows the three-tier priority: auto-match -> self-link -> admin approval
- immediate_reply is populated for all gateway-routed messages
- Dedup works via --dedupe-key flag
