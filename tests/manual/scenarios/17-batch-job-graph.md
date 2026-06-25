# Scenario 17: Batch Job Graph

**Time:** ~2 minutes
**Parallel Safe:** Yes
**LLM Required:** No

End-to-end validation of atomic batch job creation, graph validation, idempotency, and dependency wiring.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| Invalid graph detection | Step 1 |
| Valid graph validation | Step 2 |
| Atomic batch creation | Step 3 |
| Parent-child tree wiring | Step 4 |
| Idempotency key dedup | Step 5 |

## Prerequisites

- Smoke tests pass (scenario 01)
- `EVE_API_URL` set (see main README)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}

# Create or reuse test project
eve project ensure \
  --org $ORG_ID \
  --name "batch-graph-test" \
  --slug batcht \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>
```

## Steps

### 1. Validate an Invalid Batch Graph

Create a test file `batch-invalid.json`:

```json
{
  "nodes": [
    { "key": "a", "title": "Task A" },
    { "key": "b", "title": "Task B" }
  ],
  "dependencies": [
    { "job": "a", "depends_on": ["c"] }
  ]
}
```

```bash
eve job batch-validate --project $PROJECT_ID --file batch-invalid.json --json
```

**Expected:**
- `valid: false`
- Error with code `batch_node_unknown` mentioning key `c`

### 2. Validate a Valid Batch Graph

Create `batch-valid.json`:

```json
{
  "idempotency_key": "manual-test-scenario-17",
  "nodes": [
    { "key": "epic", "title": "Test Epic", "type": "epic" },
    { "key": "task-a", "title": "Task A", "parent": "epic" },
    { "key": "task-b", "title": "Task B", "parent": "epic" },
    { "key": "task-c", "title": "Task C", "parent": "epic" }
  ],
  "dependencies": [
    { "job": "task-b", "depends_on": ["task-a"] },
    { "job": "task-c", "depends_on": ["task-a", "task-b"] }
  ]
}
```

```bash
eve job batch-validate --project $PROJECT_ID --file batch-valid.json --json
```

**Expected:**
- `valid: true`
- Empty errors array

### 3. Create the Batch

```bash
eve job batch --project $PROJECT_ID --file batch-valid.json --json
```

**Expected:**
- Response includes `batch_id`
- All four jobs mapped to their keys (`epic`, `task-a`, `task-b`, `task-c`)
- `task-b` shows `blocked_by` containing `task-a`
- `task-c` shows `blocked_by` containing `task-a` and `task-b`

### 4. Verify Job Tree

```bash
eve job tree <epic-job-id>
```

**Expected:**
- Shows epic with three children
- Dependency edges visible between tasks

### 5. Test Idempotency

Re-submit the same batch file with the same idempotency key.

```bash
eve job batch --project $PROJECT_ID --file batch-valid.json --json
```

**Expected:**
- Same `batch_id` returned as Step 3
- Same job IDs returned (no duplicate creation)

## Success Criteria

- [ ] Invalid graph returns structured validation errors (`batch_node_unknown`)
- [ ] Valid graph passes validation with `valid: true`
- [ ] Batch creates all jobs atomically (single `batch_id`)
- [ ] Parent-child relationships are wired correctly (epic has three children)
- [ ] Dependencies block dependent jobs (`task-b` blocked by `task-a`, etc.)
- [ ] Idempotency key prevents duplicate creation on re-submit

## CLI Commands Reference

```bash
eve job batch-validate --project <proj> --file <path> [--json]
eve job batch --project <proj> --file <path> [--json]
eve job tree <job-id>
eve job show <job-id> --json
```

## Debugging

### Batch validation returns unexpected errors

Ensure the JSON file is well-formed and keys are unique:
```bash
cat batch-valid.json | python3 -m json.tool
```

### Batch creation fails with 409

The idempotency key may already exist from a previous run with different graph content. Use a different key or verify with:
```bash
eve job list --project $PROJECT_ID --json | jq '.[] | select(.batch_id)'
```

### Job tree shows missing children

Check that parent keys in the batch file match existing node keys:
```bash
eve job show <epic-job-id> --json | jq '.children'
```
