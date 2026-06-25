# App Compute Classes

Status: Ready for implementation
Last Updated: 2026-02-15

Inputs:
- `../eve-horizon-infra/docs/plans/gcp-cloud-support.md` (App Compute Contract section)
- `docs/plans/manifest-v2-compose-plan.md` (manifest schema reference)
- `docs/plans/agentic-app-infra-provisioning-plan.md` (parallel infra work)

## Brief

App services currently deploy without explicit compute sizing. In
`apps/worker/src/deployer/deployer.service.ts`, service containers are rendered
without `resources.requests` or `resources.limits`, so workload sizing and
placement are left entirely to scheduler defaults.

This plan introduces a per-service `x-eve.compute_class` that maps to
deterministic resource requests/limits and optional substrate-specific placement
rules.

## Decisions (Closed)

| Decision | Recommendation | Why |
|----------|----------------|-----|
| How to detect substrate | Use runtime env var `EVE_COMPUTE_MODEL` (`k3s`, `gke`, `eks`, `aks`, `ecs`) with default `k3s` in shared config schema | Worker runtime already consumes env-driven config; no cross-repo file reads |
| How to target app node pools | Use env-configured selector/taint contract, not hardcoded label keys | Infra controls node label/taint conventions; platform should not hardcode `pool=apps` |
| Should app classes and job `resource_class` share names | No. Keep app service classes (`small|medium|large|xlarge`) separate from job classes (`job.c1`, `job.c2`, ...) | Job classes are already used by pricing, billing, and CLI help; renaming would create churn |
| Where to keep class tables | Put app compute mapping in shared code (`packages/shared`) and import in worker deployer | Single source of truth; avoids duplicating values across components |

## Manifest Contract

Add `compute_class` to `x-eve` service schema:

```yaml
services:
  api:
    build:
      context: ./apps/api
    x-eve:
      compute_class: medium    # small | medium | large | xlarge
      ingress:
        public: true
        port: 3000
```

Behavior:
- Scope: per service.
- Default: if omitted, runtime treats it as `small`.
- Validation: invalid values fail manifest validation.

## Compute Class Table

Kubernetes mapping:

| Class | CPU Request | Memory Request | CPU Limit | Memory Limit |
|-------|-------------|----------------|-----------|--------------|
| `small` | `250m` | `512Mi` | `500m` | `1Gi` |
| `medium` | `1000m` | `2Gi` | `2000m` | `4Gi` |
| `large` | `2000m` | `4Gi` | `4000m` | `8Gi` |
| `xlarge` | `4000m` | `8Gi` | `8000m` | `16Gi` |

Fargate mapping (future ECS translation):

| Class | vCPU units | Memory (MiB) |
|-------|------------|--------------|
| `small` | `256` | `512` |
| `medium` | `1024` | `2048` |
| `large` | `2048` | `4096` |
| `xlarge` | `4096` | `8192` |

## Substrate Translation Rules

| Compute Model | Resource Injection | Placement |
|---------------|--------------------|-----------|
| `k3s` | Apply requests/limits from compute class | No node selector / toleration |
| `gke` | Apply requests/limits from compute class | Apply selector/taint toleration when placement env vars are set |
| `eks` | Apply requests/limits from compute class | Apply selector/taint toleration when placement env vars are set |
| `aks` | Apply requests/limits from compute class | Apply selector/taint toleration when placement env vars are set |
| `ecs` | Future: translate to task definition CPU/memory | Out of scope for this implementation |

Kubernetes placement contract (all optional, set by infra overlays):
- `EVE_APP_NODE_SELECTOR_KEY`
- `EVE_APP_NODE_SELECTOR_VALUE`
- `EVE_APP_TAINT_KEY`
- `EVE_APP_TAINT_VALUE`
- `EVE_APP_TAINT_EFFECT` (`NoSchedule` default)

Behavior:
- If `EVE_COMPUTE_MODEL` is one of `gke|eks|aks` and selector key/value are
  set, deployer injects `nodeSelector`.
- If taint key is set, deployer injects a matching toleration.
- If `EVE_COMPUTE_MODEL` is one of `gke|eks|aks` but selector config is
  missing, deployer logs a warning and continues without placement constraints.
- Infra overlay convention:
  - k3s overlays set `EVE_COMPUTE_MODEL=k3s`
  - managed-k8s overlays set `EVE_COMPUTE_MODEL` plus placement env vars

## Code Changes

### 1. Manifest schema

File: `packages/shared/src/schemas/manifest.ts`

- Add `ComputeClassSchema = z.enum(['small', 'medium', 'large', 'xlarge'])`.
- Add optional `compute_class` field under `ServiceXeveSchema`.

### 2. Shared compute resolver

New file: `packages/shared/src/deploy/app-compute-classes.ts`

- Export typed class names and K8s/Fargate mapping.
- Export helpers:
  - `resolveAppComputeClass(value?: unknown): AppComputeClass`
  - `getAppK8sResources(className: AppComputeClass): { requests; limits }`

Export it via `packages/shared/src/index.ts`.

### 3. Worker config

File: `packages/shared/src/config/schema.ts`

- Add:
  - `EVE_COMPUTE_MODEL: z.enum(['k3s', 'gke', 'eks', 'aks', 'ecs']).default('k3s')`
  - placement env vars listed above.

### 4. Deployer resource injection

File: `apps/worker/src/deployer/deployer.service.ts`

In `renderManifest()`:
- Read `compute_class` from resolved `x-eve`.
- Resolve to K8s resources via shared helper.
- Inject `resources` into each rendered container spec.

### 5. Deployer placement injection

File: `apps/worker/src/deployer/deployer.service.ts`

In pod template spec creation:
- Read `loadConfig()` once per render.
- If `EVE_COMPUTE_MODEL` is one of `gke|eks|aks`, conditionally inject
  selector/toleration based on placement env vars.

### 6. Job `resource_class` alignment (explicit non-change)

Files: `packages/shared/src/schemas/job.ts`, `apps/worker/src/invoke/invoke.service.ts`, `apps/worker/src/invoke/k8s-runner.ts`

Recommendation:
- Keep existing job class model (`job.c1`, `job.c2`, etc.) unchanged.
- Do not retarget job hints to app class names in this plan.
- Keep current runner sizing flow (resolved in `invoke.service.ts`, passed to
  `k8s-runner.ts`) unchanged.

## What Does Not Change

- No manifest version bump.
- No API or CLI surface change.
- No ECS runtime implementation in this phase.
- No billing/pricing semantic change for job `resource_class`.

## Implementation Order

### Phase 1 — Schema and shared mapping

1. Add `compute_class` to manifest schema.
2. Add shared app compute mapping module.
3. Add unit tests for resolver and mapping.
4. Checkpoint: manifest validation accepts valid classes and rejects invalid
   classes.

### Phase 2 — Deployer resources

5. Inject resolved `resources` into service containers in `renderManifest()`.
6. Add/extend worker tests for generated deployment YAML resources.
7. Checkpoint: rendered deployment includes expected requests/limits per class.

### Phase 3 — Managed Kubernetes placement contract

8. Add `EVE_COMPUTE_MODEL` + placement env vars to shared config schema.
9. Inject node selector/tolerations only for `gke|eks|aks` and only when configured.
10. Coordinate infra overlay env wiring.
11. Checkpoint: app pods schedule onto intended pool on managed Kubernetes.

### Phase 4 — Rollout validation

12. Staging deploy with mixed class services (`small`, `large`).
13. Verify scheduling and pod resources (`kubectl describe pod`).
14. Checkpoint: no regressions in existing deploy flows.

## Dependencies

| This plan needs | From |
|----------------|------|
| Managed-k8s app node pool labels/taints contract | `eve-horizon-infra` cloud overlays |
| Worker env injection for `EVE_COMPUTE_MODEL` and placement keys | `eve-horizon-infra` overlays |
| Manifest v2 service schema stability | `docs/plans/manifest-v2-compose-plan.md` |

| Other plans need | From this plan |
|-----------------|----------------|
| Managed-k8s app placement (GKE/EKS/AKS) | Compute classes + conditional placement injection |
| ECS support (future) | Defined class mapping ready for ECS translation |
| k3s safety | Explicit requests/limits to reduce overcommit risk |

## Risks and Mitigations

- **Unschedulable oversized classes on small clusters.**
  Mitigation: log class+requested resources clearly; do not silently downsize.

- **Capacity regressions from introducing requests.**
  Mitigation: conservative default (`small`) and staged rollout.

- **Infra/platform contract drift for placement keys.**
  Mitigation: env-driven contract in one place, documented in infra overlays.

- **Confusion between app compute classes and job resource classes.**
  Mitigation: keep namespaces distinct and document this explicitly.
