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

Use the stable manual test org. This scenario reuses the project scenario 03 created
(slug `fstest`): the example repo's agents and packs claim org-wide agent slugs, so a
second project syncing the same repo in this org is refused. If scenario 03 has not run,
the `ensure` below creates the project.

```bash
export ORG_ID=org_manualtestorg

# Branch of the example repo that already commits the vanity alias (see Step 1).
# If it does not exist yet, fall back to `main`; the vanity check is then skipped.
export EXAMPLE_REPO=https://github.com/eve-horizon/eve-horizon-fullstack-example
export EXAMPLE_BRANCH=manual-test-alias
git ls-remote --exit-code --heads $EXAMPLE_REPO $EXAMPLE_BRANCH >/dev/null || {
  echo "No $EXAMPLE_BRANCH branch: using main, skipping the vanity alias check"
  export EXAMPLE_BRANCH=main
}

eve project ensure \
  --org $ORG_ID \
  --name "fullstack-test-project" \
  --slug fstest \
  --repo-url $EXAMPLE_REPO \
  --branch $EXAMPLE_BRANCH \
  --force \
  --json
export PROJECT_ID=<id_from_output>

# Set required secrets
eve secrets set POSTGRES_PASSWORD eve --project $PROJECT_ID --json
eve secrets set GITHUB_TOKEN <your-github-pat> --project $PROJECT_ID --json
```

Scenario 03 uses the same repo URL and branch logic, so the project is shared as-is.

## Steps

### 1. Clone the Alias Branch and Sync Manifest

The vanity alias must be committed in the repo. The build clones the remote ref and the worker
refuses a deploy whose workspace manifest differs from the synced one (`Manifest drift detected`),
so injecting the alias into a local copy only (the old flow) cannot work. The example repo's
`manual-test-alias` branch is `main` plus this one change to the `api` service in
`.eve/manifest.yaml`:

```yaml
    x-eve:
      ingress:
        public: true
        alias: mto-fstest-api
      api_spec:
        type: openapi
        spec_url: /openapi.json
```

```bash
REPO_DIR=$(mktemp -d)/repo
git clone --depth 1 --branch $EXAMPLE_BRANCH $EXAMPLE_REPO $REPO_DIR

# Aliases are unique cluster-wide; this fixed value is claimed by the fstest project.
export API_ALIAS=mto-fstest-api
if [ "$EXAMPLE_BRANCH" = main ]; then export API_ALIAS=; fi

rg -n "ingress:|alias:" "$REPO_DIR/.eve/manifest.yaml"

# Sync manifest
eve project sync --project $PROJECT_ID --dir $REPO_DIR --json
```

**Expected:**
- Manifest synced successfully
- Components and environments registered
- On the alias branch, API service ingress includes alias `mto-fstest-api`

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
- Has namespace like `eve-mto-fstest-test`

### 3. Deploy (Pipeline Build + Release + Deploy)

```bash
# Deploy the exact commit that was cloned (and synced) above
eve env deploy test --ref $(git -C $REPO_DIR rev-parse HEAD) --repo-dir $REPO_DIR --project $PROJECT_ID
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

curl -fsS "${APP_SCHEME}://api.mto-fstest-test.${CLUSTER_DOMAIN}/health" | jq
# Vanity alias: only when running on the alias branch
[ -n "$API_ALIAS" ] && curl -fsS "${APP_SCHEME}://${API_ALIAS}.${CLUSTER_DOMAIN}/health" | jq
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
- [ ] Vanity alias endpoint responds to health check (skipped, not failed, when the alias branch does not exist yet)

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
kubectl get pods -n eve-mto-fstest-test

# Pod events (if pods failing to start)
kubectl describe pod -n eve-mto-fstest-test -l app=api

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

# Keep the fstest project: scenario 03 reuses it, and deleting a project does not
# yet free the example's org-wide agent slugs (EVE-027), so recreating it can fail.
# To fully clean up all test resources:
# eve org delete org_manualtestorg
```
