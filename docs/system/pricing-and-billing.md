# Pricing & Billing

> Status: Current
> Last Updated: 2026-05-20
> Purpose: Document pricing, receipts, balances, usage metering, and budget enforcement.

## Overview

Eve tracks costs per job attempt and per org. Pricing is driven by **rate cards**
and exchange-rate snapshots. Receipts are stored on attempts and can be queried
via API or CLI. Non-job resources (services, PVCs, managed DBs) are metered
periodically into `usage_records` and charged against org balances.

## Current (Implemented)

### Provider Registry + Model Discovery

- Providers are registered in-process and exposed via public endpoints.
- Model discovery is supported for providers that expose catalog APIs.
- All models use BYOK (bring your own key) — set API keys via org/project secrets.

Endpoints:

```
GET /providers
GET /providers/{name}
GET /providers/{name}/models
GET /models
```

### Rate Cards + Exchange Rates

- Rate cards are immutable versions (name + version + effective_at).
- Exchange-rate snapshots are stored for auditable conversions.

Endpoints (admin):

```
POST /admin/pricing/rate-cards
GET  /admin/pricing/rate-cards?name=<name>
GET  /admin/pricing/rate-cards/effective?name=<name>&at=<iso>
POST /admin/pricing/exchange-rates
GET  /admin/pricing/exchange-rates/latest?from=USD&to=EUR
POST /admin/pricing/refresh-openrouter
```

### Execution Receipts (Per Attempt)

Receipts are persisted on job attempts and include:

- Phase timings (`timing.billable_ms`)
- LLM usage totals (`llm.totals`)
- Base cost (USD) and billed cost (org currency)
- Compute usage from `resource_class`

Endpoints:

```
GET /jobs/{job_id}/receipt
GET /jobs/{job_id}/attempts/{attempt_id}/receipt
GET /jobs/{job_id}/compare?a=1&b=2&include_receipt=true
```

### Budgets + Enforcement

Jobs can set per-attempt budgets via hints:

- `hints.max_cost` (amount + currency)
- `hints.max_tokens` (integer)
- `hints.resource_class` (compute SKU)

The execution runtime tracks `llm.call` events during execution and terminates
attempts with `BUDGET_EXCEEDED` when limits are exceeded. Token counting against
`max_tokens` is **cache-aware**: cache-read tokens are weighted by the model's
cache-read share of its input price when the active rate card defines a cheaper
cache-read rate. `max_cost` is the economically correct cap; `max_tokens` is a
coarse guardrail. The `budget.summary` / `budget.exceeded` log rows carry
`weighted_tokens`, `cache_read_tokens`, `cache_read_token_weight`, and
`cache_read_tokens_excluded` for visibility. Enforcement is **fail-open** if
pricing configuration cannot be resolved. The API can mark jobs as budget-blocked
via `hints.budget_blocked` and `hints.budget_blocked_reason`.

### Balance Ledger

Org balances are tracked via an immutable ledger. Admins can credit balances and
inspect transactions.

Endpoints (admin):

```
GET  /admin/orgs/{org_id}/balance
POST /admin/orgs/{org_id}/balance/credit
GET  /admin/orgs/{org_id}/balance/transactions
```

### Usage Metering (Non-Job Resources)

Non-job resources are periodically metered into `usage_records` (services, PVCs,
managed databases) and charged against org balances.

Endpoints (admin):

```
GET /admin/orgs/{org_id}/usage
GET /admin/orgs/{org_id}/usage/summary
```

### Cloud Cost Snapshots (Bill-Backed)

Cloud cost reporting uses provider-neutral month-to-date snapshots in
`cloud_cost_snapshots`. The orchestrator cloud-cost collector calls a configured
provider adapter and writes one row per configured scope. AWS Cost Explorer is
the first adapter; it queries `UnblendedCost` in `us-east-1`, groups by
service, and filters the staging cluster by active cost allocation tags:
`Project=eve-horizon` and `Environment=staging`.

The daily Sentinel Slack summary reads cloud snapshots first. When a cluster
snapshot exists, Slack shows the bill-backed cloud headline and does not show a
whole-account cost or the OpenCost total. If no cloud row exists, or the cloud
snapshot query fails, Slack falls back to the OpenCost environment estimate
below.

Endpoint (admin):

```
GET /admin/cost/cloud?scope_type=cluster&scope_key=example-cluster&month=YYYY-MM&provider=aws&source=aws_cost_explorer
```

Response includes provider/source, scope metadata, MTD and projected amounts,
currency, confidence, coverage, observed/stale metadata, provider filters, and
service breakdowns. Provider adapters return `null` for lagged empty data so
the collector preserves the last-good snapshot and never writes a `$0` cluster
cost during Cost Explorer freshness delays.

`coverage='undercount'` means billing tags have not propagated to every
billable cluster resource yet. For staging, Terraform owns IRSA and tag
propagation in `../deployment-instance`; no static AWS keys are used.

### Environment Cost Snapshots (OpenCost Estimates)

Environment cost reporting uses precomputed month-to-date snapshots in
`environment_cost_snapshots`. The opt-in orchestrator collector reads the
OpenCost allocation API, maps namespace allocations to Eve environments, and
writes one row per environment plus a shared platform overhead row. The daily
Sentinel Slack summary and `eve system env-cost` read these snapshots only;
they never call OpenCost live and never use `usage_records` as a cost source.

Endpoint (admin):

```
GET /admin/cost/environments?month=YYYY-MM&source=opencost
```

Response includes `total_usd`, `env_total_usd`, `shared_usd`, ordered
environment rows, `observed_at`, `stale`, and `stale_after_hours`. OpenCost
values are labelled `estimate`; they are not bill-backed and are not used as the
default Slack headline when a cloud cluster snapshot exists.

### Environment Suspension

When org balances fall below thresholds, the suspension controller can suspend
environments. Suspended environments block deploys and job creation until
resumed.

Endpoints (admin/org owner):

```
POST /projects/{project_id}/envs/{env}/suspend
POST /projects/{project_id}/envs/{env}/resume
```

## CLI Reference

```
eve providers list
eve providers show <name>
eve providers models <name>

eve models list

eve admin pricing seed-defaults
eve admin pricing refresh-openrouter [--json]
eve admin receipts recompute --since 7d [--project proj_xxx] [--dry-run]
eve admin balance show <org_id>
eve admin balance credit <org_id> --amount <n> --currency <c> --reason "..."
eve admin balance transactions <org_id> [--since <iso>]
eve admin usage list --org <org_id>
eve admin usage summary --org <org_id>
eve system cloud-cost [--scope cluster] [--scope-key example-cluster] [--provider aws] [--source aws_cost_explorer] [--month YYYY-MM] [--json]
eve system env-cost [--all] [--month YYYY-MM] [--source opencost] [--json]

eve job receipt <job_id> [--attempt N]
eve job compare <job_id> <attempt-a> <attempt-b> [--receipt]
eve env suspend <project> <env> --reason "..."
eve env resume <project> <env>
```

## Notes

- Receipts are immutable snapshots; recompute only for backfills or fixes.
- `usage_records` are **only** for non-job resources; job costs are tracked via receipts.
- `environment_cost_snapshots` are OpenCost allocation estimates for environment
  reporting; they are separate from both receipts and `usage_records`.
- `cloud_cost_snapshots` are bill-backed provider snapshots for cluster/project
  totals; Slack reads these before falling back to OpenCost estimates.
