# Scenario 27: Claude Harness Auth (Setup-Token Durability)

**Time:** ~8-10 minutes
**Parallel Safe:** No (temporarily mutates org/project Claude secrets)
**LLM Required:** Yes (Claude harness)

Validates that managed `claude` jobs use durable setup-token auth. A project-scoped
`CLAUDE_CODE_OAUTH_TOKEN` setup-token must beat a broader org-scoped
`ANTHROPIC_API_KEY`, materialize as `.credentials.json` under the attempt-scoped
job HOME, scrub conflicting Claude auth env vars after `env_overrides`, and avoid
writing credential files under `repoPath`.

## Prerequisites

- Smoke tests pass (scenario 01)
- `manual-tests.secrets` contains `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...`
- Local k3d or target cluster is reachable through `EVE_API_URL`

## Setup

```bash
export ORG_ID=org_manualtestorg
export CLAUDE_SETUP_TOKEN=$(awk -F= '/^CLAUDE_CODE_OAUTH_TOKEN=/{print $2}' ./manual-tests.secrets)
test -n "$CLAUDE_SETUP_TOKEN"
```

## Steps

### 1. Create Test Project

```bash
export PROJECT_ID=$(eve project ensure \
  --org "$ORG_ID" \
  --name "claude-auth-test" \
  --slug clauth \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json | jq -r '.id')
echo "PROJECT_ID=$PROJECT_ID"
```

### 2. Seed Conflicting Claude Secrets

```bash
eve secrets set ANTHROPIC_API_KEY "sk-ant-api03-bogus-org-key" --org "$ORG_ID"
eve secrets set CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_SETUP_TOKEN" --project "$PROJECT_ID"
```

Expected: the project setup-token is selected even though an org API key exists.

### 3. Run Managed Auth Verify

```bash
eve auth verify --harness claude --project "$PROJECT_ID" --json \
  | tee /tmp/claude-auth-verify.json

jq -e '
  .ok == true
  and .scope_type == "project"
  and .secret_key == "CLAUDE_CODE_OAUTH_TOKEN"
  and .token_class == "setup-token"
  and .apiKeySource != "none"
' /tmp/claude-auth-verify.json
```

### 4. Run Two Managed Claude Jobs

```bash
for n in 1 2; do
  JOB_ID=$(eve job create \
    --project "$PROJECT_ID" \
    --description "Reply with exactly: EVE_AUTH_OK" \
    --harness claude \
    --json | jq -r '.id')
  eve job wait "$JOB_ID" --timeout 300 --json | tee "/tmp/claude-auth-job-$n.json"
  jq -e '.status == "succeeded" and (.resultText | contains("EVE_AUTH_OK"))' "/tmp/claude-auth-job-$n.json"
  eve job logs "$JOB_ID" --json | jq -e '
    .logs
    | map(select(.type == "claude_auth_selected"))
    | length >= 1
  '
done
```

Expected:
- Both jobs return `EVE_AUTH_OK`
- Each attempt logs `claude_auth_selected`
- Logs name the selected key/scope/class but do not include token bytes

### 5. Verify Invalid Setup-Token Fails Structured

```bash
eve secrets set CLAUDE_CODE_OAUTH_TOKEN "sk-ant-oat01-invalid-local-test" --project "$PROJECT_ID"

set +e
eve auth verify --harness claude --project "$PROJECT_ID" --json \
  | tee /tmp/claude-auth-invalid.json
VERIFY_EXIT=$?
set -e

test "$VERIFY_EXIT" -ne 0
jq -e '
  .ok == false
  and .secret_key == "CLAUDE_CODE_OAUTH_TOKEN"
  and .scope_type == "project"
' /tmp/claude-auth-invalid.json

eve secrets set CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_SETUP_TOKEN" --project "$PROJECT_ID"
```

### 6. Verify No Repo Credential Files

For local k3d:

```bash
kubectl -n eve exec statefulset/eve-agent-runtime -- sh -lc '
  find /opt/eve/workspaces -path "*/repo/.credentials.json" -o -path "*/repo/.claude/.credentials.json"
' | tee /tmp/claude-repo-credentials.txt

test "$(wc -l < /tmp/claude-repo-credentials.txt | tr -d " ")" = "0"
```

If the worker fallback path is active instead of agent-runtime, run the same
`find` in the worker pod.

## Success Criteria

- [ ] Project setup-token beats broader org API key
- [ ] `eve auth verify` returns `ok: true`, `scope_type: project`, `token_class: setup-token`
- [ ] Two managed `claude` jobs return `EVE_AUTH_OK`
- [ ] Invalid setup-token returns structured `ok: false` with key and scope
- [ ] `claude_auth_selected` / `claude_auth_failed` logs are redacted
- [ ] No `.credentials.json` exists under any job `repoPath`

## Troubleshooting

### `apiKeySource` is `none`

```bash
eve job diagnose "$JOB_ID"
eve job logs "$JOB_ID" --json | jq '.logs[] | select(.type | test("claude_auth"))'
```

Check that `CLAUDE_CONFIG_DIR` points to the attempt HOME, not
`.agent/harnesses/claude`, and that `claude_auth_selected.credentials_materialized`
is true for setup-token auth.

### 401 or Invalid Credentials

Run:

```bash
eve auth verify --harness claude --project "$PROJECT_ID" --json
```

If the selected token is a setup-token, regenerate it with `claude setup-token`
and re-sync/re-set `CLAUDE_CODE_OAUTH_TOKEN` at the project or org scope.
