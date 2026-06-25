# Scenario 01: Smoke Tests

**Time:** ~30 seconds
**Parallel Safe:** Yes
**LLM Required:** No

Quick validation that the Eve stack is operational.

## Prerequisites

- `EVE_API_URL` set (see main README)
- Secrets imported to test org (see main README)

## Steps

### 1. API Health Check

```bash
eve system health --json
```

**Expected:**
- Command succeeds
- Returns JSON with `status: "ok"` or `status: "healthy"`

### 2. CLI Connectivity

```bash
eve org list --json
```

**Expected:**
- Command succeeds
- Returns valid JSON (may be empty array)

### 3. Org Secrets Check

```bash
eve secrets list --org org_manualtestorg --json
```

**Expected:**
- Command succeeds
- Output shows `Z_AI_API_KEY` is set (for job execution)
- Output shows `GITHUB_TOKEN` is set (for repo access)

**If secrets are missing** (run from repo root):
```bash
eve secrets import --org org_manualtestorg --file ./manual-tests.secrets
```

### 4. Harness Auth (zai)

```bash
eve harness list --org org_manualtestorg --json
```

**Expected:**
- Command succeeds
- Output contains harness with `name: "zai"` (or alias)
- That harness has `auth.available: true`

**If zai auth is missing:**
- Check `Z_AI_API_KEY` is set on the test org
- Verify secrets are imported: `eve secrets list --org org_manualtestorg --json`

## Success Criteria

- [ ] API health returns OK status
- [ ] CLI can list orgs (even if empty)
- [ ] Org secrets are present (Z_AI_API_KEY, GITHUB_TOKEN)
- [ ] zai harness auth is available

## Commands Summary

```bash
# All-in-one validation
eve system health --json && \
eve org list --json && \
eve secrets list --org org_manualtestorg --json && \
eve harness list --org org_manualtestorg --json | jq '.data[] | select(.name == "zai" or .aliases[]? == "zai") | .auth'
```

## Debugging (If Smoke Fails)

Use Eve CLI for debugging - no kubectl needed for these checks:

```bash
# Comprehensive system status
eve system status

# Check specific service logs
eve system logs api --tail 20
eve system logs worker --tail 20

# Check all harnesses and their auth status
eve harness list --org org_manualtestorg --json | jq '.data[] | {name, auth}'
```

**Only if `eve system status` fails completely:**
```bash
# Infrastructure check
kubectl get pods -n eve
kubectl get events -n eve --sort-by='.lastTimestamp' | tail -10
```
