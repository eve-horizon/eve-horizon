# Scenario 15: Org Document Versions & Structured Query

**Time:** ~2 minutes
**Parallel Safe:** Yes
**LLM Required:** No

End-to-end validation of versioned org document writes, version history listing, version-pinned reads, structured metadata query, and document lifecycle events.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| Doc CRUD (write/read/list/delete) | Steps 1-2 |
| Version history on update | Steps 3-4 |
| Version-pinned read | Step 5 |
| Content hash integrity | Step 3 |
| Structured metadata query | Steps 6-7 |
| Full-text search | Step 8 |
| Document lifecycle events | Step 9 |

## Prerequisites

- Smoke tests pass (scenario 01)
- `EVE_API_URL` set (see main README)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
```

## Steps

### 1. Write Initial Org Document

Create a feature brief as an org doc with metadata.

```bash
eve docs write --org $ORG_ID --path /pm/features/FEAT-100.md \
  --metadata '{"feature_status":"draft","owner":"pm-team","priority":2}' \
  --stdin <<'EOF'
# FEAT-100: User Data Export

Export user data as CSV and PDF for GDPR compliance.

## Acceptance Criteria

- Export all user data to CSV
- Export all user data to PDF
- Audit log entry on every export
EOF
```

**Expected:**
- Command succeeds (HTTP 200 or 201)
- Document created at path `/pm/features/FEAT-100.md`

### 2. Read Document Back

```bash
eve docs read --org $ORG_ID --path /pm/features/FEAT-100.md --json
```

**Expected:**
- Returns full document detail with `content`, `content_hash`, `metadata`
- `mime_type` is `text/markdown`
- `metadata.feature_status` is `"draft"`
- `metadata.owner` is `"pm-team"`

### 3. Update Document (Create Version 2)

```bash
eve docs write --org $ORG_ID --path /pm/features/FEAT-100.md \
  --metadata '{"feature_status":"review","owner":"pm-team","priority":1,"risk_score":3}' \
  --stdin <<'EOF'
# FEAT-100: User Data Export

Export user data as CSV and PDF for GDPR compliance.

## Acceptance Criteria

- Export all user data to CSV
- Export all user data to PDF
- Audit log entry on every export
- Rate-limit exports to 10/hour per user

## Technical Notes

Use streaming for large datasets. Compress PDF output.
EOF
```

**Expected:**
- Command succeeds (HTTP 200)
- `content_hash` differs from the first write

### 4. List Version History

```bash
eve docs versions --org $ORG_ID --path /pm/features/FEAT-100.md --json
```

**Expected:**
- Returns array of version entries
- At least 2 versions present (version 1 and version 2)
- Each entry has `version`, `content_hash`, `created_at`
- Version 2 is most recent

### 5. Read Pinned Version

```bash
eve docs read --org $ORG_ID --path /pm/features/FEAT-100.md --version 1 --json
```

**Expected:**
- Returns version 1 content (without the "Rate-limit" and "Technical Notes" additions)
- `content_hash` matches version 1 from the version history

### 6. Write Additional Documents for Query Testing

Create a second feature doc with different metadata.

```bash
eve docs write --org $ORG_ID --path /pm/features/FEAT-101.md \
  --metadata '{"feature_status":"draft","owner":"eng-team","priority":3,"risk_score":1}' \
  --stdin <<'EOF'
# FEAT-101: Dark Mode Toggle

Add a dark mode preference to user settings.
EOF
```

Create a third feature doc.

```bash
eve docs write --org $ORG_ID --path /pm/features/FEAT-102.md \
  --metadata '{"feature_status":"review","owner":"pm-team","priority":1,"risk_score":5}' \
  --stdin <<'EOF'
# FEAT-102: Payment Integration

Integrate Stripe payment processing for premium features.
EOF
```

**Expected:**
- Both commands succeed

### 7. Structured Metadata Query

Query documents by metadata filters.

```bash
eve docs query --org $ORG_ID --path-prefix /pm/features/ \
  --where 'metadata.feature_status in draft,review' \
  --sort updated_at:desc --json
```

**Expected:**
- Returns all three FEAT docs (100, 101, 102)
- Results are sorted by `updated_at` descending

```bash
eve docs query --org $ORG_ID --path-prefix /pm/features/ \
  --where 'metadata.owner eq pm-team' --json
```

**Expected:**
- Returns FEAT-100 and FEAT-102 (owned by pm-team)
- Does NOT return FEAT-101 (owned by eng-team)

```bash
eve docs query --org $ORG_ID --path-prefix /pm/features/ \
  --where 'metadata.risk_score gte 4' --json
```

**Expected:**
- Returns FEAT-102 (risk_score=5)
- Does NOT return FEAT-100 (risk_score=3) or FEAT-101 (risk_score=1)

### 8. Full-Text Search

```bash
eve docs search --org $ORG_ID --query "GDPR compliance" --json
```

**Expected:**
- Returns FEAT-100 (contains "GDPR compliance" in content)
- May include `headline` with highlighted snippet

```bash
eve docs search --org $ORG_ID --query "Stripe payment" --json
```

**Expected:**
- Returns FEAT-102

### 9. Document Events

Check that document mutations emitted lifecycle events.

> **Note:** The CLI `event list` command currently requires `--project` and does not support
> org-scoped event queries via `--org` alone. Use a project that has org docs activity, or
> verify events directly via the API. This is a known CLI gap — org-level event listing will
> be added in a future iteration.

```bash
# Use a project slug that has had doc activity, or query the API directly:
curl -s -H "Authorization: Bearer $(eve auth token)" \
  "$EVE_API_URL/orgs/$ORG_ID/events?type=system.doc.created&limit=5" | jq
```

**Expected:**
- Contains events for doc creations
- Each event payload includes `doc_id`, `path`, `version`, `content_hash`

```bash
curl -s -H "Authorization: Bearer $(eve auth token)" \
  "$EVE_API_URL/orgs/$ORG_ID/events?type=system.doc.updated&limit=5" | jq
```

**Expected:**
- Contains event for the FEAT-100 update (version 2)

> If the org-level events API is not yet available, this step can be verified by checking
> the database directly or by using project-scoped event listing on a project that was used
> for the doc writes. Mark this step as SKIP if neither approach is available.

### 10. Cleanup

```bash
eve docs delete --org $ORG_ID --path /pm/features/FEAT-100.md --json
eve docs delete --org $ORG_ID --path /pm/features/FEAT-101.md --json
eve docs delete --org $ORG_ID --path /pm/features/FEAT-102.md --json
```

**Expected:**
- All three deletes succeed

## Success Criteria

- [ ] Org doc write/read round-trip preserves content and metadata
- [ ] Update creates new version (version history has 2+ entries)
- [ ] Pinned version read returns historical content
- [ ] Content hash differs between versions
- [ ] Structured metadata query filters correctly (owner, status, risk_score)
- [ ] Full-text search returns relevant docs with headlines
- [ ] Document lifecycle events emitted (system.doc.created, system.doc.updated)
- [ ] Cleanup deletes succeed

## CLI Commands Reference

```bash
eve docs write --org <org> --path <path> [--file <path> | --stdin] [--metadata <json>]
eve docs read --org <org> --path <path> [--version <n>] [--json]
eve docs list --org <org> [--path <prefix>] [--json]
eve docs versions --org <org> --path <path> [--json]
eve docs query --org <org> --path-prefix <prefix> --where <filter> [--sort <field:dir>] [--json]
eve docs search --org <org> --query <text> [--json]
eve docs delete --org <org> --path <path> [--json]
```

## Debugging

### Document write fails with 409

The path already exists. The CLI auto-detects and uses PUT for updates. If you see a 409, the document may have been created in a previous test run — the write should still succeed as an update.

### Version history is empty

Version history requires the `org_document_versions` table (migration 00052 or later). Check:
```bash
eve system health --json
```

### Metadata query returns unexpected results

Metadata is stored as JSONB. Verify the metadata was set correctly:
```bash
eve docs read --org $ORG_ID --path /pm/features/FEAT-100.md --json | jq '.metadata'
```

### Events not appearing

Events require the event spine to be operational. Check:
```bash
eve event list --org $ORG_ID --json | jq 'length'
```
If events are empty, verify the API is emitting events on doc mutations.
