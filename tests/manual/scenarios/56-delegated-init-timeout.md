# Scenario 56: Delegated Init Timeout

**Time:** ~3-5 minutes
**Parallel Safe:** No
**LLM Required:** No

Validates that a delegated child attempt that is claimed but never reaches
runtime acceptance is failed with `attempt_init_timeout`, and a lead job waiting
on that child does not remain stuck.

## Prerequisites

- Local k3d stack is running and owned by this checkout.
- `EVE_API_URL=http://api.eve.lvh.me`.
- `eve auth status` is authenticated against the local API.

## Setup

Use a short local-only init timeout:

```bash
./bin/eh kubectl -n eve set env deploy/eve-orchestrator \
  EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS=20 \
  EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS=30
./bin/eh kubectl -n eve rollout status deploy/eve-orchestrator --timeout=180s
```

Create a project:

```bash
export ORG_ID=org_manualtestorg

eve project ensure \
  --org $ORG_ID \
  --name delegated-init-timeout \
  --slug dinit \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>
```

Pause the orchestrator so the child can be claimed manually without dispatch:

```bash
export ORCH_REPLICAS=$(./bin/eh kubectl -n eve get deploy eve-orchestrator -o jsonpath='{.spec.replicas}')
./bin/eh kubectl -n eve scale deploy/eve-orchestrator --replicas=0
./bin/eh kubectl -n eve rollout status deploy/eve-orchestrator --timeout=180s
```

## Steps

### 1. Create A Wedged Child Attempt

```bash
eve job create \
  --project $PROJECT_ID \
  --phase backlog \
  --description "delegated child that will remain claimed before runtime acceptance" \
  --json
export CHILD_JOB_ID=<id_from_output>

eve job update $CHILD_JOB_ID --phase ready --json
eve job claim $CHILD_JOB_ID --agent delegated-worker --json
```

**Expected:**
- `eve job attempts $CHILD_JOB_ID --json` shows a running attempt.
- The attempt has `execution_started_at: null`.

### 2. Create A Lead Waiting On The Child

```bash
eve job create \
  --project $PROJECT_ID \
  --phase ready \
  --description "lead job waiting for delegated child" \
  --json
export LEAD_JOB_ID=<id_from_output>

eve job dep add $LEAD_JOB_ID $CHILD_JOB_ID --type waits_for --json
```

**Expected:**
- The lead depends on the child with relation `waits_for`.

### 3. Restore Orchestrator And Wait

```bash
./bin/eh kubectl -n eve scale deploy/eve-orchestrator --replicas="${ORCH_REPLICAS:-1}"
./bin/eh kubectl -n eve rollout status deploy/eve-orchestrator --timeout=180s

eve job wait $CHILD_JOB_ID --timeout 120 || true
eve job show $CHILD_JOB_ID --json
eve job show $LEAD_JOB_ID --json
```

**Expected:**
- The child leaves `active` within the init timeout window.
- The lead also leaves a waiting/ready loop; it is terminal or otherwise no
  longer blocked indefinitely by the child.

### 4. Inspect Diagnostics

```bash
eve job diagnose $CHILD_JOB_ID
eve job result $CHILD_JOB_ID --format json
eve job dep list $LEAD_JOB_ID
```

**Expected:**
- `diagnose` renders `Error Code: attempt_init_timeout`.
- Result JSON includes `"error_code": "attempt_init_timeout"`.
- The lead dependency is no longer an unbounded blocker.

## Cleanup

Restore orchestrator timeout defaults:

```bash
./bin/eh kubectl -n eve set env deploy/eve-orchestrator \
  EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS- \
  EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS-
./bin/eh kubectl -n eve rollout status deploy/eve-orchestrator --timeout=180s
```

## Success Criteria

- [ ] Claimed child attempt with null `execution_started_at` is reaped.
- [ ] Child attempt result has `error_code: attempt_init_timeout`.
- [ ] `eve job diagnose` renders the classified init-timeout failure.
- [ ] Lead job is not left waiting indefinitely on the child.
