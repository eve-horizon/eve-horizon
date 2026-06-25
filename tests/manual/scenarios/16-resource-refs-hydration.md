# Scenario 16: Resource Refs & Workspace Hydration

**Time:** ~3-4 minutes
**Parallel Safe:** Yes
**LLM Required:** Yes (agent job inspects hydrated workspace)

End-to-end validation of resource references on jobs, the resource resolver, workspace hydration, and diagnostics — covering both org doc refs and pinned version refs.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| Resource URI resolution | Steps 1-2 |
| Workspace hydration (required refs) | Step 3-4 |
| Hydration index.json generation | Step 4 |
| Optional ref graceful handling | Step 5 |
| Pinned version ref resolution | Step 6 |
| Job diagnostics show hydration state | Step 7 |
| Missing required ref fails provisioning | Step 8 |

## Prerequisites

- Smoke tests pass (scenario 01)
- Secrets imported to test org (Z_AI_API_KEY required for job execution)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}

# Create or reuse test project
eve project ensure \
  --org $ORG_ID \
  --name "resource-ref-test" \
  --slug rrtest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>
```

### Seed Test Documents

Create org docs that jobs will reference.

```bash
eve docs write --org $ORG_ID --path /test/feature-brief.md \
  --metadata '{"type":"brief","feature":"FEAT-200"}' \
  --stdin <<'EOF'
# Feature Brief: FEAT-200

Build a user notification system with email and in-app channels.

## Requirements

1. Email notifications via SendGrid
2. In-app notifications via WebSocket
3. User preference management
4. Notification history (30-day retention)
EOF
```

```bash
eve docs write --org $ORG_ID --path /test/architecture-notes.md \
  --metadata '{"type":"architecture"}' \
  --stdin <<'EOF'
# Architecture Notes

- Use event-driven architecture for notification dispatch
- Queue notifications via Redis Streams
- Store notification state in PostgreSQL
EOF
```

Update the brief to create version 2.

```bash
eve docs write --org $ORG_ID --path /test/feature-brief.md \
  --metadata '{"type":"brief","feature":"FEAT-200","status":"approved"}' \
  --stdin <<'EOF'
# Feature Brief: FEAT-200 (Approved)

Build a user notification system with email and in-app channels.

## Requirements

1. Email notifications via SendGrid
2. In-app notifications via WebSocket
3. User preference management
4. Notification history (30-day retention)
5. Batch notification support (max 1000/batch)

## Approved By

PM Team — 2026-02-11
EOF
```

**Expected:** Three writes succeed. Feature brief now has 2 versions.

## Steps

### 1. Verify Resource URI Resolution (CLI)

Resolve a resource URI directly to confirm the resolver works.

```bash
eve resources resolve --org $ORG_ID org_docs:/test/feature-brief.md --json
```

**Expected:**
- Returns `data` array with resolved resource entries containing `content`, `content_hash`, `mime_type`, `version`
- Content matches version 2 (latest)

```bash
eve resources resolve --org $ORG_ID org_docs:/test/feature-brief.md@v1 --json
```

**Expected:**
- Returns version 1 content in `data[0]` (without "Batch notification" and "Approved By" sections)
- `data[0].version` is `1`

### 2. List Resources by Prefix

```bash
eve resources ls --org $ORG_ID org_docs:/test/ --json
```

**Expected:**
- Returns both `/test/feature-brief.md` and `/test/architecture-notes.md`

### 3. Create Job with Required Resource Refs

Create a job that references the org docs. The agent will verify the files appear in its workspace.

```bash
RESOURCE_REFS='[{"uri":"org_docs:/test/feature-brief.md","required":true,"mount_path":"brief.md","label":"Feature Brief"},{"uri":"org_docs:/test/architecture-notes.md","required":true,"mount_path":"arch.md","label":"Architecture Notes"}]'

eve job create \
  --project $PROJECT_ID \
  --description "$(cat <<'PROMPT'
WORKSPACE RESOURCE AUDIT — inspect the hydrated resources in your workspace.

Run the following bash script and report its COMPLETE output:

```bash
#!/bin/bash
echo "=== RESOURCE HYDRATION AUDIT ==="

echo ""
echo "--- Index File ---"
if [ -f ".eve/resources/index.json" ]; then
  echo "PASS: index.json exists"
  cat .eve/resources/index.json | python3 -m json.tool 2>/dev/null || cat .eve/resources/index.json
else
  echo "FAIL: .eve/resources/index.json not found"
fi

echo ""
echo "--- Hydrated Files ---"
if [ -d ".eve/resources" ]; then
  find .eve/resources -type f | sort
else
  echo "FAIL: .eve/resources/ directory not found"
fi

echo ""
echo "--- Feature Brief Content ---"
if [ -f ".eve/resources/brief.md" ]; then
  echo "PASS: brief.md exists"
  head -5 .eve/resources/brief.md
else
  echo "FAIL: brief.md not found at expected mount path"
  # Try default path
  find .eve/resources -name "*.md" -exec echo "Found: {}" \;
fi

echo ""
echo "--- Architecture Notes Content ---"
if [ -f ".eve/resources/arch.md" ]; then
  echo "PASS: arch.md exists"
  head -3 .eve/resources/arch.md
else
  echo "FAIL: arch.md not found at expected mount path"
fi

echo ""
echo "--- Resource Status Summary ---"
if [ -f ".eve/resources/index.json" ]; then
  python3 -c "
import json
with open('.eve/resources/index.json') as f:
    idx = json.load(f)
for r in idx.get('resources', []):
    print(f\"{r.get('status','unknown'):10s} {r.get('uri','?')}\")
" 2>/dev/null || echo "(python3 not available for index parse)"
fi
echo ""
echo "=== AUDIT COMPLETE ==="
```

After running the script, state whether the hydration PASSED or FAILED based on:
1. index.json exists and is valid JSON
2. All required resources are present with status "resolved"
3. File content matches expected org doc content
PROMPT
)" \
  --resource-refs "$RESOURCE_REFS" \
  --harness zai \
  --json
export HYDRATION_JOB_ID=<id_from_output>
```

### 4. Wait and Verify Workspace Hydration

```bash
eve job wait $HYDRATION_JOB_ID --timeout 300
eve job logs $HYDRATION_JOB_ID
eve job diagnose $HYDRATION_JOB_ID --json | jq '.attempts[-1].runtime_meta.resource_hydration'
```

**Expected:**
- `resource_hydration` is present in latest attempt runtime metadata
- `resolved_count` is at least `2` and `failed_required_count` is `0`
- Required entries for both `org_docs:/test/feature-brief.md` and `org_docs:/test/architecture-notes.md` exist in `resources`
- `index.json` exists in `.eve/resources/index.json` in the hydrated workspace (best-effort check via logs; explicit job output may vary by LLM response model)

### 5. Job with Optional Missing Ref

Create a job that references one real doc and one non-existent doc (optional).

```bash
OPTIONAL_REFS='[{"uri":"org_docs:/test/feature-brief.md","required":true,"mount_path":"brief.md","label":"Brief"},{"uri":"org_docs:/test/nonexistent.md","required":false,"mount_path":"missing.md","label":"Optional Doc"}]'

eve job create \
  --project $PROJECT_ID \
  --description "$(cat <<'PROMPT'
Check workspace resources. Run:
```bash
cat .eve/resources/index.json | python3 -m json.tool 2>/dev/null || cat .eve/resources/index.json
```
Report which resources are resolved and which are missing.
PROMPT
)" \
  --resource-refs "$OPTIONAL_REFS" \
  --harness zai \
  --json
export OPTIONAL_JOB_ID=<id_from_output>
```

```bash
eve job wait $OPTIONAL_JOB_ID --timeout 300
eve job logs $OPTIONAL_JOB_ID
```

**Expected:**
- Job completes (does NOT fail despite missing optional ref)
- `index.json` shows the required ref as `resolved`
- `index.json` shows the optional ref as `missing` with `error_code: "resource_not_found"`

### 6. Pinned Version Ref

Create a job that references a pinned version of the feature brief (version 1, not latest).

```bash
PINNED_REFS='[{"uri":"org_docs:/test/feature-brief.md@v1","required":true,"mount_path":"brief-v1.md","label":"Brief V1"}]'

eve job create \
  --project $PROJECT_ID \
  --description "$(cat <<'PROMPT'
Read the file at .eve/resources/brief-v1.md and report:
1. Does the file exist?
2. Does it contain "Batch notification support"? (It should NOT — this is v1)
3. Report the first 5 lines of the file.
PROMPT
)" \
  --resource-refs "$PINNED_REFS" \
  --harness zai \
  --json
export PINNED_JOB_ID=<id_from_output>
```

```bash
eve job wait $PINNED_JOB_ID --timeout 300
eve job logs $PINNED_JOB_ID
```

**Expected:**
- Job completes successfully
- `resource_hydration` shows the single pinned `org_docs:/test/feature-brief.md@v1` ref as resolved
- If workspace output is inspected, `brief-v1.md` is expected to be version 1 (should not mention `Batch notification support`)

### 7. Job Diagnostics Show Hydration

```bash
eve job diagnose $HYDRATION_JOB_ID --json
```

**Expected:**
- Output includes a "Resources" section
- Each resource ref shows URI, local path, content hash, version, and status
- All refs show `resolved` status

### 8. Missing Required Ref Fails Provisioning

Create a job where a required resource does not exist.

```bash
MISSING_REFS='[{"uri":"org_docs:/test/does-not-exist.md","required":true,"mount_path":"missing.md","label":"Required Missing"}]'

eve job create \
  --project $PROJECT_ID \
  --description "This job should never execute — the required ref does not exist." \
  --resource-refs "$MISSING_REFS" \
  --harness zai \
  --json
export FAIL_JOB_ID=<id_from_output>
```

```bash
# Wait briefly — job should fail during provisioning
eve job wait $FAIL_JOB_ID --timeout 120 || true
eve job show $FAIL_JOB_ID --json
```

**Expected:**
- Job fails before harness launch
- Phase is `done` with a failure result
- Error indicates resource resolution failure (`resource_not_found`)

```bash
eve job diagnose $FAIL_JOB_ID
```

**Expected:**
- Diagnostics show the failed resource ref with `error_code`

### 9. Cleanup

```bash
eve docs delete --org $ORG_ID --path /test/feature-brief.md --json
eve docs delete --org $ORG_ID --path /test/architecture-notes.md --json
```

**Expected:**
- Both deletes succeed

## Success Criteria

- [ ] Resource URIs resolve correctly via CLI (`eve resources resolve`)
- [ ] Resource listing by prefix works (`eve resources ls`)
- [ ] Jobs with resource_refs get files hydrated into `.eve/resources/`
- [ ] `index.json` generated with correct metadata for all refs
- [ ] Optional missing refs do not fail the job (status: `missing`)
- [ ] Pinned version refs resolve to the correct historical version
- [ ] `eve job diagnose` shows hydration provenance
- [ ] Missing required ref fails job provisioning before harness launch

## CLI Commands Reference

```bash
eve resources resolve <uri> --org <org-id> [--json]
eve resources ls <uri-prefix> --org <org-id> [--json]
eve resources cat <uri> --org <org-id>

eve job create --project <proj> --description <desc> \
  --resource-refs '<json-array>' \
  [--harness <harness>] [--json]

eve job diagnose <job-id> [--json]
```

## Resource Ref Format

```bash
--resource-refs '[{"uri":"org_docs:/path/to/doc.md@v1","required":true,"mount_path":"pm/brief.md","label":"Brief"}]'
```

Fields:
1. **uri** — canonical resource URI (`org_docs:/path` or `org_docs:/path@vN`)
2. **required** — `true` (fail on missing) or `false` (skip on missing)
3. **mount_path** — relative path under `.eve/resources/`
4. **label** — human-readable description

## Debugging

### Resources not appearing in workspace

Check the worker is running the hydration step:
```bash
eve job diagnose $HYDRATION_JOB_ID
```

If there is no "Resources" section in diagnostics, the worker may not have the hydration code deployed.

### Job fails immediately

Check for resource resolution errors:
```bash
eve job show $FAIL_JOB_ID --verbose
```

### index.json malformed or missing

The worker writes `index.json` after resolving all refs. If it is missing, check:
```bash
eve system logs worker --tail 50
```

Look for `resource.hydration` log entries.
