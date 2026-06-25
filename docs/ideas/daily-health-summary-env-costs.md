# Daily Health Summary Environment Costs

> Status: Idea
> Date: 2026-06-02
> Trigger: an operator asked whether the daily the platform operator Slack health summary can show monthly cost per environment.

## Short Answer

Yes, but the summary should label the value as an estimate unless it is backed by an AWS Cost and Usage Report reconciliation job.

There are two different answers hiding inside "monthly cost per env":

- **Eve-billed cost**: what Eve would charge based on rate cards and internal usage records.
- **AWS infrastructure allocation**: what shared EKS and AWS resources appear to cost per environment.

an operator's Slack request is probably about AWS infrastructure allocation. The message should name the source and confidence explicitly so an OpenCost estimate, an Eve rate-card estimate, and a CUR-reconciled number are not confused.

The most useful first version is:

- use OpenCost for a month-to-date Kubernetes allocation by environment namespace or Eve labels;
- persist a daily `environment_cost_snapshots` row per environment;
- join those snapshots into the existing Platform Sentinel daily Slack summary;
- keep shared platform costs separate from per-environment app costs unless an explicit allocation rule is chosen;
- add an AWS CUR/Athena reconciliation path later for month-end accuracy.

This gives an operator and the team useful daily visibility without pretending that a shared EKS cluster has exact per-environment AWS invoice lines in real time.

## Current Platform Facts

Platform Sentinel's current daily summary is assembled in `EnvHealthWatchdogService.sendDailySummary()`. It reads only `healthChecks.summary()`, degraded envs, and critical envs, then posts a text message through `/internal/platform-notify` (`apps/orchestrator/src/cron/env-health-watchdog.service.ts:597`).

The persisted health row has `environment_id`, `project_id`, `org_id`, `environment_slug`, status, pod counts, issues, actions, and timestamps, but no spend fields (`packages/db/src/queries/environment-health.ts:5`).

Deploys already attach useful Kubernetes labels to namespaces, PVCs, services, and workloads: `eve.org_id`, `eve.project_id`, `eve.env`, `eve.component`, and `eve.release` in the worker deployer (`apps/worker/src/deployer/deployer.service.ts:321`, `apps/worker/src/deployer/deployer.service.ts:476`, `apps/worker/src/deployer/deployer.service.ts:1098`). They do not currently include `eve.env_id`, even though the resource-management plan recommends that label for resilient metering (`docs/plans/resource-management-and-cost-tracking-v2.md:850`).

The platform already has `usage_records` with `org_id`, `project_id`, `env_id`, resource type, unit, quantity, and time window (`packages/db/src/queries/usage-records.ts:3`). There are also env-capable sweepers for K8s pod/PVC usage and managed DB tenants (`apps/orchestrator/src/cron/usage-sweeper.service.ts:60`, `apps/orchestrator/src/cron/managed-db-sweeper.service.ts:31`). Those sweepers are disabled by default, and the admin usage API currently exposes org-level usage aggregates rather than a Sentinel-ready monthly cost-per-environment snapshot (`apps/api/src/billing/usage.controller.ts:44`). The public spend APIs aggregate job-attempt receipts (`packages/db/src/queries/spend.ts:66`).

Important caveat: the current usage sweepers should be audited before they are used as a source for Slack cost reporting. They appear to compute quantities from pod/PVC creation time or managed DB `ready_at` to `now` on each sweep while using a fresh sweep id (`apps/orchestrator/src/cron/usage-sweeper.service.ts:210`, `apps/orchestrator/src/cron/usage-sweeper.service.ts:268`, `apps/orchestrator/src/cron/managed-db-sweeper.service.ts:153`). That may repeatedly record cumulative lifetime usage rather than only the delta since the previous sweep. Follow-up issue: `eve-horizon-gc0v`.

## What The Slack Message Could Show

For the current 29-env shape, keep the default daily message readable and put cost into a small, explicit section:

```text
Monthly environment cost, MTD estimate:
  Total allocated env cost: $184.21
  Shared platform overhead: $96.40 unallocated
  Source: OpenCost, window=month, idle shared by request

  Top envs:
    $42.18  org-a / project-x / prod
    $31.06  org-b / project-y / sandbox
    $18.77  org-a / project-x / preview-pr-123
```

If the team wants every environment in the daily message, 29 lines is acceptable but noisier:

```text
Environment cost, MTD estimate:
  $42.18  project-x/prod
  $31.06  project-y/sandbox
  $18.77  project-x/preview-pr-123
  ...
```

Recommendation: default to top 10 plus total, and add a CLI/API/detail view for all environments. If Slack must answer an operator literally, add an `EVE_SENTINEL_COST_SUMMARY_MODE=all|top` switch and set the platform operator to `all` while there are fewer than about 50 monitored envs.

## Cost Data Options

### Option A: Eve Rate-Card Metering

This uses the existing `usage_records` path. Sweepers can record requested CPU, requested memory, PVC GB-hours, managed database tier-hours, and optional service-class rates for every environment. Costs are computed from Eve rate cards.

Pros:

- Fastest to implement inside the current codebase once the sweeper windowing is audited.
- Deterministic and explainable.
- Uses existing `env_id`-capable usage-record shape.
- Works locally and in any cloud.

Cons:

- It is platform pricing, not AWS invoice attribution.
- Current sweeper time-window semantics need audit/fix before using this for money-facing reporting.
- Requires us to choose rates for shared cluster overhead, idle capacity, NAT, load balancers, storage classes, and control-plane costs.
- Easy to confuse with real cloud spend if not labelled.

Fit: good for customer billing, quota policy, or a fast internal "Eve-billed estimate"; weak as an answer to "what did AWS cost us per env?" unless the rate cards are deliberately tied to AWS bills.

### Option B: AWS Cost Explorer By Tags

AWS Cost Explorer can retrieve cost and usage metrics, filter by dimensions/tags, and group by dimensions, tag keys, or cost categories. Cost allocation tags must be activated before they appear in Cost Explorer or cost reports.

Pros:

- Native AWS billing source.
- Good for directly tagged resources such as standalone RDS, S3, EBS, or load balancers when tags are propagated correctly.
- Simple enough for a low-frequency reconciliation job.

Cons:

- Not enough for per-pod/per-env allocation of shared EKS worker nodes.
- Grouping is limited and can only reflect activated tag dimensions.
- Billing data is delayed: Cost Explorer shows month-to-date estimates from upstream billing data, generally through the previous day and refreshed at least daily.
- Shared resources still need allocation policy.

Fit: useful secondary source for directly tagged non-Kubernetes resources; not the main answer for shared EKS env cost.

### Option C: OpenCost / Kubecost Allocation API

OpenCost is built for Kubernetes cost allocation. Its allocation API supports windows such as `month`, aggregation by `namespace`, and aggregation by labels such as `label:eve.project_id` or `label:eve.env`. It also supports `includeIdle` and `shareIdle`, which are exactly the knobs needed for shared EKS cluster overhead.

Pros:

- Best match for Eve environments because each env has a namespace and Eve labels.
- Can run daily or hourly and give near-real-time estimates.
- Can allocate by namespace, controller, pod, service, or label.
- Can include or share idle costs, which is the hard part of shared cluster accounting.
- Can be integrated into Platform Sentinel without querying AWS Billing during the Slack send path.

Cons:

- Needs OpenCost deployed, configured, secured, and scraped.
- Estimates depend on Kubernetes requests, usage, pricing model, and cloud integration freshness.
- Still needs a policy for platform-owned namespaces and unallocated overhead.

Fit: recommended v1 source for the daily Slack summary.

### Option D: AWS CUR Split Cost Allocation For EKS

AWS split cost allocation data for EKS gives pod-level cost visibility in Cost and Usage Reports and can be aggregated by Kubernetes primitives such as namespace, deployment, node, workload name, and workload type. AWS documents that split cost allocation data is available in CUR/Data Exports, not Cost Explorer.

Pros:

- Closest path to bill-backed EKS allocation.
- Good month-end reconciliation source.
- Supports real AWS CUR workflows with Athena/QuickSight.

Cons:

- Requires CUR/Data Exports, S3, Athena or equivalent query plumbing, and opt-in.
- Delayed; data can take up to 24 hours to appear, and CUR updates are estimates during the current month until the bill is finalized.
- More implementation and infrastructure surface than OpenCost.

Fit: recommended reconciliation source, not the v1 Slack source.

## Recommended Architecture

Add a small cost-snapshot layer instead of making the Slack summary call live billing APIs. The source can be OpenCost for AWS infrastructure estimates, audited `usage_records` for Eve-billed estimates, and CUR for month-end reconciliation.

```sql
CREATE TABLE environment_cost_snapshots (
  id text PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  org_id text NOT NULL,
  project_id text NOT NULL,
  environment_slug text NOT NULL,
  source text NOT NULL,              -- opencost, aws_cur, aws_cost_explorer, eve_rate_card
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  amount_usd numeric NOT NULL,
  shared_amount_usd numeric,
  confidence text NOT NULL,          -- estimate, reconciled, unavailable
  breakdown_json jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id, source, window_start, window_end)
);
```

Collector behavior:

1. Resolve active environments from the Eve DB.
2. Query OpenCost on a schedule, probably hourly or daily:
   - `GET /allocation?window=month&aggregate=namespace&shareIdle=true`
   - or `GET /allocation?window=month&aggregate=label:eve.project_id,label:eve.env&shareIdle=true`
3. Map namespace or labels back to `environment_id`.
4. Persist one snapshot per env and one platform-overhead snapshot for unallocated shared cost.
5. On month-end, optionally reconcile with AWS CUR split cost allocation and mark those rows as `confidence=reconciled`.

Summary behavior:

1. `sendDailySummary()` fetches latest snapshots for the current month.
2. It joins by `environment_id`, not by display slug.
3. Missing cost data renders as `cost unavailable` and never blocks the health summary.
4. The Slack message always includes `Source` and `window` so people know whether they are seeing an estimate or a reconciled bill-backed value.

## Implementation Sequence

1. Decide the displayed semantic: AWS infrastructure estimate, Eve-billed estimate, or both.
2. Add `eve.env_id` to namespace, service, deployment, ingress, PVC, and pod template labels. Keep namespace mapping as the fallback.
3. Audit/fix the existing usage sweeper delta-window model before using `usage_records` as a cost source.
4. Add `environment_cost_snapshots` and a query module for latest month-to-date snapshots.
5. Add an internal cost collector job/service. Start with OpenCost for AWS infrastructure estimates.
6. Update `EnvHealthWatchdogService.sendDailySummary()` to include a cost section from persisted snapshots.
7. Add `eve system env-cost --month [--json]` or an admin API so Slack is not the only surface.
8. Add AWS CUR split-cost reconciliation once the daily estimate has proved useful.

## Decisions To Make Before Build

- **Window:** use calendar month-to-date for "monthly" in the daily summary. Rolling 30-day cost is useful, but it is not what most people mean by monthly cost.
- **Idle/shared allocation:** show unallocated platform overhead separately at first. If product/customer reporting needs a single per-env number, allocate idle by requested CPU/memory share and say so in the source line.
- **Coverage:** include app namespaces first. Platform namespaces (`eve`, `kube-system`, ingress, monitoring, OpenCost itself) should be reported as shared overhead unless explicitly allocated.
- **Display:** top 10 plus total by default; allow `all` mode while env count remains low.
- **Meaning of cost:** call OpenCost values `estimate`; reserve `reconciled` for CUR-backed snapshots.

## Risks And Caveats

- A single AWS Cost Explorer query will not answer this correctly for shared EKS environments.
- Tagging must be enforced; any unlabelled workload becomes unallocated cost.
- The current labels include env name but not env id. Env names can be reused across projects, so cost joins should use `environment_id` once the label exists.
- Do not reuse the current usage sweeper values for Slack cost reporting until `eve-horizon-gc0v` is resolved.
- Cost data should be cached before the Slack send. Billing or OpenCost outages should not suppress the health report.
- Any AWS infrastructure required for CUR, Athena, or OpenCost cloud integration must be provisioned through Terraform in `../deployment-instance`, not by ad hoc AWS CLI changes.

## External References

- AWS Cost Explorer `GetCostAndUsage`: https://docs.aws.amazon.com/en_us/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html
- AWS Cost Explorer data freshness and API cost: https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html
- AWS Cost Explorer current-period data: https://docs.aws.amazon.com/cost-management/latest/userguide/ce-exploring-data.html
- AWS cost allocation tags: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html
- AWS cost allocation tag activation: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html
- AWS EKS split cost allocation: https://docs.aws.amazon.com/eks/latest/userguide/cost-monitoring-aws.html
- AWS split cost allocation enablement: https://docs.aws.amazon.com/en_us/cur/latest/userguide/enabling-split-cost-allocation-data.html
- AWS CUR overview and data freshness: https://docs.aws.amazon.com/cur/latest/userguide/what-is-cur.html
- OpenCost API: https://opencost.io/docs/integrations/api/
- OpenCost specification: https://opencost.io/docs/specification

## Related Internal References

- Platform Sentinel daily summary: `apps/orchestrator/src/cron/env-health-watchdog.service.ts:597`
- Environment health row shape: `packages/db/src/queries/environment-health.ts:5`
- Eve workload labels: `apps/worker/src/deployer/deployer.service.ts:321`, `apps/worker/src/deployer/deployer.service.ts:476`, `apps/worker/src/deployer/deployer.service.ts:1098`
- Existing env-capable usage ledger: `packages/db/src/queries/usage-records.ts:3`
- Existing K8s usage sweeper: `apps/orchestrator/src/cron/usage-sweeper.service.ts:60`
- Existing managed DB usage sweeper: `apps/orchestrator/src/cron/managed-db-sweeper.service.ts:31`
- Existing admin usage API: `apps/api/src/billing/usage.controller.ts:44`
- Existing non-job metering plan: `docs/plans/resource-management-and-cost-tracking-v2.md:850`
