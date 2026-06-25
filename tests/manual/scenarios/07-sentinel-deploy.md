# Scenario 07: Sentinel Manager Deploy & Self-Update Flow

**Time:** ~5 minutes
**Parallel Safe:** No (uses shared namespace)
**LLM Required:** No (tests job creation, not execution)

Tests deploying the reference-app reference app and verifying its
self-update flow, where the app calls the Eve API to create a job that would
implement sentinel code, commit, rebuild, and redeploy.

> **Note:** Deployed app URLs use `CLUSTER_DOMAIN` (default: `lvh.me` for local k3d).
> Set `export CLUSTER_DOMAIN=<your-domain>` for other clusters.

## Prerequisites

- Smoke tests pass (scenario 01)
- Deploy flow works (scenario 05)
- A `reference-app`-compatible repo, for example `https://github.com/example-org/reference-app`

### Required Secrets

All secrets from `manual-tests.secrets` plus:

- `POSTGRES_PASSWORD` — database password (set to `eve`)
- `EVE_API_TOKEN` — minted via `eve auth mint` (see step 2)
- `EVE_API_URL` — internal Eve API URL (`http://eve-api.eve.svc.cluster.local:4701`)

## Setup

```bash
export ORG_ID=org_manualtestorg
```

### 1. Create Project (Private Repo)

The reference-app repo is private. Embed a GitHub token in the repo URL so
the worker can clone during build and smoke-test steps.

```bash
# Read GITHUB_TOKEN from secrets file
GITHUB_TOKEN=$(grep GITHUB_TOKEN manual-tests.secrets | cut -d= -f2)

eve project ensure \
  --org $ORG_ID \
  --name "sentinel-manager" \
  --slug refapp \
  --repo-url "https://${GITHUB_TOKEN}@github.com/example-org/reference-app" \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>
```

### 2. Configure Secrets

```bash
# Import shared secrets (GITHUB_TOKEN, Z_AI_API_KEY)
eve secrets import --project $PROJECT_ID --file manual-tests.secrets

# Database
eve secrets set POSTGRES_PASSWORD eve --project $PROJECT_ID

# Mint a long-lived API token for the sentinel app to call Eve
eve auth mint \
  --email sentinel-bot@reference-app.eve \
  --project $PROJECT_ID \
  --role admin
# Copy the token from output

eve secrets set EVE_API_TOKEN <minted-token> --project $PROJECT_ID
eve secrets set EVE_API_URL http://eve-api.eve.svc.cluster.local:4701 --project $PROJECT_ID
```

### 3. Sync Manifest & Create Environment

```bash
# Clone repo and sync manifest
REPO_DIR=$(mktemp -d)/repo
git clone --depth 1 "https://${GITHUB_TOKEN}@github.com/example-org/reference-app" $REPO_DIR
eve project sync --project $PROJECT_ID --dir $REPO_DIR --json

# Create sandbox environment (manifest declares pipeline for `sandbox`)
eve env create sandbox --type persistent --project $PROJECT_ID --json
```

**Expected:**
- Manifest synced (services: api, web, db, migrate)
- Environment created with namespace `eve-mto-refapp-sandbox`

## Steps

### 4. Deploy via Pipeline

```bash
eve env deploy sandbox --ref main --repo-dir $REPO_DIR --project $PROJECT_ID
```

**Expected:**
- Pipeline `deploy` runs with 5 steps: build, release, deploy, migrate, smoke-test
- All steps complete successfully

Monitor progress:
```bash
eve job list --project $PROJECT_ID --json | \
  jq '[.jobs[] | select(.hints.pipeline_run_id == "<run_id>") | {name:.step_name, phase:.phase}]'
```

### 5. Verify Service Health

```bash
curl -s http://api.mto-refapp-sandbox.${CLUSTER_DOMAIN:-lvh.me}/health | jq
# Expected: {"ok":true,"database":"connected"}

curl -s http://api.mto-refapp-sandbox.${CLUSTER_DOMAIN:-lvh.me}/status | jq
# Expected: {"git_sha":"...","git_tag":"...","build_time":"..."}

curl -s http://api.mto-refapp-sandbox.${CLUSTER_DOMAIN:-lvh.me}/openapi.json | jq .info
# Expected: {"title":"Sentinel Manager API","version":"1.0.0"}
```

### 6. Test Self-Update Flow (Eve Job Creation)

This tests the core flow: the sentinel app calls the Eve API to create a job
that would implement sentinel logic for a compliance obligation.

```bash
# Auth for sentinel API
# NOTE: Local auth may be disabled in the sentinel app. If /auth/login returns
# "Local auth is disabled", use an Eve-minted token instead.

# Option A: Local auth (if enabled)
TOKEN=$(curl -s http://api.mto-refapp-sandbox.${CLUSTER_DOMAIN:-lvh.me}/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"admin123"}' | jq -r '.token')

# Option B: Eve token (recommended when local auth is disabled)
TOKEN=$(eve auth mint \
  --email sentinel-api-test@reference-app.eve \
  --project $PROJECT_ID \
  --role admin \
  --json | jq -r '.access_token')

# List seeded obligations (6 total, all deployed: false)
curl -s http://api.mto-refapp-sandbox.${CLUSTER_DOMAIN:-lvh.me}/obligations \
  -H "Authorization: Bearer $TOKEN" | jq '[.[] | {id:.id, name:.name, deployed:.deployed}]'
```

Pick any obligation and trigger deploy:

```bash
export OBLIGATION_ID=<id_from_list>

# Trigger sentinel deploy (creates Eve job)
curl -s http://api.mto-refapp-sandbox.${CLUSTER_DOMAIN:-lvh.me}/obligations/$OBLIGATION_ID/deploy \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" | jq
```

**Expected:**
- HTTP 201 with deployment job (status: `pending`)
- After 2-3 seconds, status transitions to `generating`

```bash
export DEPLOY_JOB_ID=<id_from_deploy_response>

# Check deployment status — should have an eve_job_id
curl -s "http://api.mto-refapp-sandbox.${CLUSTER_DOMAIN:-lvh.me}/deployments/$DEPLOY_JOB_ID/status" \
  -H "Authorization: Bearer $TOKEN" | jq '{status, current_step, eve_job_id, error}'
```

**Expected:**
- `eve_job_id` is non-null (e.g., `refapp-7f6e1692`)
- `status` is `generating`
- `error` is null

### 7. Verify Eve Job Exists

```bash
# Confirm the Eve job was created with correct metadata
eve job show <eve_job_id> --project $PROJECT_ID --json | \
  jq '{id:.id, phase:.phase, title:.title, labels:.labels, description:.description}'
```

**Expected:**
- Phase: `ready` or `active`
- Labels: `["sentinel-implement"]`
- Description contains the obligation name, path, region, and regulatory text

### 8. Verify DB Persists Across Redeploy

This confirms PVC-backed storage keeps Postgres data across redeploys.

```bash
# Insert a marker row via Eve env DB access
# `eve db sql` uses the active profile project context.
# Set it once for this scenario:
eve profile set --org $ORG_ID --project $PROJECT_ID

MARKER=$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)

eve db sql --env sandbox --write \
  --sql "create table if not exists persistence_check(id serial primary key, value text, created_at timestamptz default now())"

eve db sql --env sandbox --write \
  --sql "insert into persistence_check(value) values (\$1)" \
  --params "[\"$MARKER\"]"

# Redeploy the environment
eve env deploy sandbox --ref main --repo-dir $REPO_DIR --project $PROJECT_ID

> **Warning:** Do not reset the database immediately before this redeploy.
> The pipeline runs a `migrate` step that may recreate the schema on a fresh
> DB, defeating the persistence check. If you need a clean DB, run the full
> deploy pipeline first, *then* insert the marker row and redeploy.

# Verify the marker row is still present
eve db sql --env sandbox \
  --sql "select value from persistence_check where value = \$1" \
  --params "[\"$MARKER\"]"
```

**Expected:**
- Query returns the marker value after redeploy

## Success Criteria

- [ ] Manifest synced and environment created
- [ ] Pipeline completes (build, release, deploy, migrate, smoke-test)
- [ ] API health check returns `{"ok":true,"database":"connected"}`
- [ ] Login returns JWT token
- [ ] Obligations listed (6 seeded)
- [ ] Deploy creates deployment job (HTTP 201)
- [ ] Deployment job creates Eve job (eve_job_id populated)
- [ ] Eve job exists with correct description and labels
- [ ] DB marker row persists across redeploy

## Known Issues

- **Private repo auth**: The repo URL must embed a GITHUB_TOKEN for clone to
  work during build and script steps. Without it, `git clone` fails with 404.
- **Orchestrator in-flight stall**: If pipeline steps stay `ready` indefinitely,
  check for stale jobs from other projects blocking the in-flight counter
  (see bug eve-horizon-142). Cancel stale jobs and restart orchestrator.

## Debugging

```bash
# Environment diagnostics
eve env diagnose $PROJECT_ID test --json

# API logs
eve env logs $PROJECT_ID test api --tail 200

# Check deployment job error from sentinel API
curl -s "http://api.mto-refapp-test.${CLUSTER_DOMAIN:-lvh.me}/deployments/$DEPLOY_JOB_ID/status" \
  -H "Authorization: Bearer $TOKEN" | jq .error
```

## Cleanup

```bash
eve env delete test --project $PROJECT_ID --force
rm -rf $REPO_DIR
```
