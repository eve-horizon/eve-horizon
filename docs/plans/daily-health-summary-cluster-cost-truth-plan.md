# Implementation Plan: Daily Health Summary - Cloud Cost Truth

> Status: Ready to implement
> Date: 2026-06-04
> Source idea: [`docs/ideas/daily-health-summary-cluster-cost-truth.md`](../ideas/daily-health-summary-cluster-cost-truth.md)
> Builds on: [`docs/ideas/daily-health-summary-env-costs.md`](../ideas/daily-health-summary-env-costs.md)
> Repos: this repo for provider-neutral cloud cost collection, Slack/API/CLI surfacing, and AWS as the first provider; `../deployment-instance` for AWS IRSA and tag propagation.

## Problem

The daily Slack health summary currently says:

```text
Monthly cost (fresh estimate) — $2.21 total
```

That number is not credible for the Eve staging cluster. OpenCost is not producing an AWS-backed allocation in staging, and the whole the platform operator AWS account is not a valid fallback because the account hosts unrelated systems.

Read-only AWS Cost Explorer verification on 2026-06-04:

| Query | Window | Amount |
| --- | --- | ---: |
| Whole account `UnblendedCost` | 2026-05-01 to 2026-06-01 | `$2,421.59` |
| `Project=eve-horizon AND Environment=staging` | 2026-05-01 to 2026-06-01 | `$205.04` |
| `Project=eve-horizon AND Environment=staging` | 2026-06-01 to 2026-06-04 | `$23.43` |

The tagged AWS value is the right V1 reporting shape, but it currently undercounts because tags do not propagate to every billable cluster resource yet: EKS worker EC2 instances, node root EBS volumes, dynamic EBS CSI volumes, and the ingress NLB.

## Goal

Make the daily Slack headline show bill-backed cloud cost for the Eve staging cluster:

```text
Monthly Eve staging cloud cost — $234.30 projected / $23.43 MTD
  Source: AWS Cost Explorer UnblendedCost | Project=eve-horizon | Environment=staging | MTD through 2026-06-03
  Coverage: undercount until EKS node/NLB/EBS tag propagation is fixed
```

The implementation should be cloud-provider-neutral so GCP can be added as a second provider without changing Slack, API, CLI, or storage contracts.

## Design Principles

- Store cloud billing data separately from OpenCost environment estimates.
- Model provider, account/project, scope, source, currency, coverage, and filter metadata explicitly.
- Keep provider-specific code behind a narrow adapter interface.
- Use configured tag/label filters; do not hard-code AWS-specific concepts into Slack/API/CLI.
- AWS is the first provider. GCP support should be a new adapter plus config, not a schema rewrite.
- Keep currency explicit. Do not sum across providers/currencies until an FX/reconciliation layer exists.
- Do not display whole-account cost in the default Slack summary.
- Do not solve per-app chargeback in this plan.

## Existing Surface To Reuse

| Component | Location |
| --- | --- |
| OpenCost snapshot table | `packages/db/migrations/00105_environment_cost_snapshots.sql` |
| OpenCost snapshot queries | `packages/db/src/queries/environment-cost-snapshots.ts` |
| OpenCost collector | `apps/orchestrator/src/cron/env-cost-collector.service.ts` |
| Slack cost section | `apps/orchestrator/src/cron/env-health-watchdog.service.ts` (`appendCostSummary`) |
| Admin env-cost API | `apps/api/src/billing/cost.{controller,service}.ts` |
| CLI env-cost command | `packages/cli/src/commands/system.ts` (`eve system env-cost`) |

Do not overload `environment_cost_snapshots` with cluster billing data. That table remains the OpenCost/in-cluster allocation estimate. The new cloud table becomes the bill-backed denominator that OpenCost can reconcile against later.

## Architecture

```text
OpenCost collector
  -> environment_cost_snapshots
  -> eve system env-cost
  -> optional fallback Slack estimate

CloudCostCollectorService
  -> CloudCostProvider adapter
     -> AwsCostExplorerProvider first
     -> GcpBillingExportProvider later
  -> cloud_cost_snapshots
  -> Slack cloud-cost headline
  -> GET /admin/cost/cloud
  -> eve system cloud-cost
```

The daily Slack summary reads cloud snapshots first. If none exist, it falls back to the existing OpenCost summary.

## Phase 1 - Generic Cloud Cost Storage

Add migration `packages/db/migrations/00106_cloud_cost_snapshots.sql`.
`00105_environment_cost_snapshots.sql` is the latest migration as of 2026-06-04, but verify the next free number with `ls packages/db/migrations` before implementation in case another branch has landed a migration.

```sql
CREATE TABLE IF NOT EXISTS cloud_cost_snapshots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  account_id TEXT,
  billing_account_id TEXT,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope_label TEXT NOT NULL,
  org_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  mtd_through DATE,
  amount NUMERIC NOT NULL,
  projected_amount NUMERIC,
  currency TEXT NOT NULL DEFAULT 'USD',
  confidence TEXT NOT NULL DEFAULT 'estimate',
  coverage TEXT NOT NULL DEFAULT 'undercount',
  filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  breakdown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (scope_type IN ('cluster', 'environment', 'account', 'project')),
  CHECK (confidence IN ('estimate', 'reconciled', 'unavailable')),
  CHECK (coverage IN ('undercount', 'complete', 'partial', 'unknown')),
  CHECK (amount >= 0),
  CHECK (projected_amount IS NULL OR projected_amount >= 0),
  UNIQUE(provider, source, scope_type, scope_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_cloud_cost_scope_window
  ON cloud_cost_snapshots(provider, scope_type, scope_key, window_start);
CREATE INDEX IF NOT EXISTS idx_cloud_cost_source_window
  ON cloud_cost_snapshots(source, window_start);
```

Add `packages/db/src/queries/cloud-cost-snapshots.ts` with:

- `upsert(input)`
- `latestForScope({ provider?, source?, scopeType, scopeKey, windowStart })`
- `latestForMonth({ provider?, source?, scopeType?, windowStart })`
- `freshnessForScope({ provider?, source?, scopeType, scopeKey, windowStart })`

Add `generateCloudCostSnapshotId()` to `packages/shared/src/ids.ts` using `typeid('ccs')`. Export it through the existing shared package entrypoint. Make `UpsertCloudCostSnapshotInput.id` optional and have `cloudCostSnapshotQueries.upsert()` call `generateCloudCostSnapshotId()` when no id is supplied, so callers do not invent ad hoc IDs.

Keep checks intentionally broad. Do not add AWS/GCP-specific enum values to the schema.

## Phase 2 - Provider Adapter Contract

Add a small provider-neutral model under the orchestrator cron cost code:

```ts
export interface CloudCostScopeConfig {
  provider: string;              // aws, gcp, ...
  source: string;                // aws_cost_explorer, gcp_billing_export, ...
  accountId?: string;
  billingAccountId?: string;
  scopeType: 'cluster' | 'environment' | 'account' | 'project';
  scopeKey: string;              // example-cluster
  scopeLabel: string;            // Eve staging cluster
  currency: string;              // USD for AWS V1
  coverage: 'undercount' | 'complete' | 'partial' | 'unknown';
  filter: Record<string, unknown>;
}

export interface CloudCostResult {
  amount: number;
  projectedAmount: number | null;
  currency: string;
  windowStart: Date;
  windowEnd: Date;
  mtdThrough: string | null;     // YYYY-MM-DD
  confidence: 'estimate' | 'reconciled' | 'unavailable';
  coverage: CloudCostScopeConfig['coverage'];
  filter: Record<string, unknown>;
  breakdown: Record<string, unknown>;
}

export interface CloudCostProvider {
  readonly provider: string;
  readonly source: string;
  fetchMonthToDate(scope: CloudCostScopeConfig, now: Date): Promise<CloudCostResult | null>;
}
```

Rules:

- Provider adapters return `null` for "not enough finalized data yet" and throw for real fetch/config errors.
- The collector handles retries/staleness by preserving the last-good snapshot.
- Adapters normalize provider-specific service names and filters into `breakdown.by_service`.
- The Slack/API/CLI code reads only the generic snapshot shape.

## Phase 3 - AWS Cost Explorer Provider

Add `@aws-sdk/client-cost-explorer` as an orchestrator runtime dependency.

Implement `AwsCostExplorerProvider`:

- Provider: `aws`
- Source: `aws_cost_explorer`
- Region: fixed `us-east-1` because Cost Explorer is a global billing API.
- Metric: `UnblendedCost`.
- Granularity: `MONTHLY`.
- Grouping: `SERVICE`.
- Filter: Cost Explorer tags `Project=<value>` and `Environment=<value>`.
- Lazy-load the SDK inside the provider with `await import('@aws-sdk/client-cost-explorer')` when AWS collection is enabled. Do not top-level import the CE client into the orchestrator startup path; the disabled and future GCP paths should not load AWS billing code.

Config for the first scope:

| Var | Default | Meaning |
| --- | --- | --- |
| `EVE_CLOUD_COST_ENABLED` | `false` | Enables cloud cost collection |
| `EVE_CLOUD_COST_CRON` | `0 7 * * *` | Daily UTC collection, one hour before the 08:00 UTC Slack summary |
| `EVE_CLOUD_COST_PROVIDER` | `aws` | Provider adapter to use for V1 |
| `EVE_CLOUD_COST_SCOPE_TYPE` | `cluster` | Snapshot scope |
| `EVE_CLOUD_COST_SCOPE_KEY` | `example-cluster` | Stable scope key |
| `EVE_CLOUD_COST_SCOPE_LABEL` | `Eve staging cluster` | Human label |
| `EVE_CLOUD_COST_COVERAGE` | `undercount` | Flip to `complete` after tag propagation |
| `EVE_AWS_COST_ACCOUNT_ID` | `<aws-account-id>` | Optional display/audit metadata |
| `EVE_AWS_COST_PROJECT_TAG_VALUE` | `eve-horizon` | AWS `Project` tag value |
| `EVE_AWS_COST_ENVIRONMENT_TAG_VALUE` | `staging` | AWS `Environment` tag value |

Cost Explorer request:

```ts
{
  Granularity: 'MONTHLY',
  Metrics: ['UnblendedCost'],
  TimePeriod: {
    Start: 'YYYY-MM-01',
    End: 'YYYY-MM-DD' // UTC today, exclusive
  },
  Filter: {
    And: [
      { Tags: { Key: 'Project', Values: [projectTagValue] } },
      { Tags: { Key: 'Environment', Values: [environmentTagValue] } }
    ]
  },
  GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
}
```

Date handling:

- Cost Explorer `End` is exclusive.
- At 2026-06-04 UTC, query `Start=2026-06-01,End=2026-06-04` and label the data `MTD through 2026-06-03`.
- If `End <= Start` on the first UTC day of a month, return `null` and leave any previous snapshot untouched.
- Compute `projectedAmount = amount / daysElapsed * daysInMonth`.
- Cost Explorer current-month data can lag by 24-48 hours. Return `null` and preserve the last-good snapshot whenever the finalized total is `0` or there are no non-zero service rows, even when `End > Start`. Do not write a `$0` cluster snapshot or a projection based on lagged empty data.
- Add an early-month projection caveat to `breakdown` when `daysElapsed < 4` so Slack/API/CLI can explain that projections from the first few finalized days are volatile.

Breakdown shape:

```json
{
  "metric": "UnblendedCost",
  "days_elapsed": 3,
  "days_in_month": 30,
  "projection_caveat": "early-month estimate based on 3 finalized days",
  "by_service": [
    { "service": "Amazon Elastic Kubernetes Service", "amount": 74.4, "currency": "USD" }
  ],
  "provider_metadata": {
    "ce_end_exclusive": "2026-06-04"
  }
}
```

Empty or failed CE responses must not write `$0`.

## Phase 4 - Cloud Cost Collector

Add `CloudCostCollectorService` in the orchestrator cron module.

Behavior:

1. If `EVE_CLOUD_COST_ENABLED !== 'true'`, log and return.
2. Build `CloudCostScopeConfig` from env.
3. Select the provider adapter from `EVE_CLOUD_COST_PROVIDER`.
4. Fetch month-to-date cost.
5. If result is `null`, log and preserve the last-good snapshot.
6. Upsert one `cloud_cost_snapshots` row for the scope.

For V1, support one configured scope via env vars. Do not build a scope registry until there are multiple clusters/accounts to collect.

Register the service in `apps/orchestrator/src/cron/cron.module.ts`.

## Phase 5 - Slack Rendering

Update `appendCostSummary` in `apps/orchestrator/src/cron/env-health-watchdog.service.ts`.

New order:

1. Read `cloud_cost_snapshots` for `scope_type=cluster`, configured `scope_key`, current month, and latest available provider/source.
2. If found, render the cloud cost headline.
3. If absent, fall back to the existing OpenCost summary unchanged.

AWS V1 rendering:

```text
Monthly Eve staging cloud cost — $234.30 projected / $23.43 MTD
  Source: AWS Cost Explorer UnblendedCost | Project=eve-horizon | Environment=staging | MTD through 2026-06-03
  Coverage: undercount until EKS node/NLB/EBS tag propagation is fixed
  Projection: early-month estimate based on 3 finalized days
  Top services: EKS $74.40 | EC2-Other $66.17 | RDS $61.98
  Per-environment split: eve system env-cost --all (OpenCost estimate, not reconciled)
```

Rules:

- Use `provider/source/filter_json/breakdown_json` to render provider-specific source details.
- Suppress `Coverage:` when `coverage === 'complete'`.
- Render the projection caveat only when the provider supplied one, usually during the first few finalized billing days of a month.
- Apply `EVE_SENTINEL_COST_STALE_AFTER_HOURS` (default 26 hours). If stale, label the headline as stale and include `last observed <iso>`.
- Put the cloud-snapshot read in its own try/catch. If the cloud read throws, warn and continue into the unchanged OpenCost fallback path; do not let a cloud-query error produce `Monthly cost: unavailable` while OpenCost snapshots are still readable.
- Keep the existing try/catch so cost rendering can never break the daily health summary.
- Do not show the OpenCost `$2.21 total` line once a cloud cluster row exists.
- Do not fetch or render whole-account cost.

## Phase 6 - API And CLI

Add a provider-neutral admin API:

```text
GET /admin/cost/cloud?scope_type=cluster&scope_key=example-cluster&month=YYYY-MM&provider=aws&source=aws_cost_explorer
```

Response shape:

```ts
{
  window: { month: '2026-06', start: string, end: string | null, mtd_through: string | null },
  provider: 'aws',
  source: 'aws_cost_explorer',
  scope: { type: 'cluster', key: 'example-cluster', label: 'Eve staging cluster' },
  amount: '23.43',
  projected_amount: '234.30',
  currency: 'USD',
  confidence: 'estimate',
  coverage: 'undercount',
  observed_at: string | null,
  stale: boolean,
  filter: Record<string, unknown>,
  breakdown: Record<string, unknown>
}
```

Add CLI:

```bash
eve system cloud-cost [--scope cluster] [--scope-key example-cluster] [--provider aws] [--source aws_cost_explorer] [--month YYYY-MM] [--json]
```

Output should mirror the Slack headline and print the top service breakdown. Keep `eve system env-cost` as the OpenCost estimate command and update its help text to say it is not bill-backed.

## Phase 7 - AWS Infra Work

All AWS infrastructure changes must land in `../deployment-instance` through Terraform. Do not patch AWS resources by hand.

### IRSA

Add a read-only IAM role for the `eve-orchestrator` Kubernetes service account:

```hcl
data "aws_iam_policy_document" "orchestrator_cost_explorer" {
  statement {
    sid       = "CostExplorerRead"
    effect    = "Allow"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]
  }
}
```

Then:

- Trust-bind it to the staging EKS OIDC provider and `eve-orchestrator` service account.
- Persist the `eks.amazonaws.com/role-arn` annotation in the infra repo manifest that owns the service account, not by a live `kubectl annotate`. The `eve-orchestrator` ServiceAccount is defined in `../deployment-instance/k8s/base/orchestrator-rbac.yaml` and is re-applied on deploy; put the annotation there if it is staging-safe, or add an `overlays/aws-eks` ServiceAccount patch wired to a Terraform-managed role ARN. A live-only annotation will be stripped by the next kustomize apply.
- Roll out orchestrator with `EVE_CLOUD_COST_ENABLED=true` only after a pod-level CE call succeeds.
- Do not add static AWS keys.

### Tag Propagation

Fix the undercount by applying cost tags to billable cluster resources:

- Keep existing active Cost Explorer tags: `Project`, `Environment`, `Component`.
- Add future scope tags everywhere Terraform manages resources: `CostScope`, `EveInstance`, `EveCluster`, `ManagedBy`.
- Add launch-template `tag_specifications` for both EKS node `instance` and root `volume` resources.
- Add ASG tag propagation for managed node groups.
- Add AWS load balancer controller additional-resource-tags for the ingress NLB.
- Prefer an EBS CSI `StorageClass` tag configuration for dynamic volumes if the installed driver supports it; otherwise keep PVC precision out of V1.
- Rotate/refresh nodes after Terraform apply so new instance and root-volume tags actually appear.
- Activate new scope tags as AWS cost allocation tags before using them for future reporting. V1 still filters only on already-active `Project` and `Environment`.

After tags propagate and at least one complete billing day lands, set:

```text
EVE_CLOUD_COST_COVERAGE=complete
```

Slack will drop the undercount warning. The current-month snapshot can still use `confidence='estimate'` because cloud bills can settle after the MTD window. Use `confidence='reconciled'` only for closed-month backfills or after an explicit provider reconciliation step.

## Phase 8 - Staging Cluster Verification

Verify the feature against the real `example` staging cluster after the source repo release and infra repo rollout.

Staging safety rules:

- Use `../deployment-instance/config/kubeconfig.yaml` for staging Kubernetes access.
- Never use `~/.kube/eve-hosted.yaml` or an implicit default kube context.
- Prefer running staging operations from `../deployment-instance` through `./bin/eve-infra ...`.
- If direct `kubectl` is needed, always include:
  - `--kubeconfig ../deployment-instance/config/kubeconfig.yaml`
  - `--context <explicit-eks-context>`
- AWS CLI commands in this verification must be read-only. Any AWS infrastructure fix goes through Terraform in `../deployment-instance`.

Before enabling the collector:

```bash
cd ../deployment-instance
./bin/eve-infra status
./bin/eve-infra health --json
terraform -chdir=terraform/aws plan
```

The Terraform plan must show the intended IRSA/tag/config changes only. After `terraform apply`, run the same plan again and require no drift.

Verify orchestrator IRSA and rollout:

```bash
kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml \
  --context <explicit-eks-context> \
  -n eve get deploy eve-orchestrator \
  -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'

kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml \
  --context <explicit-eks-context> \
  -n eve get serviceaccount eve-orchestrator \
  -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}{"\n"}'

kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml \
  --context <explicit-eks-context> \
  -n eve rollout status deploy/eve-orchestrator
```

Verify the cloud cost collector writes a staging snapshot:

```bash
export EVE_API_URL=https://api.eve.example.com
eve profile use staging
eve system health --json
eve system cloud-cost \
  --scope cluster \
  --scope-key example-cluster \
  --provider aws \
  --source aws_cost_explorer \
  --json
```

Expected API/CLI result:

- `provider=aws`
- `source=aws_cost_explorer`
- `scope.type=cluster`
- `scope.key=example-cluster`
- `amount > 0`
- `projected_amount > 0`
- `currency=USD`
- `coverage=undercount` before tag propagation, then `coverage=complete` after the tag rollout and a full billing day
- `filter` includes `Project=eve-horizon` and `Environment=staging`
- `breakdown.by_service` contains at least one non-zero service row

Verify collector logs without mutating the cluster:

```bash
kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml \
  --context <explicit-eks-context> \
  -n eve logs deploy/eve-orchestrator --since=8h | rg "cloud-cost|aws_cost_explorer|Cost Explorer"
```

Verify the daily Slack summary after the next 08:00 UTC run, or trigger the existing summary path if the implementation exposes a safe admin/manual trigger. The message must show the cloud-cost headline, source line, MTD-through date, top services, and the undercount warning while `EVE_CLOUD_COST_COVERAGE=undercount`.

Read-only AWS cost and tag checks:

```bash
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=2026-06-01,End=2026-06-05 \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"And":[{"Tags":{"Key":"Project","Values":["eve-horizon"]}},{"Tags":{"Key":"Environment","Values":["staging"]}}]}' \
  --group-by Type=DIMENSION,Key=SERVICE

aws ec2 describe-instances --region eu-west-1 \
  --filters Name=tag:eks:cluster-name,Values=example-cluster \
  --query 'Reservations[].Instances[].{Id:InstanceId,Project:Tags[?Key==`Project`]|[0].Value,Environment:Tags[?Key==`Environment`]|[0].Value,Component:Tags[?Key==`Component`]|[0].Value}'

aws elbv2 describe-load-balancers --region eu-west-1 \
  --query 'LoadBalancers[?contains(LoadBalancerName, `k8s-`) == `true`].LoadBalancerArn' \
  --output text
```

For NLB tag verification, feed the discovered load balancer ARN into `aws elbv2 describe-tags --region eu-west-1 --resource-arns <arn>`. The expected final state is that worker EC2 instances, node root volumes, dynamic EBS volumes where supported, and the ingress NLB carry `Project=eve-horizon`, `Environment=staging`, and a useful `Component`.

Staging verification passes only when:

- The staging API is healthy.
- The orchestrator pod uses the expected service account and IRSA annotation.
- `eve system cloud-cost --json` returns a non-zero AWS cluster snapshot.
- Slack renders the AWS/cloud headline instead of the OpenCost fallback.
- Read-only AWS checks confirm tag propagation, or the Slack coverage warning remains present while propagation is incomplete.

## GCP Extension Point

GCP should be added by implementing a new provider adapter and infra identity, not by changing the cloud cost table or Slack/API/CLI contracts.

Expected shape:

- Provider: `gcp`
- Source: `gcp_billing_export`
- Data source: Cloud Billing export to BigQuery.
- Identity: GKE Workload Identity or the runtime equivalent, with read-only BigQuery access to the billing export dataset.
- Filters: configured label keys/values, mapped to the same logical scope fields:
  - `scope_type=cluster`
  - `scope_key=<gke-cluster-or-eve-cluster-key>`
  - labels such as `eve_project`, `environment`, `component`, `cost_scope`, `eve_instance`, `eve_cluster`
- Breakdown: normalize GCP service descriptions into the same `breakdown.by_service[]` shape.

Do not implement the GCP adapter in this AWS fix unless a GCP environment is being onboarded. The contract should make that addition mechanical.

## Out Of Scope

- Per-app chargeback.
- OpenCost reconciliation to the cloud cluster denominator.
- AWS CUR/Athena split cost allocation.
- Whole-account audit line in Slack.
- Multi-scope config registry.
- Cross-cloud/cross-currency aggregation.
- GCP implementation in the AWS-first PR.

## Tests

Add focused tests:

- `cloudCostSnapshotQueries`: generated `ccs` id when `id` is omitted, upsert, latest scope lookup, freshness, uniqueness across provider/source/scope/month.
- `AwsCostExplorerProvider`: tag filter, exclusive end date, MTD-through label, decimal parsing, by-service sorting, projection math, first-day `null`, zero total/no non-zero service rows -> `null`, early-month projection caveat.
- `CloudCostCollectorService`: disabled no-op, unsupported provider error, provider error no upsert, provider `null` no upsert, happy path writes one generic cloud snapshot.
- `EnvHealthWatchdogService`: cloud row present with undercount warning, cloud row present with complete coverage, stale cloud row, malformed/absent cloud row falls back to OpenCost, cloud snapshot query throw falls back to OpenCost.
- `CostService`/controller: cloud endpoint returns the generic response and enforces `system:admin`.
- CLI: `eve system cloud-cost --json` calls the cloud endpoint; text output includes projected/MTD, coverage, and top services.

## Docs Impact

- Update `docs/system/pricing-and-billing.md` with the cloud snapshot table, endpoint, CLI command, and relationship to OpenCost estimates.
- Update the public Eve docs skillpack `references/cli.md` for `eve system cloud-cost`.
- Update the public Eve docs skillpack overview/billing reference if one exists; otherwise keep the CLI docs as the agent-visible source.

## Rollout

1. This repo: add generic storage, AWS adapter, collector, Slack preference, API/CLI, and tests. Ship with `EVE_CLOUD_COST_ENABLED=false`.
2. Infra repo: add IRSA. Verify CE access from the orchestrator pod.
3. Enable `EVE_CLOUD_COST_ENABLED=true` with `EVE_CLOUD_COST_COVERAGE=undercount`. Run the Phase 8 staging verification and confirm Slack switches to AWS tagged cost with the warning.
4. Infra repo: fix tag propagation and rotate nodes.
5. After a full billing day, rerun Phase 8 read-only tag/cost checks, then set `EVE_CLOUD_COST_COVERAGE=complete`. Slack drops the warning.

Rollback is simple: set `EVE_CLOUD_COST_ENABLED=false`; Slack falls back to the existing OpenCost summary.

## Acceptance Criteria

- Daily Slack headline uses cloud bill-backed tagged spend, not the OpenCost `$2.21` estimate.
- AWS source line names Cost Explorer, `UnblendedCost`, `Project=eve-horizon`, `Environment=staging`, and the MTD-through date.
- Undercount warning appears while `EVE_CLOUD_COST_COVERAGE=undercount`.
- Undercount warning is absent when `EVE_CLOUD_COST_COVERAGE=complete`.
- Whole-account cost never appears in the default Slack summary.
- Provider errors or empty responses preserve the last-good snapshot and never write `$0`.
- `GET /admin/cost/cloud` and `eve system cloud-cost` expose the generic cloud cost snapshot.
- OpenCost env-cost output remains available as an estimate and fallback.
- Orchestrator accesses AWS CE through IRSA, with no static AWS credentials.
- Staging verification passes against the `example` cluster using the infra repo kubeconfig and context.
- Adding GCP later requires a provider adapter + config only, not new storage or Slack/API/CLI behavior.

## Build And Verify

For the implementation PR in this repo:

```bash
./bin/eh status
pnpm install
pnpm build
pnpm test
./bin/eh test integration
```

Manual AWS CE smoke, read-only:

```bash
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=2026-06-01,End=2026-06-05 \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"And":[{"Tags":{"Key":"Project","Values":["eve-horizon"]}},{"Tags":{"Key":"Environment","Values":["staging"]}}]}' \
  --group-by Type=DIMENSION,Key=SERVICE
```

After staging deploy, run Phase 8 against `example` before considering the feature done.

## Reference Map

- Idea and verification commands: `docs/ideas/daily-health-summary-cluster-cost-truth.md`
- Foundation env-cost plan: `docs/ideas/daily-health-summary-env-costs.md`
- Slack cost section: `apps/orchestrator/src/cron/env-health-watchdog.service.ts`
- OpenCost collector: `apps/orchestrator/src/cron/env-cost-collector.service.ts`
- Snapshot schema and queries: `packages/db/migrations/00105_environment_cost_snapshots.sql`, `packages/db/src/queries/environment-cost-snapshots.ts`
- Admin env-cost API: `apps/api/src/billing/cost.controller.ts`, `apps/api/src/billing/cost.service.ts`
- CLI env-cost command: `packages/cli/src/commands/system.ts`
- Orchestrator service account reference: `k8s/base/orchestrator-deployment.yaml`
- Infra targets: `../deployment-instance/terraform/aws/`, `../deployment-instance/scripts/setup.sh`
