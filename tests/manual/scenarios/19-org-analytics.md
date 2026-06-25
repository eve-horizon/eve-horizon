# Scenario 19: Org Analytics

**Time:** ~1 minute
**Parallel Safe:** Yes
**LLM Required:** No

End-to-end validation of org-level analytics endpoints for jobs, pipelines, and environment health.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| Analytics summary aggregation | Step 1 |
| Jobs analytics with time window | Step 2 |
| Pipeline analytics with time window | Step 3 |
| Environment health status | Step 4 |
| Dashboard formatted output | Step 5 |

## Prerequisites

- Smoke tests pass (scenario 01)
- Test org with existing jobs/pipelines (run scenarios 01-04 first for data)
- `EVE_API_URL` set (see main README)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
```

## Steps

### 1. Analytics Summary

```bash
eve analytics summary --org $ORG_ID --window 7d --json
```

**Expected:**
- Returns `as_of` timestamp
- Returns `window` matching `"7d"`
- Contains `projects` count (number of projects in org)
- Contains `jobs` stats (totals, by-status breakdown)
- Contains `pipelines` stats
- Contains `environments` stats

### 2. Jobs Analytics

```bash
eve analytics jobs --org $ORG_ID --window 30d --json
```

**Expected:**
- Job statistics for the 30-day window
- Includes aggregate counts:
  - `created`
  - `completed`
  - `failed`
  - `active`
- `as_of` timestamp is present

### 3. Pipeline Analytics

```bash
eve analytics pipelines --org $ORG_ID --window 7d --json
```

**Expected:**
- Pipeline run statistics for the window period
- If scenario 03 ran recently, at least one pipeline appears

### 4. Environment Health

```bash
eve analytics env-health --org $ORG_ID --json
```

**Expected:**
- Environment health aggregate for the org (`total`, `healthy`, `degraded`, `unknown`)
- `as_of` timestamp is present

### 5. Dashboard Output

Run summary without `--json` to verify formatted dashboard output.

```bash
eve analytics summary --org $ORG_ID --window 7d
```

**Expected:**
- Human-readable formatted dashboard
- Labeled sections for projects, jobs, pipelines, environments
- Counts and status breakdowns rendered as a table or formatted text

## Success Criteria

- [ ] Summary returns correct aggregate counts with `as_of` and `window`
- [ ] Window parameter controls time range for jobs and pipelines
- [ ] Jobs analytics returns aggregate job counts for the selected window
- [ ] Pipeline analytics returns run statistics
- [ ] Environment health endpoint returns aggregate environment status counts
- [ ] Dashboard formatting is readable with labeled sections
- [ ] All endpoints accessible with `org:read` permission

## CLI Commands Reference

```bash
eve analytics summary --org <org> [--window <duration>] [--json]
eve analytics jobs --org <org> [--window <duration>] [--json]
eve analytics pipelines --org <org> [--window <duration>] [--json]
eve analytics env-health --org <org> [--json]
```

## Debugging

### Analytics returns empty results

Analytics depend on existing data. Run scenarios 01-04 first to populate jobs and pipelines:
```bash
eve job list --org $ORG_ID --json | jq 'length'
```

### Window parameter not filtering correctly

Verify the duration format is one of the accepted values (`1d`, `7d`, `30d`, `90d`):
```bash
eve analytics summary --org $ORG_ID --window 30d --json | jq '.window'
```

### Permission denied (403)

Analytics endpoints require `org:read` permission. Verify your token has the correct scope:
```bash
eve auth whoami --json
```
