# Scenario 10: Skills CLI + AgentPacks

**Time:** ~3-4 minutes
**Parallel Safe:** Yes
**LLM Required:** Yes (Step 5 — job with on-clone hook)

Verifies the skills.sh migration (Phase 1) and AgentPacks pipeline (Phase 2) end-to-end.

## What This Tests

| Layer | Control | Verified By |
|-------|---------|-------------|
| Worker runtime | `skills` CLI installed, `openskills` removed | kubectl exec (Step 1, requires cluster access) |
| Pack resolution | Local pack resolved, agents merged, lockfile written | CLI (Step 2) |
| Slug prefixing | Pack agent slugs prefixed with project slug | Lockfile inspection (Step 2) |
| Overlay merge | Project overlay overrides pack defaults | Effective config (Step 2) |
| Packs status | Reads lockfile, detects drift | CLI (Step 3) |
| Migrate CLI | Generates pack config from skills.txt | CLI (Step 4) |
| On-clone hook | Pack skills installed in agent workspace | Job execution (Step 5) |

## Prerequisites

- `EVE_API_URL` set (see main README)
- Smoke tests pass (scenario 01)
- `eve-horizon-fullstack-example` repo cloned locally (at `$HOME/dev/eve-horizon/eve-horizon-fullstack-example` or set `FULLSTACK_DIR`)
- Secrets imported to test org (Z_AI_API_KEY required for Step 5)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
export FULLSTACK_DIR=${FULLSTACK_DIR:-$HOME/dev/eve-horizon/eve-horizon-fullstack-example}

# Build the CLI (required for pack resolution)
pnpm -C packages/shared build 2>/dev/null
pnpm -C packages/cli build 2>/dev/null
```

## Steps

### 1. Verify Worker Runtime (skills CLI)

> **Note:** This step requires `kubectl` access to the cluster. Use the
> kubectl context appropriate for your target cluster (not hardcoded to k3d).

```bash
# skills CLI should be installed in worker
kubectl exec -n eve deployment/eve-worker -- which skills
# Expected: /usr/local/bin/skills

# openskills should NOT be present
kubectl exec -n eve deployment/eve-worker -- which openskills 2>&1 || echo "PASS: openskills not found"
# Expected: "openskills not found" — confirming clean swap

# Version check
kubectl exec -n eve deployment/eve-worker -- skills --version
# Expected: prints a version string (any version is fine)
```

### 2. Pack Resolution Pipeline

This tests the full resolution pipeline against the fullstack-example's packs: the inline `notes-ops` pack and the external `software-factory` pack.

```bash
# Verify the fullstack-example has the inline pack
ls $FULLSTACK_DIR/packs/notes-ops/eve/pack.yaml
# Expected: file exists

# Verify skills.txt is removed (clean break)
test ! -f $FULLSTACK_DIR/skills.txt && echo "PASS: skills.txt removed" || echo "FAIL: skills.txt still exists"

# Verify manifest declares packs
grep -A3 'packs:' $FULLSTACK_DIR/.eve/manifest.yaml
# Expected: shows "- source: ./packs/notes-ops" and "- source: ../eve-software-factory"
```

Run `eve agents sync` with `--local` against the fullstack-example:

```bash
# Create or reuse the test project pointing at fullstack-example
eve project ensure \
  --org $ORG_ID \
  --name "fullstack-example" \
  --slug fstack \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>

# Run agents sync with local resolution
node packages/cli/bin/eve.js agents sync \
  --project $PROJECT_ID \
  --local \
  --repo-dir $FULLSTACK_DIR \
  --allow-dirty
```

**Expected:**
- Resolves both the `notes-ops` and `software-factory` packs successfully
- No agent ID collisions
- Writes `.eve/packs.lock.yaml` in the fullstack-example dir
- POSTs merged config to the API
- Reports success with agent/team/route counts

**Verify the lockfile:**

```bash
cat $FULLSTACK_DIR/.eve/packs.lock.yaml
```

**Expected lockfile contents:**
- `project_slug: fstack`
- `packs` array with two entries: `id: notes-ops`, `source: ./packs/notes-ops` and `id: software-factory`, `source: ../eve-software-factory`
- `effective.agents_count: 8` (project: mission_control + reviewer; notes-ops: notes_assistant + db_ops; software-factory: 4 agents)
- `effective.teams_count: 3` (project + notes-ops + software-factory teams)
- `effective.routes_count: 3` (route_default + route_notes + software-factory route)

**Verify slug prefixing (check the API response):**

The pack agents should have prefixed slugs:
- `notes_assistant` → slug: `fstack-notes-assistant` (or `fullstack-example-notes-assistant`)
- `db_ops` → slug: `fstack-db-ops`
- Project agents keep their explicit slugs: `mission-control`, `reviewer`

**Verify overlay merge:**

The project overlay sets `notes_assistant.harness_profile: primary-reviewer`, overriding the pack's `primary-orchestrator`. Check the sync response or API:

```bash
eve agents config --project $PROJECT_ID --json 2>/dev/null | grep -A3 notes_assistant || echo "Check API response"
```

### 3. Packs Status

```bash
# Run packs status against the fullstack-example (now has a lockfile)
node packages/cli/bin/eve.js packs status --repo-dir $FULLSTACK_DIR
```

**Expected:**
- Shows the lockfile path and resolved timestamp
- Pack table with `notes-ops` and `software-factory` entries
- Effective config counts (8 agents, 3 teams, 3 routes)
- `No drift detected. Lockfile is in sync with manifest.`

```bash
# Also test from eve-horizon repo (no lockfile)
node packages/cli/bin/eve.js packs status
```

**Expected:**
- `No lockfile found at .eve/packs.lock.yaml`

### 4. Migrate Skills-to-Packs (CLI)

Run from the eve-horizon repo root (which still has `skills.txt`):

```bash
node packages/cli/bin/eve.js migrate skills-to-packs
```

**Expected:**
- Header comment: `# Suggested AgentPack configuration for .eve/manifest.yaml`
- YAML fragment with `x-eve.packs` array
- Each entry has a `source` field matching lines from `skills.txt`
- Glob patterns skipped with `[skip]` message
- Footer suggests: `Run: eve agents sync` and `Delete skills.txt`

### 5. Job Execution with Pack Skills (requires LLM)

This verifies the on-clone hook installs skills from the pack (not skills.txt).

```bash
eve job create \
  --project $PROJECT_ID \
  --description "List all files in the .agents/skills/ directory and report which skills are installed. If no skills directory exists, report that." \
  --harness zai \
  --json
export JOB_ID=<id_from_output>

eve job wait $JOB_ID --timeout 300
eve job logs $JOB_ID
```

**Expected:**
- Job completes successfully
- On-clone hook runs (`[on-clone] Installing skills from AgentPacks...`)
- The `notes-api-reference` skill should be installed (from the pack's `skills/` directory)
- No errors about missing `skills.txt`

## Success Criteria

- [ ] `skills` CLI is present at `/usr/local/bin/skills` in the worker pod
- [ ] `openskills` is NOT present in the worker pod
- [ ] `skills.txt` removed from fullstack-example (clean break)
- [ ] `eve agents sync --local` resolves the inline pack without error
- [ ] Lockfile written with correct agent/team/route counts
- [ ] Pack agent slugs are prefixed with project slug
- [ ] Project overlay merges on top of pack defaults (harness_profile override)
- [ ] `eve packs status` shows resolved pack and no drift
- [ ] `eve migrate skills-to-packs` generates valid YAML from eve-horizon's skills.txt
- [ ] Job execution with on-clone hook installs pack skills (no skills.txt needed)

## Debugging

### Pack resolution fails
```bash
# Verify the pack directory structure
find $FULLSTACK_DIR/packs -type f | sort

# Verify pack.yaml is valid
cat $FULLSTACK_DIR/packs/notes-ops/eve/pack.yaml

# Check that imports point to real files
ls $FULLSTACK_DIR/packs/notes-ops/agents/
```

### Agent ID collision
If sync fails with "collision" error, check that no agent ID in the pack matches an agent ID in the project overlay. Pack agents and project agents share the same ID namespace after merge.

### Lockfile not written
```bash
# Check .eve/ directory permissions
ls -la $FULLSTACK_DIR/.eve/

# Run with verbose output
node packages/cli/bin/eve.js agents sync \
  --project $PROJECT_ID \
  --local \
  --repo-dir $FULLSTACK_DIR \
  --allow-dirty \
  --verbose
```

### On-clone hook fails
```bash
# Check worker logs for hook execution
eve system logs worker --tail 50

# Verify the hook is executable
ls -la $FULLSTACK_DIR/.eve/hooks/on-clone.sh
```

### skills CLI not found in worker
```bash
# Check the worker Dockerfile installs skills
grep -r "skills" apps/worker/Dockerfile

# Verify the worker image is current
eve system pods
```
