# Resource Management and Cost Tracking (v2)

> Status: Plan
> Created: 2026-02-09
> Last Updated: 2026-02-09 (v2.1: BYOK/managed LLM model, design decisions, reasoning token pricing)
>
> Supersedes: `docs/plans/resource-management-and-cost-tracking.md` (v1)
>
> Architecture references:
> - `docs/ideas/observability-time-and-cost-v3.md` (execution receipts)
> - `docs/ideas/platform-resource-plane.md` (resource plane)

## Goals (Phases 0-11)

1. **Execution receipts** for every job attempt: where time went, which models were called, what it cost.
2. **Denomination-agnostic pricing**: provider base cost in USD, customer billing in a configurable currency with markup and auditable FX snapshots.
3. **Spend visibility**: per-job, per-project, per-org aggregation and comparisons — including real-time cost streaming during `eve job follow`.
4. **Budget enforcement**: stop overspend in real time (per job) and pre-admission (per org/project).
5. **Balance ledger**: prepaid balances + immutable transactions (charge/refund/adjustment).
6. **Resource classes**: named compute SKUs that drive K8s runner pod sizing and compute accounting.
7. **Non-job metering** for env compute + storage, plus **namespace hardening** and **environment suspension**.
8. **Managed LLM support**: open-source models on platform GPU infrastructure as a chargeable service alongside BYOK provider access.

## Non-Goals (Explicitly Out of Scope Here)

- Identity provider framework (Phase 12 in the v1 doc set).
- Gateway plugin architecture (Phase 13 in the v1 doc set).
- Platform agents (Phases 14-15 in the v1 doc set).

## Current Reality (Implementation Facts We Must Design Against)

- Attempts are **created/claimed** in `packages/db/src/queries/jobs.ts` and `job_attempts.started_at` is set at claim time (`NOW()` in `claim()`).
- Attempts are **finalized** (`completeAttempt`) in the **orchestrator** (`apps/orchestrator/src/loop/loop.service.ts`).
- Execution event stream is persisted in `execution_logs` (indexed by `(attempt_id, seq)`), written by the worker and runner pods.
- Lifecycle event types today are `lifecycle_<phase>_<action>` with phases:
  - `workspace | hook | secrets | services | harness | runner` (`packages/shared/src/types/lifecycle.ts`).

These facts drive several key plan changes vs v1:
- We do **not** add `claimed_at`: it duplicates `job_attempts.started_at`.
- Receipt **assembly/persistence** must run where attempt completion is known (orchestrator), not “after completeAttempt in worker”.

---

## Core Concepts

### LLM Access Model: BYOK vs Managed

Users and agents **bring their own API keys** (BYOK) for commercial LLM providers (Anthropic, OpenAI, Google, etc.). The platform does not proxy or pay for these calls — users pay their provider directly.

The platform **may also offer managed LLM endpoints** — open-source models (Llama, Mistral, DeepSeek, etc.) running on platform-operated GPU infrastructure (cloud or bare metal). These are a chargeable platform service, priced via rate cards like compute.

This creates two LLM cost categories:

| | BYOK (user's keys) | Managed (platform GPUs) |
|---|---|---|
| Who pays the provider? | User | Platform operator |
| Tracked in receipt? | Yes — for visibility, budgeting, comparison | Yes — for billing |
| Included in `billed_cost`? | **No** — user already paid | **Yes** — platform charges for this |
| Budget enforcement? | Yes — `max_cost` applies to estimated total | Yes |

Both categories use the same `llm.call` event schema and receipt structure. The `source` field on each model entry distinguishes them. This means:

- A user running Claude (BYOK) sees their estimated LLM cost in the receipt but is only charged for compute.
- A user running Llama on platform GPUs sees both LLM and compute charges.
- `eve project spend` can show "what you paid us" vs "what you paid providers" separately.
- Budget enforcement uses the **estimated total** (BYOK + managed + compute) because the user cares about total cost regardless of who they pay.

### Base Cost vs Billed Cost (Two Views, One Receipt)

Every receipt stores:
- **base_cost_usd**: estimated real-world cost at provider rates (always USD, no markup, no FX). Covers all models regardless of BYOK/managed status.
- **billed_cost**: what the platform charges the customer (billing currency + markup + FX). Only includes **managed LLM + compute** — never BYOK LLM cost.

This allows:
- auditable historical receipts (rates embedded)
- transparent markup
- clear separation of "what did this cost in total" vs "what do I owe the platform"
- explicit recomputation (admin-only)

### Money Representation

This plan uses:
- `NUMERIC` in Postgres for money columns
- explicit `currency` strings (`usd`, `sats`, `credits`, `eur`, ...)

Rounding rules are policy:
- USD: store to at least 6 decimal places in receipt JSON; aggregate using NUMERIC.
- Integer-denominated currencies (sats/credits): **round at charge time** and store the rounded amount in ledger transactions; receipts may also store the unrounded intermediate if useful.

### Determinism and Immutability

- `execution_logs` are the source of truth for lifecycle and usage events.
- Receipts are derived, materialized summaries.
- The **balance ledger is immutable**: once charged, changing a receipt does not silently alter historical charges; adjustments must be explicit transactions.

### Design Invariants (Non-Negotiables)

- **Base cost reference currency is always USD.** (Providers price in USD; we normalize there.)
- **No denomination-specific DB columns** (`*_sats`, `*_usd` suffixes for generic financial fields are forbidden). Use `{amount, currency}` pairs or generic money columns + `currency`.
- **Receipts are self-contained.** A receipt includes the exact rates used (no “look up later” required to explain historical totals).
- **Charge transactions are immutable.** If we need to correct a historical charge, we do it with a compensating transaction.
- **Bill by requested resources** (K8s requests), not actual CPU utilization (deterministic + aligned with quota).
- **No secret content in usage events.** `llm.call` is usage only.

---

## Receipt v2 (Canonical Shape)

Receipts live on `job_attempts.receipt_json` (JSONB) and are also partially materialized into columns for fast aggregation.

```ts
type Money = {
  currency: string;         // 'usd' | 'sats' | 'credits' | ...
  amount: string;           // decimal string (avoid float); ledger may store NUMERIC
};

type ExecutionReceiptV2 = {
  version: 2;
  scope: { type: 'attempt'; attempt_id: string; job_id: string; project_id: string; org_id: string };

  timing: {
    created_at: string;                // job.created_at
    ready_at: string | null;           // jobs.ready_at (or inferred)
    claimed_at: string;                // attempt.started_at
    execution_started_at: string | null; // attempt.execution_started_at (or inferred)
    ended_at: string | null;           // attempt.ended_at
    wall_ms: number | null;            // ended_at - claimed_at
    billable_ms: number | null;        // ended_at - execution_started_at (preferred) else duration_ms fallback
  };

  phases: {
    queue_wait_ms: number | null;      // max(ready_at, defer_until) -> claimed_at
    orchestrator_ms: number | null;    // claimed_at -> execution_started_at
    runner_ms: number | null;          // lifecycle_runner_end.duration_ms (k8s)
    workspace_ms: number | null;       // lifecycle_workspace_end.duration_ms
    secrets_ms: number | null;         // lifecycle_secrets_end.duration_ms
    hooks_ms: number | null;           // sum of lifecycle_hook_end.duration_ms
    harness_ms: number | null;         // lifecycle_harness_end.duration_ms
  };

  llm: {
    total_calls: number;
    totals: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
    };
    by_model: Array<{
      provider: string;                // anthropic | openai | google | zai | platform | ...
      model: string;                   // canonicalized (see model normalization)
      source: 'byok' | 'managed';     // byok = user's API key; managed = platform GPU
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
    }>;
  };

  compute: {
    runtime: 'local' | 'k8s';
    resource_class: string | null;     // job.c1, job.c2, job.m1
    requested: { vcpu: number | null; memory_gib: number | null };
    usage: { vcpu_seconds: number; memory_gib_seconds: number };
  };

  pricing: {
    rate_card: { name: string; version: number; effective_at: string };
    markup_pct: number;
    billing_currency: string;
    fx: {
      from_currency: 'usd';
      to_currency: string;
      rate: string;                   // decimal string
      fetched_at: string;
      source: string;
    } | null;
  };

  base_cost_usd: {
    llm_usd: Money;                    // all LLM cost (BYOK + managed)
    llm_byok_usd: Money;              // BYOK portion (informational — not charged)
    llm_managed_usd: Money;           // managed portion (charged)
    compute_usd: Money;
    total_usd: Money;                  // llm_usd + compute_usd (estimated total)
    // Self-contained: exact rates applied
    llm_rates: Array<{
      provider: string;
      model: string;
      source: 'byok' | 'managed';
      input_per_million_usd: string;
      output_per_million_usd: string;
      cache_read_per_million_usd: string | null;
      cache_write_per_million_usd: string | null;
      reasoning_per_million_usd: string | null;  // defaults to output rate if null
    }>;
    compute_rates: {
      resource_class: string | null;
      vcpu_hour_usd: string | null;
      memory_gib_hour_usd: string | null;
    } | null;
  };

  billed_cost: {
    total: Money;                      // managed LLM + compute only (what user owes platform)
    llm: Money;                        // managed LLM only (zero for pure BYOK users)
    compute: Money;
  };
};
```

Receipt construction rules:
- Never include prompts/responses or secret values.
- Per-model identity should be based on **actual model used** (from `llm.call` events once available).
- If `llm.call` events are missing, fall back to `extractTokenUsage()` totals (legacy).

---

## Pricing Model (Denomination-Agnostic)

### Inputs

- **Rate cards**: provider USD rates for LLM (both BYOK reference rates and managed model rates) + compute.
- **Org billing config**: billing currency and markup override (optional).
- **FX snapshot**: USD -> billing currency (optional when billing currency != usd).

### Computation (High Level)

1. Compute `base_cost_usd` from usage quantities and USD rates (all models, regardless of source).
2. Split LLM cost: `llm_byok_usd` (user's keys) vs `llm_managed_usd` (platform GPUs).
3. Compute chargeable base: `llm_managed_usd + compute_usd` (exclude BYOK LLM).
4. Apply markup to chargeable base: `chargeable * (1 + markup_pct/100)`.
5. Convert to billing currency using FX snapshot rate (or 1.0 if billing in USD).
6. Store both base and billed views in the receipt; charge ledger uses the billed view.

Note: `base_cost_usd.total_usd` includes all estimated cost (BYOK + managed + compute) for visibility. `billed_cost.total` includes only the chargeable portion (managed + compute) for billing.

---

## Implementation Plan (Phases 0-11)

### Phase 0: Timestamp + Receipt Storage Foundation

**Goal**: Add minimal DB fields needed for queue/lead time and receipt materialization without duplicating existing timestamps.

**Migration** (`00037_receipts_foundation.sql`):
```sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;

ALTER TABLE job_attempts
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receipt_json JSONB;

-- Materialized columns for fast spend queries (optional but recommended early)
ALTER TABLE job_attempts
  ADD COLUMN IF NOT EXISTS receipt_base_total_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS receipt_billed_total NUMERIC,
  ADD COLUMN IF NOT EXISTS receipt_billed_currency TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_ready_at ON jobs(ready_at);
CREATE INDEX IF NOT EXISTS idx_attempts_receipt_currency ON job_attempts(receipt_billed_currency);
CREATE INDEX IF NOT EXISTS idx_attempts_receipt_billed_total ON job_attempts(receipt_billed_total);
```

**Backfill**:
- `jobs.ready_at`:
  - set `ready_at = created_at` where `phase = 'ready'` and `ready_at IS NULL`.
  - for non-ready jobs, leave NULL (receipts can fall back to audit logs later if needed).
- attempt receipt columns remain NULL.

**Code changes**:
- `packages/db/src/queries/jobs.ts`
  - `create(...)`: if `phase` is `ready` (default), set `ready_at = NOW()` (or `created_at`) on insert.
  - `updatePhase(...)`: whenever transitioning **to** `ready`, set `ready_at = NOW()` (and do not unset on leaving ready).
  - `requeueReady(...)`, `release(...)`, and any other path that sets phase to `ready` must also set `ready_at = NOW()`.
- `apps/worker/src/invoke/invoke.service.ts`
  - before first workspace mutation, set `job_attempts.execution_started_at = NOW()` if NULL.
  - do this in both local worker and runner pods (same code).

**Semantics**:
- `jobs.ready_at`:
  - “The last time this job entered the `ready` phase.”
  - It must be set:
    - on create when `phase = ready`
    - on any transition to `ready` (including requeue and release)
  - It is not cleared when leaving `ready`.
- Queue wait in receipts is computed as:
  - `claimed_at - max(ready_at, defer_until)` (with null-safe fallbacks).
- `job_attempts.execution_started_at`:
  - “The first time the worker begins the attempt execution pipeline.”
  - Set once, never overwritten (idempotent update `... WHERE execution_started_at IS NULL`).
  - Recommended location: immediately after `applyManifestDefaults(...)` returns and before secrets/workspace/harness steps.

**Notes**:
- We intentionally do **not** add `claimed_at`; use `job_attempts.started_at`.

**Tests**:
- Integration: create job default phase ready, verify `ready_at` set.
- Integration: claim + execute trivial job, verify `execution_started_at` is set.

---

### Phase 1: Pricing Infrastructure (Rate Cards + FX + Org Config)

**Goal**: DB-backed rate cards and FX snapshots, seeded from git-auditable defaults but runtime-updateable.

**DB schema** (`00038_pricing.sql`):
```sql
CREATE TABLE pricing_rate_cards (
  id            TEXT PRIMARY KEY,      -- rc_xxx (TypeID)
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  effective_at  TIMESTAMPTZ NOT NULL,
  rates_json    JSONB NOT NULL,        -- see RateCard schema in code
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  UNIQUE(name, version)
);

CREATE TABLE exchange_rates (
  id            TEXT PRIMARY KEY,      -- xr_xxx (TypeID)
  from_currency TEXT NOT NULL,
  to_currency   TEXT NOT NULL,
  rate          NUMERIC NOT NULL,      -- 1 from_currency = rate to_currency
  source        TEXT NOT NULL,         -- manual | coingecko | ecb | ...
  fetched_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_exchange_rates_latest
  ON exchange_rates(from_currency, to_currency, fetched_at DESC);

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS billing_config JSONB;
-- billing_config (v1):
-- { billing_currency: "usd"|"sats"|..., markup_pct: number, rate_card_name: "default" }
```

**Seed defaults**:
- New repo file: `packages/shared/src/pricing/default-rate-card.yaml` (or `.json`)
- New admin command: `eve admin pricing seed-defaults`:
  - reads the file
  - writes `pricing_rate_cards(name=default, version=1)` if absent
  - writes system settings for default billing currency + default markup if absent

**Global defaults location**:
- Use existing `system_settings` API/table (do not add a second `platform_config` table).
- Keys:
  - `billing.defaults` = JSON string: `{ "billing_currency": "usd", "markup_pct": 20, "rate_card_name": "default" }`
  - `resource_classes` = JSON string (Phase 5)

**Rate card JSON schema (v1)**:
Rate cards are versioned and immutable. `rates_json` should be structured for deterministic receipt embedding.

LLM rates are organized by source (`byok` vs `managed`) to distinguish reference pricing from chargeable pricing:

```json
{
  "llm": {
    "byok": {
      "anthropic": {
        "claude-opus-4-5": {
          "input_per_million_usd": "15.00",
          "output_per_million_usd": "75.00",
          "cache_read_per_million_usd": "1.50",
          "cache_write_per_million_usd": "18.75",
          "reasoning_per_million_usd": null
        }
      },
      "openai": {
        "o3": {
          "input_per_million_usd": "2.00",
          "output_per_million_usd": "8.00",
          "cache_read_per_million_usd": null,
          "cache_write_per_million_usd": null,
          "reasoning_per_million_usd": "8.00"
        }
      }
    },
    "managed": {
      "platform": {
        "llama-3.3-70b": {
          "input_per_million_usd": "0.40",
          "output_per_million_usd": "0.40",
          "cache_read_per_million_usd": null,
          "cache_write_per_million_usd": null,
          "reasoning_per_million_usd": null
        },
        "deepseek-r1": {
          "input_per_million_usd": "0.55",
          "output_per_million_usd": "2.19",
          "cache_read_per_million_usd": "0.14",
          "cache_write_per_million_usd": null,
          "reasoning_per_million_usd": "2.19"
        }
      }
    }
  },
  "compute": {
    "job.c1": { "vcpu_hour_usd": "0.04", "memory_gib_hour_usd": "0.01" },
    "job.c2": { "vcpu_hour_usd": "0.06", "memory_gib_hour_usd": "0.015" },
    "default": { "vcpu_hour_usd": "0.05", "memory_gib_hour_usd": "0.012" }
  },
  "storage": {
    "disk.std": { "gb_hour_usd": "0.0005" }
  }
}
```

**Notes on managed LLM rates**:
- Managed rates reflect platform operator costs (GPU amortization, electricity, bandwidth) — not provider API pricing.
- Rates are set by the platform operator and can be aggressive (open-source models have no per-token license cost).
- The `provider` field for managed models is `"platform"` (or a deployment-specific name). The `model` field uses the canonical open-source model name.

**Resolution algorithms**:
- Effective rate card for an org:
  1. `orgs.billing_config.rate_card_name` if set else `system_settings[billing.defaults].rate_card_name`
  2. choose the highest `version` for that `name` where `effective_at <= NOW()` and `superseded_at IS NULL`
- FX snapshot:
  - if billing currency is `usd`, FX is null and conversion rate is 1.0
  - else use `exchange_rates` latest row for `(from=usd, to=billing_currency)` by `fetched_at`

**FX refresh**:
- Add a scheduled updater (cron or long-running service) that inserts new FX rows periodically:
  - sats: every 5 minutes
  - fiat (eur/gbp): daily
  - source is deployment-configurable (manual bootstrap always supported)

**New shared code**:
- `packages/shared/src/pricing/types.ts`
- `packages/shared/src/pricing/rate-cards.ts` (resolve effective card for org)
- `packages/shared/src/pricing/exchange-rates.ts` (resolve latest FX snapshot)
- `packages/shared/src/pricing/cost-calculator.ts` (pure functions, deterministic)
- `packages/shared/src/pricing/model-normalization.ts` (canonical model naming)

**New DB queries**:
- `packages/db/src/queries/pricing-rate-cards.ts`
- `packages/db/src/queries/exchange-rates.ts`

**API** (admin-scoped):
- `POST /admin/pricing/rate-cards` (create new version, never mutate existing)
- `GET /admin/pricing/rate-cards?name=default`
- `POST /admin/pricing/exchange-rates` (manual insert)
- `GET /admin/pricing/exchange-rates/latest?from=usd&to=sats`

**Tests**:
- Unit: cost calculator (rounding, FX, markup, per-model rates).
- Integration: create rate card + resolve effective rate card.

---

### Phase 2: Receipt Assembly + Persistence (Attempt-Scoped)

**Goal**: Build `ExecutionReceiptV2` from attempt + job + execution_logs, persist on attempt, and materialize totals into columns.

**Key fix vs v1**: attempt completion happens in orchestrator, so receipt persistence must be orchestrator-driven.

**New shared code**:
- `packages/shared/src/pricing/receipt/receipt-v2.ts`
- `packages/shared/src/pricing/receipt/assemble-attempt-receipt.ts`
  - inputs: `job`, `attempt`, `execution_logs[]`, resolved pricing config
  - outputs: `ExecutionReceiptV2`

**Data sources**:
- Queue/lead time:
  - `jobs.created_at`, `jobs.ready_at`, `jobs.defer_until` (if present), `job_attempts.started_at`, `job_attempts.execution_started_at`
- Phase durations:
  - lifecycle end events’ `duration_ms` fields
- Token usage:
  - prefer `llm.call` events (Phase 4), else fall back to legacy `extractTokenUsage()` totals
- Compute quantities:
  - resource class (Phase 5)
  - billable duration (prefer `ended_at - execution_started_at`, else `duration_ms`)

**DB write path**:
- Add query helper in `packages/db/src/queries/jobs.ts` (or a new `packages/db/src/queries/job-attempts.ts`):
  - `updateAttemptReceipt(attemptId, receiptJson, { baseTotalUsd, billedTotal, billedCurrency })`

**Assembly algorithm (deterministic)**:
1. Load `job_attempts`, `jobs`, and `projects` (for `org_id`) for the attempt/job.
2. Load execution logs for attempt:
   - ideal: SQL-side filtering for only `lifecycle_%` + `llm.call` + `assistant` (usage fallback) to avoid scanning large logs.
3. Compute timestamps:
   - `claimed_at = attempt.started_at`
   - `ready_at = job.ready_at ?? (job.phase === 'ready' ? job.created_at : null)`
   - `execution_started_at = attempt.execution_started_at ?? ts(first lifecycle_workspace_start) ?? claimed_at`
   - `ended_at = attempt.ended_at`
4. Compute phase durations:
   - prefer `duration_ms` from lifecycle end events
   - `hooks_ms` is the sum of all `lifecycle_hook_end.duration_ms`
   - runner timing from `lifecycle_runner_end` (k8s)
5. Compute LLM usage:
   - prefer aggregating `llm.call` events
   - else fall back to legacy `extractTokenUsage()` from assistant message usage blocks
6. Compute compute usage:
   - resolve resource class (Phase 5)
   - `billable_ms = ended_at - execution_started_at` (preferred) else `attempt.duration_ms`
   - compute vcpu/memory seconds from requested amounts
7. Resolve pricing inputs:
   - rate card, markup pct, billing currency, FX snapshot
8. Compute costs and embed applied rates into the receipt.
9. Persist `receipt_json` plus materialized totals columns.

**Orchestrator changes**:
- `apps/orchestrator/src/loop/loop.service.ts`
  - after `jobs.completeAttempt(...)` succeeds, fetch logs + job + org/project IDs, assemble receipt, persist receipt.
  - ensure this runs for both success and failure outcomes (failed attempts still consume resources).

**Failure handling**:
- Receipt assembly should be “best effort” but must not hide errors:
  - if receipt assembly fails, log an error and leave receipt null (do not fail the job finalization).
  - add a retryable admin recompute command (Phase 6).

**Tests**:
- Unit: receipt assembler with fixtures for lifecycle events.
- Integration: run a job, verify receipt_json and receipt totals columns are set.

---

### Phase 3: Receipt API + CLI Surfaces

**Goal**: Expose receipts to users and attach summaries to existing debugging surfaces.

**API**:
- `GET /jobs/:jobId/attempts/:attemptId/receipt`
- `GET /jobs/:jobId/receipt` (defaults to latest attempt)

**CLI**:
- `eve job receipt <job_id> [--attempt N] [--json]`
- `eve job diagnose <job_id>`: include receipt summary when present
- `eve job result <job_id>`: append one-line cost summary

**Output requirements**:
- show base USD + billed currency totals
- show per-model breakdown when available
- show phase breakdown with percentages

**Tests**:
- Integration: receipt endpoint returns 404 when missing, returns receipt when present.
- CLI snapshot tests (if present) or golden-text tests.

---

### Phase 4: LLM Call Events (`llm.call`) and Token Ledger

**Goal**: Per-call, per-model token accounting emitted by harness adapters, persisted to `execution_logs`, aggregated into receipts (and optionally streamed for live cost).

**Event schema** (a single JSON line emitted by harnesses; worker stores it in execution_logs as `type = "llm.call"`):
```json
{
  "type": "llm.call",
  "ts": "2026-02-09T12:34:56.000Z",
  "provider": "anthropic",
  "model": "claude-opus-4-5-20250929",
  "source": "byok",
  "status": "ok",
  "latency_ms": 3420,
  "usage": {
    "input_tokens": 123,
    "output_tokens": 456,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "reasoning_tokens": 0
  },
  "meta": {
    "correlation_id": "...",
    "attempt_id": "...",
    "job_id": "..."
  }
}
```

Field notes:
- `source`: `"byok"` (user's API key) or `"managed"` (platform GPU endpoint). Harness determines this from the endpoint configuration — managed endpoints use a platform-internal URL, BYOK endpoints use the provider's public API.
- `status`: `"ok"` or `"error"`. Failed calls (rate limit, timeout, 5xx) are recorded with `status: "error"` and `usage` fields zeroed. They appear in the receipt for debugging (time spent on failed calls matters) but contribute no token cost.
- `latency_ms`: wall-clock time for the API call. Useful for diagnosing slow providers.

**Hard rule**: this event must never include prompt text, tool payloads, or secret values.

**Implementation**:
- `packages/eve-agent-cli/` harness adapters emit `llm.call` after each provider API call (including failed calls).
- `apps/worker/src/invoke/invoke.service.ts` already writes every streamed JSON line to `execution_logs` using `parsedLine.type`; no special case needed beyond schema normalization.
- Receipt assembly aggregates:
  - total calls (including failed, for diagnostics)
  - totals + per-model breakdown (only `status: "ok"` calls contribute tokens)
  - model canonicalization via `model-normalization.ts`
  - BYOK vs managed split based on `source` field

**Real-time cost streaming (`eve job follow`)**:

This is a first-class deliverable, not optional. With `llm.call` events in the execution log stream, the CLI shows running cost during `eve job follow`:

```
$ eve job follow myproj-a3f2dd12

  [12:34:01] Harness started (claude-opus-4-5, yolo)
  [12:34:03]   LLM call #1: 1,200 in / 340 out (~$0.012)       [$0.012 total]
  [12:34:08]   LLM call #2: 1,800 in / 520 out (~$0.024)       [$0.036 total]
  [12:34:15]   LLM call #3: 2,100 in / 890 out (~$0.039)       [$0.075 total]
  [12:34:15] Harness completed (14.2s, 3 calls, ~$0.075)
```

No new infrastructure needed — the SSE stream already delivers `execution_logs` entries. The CLI recognizes `llm.call` events, applies the current rate card, and formats running totals. The `~` prefix indicates the cost is estimated (final receipt may differ due to rounding or rate card version).

For BYOK calls, the cost line can optionally show `(BYOK)` to indicate the user pays their provider, not the platform.

**Tests**:
- Unit: normalization for multiple provider schemas.
- Unit: failed call handling (status: error → zero tokens, still counted in total_calls).
- Integration: fixture harness that emits llm.call (both ok and error) and verify receipt per-model breakdown.
- Integration: verify `source` field correctly propagates to receipt `by_model[].source`.

---

### Phase 5: Resource Classes + Compute Accounting

**Goal**: Named compute SKUs that:
1) drive runner pod requests/limits (k8s),
2) define compute rate inputs (pricing),
3) allow deterministic compute accounting (bill requested, not actual).

**Config location**:
- `system_settings.key = "resource_classes"` with JSON value:
```json
{
  "job.c1": { "vcpu": 1, "memory_gib": 2, "k8s": { "cpu_request": "1", "cpu_limit": "2", "mem_request": "2Gi", "mem_limit": "4Gi" } },
  "job.c2": { "vcpu": 2, "memory_gib": 4, "k8s": { "cpu_request": "2", "cpu_limit": "4", "mem_request": "4Gi", "mem_limit": "8Gi" } }
}
```

**Job hint plumbing**:
- Extend `packages/shared/src/schemas/job.ts` to explicitly support:
  - `hints.resource_class?: string`
  - `hints.max_cost?: { currency: string; amount: number }` (Phase 7)
  - `hints.max_tokens?: number` (Phase 7)
- Extend CLI `eve job create` to accept `--resource-class`.

**Resolution precedence**:
1. `jobs.hints.resource_class` (explicit per job)
2. manifest defaults (`project_manifests.parsed_defaults`) if provided (project-wide default)
3. platform default (from `system_settings[billing.defaults]` or a dedicated `resource_classes_default` key)

**K8s runner sizing**:
- `apps/worker/src/invoke/k8s-runner.ts` currently uses env vars like `EVE_K8S_RUNNER_CPU_REQUEST`.
- Replace/augment with:
  - resolve resource class at execution time (worker/runner reads job + system settings) and apply requests/limits
  - otherwise fall back to env vars (backwards compatible)

**Data flow (no orchestrator payload changes required)**:
- Both the outer worker (spawning runner pods) and the runner pod worker have DB access.
- Implement `resolveResourceClass(jobId)` in `apps/worker/src/invoke/invoke.service.ts` that:
  - loads `jobs.hints`
  - loads `system_settings["resource_classes"]`
  - returns `{resource_class, vcpu, memory_gib, k8s_requests_limits}`
- Outer worker uses this resolution before calling `runInvocationInK8s(...)` so the runner pod is sized correctly.
- Runner pod worker uses the same resolution to compute receipt compute usage.

**Compute usage calculation**:
- Quantities:
  - `vcpu_seconds = requested_vcpu * billable_seconds`
  - `memory_gib_seconds = requested_memory_gib * billable_seconds`
- Duration source:
  - prefer `ended_at - execution_started_at`
  - else `duration_ms` (legacy harness duration)

**Compute pricing in rate cards**:
- Add compute rates keyed by resource class (or a default rate if class missing).

**Tests**:
- Unit: resource class resolution and compute usage math.
- Integration (k8s env): ensure pod resources match class config.

---

### Phase 6: Spend Aggregation + Comparison + Receipt Recompute (Admin)

**Goal**: Query spend across attempts and provide comparisons.

**Aggregation sources**:
- Prefer materialized columns:
  - `job_attempts.receipt_base_total_usd`
  - `job_attempts.receipt_billed_total`
  - `job_attempts.receipt_billed_currency`
- Fall back to JSON extraction for older rows if needed.

**DB queries**:
- `packages/db/src/queries/spend.ts`
  - `sumProjectSpend(projectId, window)`
  - `sumOrgSpend(orgId, window)`
  - `topJobsByCost(projectId, window)`
  - `compareAttempts(jobId, attemptA, attemptB)`

**API**:
- `GET /projects/:id/spend?since=...&until=...&currency=...`
- `GET /orgs/:id/spend?...`

**CLI**:
- `eve project spend <project> [--since 7d] [--currency usd]`
- `eve org spend <org> ...`
- `eve job compare <job_id> --attempt 1 --attempt 2`

**Admin: recompute receipts**
- `eve admin receipts recompute --since <iso> [--project proj_xxx] [--dry-run]`
  - recompute only for attempts with `receipt_json IS NULL` by default
  - an explicit `--force` recomputes and overwrites receipts (see ledger rules in Phase 8)

**Ledger safety rule (pre-Phase 8)**:
- recompute is safe because no charging exists yet.

**Ledger safety rule (post-Phase 8)**:
- recompute must not change historical charges implicitly; see Phase 8.

---

### Phase 7: Budget Enforcement (Admission + Real-Time)

**Goal**: Prevent runaway spend.

**Budget scopes**:
- job-level: `hints.max_cost`, `hints.max_tokens`
- org/project-level: billing config + budget limits (stored in orgs/project config or separate tables)

**Enforcement points**:
1. **Pre-admission (orchestrator claim)**:
   - before claiming a ready job, check org/project budget state using spend aggregates
   - skip claim if hard limits exceeded (job stays ready)
2. **Real-time (worker/runner)**:
   - track running usage from `llm.call` events during execution
   - if job exceeds `max_cost` or `max_tokens`, terminate the harness process (SIGTERM) and return a failed result with a recognizable error message (e.g. `BUDGET_EXCEEDED: ...`)

**User-visible state when budgets block admission**:
- Do not invent a new phase.
- Keep job in `ready` but annotate:
  - `jobs.hints.budget_blocked = true`
  - `jobs.hints.budget_blocked_reason = "org hard cap exceeded"` (string)
- CLI `eve job show` / `eve job diagnose` should surface this hint clearly.

**Policy choices (explicit)**:
- Currency for enforcement:
  - enforce budgets in **billing currency** (what the org pays), not base USD.
- Cost scope for enforcement:
  - job-level `max_cost` applies to **estimated total cost** (BYOK + managed + compute), not just billed cost. Rationale: the user cares about total spend regardless of who they pay. A job burning $50 of Claude tokens via BYOK should still be stoppable.
  - org/project-level hard caps apply to **billed cost only** (what the platform charges). BYOK spend doesn't deplete the org's platform balance.
- Staleness:
  - real-time relies on `llm.call` events; for legacy harnesses without them, enforce only `max_tokens` if possible (or "best-effort" via totals at end).

**Config**:
- `orgs.billing_config` may include:
  - `hard_cap_amount`, `soft_cap_amount`, `daily_max_amount`, `per_job_max_amount` (all in billing currency)
  - `suspend_below_amount` (Phase 11)

**Tests**:
- Integration: create job with very low max_cost and verify it is terminated and receipt shows partial usage.
- Integration: orchestrator skips claim when org hard cap exceeded.

---

### Phase 8: Balance Ledger (Prepaid + Charges)

**Goal**: Track balances and create immutable transactions for credits/charges/refunds.

**DB schema** (`00039_balances.sql`):
```sql
CREATE TABLE org_balances (
  org_id        TEXT PRIMARY KEY REFERENCES orgs(id),
  balance       NUMERIC NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  lifetime_in   NUMERIC NOT NULL DEFAULT 0,
  lifetime_out  NUMERIC NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE balance_transactions (
  id            TEXT PRIMARY KEY,      -- bt_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  type          TEXT NOT NULL,          -- credit | charge | refund | adjustment
  amount        NUMERIC NOT NULL,
  currency      TEXT NOT NULL,
  description   TEXT,
  source_type   TEXT NOT NULL,          -- receipt | payment | manual | promo
  source_id     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, source_type, source_id) -- idempotency: prevent double-charges
);
```

**Charging rule**:
- On attempt finalization + successful receipt persistence:
  - create a `charge` transaction for `receipt.billed_cost.total` (rounded per currency policy)
  - update `org_balances` in the same DB transaction

**Where charging runs**:
- Charge creation happens in the orchestrator immediately after receipt persistence (same place attempt completion is observed).
- Worker/runner never writes balance transactions.

**Currency change policy**:
- Once an org has a balance ledger, changing `orgs.billing_config.billing_currency` requires an explicit migration path (e.g., settle to zero or create a new balance account). Default policy: disallow currency changes if any transactions exist.

**Recompute interaction (explicit)**:
- If a receipt is recomputed after a charge exists:
  - do not mutate the old charge
  - optionally emit an `adjustment` transaction (admin-only) with the delta, with explicit operator intent

**Payment provider interface**:
- Start with `ManualProvider`:
  - `eve admin balance credit --org org_xxx --amount 100 --currency usd --reason "..."`
- Lightning/Stripe are deployment-specific extensions (not required for Phases 0-11 correctness).

**Tests**:
- Concurrency: two attempts finishing at once should not double-charge.
- Idempotency: retrying the charge path must not create duplicate transactions.

---

### Phase 9: Non-Job Usage Metering (Envs + PVCs + Managed Resources)

**Goal**: Track resource usage that is not captured by job attempt receipts (env services, PVC storage, managed DB tiers).

**DB schema** (`00040_usage_records.sql`):
```sql
CREATE TABLE usage_records (
  id            TEXT PRIMARY KEY,      -- ur_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  project_id    TEXT REFERENCES projects(id),
  env_id        TEXT REFERENCES environments(id),
  resource_type TEXT NOT NULL,         -- env_compute | storage | managed_db | ...
  resource_class TEXT,                 -- svc.s1 | disk.std | db.p1 | ...
  quantity      NUMERIC NOT NULL,
  unit          TEXT NOT NULL,         -- vcpu_seconds | gib_seconds | gb_hours | hours | ...
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  source_type   TEXT NOT NULL,         -- k8s_sweep | provisioner | manual
  source_id     TEXT NOT NULL,         -- sweep_id, pvc_uid, ...
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_type, source_id, resource_type) -- basic idempotency for sweeps
);
CREATE INDEX idx_usage_records_org_time ON usage_records(org_id, started_at DESC);
```

**Sweeper implementation**:
- A periodic job (cron or long-running worker) that:
  - enumerates env namespaces and active pods
  - bills by requests (cpu/mem) per pod * elapsed time window
  - enumerates PVCs and bills by provisioned size * elapsed time window
- Writes usage_records in time-sliced windows (e.g., 5 minutes).

**Mapping K8s objects -> org/project/env**:
- Primary mapping: `environments.namespace` (DB) identifies the namespace for an env.
- Secondary mapping (recommended): labels applied to env workloads:
  - `eve.org_id`, `eve.project_id`, `eve.env_id`
  - makes sweep resilient even if namespace naming changes

**Units and quantities**:
- env compute:
  - `unit=vcpu_seconds`, quantity is sum over pods of `cpu_request_cores * window_seconds`
  - `unit=memory_gib_seconds`, quantity is sum over pods of `mem_request_gib * window_seconds`
- storage:
  - `unit=gb_hours`, quantity is `pvc_capacity_gb * window_hours`

**Costing and charging**:
- Convert usage_records into charges on the same schedule, using the current rate card and org billing config.
- Charges are appended as `balance_transactions(type=charge, source_type=usage_record, source_id=ur_xxx)` (idempotent by UNIQUE constraint).

**Costing**:
- Use the same rate card mechanism:
  - compute rates for `svc.*`
  - storage rates for `disk.*`
  - managed DB rates for `db.*`

---

### Phase 10: Namespace Hardening (Quota, Limits, NetworkPolicy)

**Goal**: Enforce multi-tenant isolation and prevent noisy-neighbor issues.

**Mechanisms per environment namespace**:
- `ResourceQuota` derived from org/project budget tiers
- `LimitRange` to cap pods without explicit requests
- default-deny `NetworkPolicy` with explicit allow rules for:
  - ingress controller -> public services
  - in-namespace traffic
  - namespace -> platform services where required (DB, registry, etc.)

**Implementation**:
- Extend the env deploy/ensure path to apply these manifests on every deploy (server-side apply).
- Store applied policy version in `environments.labels_json` for diagnostics.

**Example manifests (sketch)**:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: eve-env-quota
spec:
  hard:
    requests.cpu: "4"
    requests.memory: "8Gi"
    persistentvolumeclaims: "10"
    requests.storage: "50Gi"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: eve-env-limits
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: "100m", memory: "256Mi" }
      default:        { cpu: "500m", memory: "512Mi" }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: eve-default-deny
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
```

**CLI-first diagnostics**:
- `eve env diagnose <project> <env>` should show:
  - quota status
  - top pods by requested resources
  - network policy presence

---

### Phase 11: Environment Suspension (Budget-Triggered Scale-to-Zero)

**Goal**: When budgets are exceeded or balances drop below threshold, environments are suspended automatically and safely.

**DB changes** (`00041_environment_status.sql`):
```sql
ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- status: active | suspended | terminated
```

**Behavior**:
- Suspension triggers:
  - balance below `suspend_below_amount`
  - org hard cap exceeded
- On suspension:
  - scale deployments in env namespace to zero (or delete, depending on policy)
  - keep stateful storage (PVCs) unless terminating
  - block `eve env deploy` and block new jobs that target that env (with clear error)
- Resume:
  - admin or org owner can resume after credit/budget change

**API/CLI surfaces**:
- `POST /environments/:id/suspend` (admin or org owner)
- `POST /environments/:id/resume`
- `eve env suspend <project> <env> --reason "..."`
- `eve env resume <project> <env>`

**Implementation details**:
- Add a controller loop (or scheduled job) that:
  - evaluates org status
  - transitions envs and applies scaling operations
- Ensure actions are idempotent (can re-run safely).

---

## Parallelization Map (Updated)

- Phase 0 and Phase 1 can proceed in parallel.
- Phase 2 depends on Phase 0 + Phase 1.
- Phase 3 depends on Phase 2.
- Phase 4 and Phase 5 can start after Phase 2 (they enrich receipts).
- Phase 6 depends on Phase 3 (user surfaces) and benefits from Phase 4/5 data.
- Phase 7 depends on Phase 4 (real-time) and Phase 6 (aggregation).
- Phase 8 depends on Phase 7 (policy), and locks in recompute semantics.
- Phase 9-11 depend on Phase 8 for enforcement and on Phase 5 for SKU taxonomy.

---

## Design Decisions (What We Deliberately Don't Build)

These are conscious architectural choices, not oversights. Documenting them prevents re-proposing solutions to problems we've already decided not to have.

### No `telemetry_spans` table

Eve's execution model is a fixed pipeline: queue → workspace → secrets → hooks → harness → result. Every attempt walks the same phases in the same order. A generic spans table with `scope_type`, `component`, `name` is a mini-Jaeger — designed for arbitrary call graphs we don't have. The receipt's `phases` object captures the same information in one read instead of a join across a spans table.

If we ever need arbitrary spans (app-emitted traces, sub-phase granularity), we can add them then. The receipt structure is extensible — adding a `sub_phases` array to any phase is a JSONB change, not a schema change.

### No W3C trace propagation

`x-eve-correlation-id` propagates through 5 hops, all within our codebase: gateway → API → orchestrator → worker → harness. W3C `traceparent`/`tracestate` adds complexity for zero benefit at our current scale. The OTEL auto-instrumentation (already configured) provides HTTP-level traces when an OTEL collector is present. That's sufficient for infrastructure debugging without refactoring internal propagation.

### No LLM Gateway proxy

We do not proxy LLM API calls through a platform reverse proxy. That's a separate product with its own availability, latency, authentication, and operational surface. Harnesses call providers (or managed endpoints) directly and report usage via `llm.call` events. The receipt captures the same cost data without adding a network hop or a new failure mode.

If apps want cost visibility outside of Eve jobs, a lighter approach: an SDK that wraps provider clients and emits `llm.call` events to Eve's API. Same data, no proxy, no latency penalty.

### No separate `usage_records` table for job resources

The receipt IS the usage record for job-scoped resources (LLM tokens + compute time), stored on the entity it describes (the attempt), queryable with a single read. The `usage_records` table (Phase 9) exists only for non-job resources: persistent service uptime, PVC storage hours, managed database tiers — resources metered by periodic sweeps, not by attempt completion.

### No separate pricing table (for now)

Rate cards are DB-backed (Phase 1) for runtime updateability, but the default rates ship as a git-auditable config file seeded on first deploy. Receipts embed the actual rates used, so historical accuracy doesn't depend on the current config. We do not build a full pricing admin UI — `eve admin pricing` commands and direct DB operations are sufficient for the rate at which pricing changes (a few times per year).

### No composable receipt children (yet)

The v3 ideas doc proposed `children?: ExecutionReceipt[]` for pipeline runs and chat messages. We defer this — pipelines are not yet heavily used, and when they are, aggregation from child attempt receipts is a straightforward query. The type system can add `children` later without breaking existing receipts (JSONB handles missing keys naturally).

---

## Testing and Rollout Strategy

- Phase 0-3: ship behind “receipt enabled” feature flag if needed, but prefer always-on (no user-facing breakage).
- Phase 4: gradual rollout per harness (legacy fallback maintained).
- Phase 5: start with a small set of job SKUs; default remains current env-var sizing.
- Phase 7: start as “warn-only” (log budget exceeded) then enforce.
- Phase 8: start with manual credits only; keep “negative balance allowed” flag for early testing.
- Phase 9-11: deploy to local k8s first, then staging with conservative quotas.

## Security Notes (Must-Haves)

- `llm.call` must contain usage only (no content).
- Receipt JSON must not include secrets, prompts, or workspace paths beyond attempt/job IDs.
- Admin endpoints for pricing and ledger must be gated (system admin only).
- Managed LLM endpoints must authenticate requests (platform-issued tokens, not user API keys) and must not expose user prompts to other tenants.
- BYOK API keys are resolved via the existing secrets system and never appear in `llm.call` events or receipts.

## Managed LLM: Credential Resolution + Harness Routing

This section is implementable alongside Phases 0-8. It does not require running our own GPU infrastructure — it works with any OpenAI-compatible inference provider (GMI Cloud, Together AI, Fireworks, self-hosted vLLM, etc.) where the platform operator holds the account and API keys.

### How It Works Today (BYOK Only)

The current flow for a job using Claude (BYOK):

```
Job: { harness: 'mclaude', harness_options: { model: 'opus-4.5' } }
  ↓
Worker: resolveWorkerAdapter('mclaude')
  ↓
mclaude adapter: buildOptions(ctx)
  ├─ model = ctx.invocation.harness_options.model ?? ctx.env.CLAUDE_MODEL ?? 'opus'
  ├─ auth = resolveMclaudeAuth() → user's ANTHROPIC_API_KEY or OAuth token
  └─ env = { ANTHROPIC_API_KEY: userKey, CLAUDE_MODEL: model, ... }
  ↓
eve-agent-cli --harness mclaude --model opus-4.5
  ↓
Anthropic API (user's key, user pays)
```

Key implementation facts:
- Harness selection: `effectiveInvocation.harness ?? 'mclaude'` (`invoke.service.ts:1312`)
- Credential helpers: `resolveMclaudeAuth()` and `resolveCodeAuth()` (`invoke.service.ts:1541-1684`)
- Env sanitization: `buildSanitizedHarnessEnv()` (`env-builder.ts`) — explicit allowlist, no secret leakage
- Config dir instrumentation: auth written to files in `.agent/harnesses/<harness>/` — tools read natively

### Adding Managed Model Support

#### Model Naming Convention

Users specify managed models with a `managed/` prefix:

```yaml
# In manifest defaults
x-eve:
  defaults:
    harness_options:
      model: managed/deepseek-r1      # ← managed model
      # model: opus-4.5               # ← BYOK (no prefix, or provider prefix)
```

Or per-job:
```bash
eve job create --model managed/llama-3.3-70b "Refactor auth module"
```

The `managed/` prefix is the routing signal. Everything else is BYOK by default.

#### Managed Model Registry

Platform-wide config in `system_settings.key = "managed_models"`:

```json
{
  "deepseek-r1": {
    "display_name": "DeepSeek R1",
    "inference_provider": "gmicloud",
    "api_model_id": "deepseek-ai/DeepSeek-R1",
    "base_url": "https://api.gmi-serving.com/v1/",
    "auth_header": "Authorization",
    "auth_scheme": "Bearer",
    "secret_ref": "platform.gmicloud.api_key",
    "extra_headers": {
      "X-Organization-ID": "{{platform.gmicloud.org_id}}"
    },
    "capabilities": {
      "streaming": true,
      "tool_calling": true,
      "reasoning": true
    }
  },
  "llama-3.3-70b": {
    "display_name": "Llama 3.3 70B",
    "inference_provider": "gmicloud",
    "api_model_id": "meta-llama/Llama-3.3-70B-Instruct",
    "base_url": "https://api.gmi-serving.com/v1/",
    "auth_header": "Authorization",
    "auth_scheme": "Bearer",
    "secret_ref": "platform.gmicloud.api_key",
    "extra_headers": {},
    "capabilities": {
      "streaming": true,
      "tool_calling": true,
      "reasoning": false
    }
  },
  "kimi-k2": {
    "display_name": "Kimi K2",
    "inference_provider": "gmicloud",
    "api_model_id": "moonshotai/Kimi-K2-Instruct",
    "base_url": "https://api.gmi-serving.com/v1/",
    "auth_header": "Authorization",
    "auth_scheme": "Bearer",
    "secret_ref": "platform.gmicloud.api_key",
    "extra_headers": {},
    "capabilities": {
      "streaming": true,
      "tool_calling": true,
      "reasoning": false
    }
  }
}
```

Notes:
- `api_model_id`: the exact string the inference provider expects in the `model` field.
- `secret_ref`: reference to a platform-level secret (see below). Never a literal key.
- `extra_headers`: template syntax `{{secret_ref}}` resolved at runtime. Allows provider-specific headers (GMI's `X-Organization-ID`, etc.).
- `capabilities`: informational — helps CLI show which models support tool calling, reasoning, etc.
- Multiple models can share the same `inference_provider` and `secret_ref` (one GMI account serves many models).

#### Platform Secrets (Separate from User Secrets)

Platform API keys must be stored where:
- Workers can read them at execution time
- Users/agents can never access them
- They don't appear in user-facing `resolveProjectSecrets()` results

**Implementation**: Add a `scope = 'platform'` level to the existing secrets system.

```sql
-- Secrets table already has: org_id, project_id (nullable for scoping)
-- Add platform secrets as: org_id = NULL, project_id = NULL, scope = 'platform'
-- Or: use system_settings with encrypted values (simpler, no schema change)
```

Preferred approach: **`system_settings`** with a `platform_secrets` key, values encrypted at rest.

```json
{
  "platform_secrets": {
    "gmicloud.api_key": "gmi_sk_...",
    "gmicloud.org_id": "org_abc123"
  }
}
```

The worker loads platform secrets via a dedicated helper (`resolvePlatformSecret(ref)`) that is never exposed to user-facing APIs. Secrets are decrypted in-memory by the worker process and injected into the harness env — never written to config dir files, never included in execution_logs.

#### Worker Routing Logic

The interception point is early in `invoke.service.ts:execute()`, before adapter resolution:

```typescript
// In execute(), after applyManifestDefaults():

const modelSpec = effectiveInvocation.harness_options?.model;
const managedConfig = await this.resolveManagedModel(modelSpec);

if (managedConfig) {
  // Override to OpenAI-compatible adapter
  effectiveInvocation.harness = 'code';
  effectiveInvocation.harness_options = {
    ...effectiveInvocation.harness_options,
    model: managedConfig.api_model_id,        // e.g. "deepseek-ai/DeepSeek-R1"
  };

  // Inject platform credentials into harness env (bypasses user auth resolution)
  managedEnvOverrides = {
    OPENAI_API_KEY: managedConfig.resolvedApiKey,
    OPENAI_BASE_URL: managedConfig.base_url,
    EVE_LLM_SOURCE: 'managed',               // harness reads this for llm.call events
    EVE_LLM_PROVIDER: managedConfig.inference_provider,
    ...managedConfig.resolvedExtraHeaders,    // as env vars if needed
  };
}
```

`resolveManagedModel()`:
1. Check if model string starts with `managed/`
2. Strip prefix → look up in `system_settings["managed_models"]`
3. Resolve `secret_ref` via `resolvePlatformSecret()`
4. Resolve `extra_headers` template values
5. Return `ManagedModelConfig` or `null` (not managed → proceed as BYOK)

#### No New Harness Adapter Needed

All target inference providers (GMI Cloud, Together AI, Fireworks, self-hosted vLLM, Ollama) expose OpenAI-compatible chat completions APIs. The existing `code`/`codex` worker adapter already speaks this protocol:

- Sets `OPENAI_API_KEY` and respects `OPENAI_BASE_URL`
- Sends `POST /v1/chat/completions` with `model`, `messages`, `stream`, etc.
- Parses `usage` from responses (prompt_tokens, completion_tokens)
- Supports streaming

The only change: the `code` adapter's `buildOptions()` must respect `managedEnvOverrides` when present, skipping its normal `resolveCodeAuth()` flow. This is a small conditional:

```typescript
// In code worker adapter buildOptions():
if (ctx.env.EVE_LLM_SOURCE === 'managed') {
  // Skip user auth resolution — platform credentials already in env
  return {
    args: ['--harness', 'code', '--model', model, ...],
    env: ctx.env,  // already contains OPENAI_API_KEY + OPENAI_BASE_URL from worker
  };
}
// ... existing BYOK auth resolution ...
```

#### Harness llm.call Event Changes

The harness reads `EVE_LLM_SOURCE` from its env and includes it in `llm.call` events:

```json
{
  "type": "llm.call",
  "source": "managed",
  "provider": "gmicloud",
  "model": "deepseek-ai/DeepSeek-R1",
  "status": "ok",
  "latency_ms": 2100,
  "usage": { "input_tokens": 500, "output_tokens": 200, ... }
}
```

For BYOK calls, `source` defaults to `"byok"` and `provider` is the actual provider name (`"anthropic"`, `"openai"`, etc.).

#### Credential Isolation (Security)

The platform API key flows through exactly one path:

```
system_settings["platform_secrets"]
  → worker process memory (resolvePlatformSecret)
    → harness process env (OPENAI_API_KEY)
      → HTTPS request to inference provider
```

It **never** appears in:
- User-facing secrets API responses (different resolution path)
- execution_logs / llm.call events (events contain usage only, not auth)
- receipt JSON (receipts contain rates and totals, not credentials)
- Config dir files (managed models skip the "write auth.json to config dir" step)
- Git, manifests, or job hints (the `managed/deepseek-r1` string is a lookup key, not a credential)

The harness process env is sandboxed by `buildSanitizedHarnessEnv()` — the only env vars exposed are the explicit allowlist plus adapter-provided overrides. When the harness process exits, the env (and the key in it) is gone.

#### CLI: List Available Managed Models

```bash
$ eve models list

  Managed Models (platform-provided):

  Name                Provider    Capabilities
  managed/deepseek-r1 gmicloud    streaming, tools, reasoning
  managed/llama-3.3   gmicloud    streaming, tools
  managed/kimi-k2     gmicloud    streaming, tools

  Use: eve job create --model managed/deepseek-r1 "your prompt"
```

This reads `system_settings["managed_models"]` — no inference provider API call needed.

---

## Future: Managed LLM GPU Infrastructure (Beyond Phases 0-11)

The credential resolution and harness routing above work with **any OpenAI-compatible inference provider** where the platform operator holds an account. This includes:

- **Third-party inference services**: GMI Cloud, Together AI, Fireworks AI, Replicate — sign up, get API key, add to platform_secrets. Zero GPU infrastructure needed.
- **Self-hosted inference**: vLLM, TGI, Ollama running on platform-operated GPU nodes — same OpenAI-compatible API, same routing, just an internal base_url.

For self-hosted inference (running our own GPU nodes), the additional infrastructure work includes:

**Key decisions deferred**:
- GPU node provisioning (dedicated vs spot, cloud vs bare metal).
- Model lifecycle management (which models to offer, version pinning, deprecation).
- Capacity planning and autoscaling (scale-to-zero for cost, scale-up for latency).
- Multi-tenant isolation on shared GPU nodes (request queueing, fair scheduling).
- Model routing (single vLLM instance with model parameter vs per-model deployments).
- Inference server selection (vLLM vs TGI vs Ollama vs custom).

**What's ready today**: The rate card, receipt, billing infrastructure (Phases 0-8), and credential/routing system (above) can handle managed LLM charges from any OpenAI-compatible provider with zero additional work — just add entries to `managed_models` config and `platform_secrets`.
