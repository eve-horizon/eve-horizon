# Scenario 34: Per-Job Harness Profile and Env Overrides

**Time:** ~8-12 minutes
**Parallel Safe:** No (needs dedicated project, uses a unique-named org secret)
**LLM Required:** Yes (zai harness)

End-to-end validation of the per-job harness override plan.

Phase 1 (R1, R6, R7, R8): inline `harness_profile_override`, `env_overrides`
with `${secret.KEY}` interpolation, fail-fast missing-secret behaviour,
permission gating on `jobs:harness_override`, and precedence between a
string `harness_profile` ref and an inline bundle.

Phase 2 (R4): validation endpoint. No inference traffic, no billing.

Phase 3 (R2): chat hints propagation. Hints survive team fanout; coordination
thread carries the override snapshot; missing-secret errors surface back to
the originating chat thread.

Plan: [`docs/plans/per-job-harness-override-plan.md`](../../../docs/plans/per-job-harness-override-plan.md)

## Prerequisites

- Scenario 01 (smoke) is green.
- Scenario 02 (job execution) is green — establishes baseline (R6.1).
- K3d stack freshly deployed with migration 00090 applied:
  ```bash
  ./bin/eh k8s deploy
  eve system health --json
  ```
- Test org + secrets imported:
  ```bash
  eve org ensure "manual-test-org" --slug manual-test-org --json
  eve secrets import --org org_manualtestorg --file manual-tests.secrets
  ```

## Setup

```bash
export EVE_API_URL=http://api.eve.lvh.me
export ORG_ID=org_manualtestorg
```

Create a dedicated project pinned to the fullstack example repo — the agent
only needs to run `ls`, so repo choice is incidental:

```bash
eve project ensure \
  --org $ORG_ID \
  --name "per-job-override" \
  --slug pjo \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=$(eve project show pjo --json | jq -r '.id')
```

## Phase A — Baseline (R6.1)

Re-run scenario 02 against this stack. It MUST still pass: the new code must
not regress the default job-execution path when no override fields are sent.

```bash
# Expect: phase=done, exit code 0, same behaviour as before migration 00090.
eve job create --project $PROJECT_ID \
  --description "List the top-level files in the repository." \
  --harness zai \
  --json | tee /tmp/pjo-baseline.json
export BASELINE_JOB_ID=$(jq -r '.id' /tmp/pjo-baseline.json)
eve job wait $BASELINE_JOB_ID --timeout 300
eve job show $BASELINE_JOB_ID --json | jq '{phase, harness_profile_source, harness_profile_hash}'
```

**Assertions:**
- `phase == "done"`
- `harness_profile_source == null` (no override or profile provided)
- `harness_profile_hash == null`

## Phase B — Inline override, single request (R1, R6)

Write an inline bundle file and create a job with it. This exercises the API
schema, the jobs service projection into `jobs.harness`/`harness_options`, the
routing log attribution, and end-to-end execution on the overridden harness.

```bash
cat > /tmp/pjo-override.json <<'EOF'
{
  "harness": "zai",
  "model": "glm-4.6",
  "reasoning_effort": "medium"
}
EOF

eve job create --project $PROJECT_ID \
  --description "Print the Node.js version and exit." \
  --harness-override-file /tmp/pjo-override.json \
  --json | tee /tmp/pjo-inline.json
export INLINE_JOB_ID=$(jq -r '.id' /tmp/pjo-inline.json)
```

**Persistence assertions (before wait):**
```bash
eve job show $INLINE_JOB_ID --json \
  | jq '{harness, harness_profile_override, harness_profile_source, harness_profile_hash}'
```
Expect:
- `harness == "zai"` — projection landed on the legacy column the orchestrator reads
- `harness_profile_override.harness == "zai"` — raw bundle preserved
- `harness_profile_source == "inline_override"`
- `harness_profile_hash` is a 16-char hex string (not null)

**Execution assertions:**
```bash
eve job wait $INLINE_JOB_ID --timeout 300
eve job diagnose $INLINE_JOB_ID --json \
  | jq '.execution_logs[] | select(.type=="routing") | .line'
```
Expect the routing log line to include:
- `harness: "zai"` (effective)
- `harness_profile_source: "inline_override"`
- `harness_profile_hash` matching the job row
- `effective_model: "glm-4.6"`

## Phase C — Env overrides with secret interpolation (R7)

Set a named test secret and reference it from `env_overrides`. Verify the
placeholder is preserved in the API response (R7.3) and that the resolved
value never appears in logs.

```bash
eve secrets set EDEN_TEST_BASE_URL "https://test.provider.example" --org $ORG_ID

eve job create --project $PROJECT_ID \
  --description "Echo nothing; just exit 0." \
  --harness-override-file /tmp/pjo-override.json \
  --env-override "ANTHROPIC_BASE_URL=\${secret.EDEN_TEST_BASE_URL}" \
  --json | tee /tmp/pjo-env.json
export ENV_JOB_ID=$(jq -r '.id' /tmp/pjo-env.json)
```

**Placeholder preservation (R7.3):**
```bash
eve job show $ENV_JOB_ID --json | jq '.env_overrides'
# Expected: { "ANTHROPIC_BASE_URL": "${secret.EDEN_TEST_BASE_URL}" }
```

**No plaintext in response body:**
```bash
eve job show $ENV_JOB_ID --json | grep -c 'test.provider.example' | tee /tmp/pjo-env-leak.txt
# Expected: 0 (count must be zero)
```

**Execution reaches harness:**
```bash
eve job wait $ENV_JOB_ID --timeout 300
eve job show $ENV_JOB_ID --json | jq '.phase'
# Expected: "done" (the env var is set but harmlessly unused by `ls`)
```

## Phase D — Missing-secret fail-fast (R7.4)

Reference a secret that does not exist. The attempt must fail with a typed
provisioning error before any harness CLI is spawned.

```bash
eve job create --project $PROJECT_ID \
  --description "Should never execute — provisioning must fail first." \
  --env-override "ANTHROPIC_BASE_URL=\${secret.DOES_NOT_EXIST}" \
  --json | tee /tmp/pjo-missing.json
export MISSING_JOB_ID=$(jq -r '.id' /tmp/pjo-missing.json)

eve job wait $MISSING_JOB_ID --timeout 120 || true
eve job diagnose $MISSING_JOB_ID --json \
  | jq '{phase, close_reason, latest_attempt: .latest_attempt.error_message}'
```

Expected: the latest attempt's `error_message` includes
`missing_secret_override` and names `DOES_NOT_EXIST`. The job does not
consume harness tokens (no `llm.call` event for this attempt).

## Phase E — Permission gate (R8.3)

Create a service-principal / custom role that excludes `jobs:harness_override`
and verify the API returns 403 with the missing permission in the error body.

```bash
# Create a scoped role that has jobs:write but NOT jobs:harness_override
cat > /tmp/pjo-limited-role.json <<'EOF'
{
  "name": "pjo-limited",
  "permissions": ["jobs:read", "jobs:write", "projects:read"]
}
EOF
# Implementation depends on your preferred access-role CLI:
# eve access role create --org $ORG_ID --file /tmp/pjo-limited-role.json
# eve access bind --org $ORG_ID --principal <service_principal_id> --role pjo-limited

# Mint a token for that principal (or use eve service-principal token ...)
# and retry the override-bearing request; expect 403.

curl -sS -X POST "$EVE_API_URL/projects/$PROJECT_ID/jobs" \
  -H "Authorization: Bearer $SP_TOKEN_NO_OVERRIDE" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Should be rejected",
    "harness_profile_override": {"harness": "zai"}
  }' | tee /tmp/pjo-403.json

jq '.statusCode, .message' /tmp/pjo-403.json
```
Expected: statusCode 403, message includes `jobs:harness_override`.

## Phase F — Precedence: inline wins + single conflict warning (R6.3)

```bash
eve job create --project $PROJECT_ID \
  --description "Precedence test — inline must win." \
  --harness-profile "nonexistent-ref" \
  --harness-override-file /tmp/pjo-override.json \
  --json | tee /tmp/pjo-conflict.json
export CONFLICT_JOB_ID=$(jq -r '.id' /tmp/pjo-conflict.json)

eve job show $CONFLICT_JOB_ID --json \
  | jq '{harness, harness_profile, harness_profile_source}'
```
Expected:
- `harness == "zai"` (inline bundle's harness)
- `harness_profile == "nonexistent-ref"` (string ref stored for audit)
- `harness_profile_source == "inline_override"` (inline won)

Check the API logs for exactly one `harness.profile.conflict` warning — the
projection path logs it at create time via `console.warn`:
```bash
kubectl -n eve logs deployment/eve-api --since=5m \
  | grep 'harness.profile.conflict' | wc -l
# Expected: >= 1 (exactly the count of conflicting creates this scenario makes)
```

## Phase G — Validate endpoint dry-run (Phase 2 / R4)

Exercises the `POST /projects/{id}/harness-profile/validate` endpoint and
the `eve harness validate` CLI. No inference traffic, no billing — this must
be fast (<1s) and must not create any jobs.

```bash
# Well-formed override + resolved secret ref.
eve harness validate --project $PROJECT_ID \
  --profile-file /tmp/pjo-override.json \
  --env-override "ANTHROPIC_BASE_URL=\${secret.EDEN_TEST_BASE_URL}" \
  --json | tee /tmp/pjo-validate-ok.json

jq '{ok, harness: .harness.canonical, auth: .harness.auth.available, env_status: .env_overrides[0].status, resolved_at: .env_overrides[0].resolved_at}' /tmp/pjo-validate-ok.json
# Expected:
#   ok: true
#   harness: "zai"
#   auth: true
#   env_status: "resolved"
#   resolved_at: "org"   (or whichever scope you set EDEN_TEST_BASE_URL at)
```

```bash
# Missing secret ref: ok=false, per-ref status=missing with remediation hint.
eve harness validate --project $PROJECT_ID \
  --profile-file /tmp/pjo-override.json \
  --env-override "ANTHROPIC_BASE_URL=\${secret.DOES_NOT_EXIST}" \
  --json | tee /tmp/pjo-validate-missing.json

jq '{ok, env: .env_overrides}' /tmp/pjo-validate-missing.json
# Expected:
#   ok: false
#   env[0].status: "missing"
#   env[0].hint: mentions DOES_NOT_EXIST and how to set it
```

```bash
# Unknown harness: ok=false with an explanatory warning.
echo '{"harness":"bogus"}' > /tmp/pjo-bogus.json
eve harness validate --project $PROJECT_ID --profile-file /tmp/pjo-bogus.json --json \
  | jq '{ok, canonical: .harness.canonical, warnings: .warnings}'
# Expected: ok=false, canonical=null, at least one warning code="harness.unknown".
```

## Phase H — Chat hints propagation (Phase 3 / R2)

Verifies that `hints.harness_profile_override` on a chat simulate request
flows through to the lead + child jobs and is persisted on the coordination
thread metadata.

**Prerequisite**: scenario 08 (chat gateway) has been run at least once —
we need a route and a team in this project. If not, seed a minimal one:

```bash
# Assuming a team/route already exist; otherwise re-run scenario 08's setup
# steps to sync an agents config with at least one route + one team.
```

Fire a simulate payload carrying override hints:

```bash
curl -sS -X POST "$EVE_API_URL/projects/$PROJECT_ID/chat/simulate" \
  -H "Authorization: Bearer $EVE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "test",
    "team_id": "test-team",
    "user_id": "admin@example.com",
    "text": "@eve hello",
    "thread_key": "test:thread:pjo-phase-h",
    "hints": {
      "harness_profile_override": { "harness": "zai", "model": "glm-4.6" }
    }
  }' | tee /tmp/pjo-chat-hints.json

export CHAT_LEAD_ID=$(jq -r '.job_ids[0]' /tmp/pjo-chat-hints.json)
```

**Lead job carries the override:**
```bash
eve job show $CHAT_LEAD_ID --json \
  | jq '{harness, harness_profile_override, harness_profile_source}'
# Expected: harness="zai", override present, source="inline_override".
```

**Child jobs (if dispatch is fanout/council/relay) also carry the override:**
```bash
eve job list --parent $CHAT_LEAD_ID --json \
  | jq '.jobs[] | {id, harness, harness_profile_source}'
# Expected: every child has harness="zai" and source="inline_override".
```

**Coordination thread metadata shows the snapshot:**
```bash
# Coordination thread key is coord:job:<lead_id>
eve thread show "coord:job:$CHAT_LEAD_ID" --project $PROJECT_ID --json \
  | jq '.metadata_json.harness_overrides'
# Expected: { profile_override: {...}, env_overrides?: {...} } with placeholders intact.
```

**Legacy alias bridge** — the same override in `metadata.hints` is accepted:
```bash
curl -sS -X POST "$EVE_API_URL/projects/$PROJECT_ID/chat/simulate" \
  -H "Authorization: Bearer $EVE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "test",
    "team_id": "test-team",
    "user_id": "admin@example.com",
    "text": "@eve legacy alias",
    "thread_key": "test:thread:pjo-phase-h-legacy",
    "metadata": { "hints": { "harness_profile_override": { "harness": "zai" } } }
  }' | tee /tmp/pjo-chat-hints-legacy.json

export LEGACY_LEAD_ID=$(jq -r '.job_ids[0]' /tmp/pjo-chat-hints-legacy.json)
eve job show $LEGACY_LEAD_ID --json | jq '.harness_profile_source'
# Expected: "inline_override" — the legacy alias bridged to the typed path.
```

**Missing-secret delivery to chat thread (R2.3):**
```bash
curl -sS -X POST "$EVE_API_URL/projects/$PROJECT_ID/chat/simulate" \
  -H "Authorization: Bearer $EVE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "test",
    "team_id": "test-team",
    "user_id": "admin@example.com",
    "text": "@eve env override missing",
    "thread_key": "test:thread:pjo-phase-h-missing",
    "hints": {
      "env_overrides": { "ANTHROPIC_BASE_URL": "${secret.DOES_NOT_EXIST}" }
    }
  }' | tee /tmp/pjo-chat-missing.json

export MISSING_LEAD_ID=$(jq -r '.job_ids[0]' /tmp/pjo-chat-missing.json)

# The attempt should fail with missing_secret_override and an outbound thread
# message carrying the error should land on the chat thread.
eve job wait $MISSING_LEAD_ID --timeout 120 || true

# Check the thread for the ⚠️  missing_secret_override message.
eve thread messages "test:thread:pjo-phase-h-missing" --project $PROJECT_ID \
  --limit 10 --json | jq '.messages[] | select(.direction=="outbound") | .body'
# Expected: at least one outbound body matching "missing_secret_override.*DOES_NOT_EXIST".
```

## Success Criteria

- [ ] Phase A: baseline job (scenario 02 shape) still passes with
      `harness_profile_source == null`.
- [ ] Phase B: inline override is persisted raw, projected into
      `harness`/`harness_options`, emitted on routing log with source
      `inline_override`, harness executes.
- [ ] Phase C: `env_overrides` placeholder returned verbatim, no plaintext
      secret in API response, harness receives resolved value at spawn time.
- [ ] Phase D: missing secret produces typed `missing_secret_override`
      provisioning error BEFORE harness launch.
- [ ] Phase E: principal without `jobs:harness_override` gets 403 with the
      missing permission named in the error.
- [ ] Phase F: inline wins over string ref; one `harness.profile.conflict`
      warning emitted per conflicting request.
- [ ] Phase G: validate endpoint reports `ok=true` for a resolvable bundle,
      `ok=false` with `missing` status + remediation hint when a secret is
      absent, and `ok=false` with `warnings[code="harness.unknown"]` for an
      unknown harness. No job is created.
- [ ] Phase H: chat-originated lead + child jobs carry the override bundle;
      coordination thread `metadata_json.harness_overrides` contains the
      snapshot; legacy `metadata.hints` bridge works; missing-secret
      provisioning error is delivered as an outbound thread message.

## Cleanup

```bash
# Reusable project; no cleanup required. Delete the test secret if desired:
# eve secrets delete EDEN_TEST_BASE_URL --org $ORG_ID
rm -f /tmp/pjo-*.json /tmp/pjo-env-leak.txt /tmp/pjo-limited-role.json
```
