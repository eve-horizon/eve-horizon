# Scenario 03: Pipelines API

**Time:** ~30 seconds
**Parallel Safe:** Yes
**LLM Required:** No

Tests pipeline CRUD operations without executing pipeline jobs.

## Prerequisites

- Smoke tests pass (scenario 01)
- A project exists with a manifest containing pipelines
- Scenario 05 (deploy flow) shares this project; see "Shared example project" in `tests/manual/README.md`

## Setup

Use the stable manual test org:

```bash
export ORG_ID=org_manualtestorg
export API_URL=$EVE_API_URL

# Create (or reuse) the shared project linked to the example repo.
# The example's agents and packs claim org-wide agent slugs, so only ONE project
# per org may sync this repo. Scenario 05 uses this same project (slug fstest).
# Do not delete it between 03 and 05. Both use the same repo URL and branch (a slug
# re-used with a different branch is refused): the `manual-test-alias` branch of the
# example when it exists (see scenario 05), otherwise `main`.
export EXAMPLE_REPO=https://github.com/eve-horizon/eve-horizon-fullstack-example
export EXAMPLE_BRANCH=manual-test-alias
git ls-remote --exit-code --heads $EXAMPLE_REPO $EXAMPLE_BRANCH >/dev/null || export EXAMPLE_BRANCH=main
eve project ensure \
  --org $ORG_ID \
  --name "fullstack-test-project" \
  --slug fstest \
  --repo-url $EXAMPLE_REPO \
  --branch $EXAMPLE_BRANCH \
  --force \
  --json
export PROJECT_ID=<id_from_output>

# Clone the repo locally and sync manifest
# (eve project sync reads from local .eve/manifest.yaml, not remote repo)
TMPDIR=$(mktemp -d)
git clone --depth 1 --branch $EXAMPLE_BRANCH $EXAMPLE_REPO $TMPDIR/repo
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
- Contains `steps` array with step definitions
- `deploy-test` is environment-driven (the `test` environment points at it) and has no `trigger`;
  the example's event-driven pipelines (for example the CI ones) do carry a `trigger`

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
- The first job (no `depends_on`) has `phase: "ready"`; jobs that depend on another step have `phase: "backlog"`
- Relations show `blocks` relationships between the dependent and the step it waits for

## Success Criteria

- [ ] Pipeline list returns pipelines from manifest
- [ ] Pipeline show returns detailed definition
- [ ] Pipeline expand shows correct job graph
- [ ] Dependencies are correctly represented

## Notes

- Agent slugs are unique per org. If `eve project sync` fails with
  `Agent slug <slug> already used by <project>:<agent>`, another project in the org already synced this
  repo. Reuse that project instead of creating a second one. On platform releases up to 0.1.321, deleting a project does not free
  its agent slugs, so do not rely on delete-and-recreate to work around the conflict there.
- This test does NOT execute pipeline jobs (would take 10+ minutes)
- The API's `dry_run` or expand endpoint validates job graph generation
- Actual execution is covered by job execution test (scenario 02)
- `git_sha` must be a 40-character lowercase hex SHA even for dry runs
