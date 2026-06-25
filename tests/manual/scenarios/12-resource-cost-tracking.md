# Scenario 12: Resource Management & Cost Tracking

**Time:** ~3-4 minutes
**Parallel Safe:** Yes
**LLM Required:** No

End-to-end validation of pricing, receipts, spend aggregation, balance ledger, managed models, and environment suspension.

## Prerequisites

- `EVE_API_URL` set (see main README)
- Secrets imported to test org (see main README)

## Steps

### 1. Seed Pricing Defaults

```bash
eve admin pricing seed-defaults --json
```

**Expected:**
- Seeds default rate card, billing defaults, and resource classes (idempotent)
- Returns JSON with `rate_card`, `billing_defaults`, `resource_classes` objects
- Each shows `created: true` (first run) or `created: false` (already present)

### 2. Balance Ledger

```bash
eve admin balance show --org org_manualtestorg --json
```

**Expected:**
- Returns balance info (may be 0 for fresh org)
- Shows `currency`, `balance`, `lifetime_in`, `lifetime_out`

```bash
eve admin balance credit --org org_manualtestorg --amount 100 --currency usd --reason "Manual test credit" --json
```

**Expected:**
- Creates a credit transaction
- Balance increases by 100
- Returns transaction details with `id`, `amount`, `currency`

```bash
eve admin balance transactions --org org_manualtestorg --json
```

**Expected:**
- Returns array of transactions
- Includes the credit transaction just created
- Each transaction has `id`, `type`, `amount`, `currency`, `source_type`, `source_id`

### 3. Managed Models

```bash
eve models list --json
```

**Expected:**
- Returns JSON with `byok` and `managed` arrays
- Managed models list reflects currently installed Ollama models (varies by deployment)

### 4. Environment Suspension

```bash
# Create a test project for suspension testing
eve project ensure --org org_manualtestorg --name "suspension-test" --slug stest --repo-url "file:///tmp/dummy-repo" --branch main --force --json
```

**Expected:**
- Project created or updated

```bash
# Check environment status (if any envs exist)
eve env list --project <project_id> --json
```

**Expected:**
- Lists environments with `status` field (active/suspended/terminated)
- Fields include `suspended_at`, `suspension_reason`

### 5. Receipts Recompute

```bash
eve admin receipts recompute --since 7d --json
```

**Expected:**
- Returns JSON with `scanned_attempts`, `updated_attempts`, `skipped_attempts`
- No errors

### 6. Usage Records (Admin)

```bash
eve admin usage list --org org_manualtestorg --json
```

**Expected:**
- Returns usage records (may be empty if sweeper hasn't run)
- No errors

```bash
eve admin usage summary --org org_manualtestorg --json
```

**Expected:**
- Returns aggregated usage summary
- No errors

## Success Criteria

- [ ] Pricing defaults can be seeded (rate card, billing defaults, resource classes)
- [ ] Balance ledger supports credit/show/transactions
- [ ] Managed models list returns model registry
- [ ] Environment status field visible in env list
- [ ] Receipts recompute returns valid response
- [ ] Usage admin endpoints return valid responses
- [ ] No HTTP 500 errors from any endpoint
