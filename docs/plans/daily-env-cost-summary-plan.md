# Daily Environment Cost Summary Plan

> Status: Complete (phases 0-4)
> Date: 2026-06-02
> Source idea: [docs/ideas/daily-health-summary-env-costs.md](../ideas/daily-health-summary-env-costs.md)
> Decision: Option C (OpenCost allocation API) as the v1 cost source.
> Trigger: an operator asked whether the daily the platform operator Slack health summary can show monthly cost per environment.
> Review: 2026-06-02, tightened DB idempotency, OpenCost idle handling, UTC windowing, stale snapshot behavior, and API/CLI registration notes.
> Implemented: 2026-06-02, including local k3d verification with an OpenCost-compatible fixture.

## Implementation Record

Phases 0-4 are implemented in this repo:

- `eve.env_id` labels are emitted by the deployer for Eve-managed K8s resources.
- `environment_cost_snapshots` stores idempotent MTD environment and shared-overhead snapshots.
- The orchestrator env-cost collector is opt-in, OpenCost-compatible, and writes snapshots without using `usage_records`.
- Sentinel daily summaries read only precomputed snapshots and label cost data as fresh, stale, or unavailable.
- `GET /admin/cost/environments` and `eve system env-cost` expose table and JSON breakdowns.

Local k3d evidence captured on 2026-06-02:

```text
eve system env-cost
Total: $169.64 MTD (2 envs)
Shared overhead: $96.40
Source: opencost · window=2026-06 · fresh estimate

eve system env-cost --all
Total: $169.64 MTD (2 envs)
Shared overhead: $96.40

eve system env-cost --month 2026-06
Total: $169.64 MTD (2 envs)
Shared overhead: $96.40

eve system env-cost --json
{"window":{"month":"2026-06"},"source":"opencost","total_usd":"169.640000","env_count":2,"stale":false}
```

The local fixture was temporary (`opencost-fixture` service in the `eve`
namespace) and was removed after verification; the collector was reset to its
default disabled state.

## Goal

Add a compact cost section to the existing Platform Sentinel daily Slack summary:

```text
Monthly cost (MTD estimate) — $184.21 total
  Top environments:
    $42.18  org-a / project-x / prod
    $31.06  org-b / project-y / sandbox
    $18.77  org-a / project-x / preview-pr-123
    $14.92  org-c / project-z / staging
    $11.40  org-a / project-x / dev
  Shared platform overhead: $96.40 (unallocated)
  Source: opencost · window=month-to-date · estimate
  Full breakdown: eve system env-cost --all
```

Three deliverables:

1. **Total + top 5.** The daily summary shows the month-to-date Kubernetes allocation estimate for Eve-managed environments plus OpenCost-visible shared cluster overhead, and the five most expensive app environments.
2. **Cloud-neutral.** The same collector works on AWS (EKS) and GCP (GKE) with no Eve code change — the cloud difference lives entirely in how OpenCost is configured in the infra repo.
3. **CLI breakdown.** `eve system env-cost` returns every environment's estimate (table + `--json`). The Slack message names the command so anyone can self-serve the full list.

## Design Principles

- **The Slack send path never calls a billing API.** It reads pre-computed snapshots from Postgres. An OpenCost outage degrades to a stale last-good estimate or `cost unavailable`; it never blocks or delays the health report.
- **The collector is cloud-agnostic.** It speaks only the OpenCost allocation API. AWS-vs-GCP pricing is OpenCost's job, configured in `../deployment-instance`, not in eve-horizon. A `CostSource` interface keeps a CUR/BigQuery reconciliation path open without touching the daily flow.
- **Estimates are labelled as estimates.** Every snapshot carries `source` and `confidence`. OpenCost values are `estimate`; `reconciled` is reserved for bill-backed numbers added later.
- **Join on `environment_id`, not slug.** Env names repeat across projects. Snapshots key on `environment_id`; namespace is the fallback mapping.
- **Make staleness visible.** The summary can show a last-good snapshot, but it must say when cost data is stale instead of silently presenting old values as fresh.
- **Scope v1 honestly.** OpenCost allocation covers Kubernetes workload/node allocation. Non-Kubernetes costs such as shared RDS, NAT, or EKS control plane charges remain shared/reconciliation work unless OpenCost or a later bill-backed source exposes them in a mappable form.

## Architecture

```
                 (cluster, per cloud — configured in infra repo)
                 ┌─────────────────────────────────────────┐
                 │  OpenCost  ── EKS pricing (AWS)          │
                 │            └─ GKE pricing (GCP)          │
                 └───────────────┬─────────────────────────┘
                                 │ GET /allocation?window=<utc-start>,<now>&aggregate=...
                                 ▼
  apps/orchestrator/src/cron/env-cost-collector.service.ts   (hourly cron, opt-in)
                                 │  map namespace/labels → environment_id
                                 ▼
  packages/db: environment_cost_snapshots   (one row per aggregation key per source per window)
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                                ▼
  env-health-watchdog.service.ts          apps/api: GET /admin/cost/environments
  sendDailySummary() reads snapshots      → eve system env-cost (CLI)
  → top 5 + total in Slack
```

OpenCost is the only cloud-touching component, and it lives in the cluster, provisioned via Terraform. Eve's collector treats it as a plain HTTP allocation source.

## Why OpenCost is cloud-neutral for us

Every Eve environment is a Kubernetes namespace with `eve.org_id` / `eve.project_id` / `eve.env` labels (`apps/worker/src/deployer/deployer.service.ts:321`). OpenCost's allocation API accepts month-to-date windows, namespace aggregation, label aggregation, `includeIdle`, and `shareIdle`, and those parameters are the same on EKS and GKE:

```
GET /allocation?window=<utc-month-start>,<now>&aggregate=namespace&includeIdle=true&shareIdle=false
GET /allocation?window=<utc-month-start>,<now>&aggregate=label:eve.env_id&shareIdle=true
```

The only cloud-specific surface is OpenCost's pricing model (AWS pricing API / spot feeds vs GCP pricing). That is OpenCost configuration in the infra repo. Eve's collector parses the same JSON shape regardless. "Support GCP easily" therefore means: deploy OpenCost with GKE pricing in the GCP cluster — zero eve-horizon changes.

Use namespace aggregation for v1 because it works with already-deployed environments via `environments.namespace`. Only switch the primary query to label aggregation after `eve.env_id` is rolled out and validated against OpenCost's `__unallocated__` behavior; otherwise label aggregation can hide the namespace fallback for older workloads.

## Implementation

### Phase 0: Label completeness (prerequisite)

The deployer applies `eve.org_id`, `eve.project_id`, `eve.env`, `eve.component`, `eve.release` but **not** `eve.env_id` (`apps/worker/src/deployer/deployer.service.ts:321`, `:476`, `:1098`). Env names repeat across projects, so label-based aggregation needs a stable id.

- Add `eve.env_id` to namespace, deployment, service, ingress, PVC, and pod-template labels in the deployer.
- Keep namespace → `environment_id` (via `environments.namespace`) as the fallback mapping so existing deployed envs are covered before they redeploy.

This mirrors the existing recommendation in `docs/plans/resource-management-and-cost-tracking-v2.md:850`.

### Phase 1: Snapshot table

New migration `packages/db/migrations/00105_environment_cost_snapshots.sql` (next sequence after `00104_*`; follow the header-comment + `CREATE TABLE IF NOT EXISTS` + index convention of `00087_environment_health_checks.sql`):

```sql
-- Environment cost snapshots: month-to-date allocation estimates per environment.
-- Written by the env-cost collector (OpenCost). Read by the daily Sentinel summary
-- and the admin cost API. One row per (aggregation_key, source, window).

CREATE TABLE IF NOT EXISTS environment_cost_snapshots (
  id               TEXT PRIMARY KEY,            -- ecs_xxx
  aggregation_key  TEXT NOT NULL,               -- env:<environment_id> | shared:platform
  environment_id   TEXT REFERENCES environments(id) ON DELETE CASCADE, -- NULL only for shared overhead
  org_id           TEXT,
  project_id       TEXT,
  environment_slug TEXT,                        -- display only; never join on this; NULL for shared overhead
  scope            TEXT NOT NULL DEFAULT 'environment', -- environment | shared_overhead
  source           TEXT NOT NULL,               -- opencost | aws_cur | gcp_bigquery | eve_rate_card
  window_start     TIMESTAMPTZ NOT NULL,        -- start of calendar month (UTC)
  window_end       TIMESTAMPTZ NOT NULL,        -- observation time (MTD)
  amount_usd       NUMERIC NOT NULL,
  shared_amount_usd NUMERIC,                     -- idle/shared share attributed to this env, if any
  confidence       TEXT NOT NULL DEFAULT 'estimate', -- estimate | reconciled | unavailable
  breakdown_json   JSONB,                        -- raw OpenCost allocation node
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (scope IN ('environment', 'shared_overhead')),
  CHECK (confidence IN ('estimate', 'reconciled', 'unavailable')),
  CHECK (amount_usd >= 0),
  CHECK (shared_amount_usd IS NULL OR shared_amount_usd >= 0),
  CHECK ((scope = 'environment' AND environment_id IS NOT NULL) OR (scope = 'shared_overhead' AND environment_id IS NULL)),
  UNIQUE(aggregation_key, source, window_start)
);

CREATE INDEX IF NOT EXISTS idx_env_cost_window_source ON environment_cost_snapshots(window_start, source);
CREATE INDEX IF NOT EXISTS idx_env_cost_env ON environment_cost_snapshots(environment_id);
CREATE INDEX IF NOT EXISTS idx_env_cost_amount ON environment_cost_snapshots(window_start, source, amount_usd DESC);
```

Query module `packages/db/src/queries/environment-cost-snapshots.ts` (mirror the shape of `environment-health.ts` / `usage-records.ts`):

- Add `generateEnvironmentCostSnapshotId()` in `packages/shared/src/ids.ts` (prefix `ecs`) and export it through the shared package.
- Export the query module from `packages/db/src/queries/index.ts`.
- `upsert(input)` — INSERT … ON CONFLICT (aggregation_key, source, window_start) DO UPDATE (latest MTD value wins). Use `aggregation_key='env:<environment_id>'` for environments and `aggregation_key='shared:platform'` for the overhead row. Do not rely on `UNIQUE(environment_id, ...)` because Postgres allows multiple NULLs and would not dedupe shared-overhead rows.
- `latestForMonth(window_start, source)` — all env snapshots for the current month, ordered by `amount_usd DESC`. Returns the shared-overhead row too (`scope='shared_overhead'`).
- `totalForMonth(window_start, source)` — `{ total_usd, env_total_usd, shared_usd, env_count }`.
- `freshnessForMonth(window_start, source)` — latest `observed_at` for the month, used by the Slack summary and CLI to label stale data.

### Phase 2: Cloud-neutral collector

`apps/orchestrator/src/cron/env-cost-collector.service.ts`, following the `UsageSweeperService` pattern exactly (`apps/orchestrator/src/cron/usage-sweeper.service.ts:65`): `@Injectable`, `OnModuleInit`/`OnModuleDestroy`, `CronJob`, opt-in env flag. Register in `apps/orchestrator/src/cron/cron.module.ts`.

Env vars:

| Var | Default | Purpose |
| --- | --- | --- |
| `EVE_ENV_COST_COLLECTOR_ENABLED` | `false` | Opt-in switch (staging only at first). |
| `EVE_ENV_COST_COLLECTOR_CRON` | `0 * * * *` | Hourly refresh of MTD estimate. |
| `EVE_OPENCOST_URL` | — | In-cluster OpenCost service, e.g. `http://opencost.opencost.svc:9003`. |
| `EVE_ENV_COST_SHARE_IDLE` | `false` | If `true`, attribute idle/shared to envs; else keep as overhead row. |
| `EVE_OPENCOST_TIMEOUT_MS` | `10000` | Collector HTTP timeout. A timeout logs and keeps the last good snapshot. |

A `CostSource` interface keeps the daily path cloud-neutral and reconciliation-ready:

```ts
interface CostSource {
  readonly name: string; // 'opencost'
  // Month-to-date allocation keyed by namespace in v1, with labels captured when present.
  fetchMonthToDate(window: { start: Date; end: Date }): Promise<RawAllocation[]>;
}
```

`OpenCostSource` is the only v1 implementation. Collector tick:

1. `environments.listActive()` (`packages/db/src/queries/environments.ts:343`) → build `namespace → environment_id` and `env_id label → environment_id` maps.
2. `source.fetchMonthToDate({ start: monthStart, end: now })` → `GET {EVE_OPENCOST_URL}/allocation?window=${monthStart.toISOString()},${now.toISOString()}&aggregate=namespace&includeIdle=${!shareIdle}&shareIdle=${shareIdle}`. Use the explicit UTC RFC3339 pair instead of `window=month` so Eve's snapshot month matches the DB key and Slack label exactly.
3. Normalize the OpenCost response defensively: support allocation sets returned as objects or arrays, store the raw allocation node, and treat `__idle__` / `__unallocated__` as shared overhead.
4. Map each allocation node to `environment_id` (namespace fallback for v1; `eve.env_id` label can become primary after rollout validation). Unmapped platform namespaces (`eve`, `kube-system`, ingress, monitoring, `opencost`) plus OpenCost idle/unallocated buckets accumulate into one `scope='shared_overhead'` row.
5. `upsert` one snapshot per env + the overhead row, `source='opencost'`, `confidence='estimate'`, `window_start=monthStart`.
6. Log counts, unmapped namespace names, OpenCost latency, and snapshot freshness; swallow errors (never throw out of the tick). No snapshot write on fetch failure → summary shows the last good MTD value with a stale label, or `unavailable` if none.

> **GCP note:** nothing here is AWS-specific. Pointing `EVE_OPENCOST_URL` at the GKE cluster's OpenCost is the entire GCP enablement on the Eve side.

### Phase 3: Slack summary section

Extend `EnvHealthWatchdogService.sendDailySummary()` (`apps/orchestrator/src/cron/env-health-watchdog.service.ts:597`). After the existing health lines, before the `platform-notify` POST:

1. Compute `monthStart` (UTC calendar month).
2. `totalForMonth(monthStart, 'opencost')` and `latestForMonth(...)`.
3. If no snapshots → append `Monthly cost: unavailable (collector not reporting)`. Never block.
4. Else append the total, **top 5** environment rows (`scope='environment'`, by `amount_usd DESC`), the shared-overhead line, a `Source: opencost · window=month-to-date · estimate` line, and `Full breakdown: eve system env-cost --all`.
5. If the newest `observed_at` is older than the stale threshold, keep the section but label it `stale estimate` and include `last observed <timestamp>`.

The message continues through the same `POST /internal/platform-notify` with `type: 'sentinel.report'` (an always-send type, `apps/api/src/platform-notify/platform-notify.service.ts:60`), so no routing changes are needed.

Add `EVE_SENTINEL_COST_TOP_N` (default `5`) so the count is tunable without a redeploy.
Add `EVE_SENTINEL_COST_STALE_AFTER_HOURS` (default `26`) so a missed hourly collector run does not immediately mark the next daily summary stale, but multi-day gaps are visible.

### Phase 4: Admin API + CLI

**API** — new `apps/api/src/billing/cost.controller.ts` plus `cost.service.ts`, guarded by `@RequirePermission('system:admin')` (same pattern as `usage.controller.ts:12`) and registered in `BillingModule`:

- `GET /admin/cost/environments?month=YYYY-MM&source=opencost` → `{ window, source, total_usd, shared_usd, environments: [{ environment_id, org_id, project_id, environment_slug, amount_usd, shared_amount_usd, confidence }] }`, ordered by `amount_usd DESC`.
- Validate `month` as `YYYY-MM`; default to the current UTC month. Include `observed_at`, `stale`, and `stale_after_hours` in the response so the CLI can display freshness without reimplementing policy.

**CLI** — add an `env-cost` subcommand under `eve system` in `packages/cli/src/commands/system.ts` (add it to the switch and usage string; follow the existing `requestJson` + `outputJson` table/JSON pattern used by system/admin commands):

```
eve system env-cost                 # top 20 envs + total, table
eve system env-cost --all           # every env
eve system env-cost --month 2026-06 # specific month
eve system env-cost --source opencost
eve system env-cost --json          # machine-readable
```

Table columns: `COST  ORG / PROJECT / ENV  CONFIDENCE`. Footer: total + shared overhead + source/window. `--json` emits the raw API payload. This is the command named in the Slack message.

### Phase 5 (later): bill-backed reconciliation

Out of scope for v1; the table and `CostSource` interface already accommodate it.

- **AWS:** CUR split cost allocation for EKS → Athena → snapshots with `source='aws_cur'`, `confidence='reconciled'`.
- **GCP:** BigQuery billing export with GKE cost allocation → `source='gcp_bigquery'`, `confidence='reconciled'`.

Both reconcilers write the same table; the summary and CLI prefer `reconciled` over `estimate` for a given month when present.

## Infra Work (separate repo: `../deployment-instance`)

Per CLAUDE.md rule 2, all AWS/GCP changes go through Terraform. Out of scope for this repo's PR, tracked as a sibling task:

- Deploy OpenCost into each cluster (Helm/manifests).
- AWS: configure OpenCost AWS pricing integration; GCP: configure GKE pricing.
- Expose OpenCost in-cluster (`EVE_OPENCOST_URL`), no public ingress.
- Restrict access to the OpenCost service to the orchestrator namespace/service account where practical; the collector does not need public or user-facing access.
- Activate cost-allocation tags (AWS) when Phase 5 CUR lands.

## Rollout

1. Land Phase 0 (`eve.env_id` label) — harmless, improves all metering.
2. Land Phases 1–4 with `EVE_ENV_COST_COLLECTOR_ENABLED=false` (no behavior change anywhere).
3. Infra: deploy OpenCost to **staging** cluster.
4. Enable collector on staging; verify snapshots and `eve system env-cost`.
5. Verify the cost section in a real Sentinel daily summary on staging.
6. Confirm a forced OpenCost outage leaves the daily summary non-blocking and renders stale/unavailable cost text.
7. Repeat for the the platform operator production cluster; set `EVE_SENTINEL_COST_TOP_N=5`.
8. (Later) GKE: deploy OpenCost, point `EVE_OPENCOST_URL` at it — no code change.

## Decisions Locked

- **Source:** OpenCost (Option C) for v1.
- **Window:** calendar month-to-date (UTC).
- **Display:** total + top 5 envs + shared overhead, with CLI command for the full list.
- **Idle/shared:** reported as a separate overhead line by default (`EVE_ENV_COST_SHARE_IDLE=false`).
- **Idle query semantics:** when idle is separate, send `includeIdle=true&shareIdle=false`; when idle is attributed, send `shareIdle=true` and no separate idle bucket is expected.
- **Cloud strategy:** cloud-neutral collector; AWS/GCP difference lives in OpenCost config in the infra repo.
- **Confidence:** OpenCost = `estimate`; `reconciled` reserved for Phase 5.

## Risks & Caveats

- A single AWS Cost Explorer query cannot allocate shared EKS correctly — that is exactly why OpenCost is the source.
- Unlabelled workloads become unallocated overhead. Phase 0 + namespace fallback keep this small; the overhead line makes any gap visible rather than hidden.
- Do **not** reuse current usage-sweeper values for cost reporting until `eve-horizon-gc0v` (delta-window audit) is resolved — this plan deliberately uses OpenCost, not the sweeper.
- Snapshots must be cached before the Slack send; an OpenCost outage shows a stale last-good estimate or `unavailable`, never blocks the health report.
- Stale snapshots are acceptable as a degraded mode only if labelled. Never present an old observed value as a fresh month-to-date estimate.
- OpenCost v1 does not magically allocate every cloud bill line. Costs outside Kubernetes allocation remain shared overhead or Phase 5 reconciliation work.

## Verification

- **DB query tests:** upsert env rows and the shared-overhead row twice; assert one row per `(aggregation_key, source, window_start)`, totals are correct, and NULL `environment_id` overhead does not duplicate.
- **Collector unit tests:** normalize OpenCost object/array response shapes, map namespaces to env ids, route `__idle__` and unmapped namespaces to shared overhead, and verify fetch failures do not delete last-good snapshots.
- **API tests:** month validation, default current UTC month, admin permission guard, ordered environment rows, freshness/stale fields.
- **CLI smoke:** `eve system env-cost --json`, default table top 20, `--all`, `--month`, and stale footer formatting.
- **Sentinel test:** daily summary includes unavailable, fresh estimate, and stale estimate variants without blocking the existing health report.

## Touch List

| Area | File |
| --- | --- |
| Label rollout | `apps/worker/src/deployer/deployer.service.ts:321`, `:476`, `:1098` |
| Migration | `packages/db/migrations/00105_environment_cost_snapshots.sql` (new) |
| Query module | `packages/db/src/queries/environment-cost-snapshots.ts` (new) |
| Shared ID | `packages/shared/src/ids.ts` (`generateEnvironmentCostSnapshotId`) |
| DB exports | `packages/db/src/queries/index.ts` |
| Collector | `apps/orchestrator/src/cron/env-cost-collector.service.ts` (new) |
| Cron registration | `apps/orchestrator/src/cron/cron.module.ts` |
| Daily summary | `apps/orchestrator/src/cron/env-health-watchdog.service.ts:597` |
| Admin API | `apps/api/src/billing/cost.controller.ts`, `apps/api/src/billing/cost.service.ts`, `apps/api/src/billing/billing.module.ts` |
| CLI | `packages/cli/src/commands/system.ts` |
| Infra | `../deployment-instance` (OpenCost deploy, per cloud) |

## Docs Obligation

Per CLAUDE.md, on ship update the eve-skillpacks references:

- `cli.md` — new `eve system env-cost` command.
- `deploy-debug.md` — env-cost collector + OpenCost dependency.
- `overview.md` — cost snapshot surface, if architecture index touches it.
