# Scenario 06: Builds API

**Time:** ~1 minute
**Parallel Safe:** Yes
**LLM Required:** No

Tests the builds API: list builds, show build details, inspect artifacts and logs.

## Prerequisites

- Smoke tests pass (scenario 01)
- At least one deploy has been run (scenario 05) to create build records

## Setup

Use the stable manual test org and project from scenario 05:

```bash
export ORG_ID=org_manualtestorg
# Use the project from scenario 05 or create one
export PROJECT_ID=<project_id>
```

## Steps

### 1. List Builds

```bash
eve build list --project $PROJECT_ID --json
```

**Expected:**
- Returns array of build specs
- Each has: id, project_id, git_sha, manifest_hash, created_at

### 2. Show Build Details

```bash
# Use the first build ID from the list
export BUILD_ID=<build_id_from_list>

eve build show $BUILD_ID --json
```

**Expected:**
- Returns full build spec with services, inputs, registry config

### 3. List Build Runs

```bash
eve build runs $BUILD_ID --json
```

**Expected:**
- Returns array of build runs
- Each has: id, build_id, status, backend, started_at, completed_at

### 4. List Build Artifacts

```bash
eve build artifacts $BUILD_ID --json
```

**Expected:**
- Returns array of build artifacts
- Each has: service_name, image_ref, digest (sha256:...), platforms

### 5. View Build Logs

```bash
eve build logs $BUILD_ID --json
```

**Expected:**
- Returns build log entries with timestamps

### 6. Full Diagnostics

```bash
eve build diagnose $BUILD_ID --json
```

**Expected:**
- Returns combined view: spec + runs + artifacts + recent logs

## Success Criteria

- [ ] Build list returns records
- [ ] Build show returns spec details
- [ ] Build runs shows execution history
- [ ] Build artifacts contain image digests
- [ ] Build logs are accessible
- [ ] Build diagnose shows complete state

## Debugging

```bash
# If no builds exist, run scenario 05 first to trigger a deploy pipeline
# The deploy pipeline's build step creates build records

# Check pipeline runs for build step
eve pipeline runs deploy-test $PROJECT_ID --json
```
