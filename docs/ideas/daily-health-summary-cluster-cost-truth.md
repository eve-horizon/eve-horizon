# Daily Health Summary: Eve Cluster Cost Truth + Tag Strategy

> Status: Idea - decisions closed
> Date: 2026-06-04
> Follow-up: The the platform operator AWS account includes other systems. The Slack health summary must not show the whole account bill as the Eve staging cluster cost.
> Trigger: an operator saw the daily Slack health summary report "Monthly cost (fresh estimate) - $2.21 total" and asked: (1) verify the numbers, (2) use the AWS API to get actual costs, (3) make the Slack message show estimated monthly cost for the Eve cluster and app attribution without over-engineering.
> Builds on: [`daily-health-summary-env-costs.md`](./daily-health-summary-env-costs.md) (the OpenCost per-env snapshot design). This doc adds AWS verification and the cluster-scoped tagging strategy.

## TL;DR

Two things are true:

1. The current Slack number (`$2.21`) is wrong because OpenCost is not producing a credible AWS-backed allocation.
2. The whole the platform operator account bill is also the wrong headline for Eve staging, because it includes other systems.

Verified with read-only AWS APIs on 2026-06-04:

- May 2026 full account bill: `$2,421.59`.
- May 2026 `eu-west-1` bill: `$578.03`.
- May 2026 currently tagged `Project=eve-horizon AND Environment=staging`: `$205.04`.
- The `eu-west-1` remainder contains both unrelated systems and Eve cluster resources whose tags do not propagate to billable resources yet.

Recommendation:

1. **Do not display the whole account bill as Eve cluster cost.** Keep it only as an audit/debug comparison.
2. **Display Eve staging cluster cost from Cost Explorer filtered by active tags:** `Project=eve-horizon AND Environment=staging`.
3. **Fix tag propagation in `../deployment-instance` first**, because the current filtered value undercounts the cluster by missing EC2 worker nodes, node root volumes, dynamic EBS volumes, and the ingress NLB.
4. **Use existing active Cost Explorer tags for v1** (`Project`, `Environment`, optionally `Component`). Add more precise tags (`CostScope`, `EveInstance`, `EveCluster`) in Terraform, but only switch reporting to them after they are activated for cost allocation and have accumulated data.
5. **Per-app attribution remains an estimate.** Once the cluster total is accurate, apportion it with OpenCost/EKS split allocation; do not use account-wide `Project` tags for in-cluster app chargeback.

## AWS Verification

Cost Explorer dates are start-inclusive and end-exclusive.

| Query | Window | Amount |
| --- | --- | ---: |
| Whole account `UnblendedCost` | May 1-31, 2026 | `$2,421.59` |
| Whole account `UnblendedCost` | Jun 1-3, 2026 | `$233.87` |
| `Project=eve-horizon AND Environment=staging` | May 1-31, 2026 | `$205.04` |
| `Project=eve-horizon AND Environment=staging` | Jun 1-3, 2026 | `$23.43` |

May 2026 whole-account cost by region:

```
  $ 1168.91  us-west-2
  $  578.03  eu-west-1
  $  403.60  NoRegion / Tax
  $  255.89  eu-west-2
  $    8.98  us-east-1
  $    6.17  global
```

That proves the account bill includes more than Eve staging. `us-west-2` alone is almost half the account total and is driven by non-Eve project tags such as `fanfair`, `Linguard`/`linguard`, `sri`, `BNY`, and a large untagged bucket.

May 2026 `eu-west-1` cost by service and `Project` tag also proves the current Eve tag filter is incomplete:

```
  $ 196.90  EC2 Compute, untagged
  $  61.98  RDS, Project=eve-horizon
  $  66.17  EC2 - Other, Project=eve-horizon
  $  74.40  EKS control plane, Project=eve-horizon
  $  48.53  ELB, untagged
  $  35.82  VPC, untagged
  $  29.40  ECS, untagged
```

Resource API checks explain the gap:

- EKS cluster `example-cluster` is correctly tagged `Project=eve-horizon`, `Environment=staging`, `ManagedBy=terraform`.
- EKS managed node groups are tagged, but their launched EC2 instances are not. Running worker instances have `kubernetes.io/cluster/example-cluster` and `eks:cluster-name=example-cluster`, but no `Project` or `Environment` tag.
- EKS node root EBS volumes and dynamic EBS CSI PVC volumes are not tagged with `Project` or `Environment`.
- The Eve ingress NLB in VPC `vpc-017fa00d17e5ab857` is tagged only with Kubernetes service/cluster tags, not `Project` or `Environment`.
- There are unrelated `eu-west-1` resources in the account, including a CloudFormation `MlconChatStack` VPC/NAT/ALB in `vpc-0bac92038ddbee70c` and non-Eve EC2 instances.

## Closed Reporting Decision

The Slack headline should be:

```text
Monthly Eve staging AWS cost - $234.28 projected / $23.43 MTD
  Source: AWS Cost Explorer UnblendedCost | Project=eve-horizon | Environment=staging | MTD through 2026-06-03
  Coverage: undercount until EKS node/NLB/EBS tag propagation is fixed
```

After tag propagation is fixed and at least one full billing day has landed, remove the undercount warning and show the filtered Cost Explorer value as the cluster total.

Do not show the whole account total in the default health summary. If useful, include it only in debug/detail output:

```text
Account audit: the platform operator AWS account May actual was $2,421.59; Eve staging tagged spend was $205.04 before tag propagation fixes.
```

## Tagging Strategy

Use a two-layer strategy.

### Layer 1: Existing Active Cost Tags

These are already active in Cost Explorer:

```
Project
Environment
Component
Customer
Application
```

For v1 reporting, filter by:

```json
{
  "And": [
    { "Tags": { "Key": "Project", "Values": ["eve-horizon"] } },
    { "Tags": { "Key": "Environment", "Values": ["staging"] } }
  ]
}
```

Use `Component` for breakdowns, not for the primary filter. Suggested values:

```
eks-control-plane
eks-node-default
eks-node-agents
eks-node-apps
eks-node-egress
ingress
network
database
storage
registry
dns
mail
observability
```

### Layer 2: New Scope Tags

Add these tags everywhere in Terraform for audit clarity and future multi-cluster reporting:

```
CostScope=example-cluster
EveInstance=example
EveCluster=example-cluster
ManagedBy=terraform|helm|kubernetes
```

Before using them in Cost Explorer reports, activate them as AWS cost allocation tags. Until then, they are useful for resource inventory but not authoritative billing filters.

## Infra Changes Required

All changes belong in `../deployment-instance`. Do not mutate AWS resources by hand.

1. Define shared cost tags in Terraform, probably near `terraform/aws/providers.tf` or `terraform/aws/main.tf`:

```hcl
locals {
  cost_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    CostScope   = "${var.name_prefix}-${var.environment}-cluster"
    EveInstance = var.name_prefix
    EveCluster  = "${var.name_prefix}-cluster"
  }
}
```

2. Extend provider `default_tags` with the new scope tags, while keeping `Project` and `Environment`.

3. Fix EKS node launch templates in:

- `terraform/aws/modules/eks/main.tf`
- `terraform/aws/modules/eks-egress-pool/main.tf`

Each launch template should tag both `instance` and `volume` resources, not just `Name`. Example pattern:

```hcl
tag_specifications {
  resource_type = "instance"
  tags = merge(var.cost_tags, {
    Name      = "${var.name_prefix}-eks-default"
    Component = "eks-node-default"
  })
}

tag_specifications {
  resource_type = "volume"
  tags = merge(var.cost_tags, {
    Name      = "${var.name_prefix}-eks-default-root"
    Component = "storage"
  })
}
```

4. Add `aws_autoscaling_group_tag` resources for the EKS-managed ASGs so `Project`, `Environment`, `Component`, and scope tags propagate at launch. Existing ASGs currently propagate only Kubernetes/autoscaler tags.

5. Tag the ingress NLB at creation time in `scripts/setup.sh` by adding the AWS service annotation:

```bash
--set-string controller.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-additional-resource-tags"="Project=eve-horizon,Environment=staging,Component=ingress,CostScope=example-cluster,EveInstance=example,EveCluster=example-cluster,ManagedBy=helm"
```

Use config-derived values rather than hardcoding if this script is kept template-safe.

6. Tag dynamic EBS CSI volumes. Prefer a managed `StorageClass` in the infra repo with EBS CSI tag parameters if supported by the installed driver version; otherwise document that CUR/EKS split allocation is required for PVC-level precision and keep dynamic EBS under shared cluster storage.

7. Run `terraform plan` and `terraform apply` from `../deployment-instance`, then rotate/refresh nodes so existing EC2 instances and root volumes pick up launch template tags. New tags do not retroactively reclassify old Cost Explorer line items.

## Cost Display Strategy

V1, after tag propagation:

- Headline: AWS Cost Explorer `UnblendedCost`, month-to-date, filter `Project=eve-horizon AND Environment=staging`.
- Projection: linear MTD projection, labelled `projected`.
- Detail: by `SERVICE` and optionally by `Component`.
- Confidence: `aws-tagged`; no account-wide costs included.

V1 fallback before tag propagation:

- Show the filtered value with a clear undercount warning.
- Optionally include "tag coverage gap" from the audit checks, not as a dollar-accurate cluster total.

V2:

- Use the AWS-tagged cluster total as the denominator.
- Use OpenCost/EKS split allocation only for proportions across Eve apps/environments.
- Reconcile app rows so they sum to the AWS-tagged cluster total, with unallocated shared platform cost shown explicitly.

## Reproduce The Verification

```bash
# Whole account May actual - proves account scope is too broad.
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=2026-05-01,End=2026-06-01 \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=REGION

# Current Eve staging tagged cost.
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=2026-05-01,End=2026-06-01 \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"And":[{"Tags":{"Key":"Project","Values":["eve-horizon"]}},{"Tags":{"Key":"Environment","Values":["staging"]}}]}' \
  --group-by Type=DIMENSION,Key=SERVICE

# Show eu-west-1 tagged and untagged service costs.
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=2026-05-01,End=2026-06-01 \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"REGION","Values":["eu-west-1"]}}' \
  --group-by Type=DIMENSION,Key=SERVICE Type=TAG,Key=Project

# Confirm worker instances are currently missing Project/Environment tags.
aws ec2 describe-instances --region eu-west-1 \
  --filters Name=tag:eks:cluster-name,Values=example-cluster \
  --query 'Reservations[].Instances[].{Id:InstanceId,Name:Tags[?Key==`Name`]|[0].Value,Project:Tags[?Key==`Project`]|[0].Value,Environment:Tags[?Key==`Environment`]|[0].Value}'

# Confirm the ingress NLB is currently missing Project/Environment tags.
aws elbv2 describe-tags --region eu-west-1 \
  --resource-arns arn:aws:elasticloadbalancing:eu-west-1:<aws-account-id>:loadbalancer/net/a195f9517e2594b6b975b0681a838977/f57144276e1e8121
```

## Related Internal References

- Prior idea (foundation): `docs/ideas/daily-health-summary-env-costs.md`
- Slack cost section: `apps/orchestrator/src/cron/env-health-watchdog.service.ts:658` (`appendCostSummary`)
- OpenCost collector: `apps/orchestrator/src/cron/env-cost-collector.service.ts` (`OpenCostSource`, `isSharedOverheadAllocation`)
- Cost API/service: `apps/api/src/billing/cost.controller.ts`, `apps/api/src/billing/cost.service.ts`
- Snapshot schema/queries: `packages/db/src/queries/environment-cost-snapshots.ts`
- Infra repo: `../deployment-instance/terraform/aws/providers.tf`, `../deployment-instance/terraform/aws/modules/eks/main.tf`, `../deployment-instance/terraform/aws/modules/eks-egress-pool/main.tf`, `../deployment-instance/scripts/setup.sh`
