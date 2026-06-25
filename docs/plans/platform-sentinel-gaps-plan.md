# Platform Sentinel — Closing Remaining Gaps

> **Status**: Ready
> **Created**: 2026-03-30
> **Depends On**: [platform-sentinel-plan.md](./platform-sentinel-plan.md) (Complete)
> **Author**: Adam / Claude
> **Audit Basis**: Source-repo audit as of 2026-03-30. This document confirms gaps from code and manifests; it does not claim live staging verification.

## Context

Platform Sentinel shipped in `eve-horizon-2`, but the work is not fully closed. A repo audit shows the core implementation exists locally while the staging backport, integration coverage, manual verification, and public docs propagation remain incomplete.

### Confirmed in `eve-horizon-2`

- Watchdog implementation exists in `apps/orchestrator/src/cron/env-health-watchdog.service.ts`
- Notify + responder implementation exists in `apps/api/src/platform-notify/`
- Gateway routing for the sentinel channel exists in `apps/gateway/src/webhook/webhook.controller.ts`
- DB migration + query layer exist in `packages/db/migrations/00087_environment_health_checks.sql` and `packages/db/src/queries/environment-health.ts`
- System API + CLI surface exist in `apps/api/src/system/system.controller.ts` and `packages/cli/src/commands/system.ts`
- Local k8s manifests already include the orchestrator service account + RBAC in `k8s/base/orchestrator-rbac.yaml`, `k8s/base/kustomization.yaml`, and `k8s/base/orchestrator-deployment.yaml`
- Unit/spec coverage exists for the watchdog and notify/responder services in:
  - `apps/orchestrator/src/cron/env-health-watchdog.service.spec.ts`
  - `apps/api/src/platform-notify/platform-notify.service.spec.ts`
  - `apps/api/src/platform-notify/platform-responder.service.spec.ts`

### Confirmed missing or unverified

| Gap | Evidence |
|-----|----------|
| Infra repo missing orchestrator RBAC backport | `../deployment-instance/k8s/base/` has no `orchestrator-rbac.yaml`; base `kustomization.yaml` does not reference it |
| Infra repo orchestrator still runs without a dedicated service account | `../deployment-instance/k8s/base/orchestrator-deployment.yaml` has no `serviceAccountName` |
| Staging overlay does not enable the watchdog or inbound responder routing | `../deployment-instance/k8s/overlays/aws-eks/orchestrator-deployment-patch.yaml` lacks `EVE_ENV_HEALTH_*`; `gateway-deployment-patch.yaml` lacks `EVE_SENTINEL_CHANNEL_ID` |
| API integration coverage is missing | `apps/api/test/integration/sentinel.integration.test.ts` does not exist |
| Manual watchdog scenario is missing | `tests/manual/scenarios/33-sentinel-watchdog.md` does not exist, and `tests/manual/README.md` has no entry for it |
| Public docs propagation is incomplete | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/` documents org analytics env-health, but not `eve system env-health`, `/system/env-health`, sentinel notify/respond, or sentinel settings |
| Live staging behaviour is still unverified in this repo | No staging verification report has been captured for the sentinel rollout |

## What This Means

### What works today

- The core feature is implemented in the main repo: watchdog, circuit-breaker, notify path, responder path, system API, CLI, and local k8s RBAC
- Local code-level verification is reasonable because the unit/spec coverage is present

### What is still blocking closure

- Staging will not get the full feature until the infra repo picks up the RBAC + env-var changes
- The API surface is still missing integration coverage
- The manual test suite still has no watchdog scenario
- The public Eve docs skill still does not teach agents/operators how to use the sentinel features
- We do not yet have a staging verification artifact proving the end-to-end flow works

## Implementation

### Phase A: Infra Repo Backport

**Where**: `../deployment-instance/k8s/`

**Step A1**: Copy `orchestrator-rbac.yaml` into infra base

Copy `k8s/base/orchestrator-rbac.yaml` from `eve-horizon-2` to `../deployment-instance/k8s/base/orchestrator-rbac.yaml`.

**Step A2**: Add RBAC to infra base kustomization

Add `orchestrator-rbac.yaml` to `../deployment-instance/k8s/base/kustomization.yaml` near the existing `worker-rbac.yaml`.

**Step A3**: Add the orchestrator service account binding

Patch `../deployment-instance/k8s/base/orchestrator-deployment.yaml` to include:

```yaml
spec:
  template:
    spec:
      serviceAccountName: eve-orchestrator
```

**Step A4**: Enable the watchdog in the staging overlay

Patch `../deployment-instance/k8s/overlays/aws-eks/orchestrator-deployment-patch.yaml` to add the minimum required env vars:

```yaml
- name: EVE_ENV_HEALTH_ENABLED
  value: "true"
- name: EVE_ENV_HEALTH_STABLE_TICKS
  value: "3"
```

Notes:
- `EVE_ENV_HEALTH_CIRCUIT_BREAK_ENABLED=true` is optional because the code already defaults it to enabled
- `STABLE_TICKS=3` is a better staging default than the local default of `2` because it gives operators a longer window before scale-to-zero

**Step A5**: Add the gateway sentinel channel env var after the Slack channel exists

Patch `../deployment-instance/k8s/overlays/aws-eks/gateway-deployment-patch.yaml` with the real channel ID:

```yaml
- name: EVE_SENTINEL_CHANNEL_ID
  value: "<channel_id>"
```

Do not use a placeholder commit plus a second follow-up deploy if the channel can be created first. Create the Slack channel up front, then land the real value in the first infra change.

**Step A6**: Audit overlay drift

The repo still has both `k8s/overlays/aws-eks/` and `k8s/overlays/aws/`. If `aws/` is still a supported deployment path, mirror the sentinel env-var changes there as well. If it is dead, delete it in a separate cleanup to prevent the same drift from recurring.

### Phase B: Slack Channel + System Settings

**Ops steps**:

1. Create `#eve-horizon-notifications` in the the platform operator Slack workspace
2. Capture the channel ID
3. Confirm EveBot can post there
4. Find the active Slack integration ID:
   ```bash
   eve profile use staging
   eve org list --json
   eve integrations list --org <org_id> --json
   ```
5. Land the infra repo gateway env var with the real channel ID from Step 2
6. Deploy the infra changes
7. Configure system settings in this order:
   ```bash
   eve profile use staging
   eve system settings set sentinel.slack.integration_id <integration_id>
   eve system settings set sentinel.slack.channel_id <channel_id>
   eve system settings set sentinel.enabled true
   ```

Enable sentinel last. Setting `sentinel.enabled=true` before the Slack IDs exist only creates noisy no-op delivery attempts.

### Phase C: Integration Tests

**Where**: `apps/api/test/integration/sentinel.integration.test.ts`

Add a focused integration suite that covers:

| Test | What it verifies |
|------|------------------|
| Health check row round-trip | Seed/query `environment_health_checks` through the real DB layer |
| `GET /system/env-health` | Returns summary + rows, requires `system:read` |
| `GET /system/env-health` — unauthorized | Non-admin request returns 403 |
| `POST /internal/platform-notify` | Valid `x-eve-internal-token` is accepted |
| `POST /internal/platform-notify` — unauthorized | Missing/wrong token returns 401 |
| `POST /internal/platform-respond` | Known keywords return formatted markdown |
| `POST /internal/platform-respond` — unauthorized | Missing/wrong token returns 401 |
| Sentinel settings CRUD | `sentinel.enabled`, `sentinel.slack.integration_id`, `sentinel.slack.channel_id` can be stored and read |

Pattern:
- Reuse the authenticated HTTP client + DB helpers from the existing integration harness in `apps/api/test/integration/`
- Keep this suite API-focused; the watchdog loop itself is already covered by unit/spec tests in the orchestrator

### Phase D: Manual Test Scenario

**Where**: `tests/manual/scenarios/33-sentinel-watchdog.md`

Add a manual scenario that covers the local k3d verification loop from the original plan:

1. Prerequisites: healthy stack, test org/project/environment deployed
2. Healthy detection: wait for sentinel ticks and confirm `eve system env-health`
3. CrashLoopBackOff injection: create a failing deployment and verify detection
4. ImagePullBackOff injection: use a bad image and verify detection
5. Circuit-breaker: wait for stable ticks and verify scale-to-zero
6. Recovery: remove broken deployments and verify the environment returns to healthy
7. CLI verification: confirm the report and actions shown by `eve system env-health --json`
8. Cleanup: delete test deployments

Add an optional Slack appendix rather than making Slack a hard prerequisite for the whole scenario.

Also update `tests/manual/README.md` to register Scenario 33.

### Phase E: Public Docs Propagation

**Where**: `../eve-skillpacks/eve-work/eve-read-eve-docs/references/`

The current public docs cover org-level env-health analytics, but not the new platform-wide sentinel surface. Update at least:

- `references/cli.md`:
  - `eve system env-health`
  - sentinel-related `eve system settings set ...` examples
- `references/observability.md`:
  - platform-wide environment health monitoring
  - degraded/critical/circuit-breaker semantics
- `references/gateways.md`:
  - sentinel notification channel routing
  - responder keywords (`health`, `degraded`, `resources`, `help`)

Commit and push the `eve-skillpacks` repo separately after those updates land.

### Phase F: Staging Deploy + Verification

After Phases A-B are complete, deploy and verify from `../deployment-instance`.

Staging safety rules:
- Prefer `./bin/eve-infra ...` from `../deployment-instance`
- If direct `kubectl` is needed, always use:
  - `--kubeconfig config/kubeconfig.yaml`
  - `--context <explicit-eks-context>`

Verification checklist:

```text
[ ] Infra repo kustomize build includes orchestrator RBAC and serviceAccountName
[ ] Orchestrator logs show sentinel startup / tick messages
[ ] eve system env-health --json returns real staging data
[ ] Existing degraded envs are detected correctly
[ ] Slack notification arrives in #eve-horizon-notifications
[ ] Responder works in-channel for "health" and "degraded"
[ ] Recovery notification arrives after fixing a degraded env
[ ] Daily summary fires at 08:00 UTC
[ ] No repeated alert spam inside the 4h dedup window
```

Capture the results in a report under `docs/reports/` before declaring the rollout complete.

## Implementation Order

| Step | What | Depends On | Effort |
|------|------|------------|--------|
| A1-A3 | Infra base RBAC + serviceAccount backport | — | S |
| B1-B4 | Slack channel creation + integration/channel ID discovery | — | S (ops) |
| A4-A5 | Overlay env vars with real values | A1-A3, B1-B4 | XS |
| C | API integration tests | — | M |
| D | Manual scenario + README index | — | S |
| E | Public docs propagation to `eve-skillpacks` | — | S |
| F | Staging deploy + verification report | A, B | S (ops) |

Phases C-E can happen in parallel with the infra backport, but the work should not be considered fully closed until all six phases are done.

## Exit Criteria

Do not close this gap until all of the following are true:

- `../deployment-instance` contains the sentinel RBAC + service-account + env-var backport
- `apps/api/test/integration/sentinel.integration.test.ts` exists and passes
- `tests/manual/scenarios/33-sentinel-watchdog.md` exists and is indexed in `tests/manual/README.md`
- The public docs skill in `../eve-skillpacks/eve-work/eve-read-eve-docs/` documents the sentinel surface
- A staging verification report exists in `docs/reports/`

## Risk

| Risk | Mitigation |
|------|------------|
| Repo audit differs from live staging reality | Verify generated manifests and capture a staging report instead of assuming repo state equals cluster state |
| Overlay drift between `aws-eks` and `aws` | Patch both supported overlays or delete the dead one |
| Sentinel enabled before Slack config exists | Set integration/channel IDs first, enable sentinel last |
| Circuit-breaker scales an environment that someone is actively fixing | Start with `EVE_ENV_HEALTH_STABLE_TICKS=3` on staging and use `eve env suspend` during active repair windows |
| Public docs stay stale after rollout | Treat the `eve-skillpacks` update as an explicit phase with its own exit criterion |
