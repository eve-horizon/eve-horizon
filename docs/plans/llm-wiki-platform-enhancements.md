# LLM Wiki: Platform Enhancements

> **Status**: Implemented
> **Created**: 2026-04-05
> **Updated**: 2026-04-05 (all 7 enhancements implemented and verified on k3d)
> **Priority**: High (prerequisite for OrgPack / Company as Intelligence)
> **Related**: `docs/plans/company-as-intelligence-plan.md`

---

## Context

The LLM Wiki pattern - agents that incrementally build and maintain persistent, structured knowledge bases - is a first-class platform pattern for Eve. The Company as Intelligence plan depends on it: the world model is an LLM Wiki maintained by OrgPack agents over org docs.

Eve's existing primitives are already close:

| Need | What Exists | Status |
| --- | --- | --- |
| Wiki pages | Org docs (versioned, searchable, metadata, lifecycle, version history) | Good |
| File-based read/write | Org-fs mount in agent warm pods (`/org/`) | Good |
| Auto-indexing | Org-fs -> org-docs async pipeline | Works, but current poll latency is noticeable |
| Full-text search | `eve docs search` (BM25, headline snippets, `mode=text|semantic|hybrid`) | Works, but needs prefix/context output |
| Structured queries | `eve docs query` (metadata filters, pagination) | Works |
| Patch operations | API supports replace/append/insert_after on `PATCH /docs/by-path` | **Not in CLI** |
| Version history | Immutable versions, retrievable by number | Works |
| Lifecycle management | `review_due`, `expires_at`, `lifecycle_status` | Works |
| Doc lifecycle events | `system.doc.created|updated|deleted` | Works, underused by CLI |

This plan addresses the gaps that prevent agents from using the LLM Wiki pattern fluently from normal file tools plus the Eve CLI.

---

## The Wiki Substrate

The LLM Wiki substrate is a two-layer system:

```text
Agent writes/reads files at /org/wiki/...       <- normal file tools (Read, Write, Edit)
         ↓ auto-index
Org docs at /wiki/...                           <- versioned, searchable, queryable
         ↓
Other agents and humans search/query via CLI    <- eve docs search, eve docs query
```

**Write path**: Agents use normal file tools on the org-fs mount. Zero friction.  
**Read path**: Agents use normal file tools on the org-fs mount. Zero friction.  
**Search path**: Agents use `eve docs` CLI commands. Needs improvement.  
**Patch path**: Agents should use `eve docs patch` CLI. The API exists; the CLI does not.

The org filesystem is the working copy. Org docs is the indexed, searchable, versioned layer. Changes flow automatically from org-fs to org docs via the async indexing pipeline.

---

## Enhancement 1: Near-Instant Indexing

### Problem

The org-fs -> org-docs indexing pipeline currently polls every 2 seconds. An agent writes a file, and another agent may not see the updated content in `eve docs search` for up to 2 seconds.

For slow background synthesis this is tolerable. For interactive wiki maintenance or rapid multi-agent coordination it is too slow.

### Discovery: PostgreSQL NOTIFY Already Exists

Migration `00060_org_fs_events_notify.sql` already created trigger `trg_notify_org_fs_event`. Every insert to `org_fs_events` emits `NOTIFY org_fs_events`.

The payload already includes:
- `seq`
- `id`
- `org_id`
- `event_type`
- `path`
- `created_at`

Nobody is listening today.

### Solution: Wake-on-NOTIFY, Keep the Queue as Source of Truth

Keep the current 2-second poller as the fallback path. Add a listener that wakes the index processor immediately when a relevant `org_fs_events` notification arrives.

```text
Current:
  file write -> org_fs_events row -> NOTIFY (ignored)
  ... up to 2000ms ...
  polling timer -> processBatch() -> fetch from object store -> write to org_documents

After:
  file write -> org_fs_events row -> NOTIFY
  -> listener receives event -> requestDrain()
  -> drain loop claims queue item(s) immediately
  -> fetch from object store -> write to org_documents
  Typical single-write latency target: sub-second on k3d
```

### Implementation

Add a new listener service in `apps/api/src/org-fs-sync/`:

- Own a dedicated long-lived Postgres LISTEN connection. Do not try to multiplex LISTEN/NOTIFY on the normal request pool.
- Subscribe to `org_fs_events` on module init and close cleanly on module destroy.
- Filter to `file.created` and `file.updated`.
- Treat NOTIFY as a wake signal only. Do **not** try to index directly from the NOTIFY payload because it does not contain `storage_key`, `content_hash`, or `mime_type`.
- On each wake, call `OrgFsIndexProcessor.requestDrain()`.

Refactor `OrgFsIndexProcessor`:

- Add explicit in-flight coordination (`draining`, `pendingDrain`).
- Replace one-shot wake behavior with a drain loop that keeps claiming batches until the queue is empty.
- Keep the 2-second `setInterval()` poller unchanged as fallback.
- Log and expose enough metrics to distinguish:
  - wake received
  - queue claimed
  - item indexed
  - listener reconnect/failure path

The queue remains the canonical source of work. NOTIFY only removes the avoidable idle wait between queue insert and processor wake-up.

### Acceptance Criteria

- A text file written through org-fs becomes searchable via `eve docs search` with p95 under 500ms on local k3d for low queue depth.
- No duplicate indexing or version churn when rapid writes hit the same path.
- If the listener connection dies, the existing 2-second polling path still indexes correctly.

### Effort

4-6 hours including tests. No schema changes. The trigger already exists.

---

## Enhancement 2: CLI Patch Command

### Problem

The org docs API already supports PATCH with three operations:
- `replace` - search string and replace with another
- `append` - add content to the end
- `insert_after` - insert content after an anchor string

This is exactly what wiki-maintaining agents need for surgical edits. But it is not exposed in the CLI. Agents must either overwrite the entire document or make raw API calls.

### Solution

```bash
# Search and replace within a document
eve docs patch --org <org_id> --path /wiki/page \
  --replace "old text" "new text"

# Append to end of document
eve docs patch --org <org_id> --path /wiki/page \
  --append "## New Section\n\nContent here."

# Insert after anchor text
eve docs patch --org <org_id> --path /wiki/page \
  --insert-after "## Section Header" "New paragraph after this header."

# Multiple operations in one call
eve docs patch --org <org_id> --path /wiki/page \
  --operations '[
    {"op":"replace","search":"old","replace":"new"},
    {"op":"append","content":"## Footer"}
  ]'
```

### Implementation

Add `patch` subcommand to `packages/cli/src/commands/docs.ts`.

Design details:
- Support simple flag forms for the common single-operation cases.
- Support raw `--operations` JSON for advanced multi-op usage.
- Make simple flags and `--operations` mutually exclusive.
- Return the updated doc response so callers can see `current_version`, `content_hash`, and `updated_at`.
- Update CLI help text and manual verification docs at the same time.

This is CLI parity for an existing API surface, not a new platform primitive.

### Effort

2-3 hours.

---

## Enhancement 3: Tree View

### Problem

`eve docs list` returns a flat array of paths. Agents navigating a wiki need to see structure.

```text
Current:
  /operating-model/mission
  /operating-model/outcomes/first-deploy
  /operating-model/outcomes/reduce-churn
  /operating-model/capabilities/deploy-runtime
  /world-model/state
  /world-model/execution-state

Needed:
  /operating-model/
    mission
    outcomes/
      first-deploy
      reduce-churn
    capabilities/
      deploy-runtime
  /world-model/
    state
    execution-state
```

### Solution

```bash
# Tree view of wiki structure
eve docs list --org <org_id> --path /operating-model --tree

# Nested JSON tree for agents
eve docs list --org <org_id> --path /operating-model --tree --json

# Flat list remains the default
eve docs list --org <org_id> --path /operating-model
```

### Implementation

Pure CLI formatting on top of the existing list endpoint:

- `--tree` renders a human-readable hierarchy.
- `--tree --json` returns nested nodes so agents do not need to parse ASCII tree output.
- Default behavior remains today's flat list for backwards compatibility.

### Effort

2-3 hours. No API changes.

---

## Enhancement 4: Search with Context

### Problem

`eve docs search` returns short headlines, but not enough surrounding context for an agent to decide whether to fetch the full document.

```text
Current:
  /world-model/state  (rank: 0.85)
  ...error rate crossed 2% threshold...

Needed:
  /world-model/state  (rank: 0.85)
  ---
  capabilities:
    deploy-runtime:
      status: degraded
      reason: "error rate crossed 2% threshold"
      since: "2026-04-05T14:15:00Z"
  ---
```

There is also no docs-search prefix filter today, even though the DB layer already has `searchWithFilters()` support for path-prefix filtering.

### Solution

```bash
# Search with context lines (grep-style)
eve docs search --org <org_id> --query "error rate" --context 5

# Search constrained to one wiki subtree
eve docs search --org <org_id> --query "error rate" --path /world-model

# Keep semantic/hybrid flags stable even though they currently degrade to text
eve docs search --org <org_id> --query "error rate" --path /world-model --mode hybrid
```

### Implementation

Split the work into the right scopes:

- **API**: extend `GET /orgs/{org_id}/docs/search` with optional `path_prefix`.
- **DB**: reuse existing `searchWithFilters()` for prefix filtering instead of inventing new SQL.
- **Headline quality**: widen `ts_headline()` output and allow more than one useful fragment.
- **CLI context mode**: for `--context N`, fetch each matched document and extract surrounding lines client-side.

Important scope cut:

- Phase 1 should cover `--path` and `--context`.
- Arbitrary metadata filtering during full-text search (`--where`) is useful but not required for fluent wiki use because `eve docs query` already covers metadata-only filtering.
- If combined search + metadata filters are still needed later, treat that as a separate Phase 2 extension.

### Effort

3-5 hours for path-prefix + context. Add another 3-4 hours later if combined metadata-filtered search is still needed.

---

## Enhancement 5: Version Diff

### Problem

Agents maintaining a wiki need to see what changed between versions. Currently they must fetch two versions and diff manually.

### Solution

```bash
# Diff current version against previous version
eve docs diff --org <org_id> --path /world-model/state

# Diff specific versions
eve docs diff --org <org_id> --path /world-model/state \
  --from 3 --to 5

# Unified diff format
eve docs diff --org <org_id> --path /world-model/state --unified
```

### Implementation

Pure CLI feature:

- Default to `latest` vs `latest-1`.
- Fetch versions through existing version endpoints.
- Compute unified diff client-side.
- Keep output small and agent-readable by default.

### Effort

2-3 hours.

---

## Enhancement 6: Bulk Write and Safe Sync

### Problem

A wiki ingest operation may need to create or update 10-15 documents in one pass. Today that means one CLI call per document. That is slow and noisy in agent logs.

### Solution

```bash
# Write many docs from a directory
eve docs write-dir --org <org_id> --source ./wiki-pages --path-prefix /operating-model

# Write many docs from NDJSON
printf '%s\n' \
  '{"path":"/wiki/a","content":"..."}' \
  '{"path":"/wiki/b","content":"..."}' \
  | eve docs bulk-write --org <org_id>

# Sync a local directory to org docs
eve docs sync --org <org_id> --source ./.eve-org --path-prefix /operating-model --dry-run
eve docs sync --org <org_id> --source ./.eve-org --path-prefix /operating-model --delete
```

### Implementation

Start with the safe pieces first:

- `write-dir`: map local files to doc paths and write/update them.
- `bulk-write`: NDJSON convenience wrapper over repeated single-doc writes.
- `sync`: only land once it supports `--dry-run` and requires explicit `--delete` for destructive removal.

Safety rules:

- Delete must never be the default behavior.
- Dry-run must print create/update/delete counts before mutating.
- Hidden files and junk should be skipped unless explicitly included.

This keeps OrgPack deploy-time sync useful without making it easy to wipe a wiki subtree by accident.

### Effort

4-6 hours for `write-dir` + `bulk-write`. Add another 4-6 hours for safe `sync`.

---

## Enhancement 7: Watch for Changes

### Problem

Agents that react to wiki changes currently need to poll manually. A watch command would let them block until something changes.

### Solution

```bash
# Watch for changes to any doc under a prefix
eve docs watch --org <org_id> --path /world-model --since now

# Watch from a recent horizon
eve docs watch --org <org_id> --path /world-model --since 5m

# Output: NDJSON stream of change events
{"type":"system.doc.updated","path":"/world-model/state","version":42,"updated_at":"2026-04-05T14:30:00Z","content_hash":"abc123"}
{"type":"system.doc.deleted","path":"/world-model/old-state","version":7,"updated_at":"2026-04-05T14:31:00Z","content_hash":"def456"}
```

### Implementation

Do not invent a docs-specific event system. Org docs already emit:

- `system.doc.created`
- `system.doc.updated`
- `system.doc.deleted`

Use that.

Phase 2 implementation options:

- **Simple (good enough)**: CLI polls the existing org events API, filters doc events client-side by `path` prefix, and emits NDJSON.
- **Better (generic, reusable)**: add an org-events SSE endpoint, then have `eve docs watch` consume that stream.

Avoid a new docs-only SSE endpoint. If streaming is worth adding, it should be generic org-events infrastructure that other platform features can reuse.

### Effort

Simple polling watch: 2-3 hours. Generic org-events SSE: 6-8 hours.

---

## Priority and Sequencing

### Must-have for Fluent Wiki Usage (Phase 1)

These are the minimum set for agents to use the wiki pattern cleanly:

| # | Enhancement | Effort | Impact |
| --- | --- | --- | --- |
| 1 | Near-instant indexing | 4-6h | Removes the biggest latency gap |
| 2 | CLI patch command | 2-3h | Enables surgical edits without full rewrites |
| 3 | Tree view | 2-3h | Agents can navigate wiki structure |
| 4 | Search with context | 3-5h | Agents can judge relevance without fetching every doc |

**Total Phase 1**: ~11-17 hours, plus verification work.

### Nice-to-have for OrgPack (Phase 2)

| # | Enhancement | Effort | Impact |
| --- | --- | --- | --- |
| 5 | Version diff | 2-3h | Agents can inspect changes between revisions |
| 6 | Bulk write / safe sync | 4-12h | Faster ingest and deploy-time wiki sync |
| 7 | Watch for changes | 2-8h | Reactive agents without bespoke polling loops |

**Total Phase 2**: ~8-23 hours depending on scope choices.

### Verification Is Part of the Work

This plan should not ship as "implemented" when the code compiles. Each enhancement should land with:

- targeted unit and integration coverage
- manual verification against the local k3d stack
- repo-local CLI verification so new subcommands are tested before npm release

Phase 1 is not complete until the local k3d loop at the end of this document passes.

### Not Needed

- **MCP tools**: The interface should remain normal file tools plus CLI.
- **Semantic search implementation**: The API shape already exists and currently degrades to text. Real embedding-backed search is not required for this plan.
- **Docs-specific SSE endpoint**: reuse doc lifecycle events and, if needed later, build generic org-events streaming.
- **Bulk patch across multiple docs**: low-value convenience; agents can loop.
- **Content-analysis metadata** (word count, headers, links): useful later, not blocking.

---

## Interaction Model for Wiki Agents

After these enhancements, a wiki-maintaining agent workflow looks like:

```text
# Read a wiki page (normal file tool)
Read /org/world-model/state.yaml

# Edit a wiki page (normal file tool)
Edit /org/world-model/state.yaml
  old: "health: green"
  new: "health: amber"

# Auto-index into org docs quickly

# Search the wiki
eve docs search --org $EVE_ORG_ID --query "deploy failure" --context 3 --path /world-model

# Navigate the wiki structure
eve docs list --org $EVE_ORG_ID --path /operating-model --tree

# Surgical patch without fetching full doc
eve docs patch --org $EVE_ORG_ID --path /operating-model/capabilities/deploy-runtime \
  --replace "health: green" "health: amber"

# Check what changed
eve docs diff --org $EVE_ORG_ID --path /world-model/state

# Wait for downstream updates
eve docs watch --org $EVE_ORG_ID --path /world-model --since now
```

**Key principle**: normal file tools for read/write. CLI for search, navigation, diff, watch, and surgical operations. No raw API calls. No extra protocol for agents to learn.

---

## Relationship to Company as Intelligence Plan

This plan is a prerequisite for Phase 2 of the Company as Intelligence rollout (App: Lean Coordination). The world model agent, signal watcher, policy engine, and operating review agent all need these capabilities.

| OrgPack Agent | Depends On |
| --- | --- |
| World model | File read/write, near-instant indexing, bulk write |
| Signal watcher | File write, near-instant indexing, watch |
| Policy engine | Search with context, tree view, watch |
| Operating review | Search, diff, tree view |
| All agents | Patch for cross-reference updates |

Phase 1 of this plan should ship alongside or before Phase 2 of the Company as Intelligence plan.

---

## Local k3d Verification Loop

This is the acceptance gate for this plan. When implementation starts, capture this flow as a manual scenario (for example `tests/manual/scenarios/34-llm-wiki-platform.md`) and keep it green as features land.

Use the **repo-local CLI** so new subcommands are exercised before npm release.

### Preconditions

```bash
set -euo pipefail

./bin/eh status
# Require k8s_owner: true before redeploying the local stack.

./bin/eh k8s start
./bin/eh k8s deploy

export EVE_API_URL=http://api.eve.lvh.me
export EVE="node packages/cli/bin/eve.js"

pnpm -C packages/cli build

eve profile use local
$EVE auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
$EVE system health --json

export ORG_ID="$($EVE org ensure "manual-test-org" --slug mto --json | jq -r '.id')"
export TOKEN="$($EVE auth token --raw)"
api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }

export FIXTURE_DIR=/tmp/wiki-platform-loop
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR/.eve"
cat >"$FIXTURE_DIR/.eve/manifest.yaml" <<'EOF'
services:
  api:
    image: nginx:alpine
EOF
git -C "$FIXTURE_DIR" init
git -C "$FIXTURE_DIR" add .eve/manifest.yaml
git -C "$FIXTURE_DIR" -c user.name=codex -c user.email=codex@example.com commit -m "temp: wiki platform loop fixture"
git -C "$FIXTURE_DIR" branch -M main

export PROJECT_ID="$(
  $EVE project ensure \
    --org "$ORG_ID" \
    --name "Wiki Platform Loop" \
    --slug wikiloop \
    --repo-url "file://$FIXTURE_DIR" \
    --branch main \
    --force \
    --json | jq -r '.id'
)"

export RUN_ID="$(date +%s)"
export WIKI_ROOT="/wiki-loop/$RUN_ID"
export BASE_WIKI_ROOT="$WIKI_ROOT"
export VERIFICATION_LOOPS="${VERIFICATION_LOOPS:-2}"
```

### Phase 1: Existing Surface Regression

Confirm current org docs behavior still works before exercising the new commands.

```bash
$EVE docs write --org "$ORG_ID" --path "$WIKI_ROOT/baseline/feature.md" \
  --metadata '{"owner":"pm","priority":1}' \
  --stdin <<'EOF'
# Baseline Feature

This baseline document proves write/read/query/version behavior before the wiki enhancements are exercised.
EOF

$EVE docs read --org "$ORG_ID" --path "$WIKI_ROOT/baseline/feature.md" --json
$EVE docs versions --org "$ORG_ID" --path "$WIKI_ROOT/baseline/feature.md" --json
$EVE docs query --org "$ORG_ID" --path-prefix "$WIKI_ROOT/baseline" --where 'metadata.owner eq pm' --json
$EVE docs search --org "$ORG_ID" --query "baseline document" --json
```

**Expected:**
- Existing write/read/query/search/version behavior still passes.
- The test org has at least one project so `system.doc.*` events are emitted.

### Phase 2: Near-Instant Indexing

Measure end-to-end latency from org-fs event ingest to docs search visibility.

```bash
measure_orgfs_index_latency() {
  local remote_path="$1"
  local marker="$2"
  local tmp_file="/tmp/$(basename "$remote_path")"
  local link_id link_token upload_resp upload_url storage_key file_hash file_size start_ms end_ms

  cat >"$tmp_file" <<EOF
# $marker
source: org-fs
marker: $marker
EOF

  link_id="$(api "$EVE_API_URL/orgs/$ORG_ID/fs/links" | jq -r '.[0].id // empty')"
  if [ -z "$link_id" ]; then
    link_id="$(api -X POST "$EVE_API_URL/orgs/$ORG_ID/fs/links" -H "Content-Type: application/json" \
      -d '{"device_name":"wiki-platform-loop","mode":"two-way"}' | jq -r '.id')"
  fi

  link_token="$(api "$EVE_API_URL/orgs/$ORG_ID/fs/links/$link_id/token" | jq -r '.token')"
  upload_resp="$(curl -sf -H "x-eve-internal-token: $link_token" \
    "$EVE_API_URL/orgs/$ORG_ID/fs/upload-url?path=$remote_path")"
  upload_url="$(echo "$upload_resp" | jq -r '.upload_url')"
  storage_key="$(echo "$upload_resp" | jq -r '.storage_key')"
  file_hash="sha256:$(shasum -a 256 "$tmp_file" | awk '{print $1}')"
  file_size="$(wc -c < "$tmp_file" | tr -d ' ')"

  start_ms="$(node -e 'console.log(Date.now())')"
  curl -sf -X PUT -H "Content-Type: text/markdown" --data-binary @"$tmp_file" "$upload_url" >/dev/null
  curl -sf -X POST \
    -H "x-eve-internal-token: $link_token" \
    -H "Content-Type: application/json" \
    "$EVE_API_URL/internal/orgs/$ORG_ID/fs/events" \
    -d "{\"event_type\":\"file.updated\",\"path\":\"$remote_path\",\"content_hash\":\"$file_hash\",\"size_bytes\":$file_size,\"storage_key\":\"$storage_key\"}" >/dev/null

  until $EVE docs search --org "$ORG_ID" --query "$marker" --json | jq -e '.documents | length > 0' >/dev/null; do
    sleep 0.1
  done

  end_ms="$(node -e 'console.log(Date.now())')"
  echo "$((end_ms - start_ms))"
}

for i in $(seq 1 5); do
  latency_ms="$(measure_orgfs_index_latency "$WIKI_ROOT/indexing/run-$i.md" "wiki-notify-$RUN_ID-$i")"
  echo "run=$i latency_ms=$latency_ms"
done
```

**Expected:**
- All five writes appear in docs search without waiting for the old 2-second cadence.
- p95 is under 500ms on local k3d for an otherwise idle stack.
- No run exceeds 2 seconds.

### Phase 3: Patch, Tree, Search Context, Diff

Exercise the fluent wiki navigation/editing surfaces.

```bash
$EVE docs write --org "$ORG_ID" --path "$WIKI_ROOT/operating-model/mission.md" --stdin <<'EOF'
# Mission

Ship product faster without founders becoming routers of context.
EOF

$EVE docs write --org "$ORG_ID" --path "$WIKI_ROOT/operating-model/outcomes/first-deploy.md" --stdin <<'EOF'
# First Deploy

Status: on-track
EOF

$EVE docs write --org "$ORG_ID" --path "$WIKI_ROOT/world-model/state.yaml" --stdin <<'EOF'
health: green
capabilities:
  deploy-runtime:
    status: degraded
    reason: "error rate crossed 2% threshold"
signals:
  - backlog rising
EOF

$EVE docs patch --org "$ORG_ID" --path "$WIKI_ROOT/world-model/state.yaml" \
  --replace "health: green" "health: amber"

$EVE docs patch --org "$ORG_ID" --path "$WIKI_ROOT/world-model/state.yaml" \
  --insert-after 'signals:' $'\n  - paging active'

set +e
$EVE docs patch --org "$ORG_ID" --path "$WIKI_ROOT/world-model/state.yaml" \
  --insert-after "missing-anchor" "should fail"
status=$?
set -e
test "$status" -ne 0

$EVE docs list --org "$ORG_ID" --path "$WIKI_ROOT" --tree
$EVE docs list --org "$ORG_ID" --path "$WIKI_ROOT" --tree --json

$EVE docs search --org "$ORG_ID" --query "error rate" --path "$WIKI_ROOT/world-model" --context 3 --json
$EVE docs diff --org "$ORG_ID" --path "$WIKI_ROOT/world-model/state.yaml" --unified
```

**Expected:**
- `patch` updates content and creates a new version.
- Missing anchor/search text fails with a non-zero exit code.
- `list --tree` groups by path hierarchy instead of returning a flat list.
- `search --path ... --context 3` returns only docs under the requested subtree and includes surrounding lines.
- `diff --unified` shows the `health: green -> health: amber` change and the inserted signal line.

### Phase 4: Bulk Write and Safe Sync

Verify that multi-doc writes are convenient but not dangerous.

```bash
export BULK_DIR="/tmp/wiki-bulk-$RUN_ID"
rm -rf "$BULK_DIR"
mkdir -p "$BULK_DIR/operating-model/outcomes"

cat >"$BULK_DIR/operating-model/mission.md" <<'EOF'
# Mission

Keep the company model current.
EOF

cat >"$BULK_DIR/operating-model/outcomes/first-deploy.md" <<'EOF'
# First Deploy

Owner: platform
EOF

cat >"$BULK_DIR/operating-model/outcomes/reduce-churn.md" <<'EOF'
# Reduce Churn

Owner: growth
EOF

$EVE docs write-dir --org "$ORG_ID" --source "$BULK_DIR" --path-prefix "$WIKI_ROOT/bulk"
$EVE docs list --org "$ORG_ID" --path "$WIKI_ROOT/bulk" --json

rm "$BULK_DIR/operating-model/outcomes/reduce-churn.md"

$EVE docs sync --org "$ORG_ID" --source "$BULK_DIR" --path-prefix "$WIKI_ROOT/bulk" --dry-run --delete
$EVE docs sync --org "$ORG_ID" --source "$BULK_DIR" --path-prefix "$WIKI_ROOT/bulk" --delete
```

**Expected:**
- `write-dir` creates all docs under the requested prefix.
- `sync --dry-run --delete` reports pending deletes without mutating.
- Actual deletion only happens when `--delete` is explicitly present.

### Phase 5: Watch for Changes

Verify that wiki changes can be consumed as a stream.

```bash
export WATCH_OUT="/tmp/wiki-watch-$RUN_ID.ndjson"
rm -f "$WATCH_OUT"

$EVE docs watch --org "$ORG_ID" --path "$WIKI_ROOT" --since now >"$WATCH_OUT" &
WATCH_PID=$!
sleep 1

$EVE docs patch --org "$ORG_ID" --path "$WIKI_ROOT/world-model/state.yaml" \
  --append $'\nwatch_marker: '"$RUN_ID"

$EVE docs delete --org "$ORG_ID" --path "$WIKI_ROOT/operating-model/outcomes/first-deploy.md"

sleep 3
kill "$WATCH_PID" || true
wait "$WATCH_PID" || true

cat "$WATCH_OUT"
```

**Expected:**
- The stream emits NDJSON entries for `system.doc.updated` and `system.doc.deleted`.
- Each event includes at least `type`, `path`, `version`, `updated_at`, and `content_hash`.
- Prefix filtering excludes unrelated doc events outside `$WIKI_ROOT`.

### Replay Loop

Run Phases 2-5 multiple times:

```bash
for i in $(seq 1 "$VERIFICATION_LOOPS"); do
  echo "=== wiki verification loop $i / $VERIFICATION_LOOPS ==="
  export WIKI_ROOT="$BASE_WIKI_ROOT/replay-$i"
  # Re-run Phases 2-5 with the new WIKI_ROOT for this iteration.
done
```

This catches statefulness bugs, stale watcher behavior, and sync idempotency problems.

### Fix/Deploy Cycle on Failure

If any phase fails:

1. Fix the code.
2. Run targeted tests plus `pnpm build`.
3. Rebuild the repo-local CLI with `pnpm -C packages/cli build`.
4. If API, worker, or k8s code changed, redeploy with `./bin/eh k8s deploy`.
5. Re-run the failed phase.
6. Once the failed phase is green, rerun the full loop before closing the work.

### Pass Criteria

- Existing docs CRUD/query/search/version behavior stays green.
- Org-fs indexing latency is clearly below the old 2-second poll interval on local k3d.
- CLI patch/tree/search-context/diff surfaces work end-to-end with the repo-local CLI.
- Bulk write is convenient, and sync is safe by default.
- Watch emits doc lifecycle changes without inventing a new docs-specific event system.
- The replay loop passes more than once without manual cleanup between iterations.
