# Scenario 23: Agent Memory Platform

**Time:** ~3-4 minutes  
**Parallel Safe:** Yes  
**LLM Required:** No

End-to-end validation of the new agent-memory surfaces: memory namespaces, agent KV storage, unified search across memory/docs/threads, and thread distillation into durable memory docs.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| Agent memory write/read/list/delete | Steps 1-2, 8 |
| Shared memory namespace | Steps 1-2, 8 |
| Memory lifecycle metadata (`review_due`, `expires_at`) | Step 1 |
| Agent KV namespace CRUD + mget | Step 3, 7 |
| Unified search source coverage (`memory`, `docs`, `threads`) | Step 5 |
| Thread distillation into memory doc | Step 6 |

## Prerequisites

- Smoke tests pass (scenario 01)
- `EVE_API_URL` set (see main README)
- Token has org admin-level permissions (needs `threads:write`; setup below grants scoped `orgdocs:*`)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}

# Unique run identifiers (avoid collisions across reruns)
export RUN_ID=$(date +%s)
export MEM_KEY=auth-retry-$RUN_ID
export SHARED_KEY=api-style-$RUN_ID
export DISTILL_KEY=distill-$RUN_ID
export KV_NS=scenario23-$RUN_ID
export KV_KEY=last_commit
export DOCS_PATH=/test/memory-s23-$RUN_ID.md
export THREAD_KEY=agents:test:scenario-23-$RUN_ID

export MEM_TOKEN=tok-memory-$RUN_ID
export DOCS_TOKEN=tok-docs-$RUN_ID
export THREAD_TOKEN=tok-thread-$RUN_ID

# Discover current user id (used for scoped orgdocs grant below)
export USER_ID=$(eve auth whoami --json | jq -r '.user_id // empty')
test -n "$USER_ID"
```

## Steps

### 0. Verify CLI Supports New Commands

```bash
eve memory --help
eve kv --help
```

**Expected:**
- Both commands exist.

> If your global `eve` binary is older and missing these commands, run this scenario with the repo-local CLI:
> `node packages/cli/bin/eve.js <command> ...`

### 0.1 Ensure Scoped Orgdocs Access (required for memory/docs paths)

```bash
cat >/tmp/s23-access.yaml <<EOF
version: 2
access:
  roles:
    scenario23_memory_editor:
      scope: org
      permissions:
        - orgdocs:read
        - orgdocs:write
        - orgdocs:admin
  bindings:
    - subject: { type: user, id: $USER_ID }
      roles: [scenario23_memory_editor]
      scope:
        orgdocs:
          allow_prefixes:
            - "/agents/**"
            - "/test/**"
EOF
```

```bash
eve access validate --file /tmp/s23-access.yaml
eve access sync --org $ORG_ID --file /tmp/s23-access.yaml --yes
```

```bash
eve access can --org $ORG_ID --user $USER_ID \
  --permission orgdocs:write \
  --resource-type orgdocs \
  --resource /agents/reviewer/memory/learnings/s23-bootstrap.md \
  --action write --json
```

**Expected:**
- Access validate/sync succeeds
- Access check returns `"allowed": true`

### 1. Create Agent + Shared Memory Entries

```bash
eve memory set --org $ORG_ID --agent reviewer \
  --category learnings --key $MEM_KEY \
  --content "Retry guidance $MEM_TOKEN" \
  --tags auth,retry --confidence 0.9 \
  --review-in 7d --expires-in 30d --json
```

```bash
eve memory set --org $ORG_ID --shared \
  --category conventions --key $SHARED_KEY \
  --content "API style guidance $RUN_ID" --json
```

**Expected:**
- Agent memory path includes `/agents/reviewer/memory/learnings/$MEM_KEY.md`
- Shared memory path includes `/agents/shared/memory/conventions/$SHARED_KEY.md`
- Agent memory response has non-null `review_due` and `expires_at`

### 2. Read and List Memory

```bash
eve memory get --org $ORG_ID --agent reviewer \
  --category learnings --key $MEM_KEY --json
```

```bash
eve memory list --org $ORG_ID --agent reviewer \
  --category learnings --limit 20 --json
```

```bash
eve memory list --org $ORG_ID --shared \
  --category conventions --limit 20 --json
```

**Expected:**
- `memory get` content contains `$MEM_TOKEN`
- Agent list includes `$MEM_KEY`
- Shared list includes `$SHARED_KEY`

### 3. Verify KV Namespace Operations

```bash
eve kv set --org $ORG_ID --agent reviewer \
  --namespace $KV_NS --key $KV_KEY --value '"abc123"' --ttl 600 --json
```

```bash
eve kv get --org $ORG_ID --agent reviewer \
  --namespace $KV_NS --key $KV_KEY --json
```

```bash
eve kv mget --org $ORG_ID --agent reviewer \
  --namespace $KV_NS --keys "$KV_KEY,missing" --json
```

**Expected:**
- KV set/get return key `last_commit` with value `"abc123"`
- `mget` includes entry for `last_commit`

### 4. Seed Docs + Thread Data for Unified Search

```bash
eve docs write --org $ORG_ID --path $DOCS_PATH --stdin <<EOF
# Scenario 23 Search Seed

Knowledge token: $DOCS_TOKEN
EOF
```

```bash
eve thread create --org $ORG_ID --key $THREAD_KEY --json
```

Save thread id:
```bash
export THREAD_ID=<id_from_output>
```

```bash
eve thread post $THREAD_ID --org $ORG_ID \
  --body "Discussing rollout $THREAD_TOKEN" \
  --actor-type user --actor-id scenario-23 --json
```

**Expected:**
- Doc write succeeds
- Org thread created with `scope: "org"`
- Thread message created

### 5. Validate Unified Search Source Coverage

```bash
eve search --org $ORG_ID --query $MEM_TOKEN \
  --sources memory,docs,threads --limit 20 --json | jq -e '.data | any(.source=="memory")'
```

```bash
eve search --org $ORG_ID --query $DOCS_TOKEN \
  --sources memory,docs,threads --limit 20 --json | jq -e '.data | any(.source=="docs")'
```

```bash
eve search --org $ORG_ID --query $THREAD_TOKEN \
  --sources memory,docs,threads --limit 20 --json | jq -e '.data | any(.source=="threads")'
```

**Expected:**
- All three commands return `true`
- Memory query returns memory source hit
- Docs query returns docs source hit
- Thread query returns threads source hit

### 6. Distill Thread into Memory

```bash
eve thread distill $THREAD_ID --org $ORG_ID \
  --agent reviewer --category decisions --key $DISTILL_KEY --json | tee /tmp/s23-distill.json
```

```bash
eve memory get --org $ORG_ID --agent reviewer \
  --category decisions --key $DISTILL_KEY --json
```

```bash
jq -r '.path' /tmp/s23-distill.json
```

Save distill path:
```bash
export DISTILL_PATH=<path_from_output>
```

**Expected:**
- Distill response has `status: "ok"`
- Distill response path includes `/agents/reviewer/memory/decisions/$DISTILL_KEY.md`
- Distilled memory content contains `# Thread Distillation`

### 7. Delete KV Entry and Verify Missing

```bash
eve kv delete --org $ORG_ID --agent reviewer \
  --namespace $KV_NS --key $KV_KEY --json
```

```bash
set +e
eve kv get --org $ORG_ID --agent reviewer --namespace $KV_NS --key $KV_KEY --json >/tmp/s23-kv-gone.out 2>&1
status=$?
set -e
test $status -ne 0
grep -E "404|not found" /tmp/s23-kv-gone.out
```

**Expected:**
- Delete succeeds
- Follow-up get fails with 404/not found

### 8. Cleanup

```bash
eve memory delete --org $ORG_ID --agent reviewer \
  --category learnings --key $MEM_KEY --json
```

```bash
eve memory delete --org $ORG_ID --shared \
  --category conventions --key $SHARED_KEY --json
```

```bash
eve docs delete --org $ORG_ID --path $DISTILL_PATH --json
eve docs delete --org $ORG_ID --path $DOCS_PATH --json
```

**Expected:**
- Cleanup commands succeed

## Success Criteria

- [ ] Agent memory CRUD works for `reviewer` namespace
- [ ] Shared memory namespace works with `--shared`
- [ ] Memory lifecycle fields (`review_due`, `expires_at`) are populated when requested
- [ ] KV set/get/mget/delete works in custom namespace
- [ ] Unified search returns expected source hits for memory/docs/threads
- [ ] Thread distill creates a durable memory doc and it can be retrieved
- [ ] Cleanup removes all scenario artifacts

## CLI Commands Reference

```bash
eve memory set --org <org> (--agent <slug>|--shared) --category <name> --key <key> --content <text>
eve memory get --org <org> (--agent <slug>|--shared) --category <name> --key <key>
eve memory list --org <org> (--agent <slug>|--shared) [--category <name>] [--limit <n>]
eve memory delete --org <org> (--agent <slug>|--shared) --category <name> --key <key>
eve kv set --org <org> --agent <slug> --namespace <ns> --key <key> --value <json-or-string>
eve kv get --org <org> --agent <slug> --namespace <ns> --key <key>
eve kv mget --org <org> --agent <slug> --namespace <ns> --keys a,b,c
eve kv delete --org <org> --agent <slug> --namespace <ns> --key <key>
eve search --org <org> --query <text> --sources memory,docs,threads
eve thread distill <thread-id> --org <org> --agent <slug> --category <name> --key <key>
```
