# Scenario 03: Pipelines API

**Time:** ~30 seconds
**Parallel Safe:** Yes
**LLM Required:** No

Tests pipeline CRUD operations without executing pipeline jobs.

## Prerequisites

- Smoke tests pass (scenario 01)
- A project exists with a manifest containing pipelines

## Setup

Use the stable manual test org:

```bash
export ORG_ID=org_manualtestorg
export API_URL=$EVE_API_URL

# Create project linked to example repo (has pipelines in manifest)
eve project ensure \
  --org $ORG_ID \
  --name "pipeline-test-project" \
  --slug ptest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>

# Clone the repo locally and sync manifest
# (eve project sync reads from local .eve/manifest.yaml, not remote repo)
TMPDIR=$(mktemp -d)
git clone --depth 1 https://github.com/eve-horizon/eve-horizon-fullstack-example $TMPDIR/repo
cd $TMPDIR/repo
eve project sync --project $PROJECT_ID --json
cd -
```

## Steps

### 1. List Pipelines

```bash
eve pipeline list $PROJECT_ID --json
```

**Expected:**
- Returns JSON with `data` array
- Array contains pipeline definitions from manifest
- Each pipeline has `name`, `project_id`, `definition`

### 2. Show Pipeline Details

```bash
eve pipeline show $PROJECT_ID deploy-test --json
```

**Expected:**
- Returns single pipeline object
- Contains `trigger` configuration
- Contains `steps` array with step definitions

**Note:** Pipeline name depends on manifest. Try `deploy-test` or check list output.

### 3. Expand Pipeline (Preview Job Graph)

```bash
# Use the API directly to expand a pipeline into jobs without executing
TOKEN=$(eve auth token)
curl -s -X POST "$API_URL/projects/$PROJECT_ID/pipelines/deploy-test/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"git_sha": "0000000000000000000000000000000000000000", "env_name": "test", "dry_run": true}' | jq
```

**Expected:**
- Returns `run` object with pipeline run metadata
- Returns `jobs` array showing jobs that would be created
- Returns `relations` array showing job dependencies
- Jobs have `phase`, `step_name`, `execution_type`

### 4. Verify Pipeline Job Dependencies

From the expand output:

**Expected:**
- All jobs have `phase: "ready"` (dry_run mode returns all phases as ready)
- Relations show `blocks` relationships (dependencies are expressed via relations, not phases)

## Success Criteria

- [ ] Pipeline list returns pipelines from manifest
- [ ] Pipeline show returns detailed definition
- [ ] Pipeline expand shows correct job graph
- [ ] Dependencies are correctly represented

## Notes

- This test does NOT execute pipeline jobs (would take 10+ minutes)
- The API's `dry_run` or expand endpoint validates job graph generation
- Actual execution is covered by job execution test (scenario 02)
- `git_sha` must be a 40-character lowercase hex SHA even for dry runs
