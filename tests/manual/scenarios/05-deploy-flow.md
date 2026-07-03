# Scenario 05: Deploy Flow

**Time:** ~3 minutes
**Parallel Safe:** No (uses shared namespace)
**LLM Required:** No

Tests the deployment flow: sync manifest, deploy via pipeline, verify services.

## Prerequisites

- Smoke tests pass (scenario 01)
- Sufficient cluster resources

### Required Secrets

The following secrets must be created in the project before running this scenario:

- `GITHUB_TOKEN` — GitHub PAT for repo clone during build
- `POSTGRES_PASSWORD` — Database password (set to `eve` for testing)

## Setup

Use the stable manual test org:

```bash
export ORG_ID=org_manualtestorg

eve project ensure \
  --org $ORG_ID \
  --name "deploy-test-project" \
  --slug dtest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>

# Set required secrets
eve secrets set POSTGRES_PASSWORD eve --project $PROJECT_ID --json
eve secrets set GITHUB_TOKEN <your-github-pat> --project $PROJECT_ID --json
```

## Steps

### 1. Clone, Configure Alias, and Sync Manifest

```bash
# Clone the example repo locally
REPO_DIR=$(mktemp -d)/repo
git clone --depth 1 https://github.com/eve-horizon/eve-horizon-fullstack-example $REPO_DIR

# Configure a deterministic vanity alias for this project
ALIAS_SUFFIX=$(echo "$PROJECT_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 10)
export API_ALIAS="dtest-${ALIAS_SUFFIX}"

# Inject ingress alias into api service config
perl -0pi -e "s/(x-eve:\\n)(\\s+api_spec:)/\$1      ingress:\\n        public: true\\n        alias: ${API_ALIAS}\\n\$2/s" \
  "$REPO_DIR/.eve/manifest.yaml"

rg -n "ingress:|alias:" "$REPO_DIR/.eve/manifest.yaml"

# Sync manifest
eve project sync --project $PROJECT_ID --dir $REPO_DIR --json
```

**Expected:**
- Manifest synced successfully
- Components and environments registered
- API service ingress includes alias `${API_ALIAS}`

### 2. Create Test Environment

```bash
eve env list $PROJECT_ID --json
# Check if 'test' env exists

# If not, create it:
eve env create test \
  --type persistent \
  --project $PROJECT_ID \
  --json
```

**Expected:**
- Environment created or already exists
- Has namespace like `eve-mto-dtest-test`

### 3. Deploy (Pipeline Build + Release + Deploy)

```bash
eve env deploy test --ref main --repo-dir $REPO_DIR --project $PROJECT_ID
```

**Expected:**
- Command returns a pipeline run ID
- Pipeline status transitions to `succeeded`

Optional (inspect the run):
```bash
eve pipeline runs deploy-test $PROJECT_ID --json
```

#### Build Step Verification

The build step now performs real Docker image builds (not stubs). Verify:

- Build outputs should show per-service image digests (e.g., `sha256:abc123...`)
- Build logs should show BuildKit (or Docker Buildx locally) output
- The build step output should contain `image_digests` field with digest values for each service

#### Inspect Build Records

After the pipeline completes, verify builds were tracked:

```bash
# List builds for the project
eve build list --project $PROJECT_ID --json

# Get the most recent build ID
export BUILD_ID=<id_from_list>

# Full diagnostic
eve build diagnose $BUILD_ID --json
```

**Expected:**
- Build spec exists with correct git_sha
- Build run shows status = `succeeded`
- Build artifacts contain digests for each built service

#### Release Step Verification

Use the pipeline run output to verify the release + digests:

```bash
# Get the run ID from the deploy output
PIPELINE_RUN_ID=<run_id_from_output>

# Inspect step outputs (release_id + image digests)
eve pipeline show-run deploy-test $PIPELINE_RUN_ID --project $PROJECT_ID --json | \
  jq '{release_id: .run.step_outputs.release.release_id, image_digests: .run.step_outputs.build.image_digests}'
```

**Expected:**
- `release_id` is non-null
- `image_digests` contains digests for each service

#### Deploy Step Verification

Deploy now uses digest-based image references (`image@sha256:...`):

- No manual `./bin/eh k8s-image push` should be needed
- Kubernetes deployment specs should reference images by digest
- This ensures immutable deployments tied to specific builds

### 4. Verify Deployment (Use Eve CLI)

```bash
# Check environment status
eve env show $PROJECT_ID test --json
```

**Expected:**
- Environment shows deployed status
- Components listed with their status

### 5. Verify Service Health (Mechanical + Vanity Ingress)

```bash
# URL pattern:
#   Mechanical: api.{orgSlug}-{projectSlug}-{env}.{domain}
#   Vanity:     {alias}.{domain}
#
# Auto-select domain/scheme for staging; default to local k3d.
if [[ "${EVE_API_URL:-}" == "https://api.eve.example.com" ]]; then
  export CLUSTER_DOMAIN=eve.example.com
  export APP_SCHEME=https
else
  export CLUSTER_DOMAIN=${CLUSTER_DOMAIN:-lvh.me}
  export APP_SCHEME=${APP_SCHEME:-http}
fi

curl -fsS "${APP_SCHEME}://api.mto-dtest-test.${CLUSTER_DOMAIN}/health" | jq
curl -fsS "${APP_SCHEME}://${API_ALIAS}.${CLUSTER_DOMAIN}/health" | jq
```

**Expected:**
- Mechanical endpoint responds to health check
- Vanity alias endpoint responds to health check
- Returns healthy status

## Success Criteria

- [ ] Manifest synced with components
- [ ] Environment created
- [ ] Deployment completed
- [ ] Mechanical service endpoint responds to health check
- [ ] Vanity alias endpoint responds to health check

## Debugging with Eve CLI

### Check Environment Status

```bash
# Environment details
eve env show $PROJECT_ID test --json

# Environment diagnostics (pods/events/deployments)
eve env diagnose $PROJECT_ID test --json

# Component logs (API example)
eve env logs $PROJECT_ID test api --tail 200

# List all environments
eve env list $PROJECT_ID --json
```

### System-Level Debugging (Admin)

```bash
# Overall system status
eve system status

# All environments across projects
eve system envs

# Cluster pods (admin view)
eve system pods
```

### When to Use kubectl (Infrastructure Only)

Only if `eve system status` shows infrastructure issues:

```bash
# Check pod status in namespace
kubectl get pods -n eve-mto-dtest-test

# Pod events (if pods failing to start)
kubectl describe pod -n eve-mto-dtest-test -l app=api

# Check postgres is running (infra)
kubectl get pods -n eve | grep postgres
```

## Notes

- Environment health and diagnostics are available via `eve env show` and `eve env diagnose`.

## Cleanup

```bash
# Delete the environment (removes k8s resources)
eve env delete test --project $PROJECT_ID --force

# Clean up temp directory
rm -rf $REPO_DIR

# To fully clean up all test resources:
# eve org delete org_manualtestorg
```
