# Scenario 18: Org-Scoped Threads

**Time:** ~1 minute
**Parallel Safe:** Yes
**LLM Required:** No

End-to-end validation of org-scoped thread creation, messaging, key canonicalization, and listing with scope/prefix filters.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| Org thread creation | Step 1 |
| Scope and key canonicalization | Step 1-2 |
| Thread listing with filters | Step 2 |
| Message posting | Step 3 |
| Message retrieval | Step 4 |
| Thread detail with timestamps | Step 5 |

## Prerequisites

- Smoke tests pass (scenario 01)
- `EVE_API_URL` set (see main README)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
```

## Steps

### 1. Create an Org Thread

```bash
eve thread create --org $ORG_ID --key "agents:test:scenario-18" --json
```

**Expected:**
- Thread created successfully
- `scope` is `"org"`
- `org_id` is set to `org_manualtestorg`
- `project_id` is `null`

Save the thread ID:
```bash
export THREAD_ID=<id_from_output>
```

### 2. List Org Threads

```bash
eve thread list --org $ORG_ID --scope org --key-prefix "agents:test:" --json
```

**Expected:**
- List includes the thread from Step 1
- Thread key matches `agents:test:scenario-18`
- All returned threads have `scope: "org"`

### 3. Post a Message

```bash
eve thread post $THREAD_ID --org $ORG_ID \
  --body "Hello from scenario 18" \
  --actor-type agent --actor-id test-agent \
  --json
```

**Expected:**
- Message created with `body` matching `"Hello from scenario 18"`
- `actor_type` is `"agent"`
- `actor_id` is `"test-agent"`

### 4. List Messages

```bash
eve thread messages $THREAD_ID --org $ORG_ID --json
```

**Expected:**
- Contains the message from Step 3
- Message body, actor type, and actor ID are correct

### 5. Show Thread Details

```bash
eve thread show $THREAD_ID --org $ORG_ID --json
```

**Expected:**
- Thread `updated_at` reflects the message post (later than `created_at`)
- Thread key and scope are correct

## Success Criteria

- [ ] Org threads are created with `scope: "org"` and correct `org_id`
- [ ] Key canonicalization works (short key stored with org prefix)
- [ ] Messages can be posted with actor metadata
- [ ] Messages can be retrieved by thread ID
- [ ] Listing filters by scope and key prefix
- [ ] Thread `updated_at` advances on message post

## CLI Commands Reference

```bash
eve thread create --org <org> --key <key> [--json]
eve thread list --org <org> [--scope <scope>] [--key-prefix <prefix>] [--json]
eve thread post <thread-id> --org <org> --body <text> --actor-type <type> --actor-id <id> [--json]
eve thread messages <thread-id> --org <org> [--json]
eve thread show <thread-id> --org <org> [--json]
```

## Debugging

### Thread create fails with 400

Verify the key format is valid. Keys must be non-empty strings without leading/trailing whitespace:
```bash
eve thread create --org $ORG_ID --key "agents:test:scenario-18" --json 2>&1
```

### Listing returns empty results

Check that the scope and key-prefix filters match. Try listing without filters first:
```bash
eve thread list --org $ORG_ID --json
```

### Messages not appearing

Verify the thread ID is correct and the org matches:
```bash
eve thread show $THREAD_ID --org $ORG_ID --json
```
