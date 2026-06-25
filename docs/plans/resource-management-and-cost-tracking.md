# Resource Management, Cost Tracking, and Pricing Engine

> Status: Superseded (see `docs/plans/resource-management-and-cost-tracking-v2.md`)
> Created: 2026-02-09
>
> Unifies and supersedes the phasing/implementation sections of:
> - `docs/ideas/observability-time-and-cost-v3.md` (execution receipts)
> - `docs/ideas/platform-resource-plane.md` (resource plane)
>
> Those docs remain as architectural references. This doc owns the implementation sequence and the revised pricing model.

## Problem Statement

Two design docs describe ~15 phases of work across execution receipts, resource classes, billing, budgets, identity, gateway plugins, and platform agents. Three issues need resolution before implementation begins:

1. **Denomination-specific column names** — `balance_sats`, `rate_sats`, `amount_sats` in the resource plane doc belong to Nostr/Bitcoin, not the core platform. The core must be denomination-agnostic.
2. **Static pricing** — The v3 doc proposes a YAML config file. Real deployments need runtime-changeable pricing: LLM providers cut prices, cloud costs shift, Bitcoin fluctuates by the minute.
3. **No cost+markup model** — Eve passes through provider resources. Receipts should separate what providers charge (base cost) from what the platform bills (marked-up cost in the customer's currency).

---

## Revised Pricing Architecture

### Separate Base Cost from Billed Cost

Every receipt embeds two cost views:

```
base_cost (what providers charge us, always USD)
  +-- llm_total:     $0.038
  +-- compute_total:  $0.001
  +-- total:          $0.039
  +-- rates: [{provider, model, input_rate_per_million, ...}]

billed_cost (what customer pays, in their billing currency)
  +-- currency:       "sats"
  +-- markup_pct:     20
  +-- exchange_rate:  3846.15  (1 USD = 3846.15 sats at snapshot time)
  +-- exchange_rate_at: "2026-02-09T12:34:00Z"
  +-- llm_total:      180 sats
  +-- compute_total:  5 sats
  +-- total:          185 sats
```

**Why this matters**:
- Historical receipts are always accurate (rates embedded, not referenced)
- Markup is transparent (customer sees base + margin)
- Currency conversion is auditable (exchange rate + timestamp in receipt)
- Recomputation is explicit (admin command), not implicit (config drift)
- Same receipt structure works for USD enterprise, sats nostrworld, or abstract credits

### Where Pricing Data Lives

| Data | Storage | Why |
|------|---------|-----|
| LLM provider rates (USD) | DB: `pricing_rate_cards`, seeded from YAML | Runtime-updatable; YAML provides git-auditable defaults |
| Compute rates (USD) | Same table, same card | One rate card covers everything |
| Default markup % | DB: `platform_config` table | Per-deployment setting |
| Per-org markup override | DB: `orgs.billing_config` JSONB | Enterprise discounts |
| Exchange rates | DB: `exchange_rates` table | Updated frequently for volatile currencies |
| Billing currency | `platform_config` + per-org override | Per-deployment default, per-org override |

**Update flows**:
- **Admin API**: `POST /admin/pricing/rate-cards` creates a new version. Old versions are never deleted (marked `superseded_at`).
- **Automated sync**: A cron job or platform agent fetches provider rate changes and proposes a new rate card version.
- **Exchange rates**: Separate cron, configurable interval (every 5 min for sats, daily for EUR).

### Denomination-Agnostic Schema

All financial columns use generic names with a `currency` field:

```sql
-- WRONG (current resource plane doc):
balance_sats BIGINT, amount_sats BIGINT, rate_sats INTEGER

-- RIGHT (this plan):
balance NUMERIC, amount NUMERIC, currency TEXT
```

### Cost+Markup Calculation

```
provider_base_rate      (from rate card, in USD)
  * quantity            (tokens, vCPU-seconds, etc.)
  = base_cost           (in USD)

base_cost
  * (1 + markup_pct/100)
  * exchange_rate        (USD -> billing currency, 1.0 if billing in USD)
  = billed_cost          (in billing currency)
```

Both values are stored in the receipt. The customer's balance is debited by `billed_cost.total`.

---

## Implementation Phases

### Phase 0: Schema Foundation

**Goal**: Add the missing timestamps that everything else depends on.

**Migration** (`000XX_execution_receipts_foundation.sql`):
```sql
ALTER TABLE jobs ADD COLUMN ready_at TIMESTAMPTZ;

ALTER TABLE job_attempts
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN execution_started_at TIMESTAMPTZ,
  ADD COLUMN receipt JSONB;

CREATE INDEX idx_attempts_receipt
  ON job_attempts ((receipt->'billed_cost'->>'total')::numeric)
  WHERE receipt IS NOT NULL;
```

**Code changes**:
- `packages/db/src/queries/jobs.ts` — `claim()` sets `claimed_at = NOW()` on the new attempt; `updatePhase()` sets `ready_at` when transitioning to `ready`
- `apps/worker/src/invoke/invoke.service.ts` — set `execution_started_at` via `updateExecutionStarted()` before workspace prep
- `apps/orchestrator/src/loop/loop.service.ts` — no changes (claim already happens in `jobs.claim()`)

**Dependencies**: None.

---

### Phase 1: Pricing Infrastructure

**Goal**: Rate cards, exchange rates, and cost calculation functions.

**Migration** (`000XX_pricing_infrastructure.sql`):
```sql
CREATE TABLE pricing_rate_cards (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  effective_at  TIMESTAMPTZ NOT NULL,
  rates         JSONB NOT NULL,           -- { llm: {...}, compute: {...} }
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  UNIQUE(name, version)
);

CREATE TABLE exchange_rates (
  id              TEXT PRIMARY KEY,
  from_currency   TEXT NOT NULL,
  to_currency     TEXT NOT NULL,
  rate            NUMERIC NOT NULL,
  source          TEXT NOT NULL,           -- 'manual', 'coingecko', 'ecb'
  fetched_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_exchange_rates_latest
  ON exchange_rates(from_currency, to_currency, fetched_at DESC);

CREATE TABLE platform_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orgs ADD COLUMN billing_config JSONB;
-- billing_config: { currency, markup_pct, rate_card_name }
```

**New files**:
- `packages/shared/src/config/default-pricing.yaml` — git-auditable default LLM + compute rates
- `packages/shared/src/pricing/types.ts` — `RateCard`, `ExchangeRate`, `BillingConfig`, `ReceiptCost`
- `packages/shared/src/pricing/rate-card.ts` — resolve effective rate card for an org
- `packages/shared/src/pricing/model-names.ts` — canonicalize provider model strings (`claude-opus-4-5-20250929` -> `claude-opus-4-5`)
- `packages/shared/src/pricing/cost-calculator.ts` — compute `base_cost` + `billed_cost` from quantities + rates + markup + exchange rate
- `packages/db/src/queries/pricing.ts` — rate card and exchange rate CRUD

**Parallelizable**: Yes — independent of Phase 0.

---

### Phase 2: Receipt Assembly

**Goal**: Compute receipts from lifecycle events and store them on attempts.

**New files**:
- `packages/shared/src/pricing/receipt.ts` — `ExecutionReceipt` interface
- `packages/shared/src/pricing/receipt-assembly.ts` — `assembleReceipt()`: read lifecycle events, extract phase durations, aggregate tokens, compute cost

**Modified files**:
- `apps/worker/src/invoke/invoke.service.ts` — after `completeAttempt()`, call `assembleReceipt()` and store via `updateReceipt()`
- `packages/db/src/queries/jobs.ts` — add `updateReceipt(attemptId, receipt)`

**Token handling (pre-llm.call)**: Uses existing `extractTokenUsage()` totals. Model identity from `lifecycle_harness_start` event metadata.

**Compute section**: `resource_class: null`, `vcpu_seconds: 0` until Phase 5.

**Dependencies**: Phase 0 + Phase 1.

---

### Phase 3: Receipt API + CLI

**Goal**: Surface receipts to users.

**New files**:
- `apps/api/src/jobs/jobs.receipt.controller.ts` — `GET /jobs/:id/receipt`
- `packages/cli/src/commands/job/receipt.ts` — `eve job receipt <job_id> [--attempt N] [--json]`

**Modified files**:
- `packages/cli/src/commands/job/diagnose.ts` — append receipt phase breakdown
- `packages/cli/src/commands/job/result.ts` — append cost one-liner

**CLI output**:
```
$ eve job receipt myproj-a3f2dd12

  Job: myproj-a3f2dd12  (attempt 1, succeeded)
  Duration: 47.2s

  Phase Breakdown:
    queue wait       2.1s   ====            4%
    orchestrator     0.2s   =              <1%
    workspace        5.8s   =======        12%
    secrets          0.3s   =               1%
    hooks            3.2s   ====            7%
    harness         35.8s   ==================  76%

  LLM Usage:
    claude-opus-4-5 (anthropic):  3 calls
      Tokens:   2,150 in / 847 out (+ 1,200 cache read)

  Cost:
    Base (USD):   $0.039  (LLM: $0.038, compute: $0.001)
    Billed:       $0.047  (20% markup)
    Rate card:    default v3 (2026-02-01)
```

**Dependencies**: Phase 2.

---

### Phase 4: LLM Call Events (Token Ledger)

**Goal**: Per-call, per-model token tracking from harness-side events.

**Shared types**:
- `packages/shared/src/types/lifecycle.ts` — add `LlmCallEvent` type

**Harness changes** (emit `llm.call` JSON event after each provider API call):
- `packages/eve-agent-cli/` — mclaude adapter (Anthropic SDK `response.usage`)
- Other harness adapters (zai, gemini, codex) — normalize provider usage to common schema

**Worker changes**:
- `apps/worker/src/invoke/invoke.service.ts` — streaming loop recognizes `type: "llm.call"` and writes to `execution_logs`
- `extractTokenUsage()` becomes fallback for non-`llm.call` harnesses

**Receipt assembly update**:
- `packages/shared/src/pricing/receipt-assembly.ts` — aggregate `llm.call` events into per-model breakdown with cache tokens, reasoning tokens

**CLI**:
- `packages/cli/src/commands/job/follow.ts` — show running cost from `llm.call` events

**Parallelizable**: Can start alongside Phase 3 (different code paths).

---

### Phase 5: Resource Classes

**Goal**: Named compute SKUs that drive K8s pod sizing and compute cost.

**Resource class config** (in `platform_config`, seeded from YAML):
```yaml
resource_classes:
  job.c1: { vcpu: 1, memory_gib: 2 }
  job.c2: { vcpu: 2, memory_gib: 4 }
  job.m1: { vcpu: 2, memory_gib: 8 }
```

**Modified files**:
- `packages/shared/src/schemas/job.ts` — add `resource_class` to `JobHints`
- `apps/worker/src/invoke/k8s-runner.ts` — resolve resource class to K8s requests/limits (replaces hardcoded env vars)
- `packages/shared/src/pricing/receipt-assembly.ts` — compute `vcpu_seconds`, `memory_gib_seconds`, compute cost
- `packages/shared/src/config/default-pricing.yaml` — add compute rates per class

**Parallelizable**: Can start alongside Phase 4 (independent).

---

### Phase 6: Spend Aggregation + Comparison

**Goal**: Cross-job cost queries, project/org spend views, job comparison.

**New files**:
- `packages/db/src/queries/spend.ts` — aggregation queries over `job_attempts.receipt`
- `apps/api/src/projects/projects.spend.controller.ts` — `GET /projects/:id/spend`
- `apps/api/src/orgs/orgs.spend.controller.ts` — `GET /orgs/:id/spend`
- `packages/cli/src/commands/project/spend.ts`
- `packages/cli/src/commands/org/spend.ts`
- `packages/cli/src/commands/job/compare.ts`
- `packages/cli/src/commands/admin/recompute-receipts.ts`

**Dependencies**: Phases 3, 4, 5 (full receipt data).

---

### Phase 7: Budget Enforcement

**Goal**: Cost limits at job, project, and org level.

**Worker**:
- `apps/worker/src/invoke/invoke.service.ts` — track running cost from `llm.call` events; SIGTERM harness when `max_cost` exceeded

**Orchestrator**:
- `apps/orchestrator/src/loop/loop.service.ts` — query project/org spend before `claimNextJob()`; skip claim if hard limit exceeded

**Config**:
- `packages/shared/src/schemas/job.ts` — `max_cost`, `max_tokens` in hints
- Manifest `x-eve.budgets` block

**Dependencies**: Phase 4 (llm.call for real-time), Phase 6 (spend queries).

---

### Phase 8: Balance Ledger

**Goal**: Prepaid balances and charge transactions for multi-tenant billing.

**Migration**:
```sql
CREATE TABLE org_balances (
  org_id        TEXT PRIMARY KEY REFERENCES orgs(id),
  balance       NUMERIC NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  lifetime_in   NUMERIC NOT NULL DEFAULT 0,
  lifetime_out  NUMERIC NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE balance_transactions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  type          TEXT NOT NULL,          -- credit, charge, refund, adjustment
  amount        NUMERIC NOT NULL,
  currency      TEXT NOT NULL,
  description   TEXT,
  source_type   TEXT,                   -- payment, receipt, manual, promo
  source_id     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

No `_sats` anywhere. Generic `NUMERIC` + `currency TEXT`.

**Payment provider interface**: `ManualProvider` first (admin credits). `LightningProvider`, `StripeProvider` are deployment-specific extensions.

**Dependencies**: Phase 7.

---

### Phases 9-11: Infrastructure Hardening

9. **Non-Job Usage Metering** — `usage_records` table for services/PVCs (periodic sweeps). Receipts already cover job resources.
10. **Namespace Hardening** — ResourceQuota, LimitRange, NetworkPolicy per namespace.
11. **Environment Suspension** — active/suspended/terminated, budget-triggered scale-to-zero.

### Phases 12-13: Extensibility (Independent Track)

12. **Identity Provider Framework** — pluggable `IdentityProvider` interface, auth chain (Bearer -> Signature -> Internal).
13. **Gateway Plugin Architecture** — refactor Slack monolith into `GatewayPlugin` interface.

These are fully independent of the metering/billing track. Can start at any time.

### Phases 14-15: Platform Agents

14. **Platform Agent Foundation** — system org, health agent, auto-remediation agent.
15. **Provisioning + Intelligence** — infra provisioner, capacity planning, cost optimization.

---

## Parallelization Map

```
Phase 0 (timestamps) -----+
                           +--> Phase 2 (receipt assembly) --> Phase 3 (API/CLI)
Phase 1 (pricing)    -----+          |                              |
                                     +--> Phase 4 (llm.call) ------+
                                     +--> Phase 5 (resource class) -+
                                     |                              |
                                     |         Phase 6 (aggregation) <--+
                                     |                |
                                     |         Phase 7 (budgets)
                                     |                |
                                     |         Phase 8 (balances)
                                     |                |
                                     |         Phases 9-11 (hardening)
                                     |
Phase 12 (identity)  ----> independent, any time
Phase 13 (gateway)   ----> independent, any time
                                     |
                              Phases 14-15 (platform agents)
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Reference currency | Always USD for base costs | All major LLM and cloud providers price in USD |
| Pricing storage | DB table seeded from YAML | Git-auditable defaults + runtime mutability |
| Exchange rate staleness | Max 5 min for volatile currencies | Rate snapshot embedded in receipt; acceptable trade-off |
| Receipt recomputation | Explicit admin command only | Old receipts keep historical rates; no surprise changes |
| Markup granularity | Per-org flat percentage to start | Add per-resource-type when customers need it |
| Resource class naming | Named tiers (job.c1, job.c2, job.m1) | Agents reason better about names than raw numbers |
| `usage_records` table | Only for non-job resources | Receipts ARE the usage record for job-scoped resources |

---

## What This Plan Changes from the Existing Docs

**From `observability-time-and-cost-v3.md`**:
- Single `cost` object -> split `base_cost` (USD) + `billed_cost` (billing currency)
- Static YAML pricing -> DB-backed `pricing_rate_cards` seeded from YAML
- No markup -> explicit `markup_pct` on receipts and per-org config
- No exchange rates -> `exchange_rates` table with automated sync support

**From `platform-resource-plane.md`**:
- All `_sats` column suffixes -> generic `NUMERIC` + `currency TEXT`
- `billing: { rate_sats: N }` on resource classes -> rates live in pricing rate card
- `usage_records` for everything -> receipts replace it for job resources
- `balance_sats` -> `balance NUMERIC` + `currency TEXT`

---

## Open Questions

1. **Markup per resource type**: Should LLM and compute have different markup percentages? (e.g., 20% on LLM, 50% on compute). Start with flat per-org; revisit when needed.

2. **Exchange rate source for sats**: CoinGecko API is free tier limited. Alternatives: Kraken, Bisq, or a simple Bitcoin price feed. Need to pick a source before sats billing goes live.

3. **Receipt for failed attempts**: A failed attempt still consumed tokens and compute. Should it generate a receipt and charge the org? Proposed: yes, failed attempts get receipts. The customer pays for resources consumed regardless of outcome.

4. **Backfill strategy**: When Phase 2 ships, existing completed attempts have no receipt. Options: (a) leave them empty, (b) backfill from `execution_logs`. Proposed: (b) — run `eve admin recompute-receipts --since <deploy-date>` after Phase 2 ships.

5. **Rate card approval workflow**: Should new rate card versions require admin approval before taking effect? Or immediate? Proposed: immediate for automated provider rate sync (lower prices benefit customers), approval required for markup changes.

---

## Related Docs

- Architecture: `docs/ideas/observability-time-and-cost-v3.md` (receipt structure, phase timing, CLI surfaces)
- Architecture: `docs/ideas/platform-resource-plane.md` (resource classes, balances, identity, gateway, platform agents)
- Current system: `docs/system/observability.md`
- Lifecycle types: `packages/shared/src/types/lifecycle.ts`
- Worker invoke: `apps/worker/src/invoke/invoke.service.ts`
- Orchestrator loop: `apps/orchestrator/src/loop/loop.service.ts`
- Job queries: `packages/db/src/queries/jobs.ts`
- K8s runner: `apps/worker/src/invoke/k8s-runner.ts`
