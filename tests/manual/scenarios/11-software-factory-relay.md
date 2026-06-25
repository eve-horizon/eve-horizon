# Scenario 11: Software Factory Relay Chain

**Time:** ~10-15m  
**Parallel Safe:** No (creates/pushes a feature branch)  
**LLM Required:** Yes (claude + codex harnesses)

Validates the end-to-end factory relay chain: PM -> Planner -> Coder -> Verifier.

This scenario assumes the `software-factory` AgentPack is installed into the
`eve-horizon-fullstack-example` repo via `.eve/manifest.yaml`, and that you
have OAuth credentials synced to the org for both the `claude` and `codex`
harnesses.

## What This Tests

| Layer | Control | Verified By |
|-------|---------|-------------|
| AgentPack resolution | Factory pack resolves with agents + teams + chat | `eve agents config --json` |
| Relay dispatch | Team dispatch creates a relay chain | `eve job tree` shows PM->Planner->Coder->Verifier |
| Harness auth | OAuth tokens injected into jobs | Smoke jobs + relay jobs complete |
| Coordination thread | Handoff summaries captured | `eve thread messages` |
| Git workflow | Branch + commits produced | job logs mention branch/commits |

## Prerequisites

- `EVE_API_URL` set (see main README)
- `eve-horizon-fullstack-example` exists at `../eve-horizon-fullstack-example`
- `eve-software-factory` exists at `../eve-software-factory`
- Factory pack installed into the example manifest:
  - Verify `../eve-horizon-fullstack-example/.eve/manifest.yaml` includes `x-eve.packs: - source: ../eve-software-factory`

OAuth tokens:

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}

eve auth creds
eve auth sync --org $ORG_ID

# Expect these org secrets (metadata only):
eve secrets list --org $ORG_ID --json | jq -r '.data[].key' | rg "CLAUDE_CODE_OAUTH_TOKEN|CODEX_AUTH_JSON_B64|CODEX_OAUTH_ACCESS_TOKEN"
```

## Setup

Re-use the stable fullstack-example manual test project from Scenario 10 (recommended).
If you have not run Scenario 10, create/ensure it first.

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
export FULLSTACK_DIR=../eve-horizon-fullstack-example

# 1) Ensure project (same as Scenario 10)
PROJECT_JSON=$(eve project ensure \
  --org $ORG_ID \
  --name "fullstack-example" \
  --slug fstack \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json)
PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.id')

# 2) Sync agents with local pack resolution (reads ../eve-software-factory)
eve agents sync \
  --project $PROJECT_ID \
  --repo-dir $FULLSTACK_DIR \
  --allow-dirty \
  --local

# 3) Connect Slack integration (stub OAuth) so chat simulate works
eve integrations slack connect --org $ORG_ID --team-id T123 --token xoxb-test
```

## Steps

### 1) Verify Factory Route + Team Dispatch

```bash
# Triggering chat routing is the easiest end-to-end validation that:
# - route_factory exists and is selected over route_default
# - team:factory exists
# - dispatch mode is relay (sequential chain)
CHAT_JSON=$(eve chat simulate \
  --project $PROJECT_ID \
  --team-id T123 \
  --channel-id C123 \
  --user-id U123 \
  --text "factory [sf11] (dry run) create a brief/spec/plan only; no code changes yet" \
  --json)

echo "$CHAT_JSON" | jq '{route_id, thread_id, job_ids}'
```

**Expected:**
- `route_id: "route_factory"`
- a `thread_id`
- one `job_ids[0]` (the parent/lead job)

### 2) Trigger Factory Run via Chat Simulate

Use a request that is small but exercises planning + coding. Include a unique marker
so the PM chooses a unique branch slug if it derives from the prompt.

```bash
CHAT_JSON=$(eve chat simulate \
  --project $PROJECT_ID \
  --team-id T123 \
  --channel-id C123 \
  --user-id U123 \
  --text "factory [sf11] Add a /health endpoint that returns JSON { status: ok, timestamp: <iso> }. Include tests." \
  --json)

THREAD_ID=$(echo "$CHAT_JSON" | jq -r '.thread_id')
LEAD_JOB_ID=$(echo "$CHAT_JSON" | jq -r '.job_ids[0]')

echo "Thread: $THREAD_ID"
echo "Lead job: $LEAD_JOB_ID"
```

### 3) Verify Relay Chain Structure

```bash
eve job tree $LEAD_JOB_ID
```

**Expected:** job tree shows a 4-step chain (parent + 3 children), where each child depends on the previous.

Verify dependencies + assignees:

```bash
eve job show $LEAD_JOB_ID --json | jq '{id, assignee, phase}'
eve job show ${LEAD_JOB_ID}.1 --json | jq '{id, assignee, phase}'
eve job show ${LEAD_JOB_ID}.2 --json | jq '{id, assignee, phase}'
eve job show ${LEAD_JOB_ID}.3 --json | jq '{id, assignee, phase}'

eve job dep list ${LEAD_JOB_ID}.2
```

**Expected assignees:**
- Parent: `factory_pm`
- Child 1: `factory_planner`
- Child 2: `factory_coder`
- Child 3: `factory_verifier`

### 4) Follow / Wait For Completion

```bash
eve job follow $LEAD_JOB_ID
# or:
eve job wait $LEAD_JOB_ID --timeout 900
```

**Expected:** all jobs end in `phase: done`.

### 5) Verify Coordination Thread

```bash
eve thread messages $THREAD_ID
```

**Expected:** at least 4 messages in chronological order (PM -> Planner -> Coder -> Verifier) summarizing handoffs.

## Success Criteria

- [ ] Factory pack resolves (agents/teams/routes present)
- [ ] `eve chat simulate` creates a job routed to the `factory` team
- [ ] Relay chain exists (4 jobs, correct ordering)
- [ ] All 4 jobs complete successfully
- [ ] Thread contains handoff summaries

## Debugging

```bash
eve job diagnose <job-id>
eve job logs <job-id>
eve system logs worker --tail 80
```

Auth:

```bash
eve auth creds
eve auth sync --org $ORG_ID
eve secrets list --org $ORG_ID --json
```
