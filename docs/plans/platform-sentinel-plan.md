# Platform Sentinel — Environment Health Monitoring & Slack Notifications

> **Status**: Complete
> **Created**: 2026-03-27
> **Author**: Adam / Claude

## Problem

Deployed environments on Eve Horizon can enter terminal failure states — `ImagePullBackOff`, `CrashLoopBackOff`, unresolved env var interpolation — and nobody notices. Right now:

- **9 Canopy scraper pods** have been in `ImagePullBackOff` for 15 days (100,406 backoff events)
- **1 MTO test pod** has been in `CrashLoopBackOff` for 20 days (7,434 restarts)
- **3 MTO test pods** stuck in `ImagePullBackOff` for 20-28 days

All the detection infrastructure exists (`EnvDiagnosticsService` can identify every one of these issues) but it's purely on-demand — someone has to run `eve env diagnose` against every environment to find problems.

### 5 Whys

**Why are pods stuck in failure loops for weeks?**

1. K8s `restartPolicy: Always` means pods retry forever — there's no give-up threshold for Deployments
2. The platform applies Deployments but never checks back to see if they converged
3. There is no continuous health monitoring — `EnvDiagnosticsService` is only called on demand
4. There is no notification channel — even if we detected issues, there's nowhere to send alerts
5. **Root cause**: The platform has no watchdog loop, no circuit-breaker, and no notification system

## Solution: Platform Sentinel

A built-in platform capability — not a deployed app — that continuously monitors environment health, circuit-breaks terminal failures, and reports to a Slack channel.

### Design Principles

1. **Reuse patterns, not services** — `EnvDiagnosticsService` (in the API) has the K8s introspection patterns we need, but lives in a different process. The watchdog implements its own lightweight K8s health checking in the orchestrator, reusing the same `@kubernetes/client-node` patterns and label selectors — not calling across service boundaries. The gateway already supports proactive Slack posting (`chat:write.public` scope, optional `thread_ts`). System settings already exist. Wire them together.

2. **Platform-native, not app-native** — This is a core platform responsibility, like the runner reaper or cron scheduler. It lives in the orchestrator/API, not as a deployed app. It has system-level visibility by design, not via special permission grants.

3. **Slack-first notifications** — The EveBot is already installed in the the platform operator Slack workspace. We configure a `#eve-horizon-notifications` channel and the platform posts there. No email, no PagerDuty — Slack is where the team lives.

4. **Conversational when asked** — Beyond proactive alerts, the platform should respond to questions in the notification channel: "what's the health status?", "show me resource usage", "which environments are degraded?". This makes the notification channel a lightweight ops console.

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Orchestrator                          │
│                                                          │
│  ┌────────────────────────────────────┐                  │
│  │  EnvHealthWatchdogService (NEW)    │  cron: every 2m  │
│  │                                    │                  │
│  │  1. List active deployed envs (DB) │                  │
│  │  2. Diagnose each (K8s API)        │                  │
│  │  3. Classify health state          │                  │
│  │  4. Detect state transitions       │                  │
│  │  5. Circuit-break terminal pods    │                  │
│  │  6. Request notification on change │                  │
│  └──────────────┬─────────────────────┘                  │
│                 │ POST /internal/platform-notify          │
└─────────────────┼────────────────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────────────────┐
│                        API                                │
│                                                          │
│  ┌────────────────────────────────────┐                  │
│  │  PlatformNotifyService (NEW)       │                  │
│  │                                    │                  │
│  │  - Format Slack message            │                  │
│  │  - Resolve notification config     │                  │
│  │  - Dedup (don't re-alert < 4h)     │                  │
│  │  - POST to gateway delivery        │                  │
│  └──────────────┬─────────────────────┘                  │
│                 │                                         │
│  ┌──────────────▼─────────────────────┐                  │
│  │  PlatformResponderService (NEW)    │                  │
│  │                                    │                  │
│  │  Handles inbound messages in the   │                  │
│  │  notification channel:             │                  │
│  │  - "health" → env health report    │                  │
│  │  - "resources" → resource report   │                  │
│  │  - "status" → platform status      │                  │
│  └──────────────┬─────────────────────┘                  │
│                 │ POST /internal/deliver                 │
└─────────────────┼────────────────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────────────────┐
│                      Gateway                              │
│                                                          │
│  Existing delivery endpoint:                             │
│  POST /internal/deliver                                  │
│  { provider, account_id, channel_id, text }              │
│  → Slack chat.postMessage (no thread_ts = new post)      │
│                                                          │
│  Inbound routing enhancement:                            │
│  Messages in notification channel                        │
│  → route to API PlatformResponder (not agent harness)    │
└──────────────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│  Slack: #eve-horizon-notifications                       │
│                                                          │
│  EveBot: 🔴 Environment degraded                        │
│  example/canopy/staging — 9 pods ImagePullBackOff        │
│  Circuit-breaker activated: scaled scraper to 0 replicas │
│  → eve env diagnose proj_xxx staging                     │
│  → eve env deploy proj_xxx staging                       │
│                                                          │
│  You: @EveBot health                                     │
│  EveBot: Platform Health Report (3 nodes, 21 envs)       │
│  ✅ 17 healthy │ 🔴 3 degraded │ ⚫ 1 circuit-broken    │
│  ...                                                     │
└──────────────────────────────────────────────────────────┘
```

### Why Not a Deployed Eve App?

We considered making this an Eve app with elevated permissions. Rejected because:

- **Circular dependency** — An app that monitors the platform's health... runs on the platform. If the platform is unhealthy, the health monitor is also unhealthy.
- **Unnecessary complexity** — This needs DB access, K8s API access, and system-admin scope. An Eve app would need special permission grants for all of these. The orchestrator already has all of them.
- **Latency** — A deployed app would need to poll the API. The orchestrator can query K8s directly with sub-second latency.
- **Precedent** — The cron scheduler, suspension controller, and usage sweeper are all built-in orchestrator services. The runner reaper (in the worker) follows the same `OnModuleInit`/`setInterval` pattern. This is the same approach.

The platform should monitor itself. Apps should do app things.

## Implementation

### Phase 1: Detect — Environment Health Watchdog

**Where**: `apps/orchestrator/src/cron/env-health-watchdog.service.ts` (registered in existing `CronModule`)

**Prerequisites**:
- Add `@kubernetes/client-node` to `apps/orchestrator/package.json` — the orchestrator currently has no K8s client dependency
- **Create orchestrator RBAC** — the orchestrator deployment currently has no `serviceAccountName` (defaults to `default` SA with no permissions). Create `k8s/base/orchestrator-rbac.yaml` with:
  - `eve-orchestrator` ServiceAccount
  - ClusterRole with mostly-read access plus scale patch: `pods` (get, list), `deployments` (get, list, patch), `deployments/scale` (get, patch), `events` (list) — narrower than worker's broad write access
  - ClusterRoleBinding (cross-namespace: watchdog reads pods in `eve-{org}-{project}-{env}` namespaces, not just `eve`)
  - Add `serviceAccountName: eve-orchestrator` to `k8s/base/orchestrator-deployment.yaml`
- Initialize `CoreV1Api` and `AppsV1Api` via `KubeConfig.loadFromDefault()` (same pattern as `EnvDiagnosticsService` in the API and `RunnerReaperService` in the worker)
- Gracefully handle K8s unavailability — set `this.k8sAvailable = false` in constructor catch block, skip health checks when unavailable (log warning, don't crash)

**Pattern**: Follows `SuspensionControllerService` / `UsageSweeperService` in the orchestrator's `CronModule` — `OnModuleInit`, `CronJob`, env-var-configurable, safe wrapper. (Note: `RunnerReaperService` uses the same boot-time background pattern but lives in the worker, not the orchestrator.)

**Behaviour on each tick**:

1. Query DB with JOIN to get org/project slugs for reporting:
   ```sql
   SELECT e.*, p.slug as project_slug, o.slug as org_slug
   FROM environments e
   JOIN projects p ON e.project_id = p.id
   JOIN orgs o ON p.org_id = o.id
   WHERE e.status = 'active' AND e.namespace IS NOT NULL
   ```
2. For each environment, query K8s directly via `CoreV1Api.listNamespacedPod()` using label selector `eve.project_id={projectId},eve.env={envName}` — same selector pattern as `EnvDiagnosticsService`, but running in-process (not calling across to the API). Diagnose with bounded concurrency (`Promise.allSettled` with limit of 10 parallel K8s calls) to stay within the tick interval.
3. Classify each pod's containers into health buckets:

| Condition | Detection | Severity |
|-----------|-----------|----------|
| `ImagePullBackOff` | `container.reason === 'ImagePullBackOff'` | critical |
| `CrashLoopBackOff` | `container.reason === 'CrashLoopBackOff'` AND `restart_count > 20` | critical |
| High restarts | `restart_count > 5` within pod age < 1h | warning |
| Pending too long | `pod.phase === 'Pending'` AND age > 10 min | warning |

4. Write result to `environment_health_checks` table (upsert by `environment_id`)
5. Compare with previous check + issue signature — detect state transitions (healthy → degraded, degraded → healthy)
6. On transition: call API `POST /internal/platform-notify` with structured alert (`x-eve-internal-token` required)

**New DB migration**: `00087_environment_health_checks.sql`

```sql
CREATE TABLE environment_health_checks (
  environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  environment_slug TEXT NOT NULL,          -- org/project/env for reporting
  status TEXT NOT NULL DEFAULT 'healthy',  -- 'healthy' | 'degraded' | 'critical'
  issue_signature TEXT NOT NULL DEFAULT '', -- normalized hash of active issue types
  issues_json JSONB,                       -- [{type, pod, container, restarts, reason, since}]
  pod_count INTEGER NOT NULL DEFAULT 0,
  healthy_pod_count INTEGER NOT NULL DEFAULT 0,
  degraded_since TIMESTAMPTZ,              -- when this env first entered non-healthy state (null when healthy)
  consecutive_degraded_ticks INTEGER NOT NULL DEFAULT 0,  -- reset to 0 on recovery
  actions_taken_json JSONB,                -- [{type: 'scale_to_zero', deployment, at}]
  notified_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One latest check per environment (upsert pattern). No history table — event log + Slack channel are the audit trail.
CREATE INDEX idx_env_health_status ON environment_health_checks(status);
CREATE INDEX idx_env_health_checked_at ON environment_health_checks(checked_at);
```

Note: single row per environment (upsert on each check). No history table — the event log + Slack channel are the audit trail.

**Stable tick tracking**: `consecutive_degraded_ticks` increments on each tick where the environment is non-healthy, and resets to 0 when it recovers. `degraded_since` records when the degradation first started. The circuit-breaker only fires when `consecutive_degraded_ticks >= EVE_ENV_HEALTH_STABLE_TICKS` — this prevents acting on transient blips (e.g., a pod restarting during a rolling deploy).

**Configuration** (env vars on orchestrator):

```
EVE_ENV_HEALTH_ENABLED=true                        # kill switch
EVE_ENV_HEALTH_INTERVAL_MS=120000                  # 2 minutes
EVE_ENV_HEALTH_CIRCUIT_BREAK_ENABLED=true          # gate scale-to-zero behavior
EVE_ENV_HEALTH_CIRCUIT_BREAK_AFTER_RESTARTS=50     # scale to 0 after this many restarts
EVE_ENV_HEALTH_CIRCUIT_BREAK_AFTER_MS=1800000      # or after 30 min in failure state
EVE_ENV_HEALTH_STABLE_TICKS=2                      # require consecutive degrading checks before action
```

### Phase 2: Stop Looping — Circuit-Breaker

**Where**: Same `EnvHealthWatchdogService`

When a pod has been in a terminal failure state (`ImagePullBackOff` for > 30 min, or `CrashLoopBackOff` with > 50 restarts) and `consecutive_degraded_ticks >= EVE_ENV_HEALTH_STABLE_TICKS`:

1. **Scale the failing Deployment to 0 replicas** via K8s Apps API (`AppsV1Api.patchNamespacedDeploymentScale()`). Identify failing deployments by listing deployments in the namespace with `AppsV1Api.listNamespacedDeployment()`, then matching pod owner references back to their parent deployment — don't scale healthy deployments in the same namespace.
2. **Update `environments.deploy_status`** to `'failed'`
3. **Record action** in `actions_taken_json` on the health check row
4. **Request notification** with severity `circuit_broken`

This action is skipped when:
- `EVE_ENV_HEALTH_CIRCUIT_BREAK_ENABLED != true`
- Environment status is `'suspended'` (already frozen by the suspension controller)
- `consecutive_degraded_ticks < EVE_ENV_HEALTH_STABLE_TICKS` (hasn't been degraded long enough)

The Deployment is preserved (not deleted) so `eve env diagnose` still shows full context. A subsequent `eve env deploy` will redeploy normally.

### Phase 3: Notify — Slack via Gateway

**Where**: `apps/api/src/platform-notify/platform-notify.service.ts`

**Configuration** — stored as system settings (already have `PUT /system/settings/:key`):

| Setting Key | Example Value | Purpose |
|-------------|---------------|---------|
| `sentinel.slack.integration_id` | `int_xxx` | Which Slack workspace integration to use |
| `sentinel.slack.channel_id` | `C08XXXXXX` | The `#eve-horizon-notifications` channel ID |
| `sentinel.enabled` | `true` | Master enable/disable |
| `sentinel.quiet_hours` | `null` | Optional: suppress non-critical during hours (future) |

**Notification flow**:

1. Orchestrator calls `POST /internal/platform-notify` with:
   ```json
   {
     "severity": "critical",
     "type": "env.health.degraded",
     "environment": { "org_slug": "example", "project_slug": "canopy", "env_name": "staging" },
     "issues": [{ "type": "image_pull_backoff", "pod": "staging-scraper-xxx", "age": "15d" }],
     "actions_taken": [{ "type": "scale_to_zero", "deployment": "staging-scraper-xxx" }]
   }
   ```

2. `PlatformNotifyService` checks:
   - Is sentinel enabled? (system setting)
   - Was this environment already notified within the dedup window (4h)?
   - Is this request authorized (`x-eve-internal-token`)?
   - If not already notified and above checks pass, format and deliver.

3. Format as **markdown** (not Block Kit — the gateway's `formatAgentReply()` already converts markdown to Slack mrkdwn + Block Kit):
   ```
   🔴 Environment Degraded — example / canopy / staging

   9 pods in ImagePullBackOff for 15 days
   Image: registry.eve.example.com/scraper:latest

   ⚡ Circuit-breaker activated
   Scaled staging-scraper deployments to 0 replicas

   **Recovery:**
   - `eve env diagnose proj_xxx staging`
   - `eve env deploy proj_xxx staging --tag <working-tag>`
   ```

4. POST to gateway: `POST /internal/deliver` with:
   ```json
   {
     "provider": "slack",
     "account_id": "<team_id from integration>",
     "channel_id": "<from system setting>",
     "text": "<markdown message — gateway converts to Slack Block Kit>"
   }
   ```
   No `thread_id` — creates a top-level channel post.

**Notification types**:

| Event | Severity | When |
|-------|----------|------|
| `env.health.degraded` | warning | Environment transitions from healthy to degraded |
| `env.health.critical` | critical | ImagePullBackOff or CrashLoop detected |
| `env.health.circuit_broken` | critical | Circuit-breaker activated (pods scaled to 0) |
| `env.health.recovered` | info | Environment transitions back to healthy |
| `sentinel.startup` | info | Watchdog started (on orchestrator boot) |
| `sentinel.report` | info | Periodic daily summary (08:00 UTC) |

**Dedup rules**:
- Same environment + same issue type: suppress re-notification for 4 hours
- Recovery notifications: always send (good news shouldn't be suppressed)
- Circuit-breaker notifications: always send (this is an action taken, not just an observation)

### Phase 4: Respond — On-Demand Reports via Slack

**Where**: Gateway routing enhancement + `apps/api/src/platform-notify/platform-responder.service.ts`

**Concept**: When someone sends a message in the notification channel (or @mentions EveBot there), instead of routing to an org-scoped agent, the gateway recognises this as a "platform channel" and routes to a lightweight built-in responder.

**Gateway routing change** (in `apps/gateway/src/webhook/webhook.controller.ts`):

```
Inbound message from Slack
  ↓
Resolve integration → get org_id
  ↓
Is channel_id === EVE_SENTINEL_CHANNEL_ID env var?
  ├── YES → POST /internal/platform-respond { text, channel_id, thread_ts }
  │         (x-eve-internal-token auth)
  └── NO  → existing agent routing flow
```

This is a single `if` check before the existing routing — minimal gateway change.

**Note on sentinel channel ID**: The gateway doesn't have DB access to read system settings. The sentinel channel ID is configured as an env var (`EVE_SENTINEL_CHANNEL_ID`) on the gateway deployment. This is intentional — it's a deployment-time constant, not a runtime-configurable value. When the channel changes, update the gateway env var and restart. The alternative (gateway fetching from API) adds a network call to every inbound message hot path. The outbound system setting (`sentinel.slack.channel_id`) and inbound gateway env var must be kept in sync.

**PlatformResponderService** — lightweight keyword-based handler (no LLM, no harness):

| Trigger | Response |
|---------|----------|
| `health` or `status` | Full environment health report across all orgs |
| `resources` or `report` | Resource usage report (nodes, pods, capacity) |
| `degraded` or `issues` | List only degraded/critical environments |
| `help` or `cmds` | List available commands |
| Anything else | "I can help with: health, resources, degraded, help" |

**Response format** — structured Slack message posted as a thread reply:

```
📊 Platform Health Report — 2026-03-27 14:30 UTC

Infrastructure: 3 nodes (t3.large) • 5.8 vCPU / 21 GiB allocatable
Platform: v0.1.234 • 10 services running

Environments: 21 deployed
  ✅ 17 healthy
  🟡  1 warning (high restarts)
  🔴  2 critical (ImagePullBackOff)
  ⚫  1 circuit-broken

Degraded:
  example/canopy/staging — 9 pods ImagePullBackOff (15d)
  mto/dtest/test — CrashLoopBackOff (7,434 restarts)
  mto/dtest2/test — ImagePullBackOff (20d)

Orgs: 13 • Projects: 35 • App pods: 44
```

This is intentionally simple — keyword matching, no NLP, no LLM. It's an ops tool, not a chatbot. If we later want richer conversation, we can promote this to a real agent with a harness. For now, fast and reliable beats clever.

### Phase 5: CLI Surface

**New commands**:

```bash
# Full platform-wide health report (system_admin only)
eve system env-health

# Output:
# Environment Health Report (21 environments)
# ✅ healthy:  17
# 🟡 warning:   1
# 🔴 critical:  2
# ⚫ broken:    1
#
# CRITICAL:
#   example/canopy/staging   9 pods ImagePullBackOff (15d)
#   mto/dtest/test           CrashLoopBackOff (7,434 restarts)
# ...
```

```bash
# Configure sentinel notifications
eve system settings set sentinel.enabled true
eve system settings set sentinel.slack.integration_id int_xxx
eve system settings set sentinel.slack.channel_id C08XXXXXX
```

**New API endpoint**: `GET /system/env-health`
- Returns aggregated health status for all deployed environments
- Same data the Slack responder uses
- Requires `system:read` permission
- Supports optional `limit`/`offset` to avoid unbounded scans in large installs.

**Relationship to existing analytics**:
- Keep `GET /orgs/{org_id}/analytics/env-health` and `eve analytics env-health --org <org_id>` as the org-scoped summary view.
- Add `GET /system/env-health` and `eve system env-health` as the cross-org, system-admin view with issue details, actions taken, and circuit-break metadata.

## Implementation Order

| Step | What | Depends On | Effort |
|------|------|------------|--------|
| 0a | Add `@kubernetes/client-node` to orchestrator `package.json` | — | XS |
| 0b | Create `k8s/base/orchestrator-rbac.yaml` + add `serviceAccountName` to deployment | — | S |
| 1 | DB migration `00087`: `environment_health_checks` table | — | S |
| 2 | `EnvHealthWatchdogService` in orchestrator `CronModule` — detection + logging only | 0a, 0b, 1 | M |
| 3 | `GET /system/env-health` API endpoint | 1 | S |
| 4 | `eve system env-health` CLI command | 3 | S |
| 5 | Circuit-breaker: scale-to-0 on terminal failure | 2 | S |
| 6 | `PlatformNotifyService` — Slack delivery via gateway | — | M |
| 7 | Wire watchdog → notify on state transitions | 2, 6 | S |
| 8 | `PlatformResponderService` — keyword handler for Slack | 3, 6 | M |
| 9 | Gateway routing: `EVE_SENTINEL_CHANNEL_ID` env var + route to responder | 8 | S |
| 10 | Daily summary cron (08:00 UTC post to channel) | 6, 3 | S |

Steps 1-5 (detect + circuit-break) are independently valuable without Slack.
Steps 6-7 (proactive alerts) are independently valuable without the responder.
Steps 8-9 (on-demand reports) are the polish.

## Configuration Checklist (Ops)

Before enabling in staging:

1. Create `#eve-horizon-notifications` channel in the platform operator Slack
2. Invite EveBot to the channel (or rely on `chat:write.public` for public channels)
3. Get the channel ID (right-click channel → View channel details → copy ID at bottom)
4. Get the Slack integration ID for the the platform operator workspace with `eve integrations list --org <org_id>` (integrations are org-scoped today, so sentinel reuses the chosen org's active Slack integration)
5. Configure system settings (notification delivery):
   ```bash
   eve system settings set sentinel.enabled true
   eve system settings set sentinel.slack.integration_id <integration_id>
   eve system settings set sentinel.slack.channel_id <channel_id>
   ```
6. Configure gateway env var (inbound message routing for Phase 4):
   ```bash
   # In deployment-instance-repo kustomize overlay for gateway:
   EVE_SENTINEL_CHANNEL_ID=<channel_id>
   ```
7. Keep the API setting and gateway env var on the same channel ID
8. Test delivery with a direct `POST /internal/platform-notify` call until a dedicated `eve system notify --test` helper exists

## Immediate Cleanup (Pre-Implementation)

These stuck resources should be cleaned up now, before the watchdog exists. Run from `../deployment-instance` and only when `./bin/eh status` shows `Staging Owner: true`:

```bash
# Canopy: 9 scraper deployments with broken images
cd ../deployment-instance
kubectl --kubeconfig config/kubeconfig.yaml \
  --context <explicit-eks-context> \
  scale deployment -n eve-example-canopy-staging -l app=scraper --replicas=0

# MTO dtest: CrashLoopBackOff API pod
kubectl --kubeconfig config/kubeconfig.yaml \
  --context <explicit-eks-context> \
  scale deployment test-api-69d55879db -n eve-mto-dtest-test --replicas=0

# MTO dtest2: ImagePullBackOff pods
kubectl --kubeconfig config/kubeconfig.yaml \
  --context <explicit-eks-context> \
  scale deployment -n eve-mto-dtest2-test --all --replicas=0
```

Run only when you are the staging owner and after staging health checks pass.

## Implementation Notes

**Cross-service boundaries**: `EnvDiagnosticsService` lives in the API process (`apps/api/src/environments/`). The watchdog lives in the orchestrator. Rather than calling across service boundaries (which adds latency and a circular dependency), the watchdog implements its own K8s health checking using the same `@kubernetes/client-node` patterns and label selectors (`eve.project_id`, `eve.env`). The API's `EnvDiagnosticsService` remains for on-demand `eve env diagnose` CLI calls — these are complementary, not duplicated.

**Tick budget**: With 2-minute intervals and potentially 100+ environments, each health check must complete within ~1 second. The bounded concurrency (10 parallel) keeps total tick time under 20 seconds for 100 envs. If environments grow beyond this, increase the interval or add pagination (check 50 envs per tick, round-robin).

**K8s unavailability**: If the K8s API is unreachable (e.g., running outside the cluster, API server restart), the watchdog logs a warning and skips the tick — it does NOT mark environments as degraded based on inability to reach K8s. This prevents false alerts during control plane maintenance.

## Future Extensions (Not in Scope)

- **LLM-powered responder** — Promote the keyword handler to a real agent with a harness profile, so it can answer natural language ops questions. Only worth doing if keyword matching proves insufficient.
- **Per-org notification channels** — Let org admins configure their own Slack channel for alerts about their environments. Requires extending the notification config from system-level to org-level.
- **Auto-recovery policies** — Manifest-level annotations like `x-eve.health.auto-rollback: true` that tell the circuit-breaker to rollback instead of just scaling to zero.
- **Webhook subscriptions** — Wire health events into the existing webhooks service so external systems can subscribe to `env.health.*` events.
- **Quiet hours / escalation** — Suppress non-critical alerts during configurable hours; escalate critical alerts that aren't acknowledged.
- **Shared K8s health module** — Extract the pod/container health classification logic into `@eve/shared` so both the watchdog (orchestrator) and `EnvDiagnosticsService` (API) share one implementation. Not needed until the classification rules diverge or get complex enough to warrant dedup.

---

## Test Plan

### Unit Tests

**Where**: `apps/orchestrator/src/cron/env-health-watchdog.service.spec.ts`

**Framework**: Vitest (same as all orchestrator tests). Mock DB via `vi.fn()`, mock K8s client via `vi.fn()`.

| Test | What it verifies |
|------|-----------------|
| **Tick skips when disabled** | `EVE_ENV_HEALTH_ENABLED=false` → no DB query, no K8s call |
| **Tick skips when K8s unavailable** | `this.k8sAvailable = false` → logs warning, returns early |
| **Empty environments** | DB returns no active envs → no K8s calls, no writes |
| **Healthy environment** | All pods running, no waiting containers → status `healthy`, `consecutive_degraded_ticks = 0` |
| **ImagePullBackOff detection** | Container with `reason: 'ImagePullBackOff'` → status `critical` |
| **CrashLoopBackOff detection** | Container with `reason: 'CrashLoopBackOff'`, restarts > 20 → status `critical` |
| **CrashLoopBackOff below threshold** | Restarts = 5, age < 1h → status `warning` (not critical) |
| **Pending pod detection** | Pod phase `Pending`, age > 10 min → status `warning` |
| **State transition: healthy → degraded** | Previous check was `healthy`, new check is `degraded` → calls notify |
| **State transition: degraded → healthy** | Previous check was `degraded`, new check is `healthy` → calls notify (recovery), resets `consecutive_degraded_ticks` to 0, clears `degraded_since` |
| **Stable ticks: no premature action** | `consecutive_degraded_ticks = 1`, `EVE_ENV_HEALTH_STABLE_TICKS = 2` → no circuit-breaker |
| **Stable ticks: threshold reached** | `consecutive_degraded_ticks = 2` → circuit-breaker fires |
| **Circuit-breaker: scales correct deployment** | Failing pod's owner ref → matches deployment → scales only that deployment to 0 |
| **Circuit-breaker: skips suspended env** | Environment status `suspended` → no scale action |
| **Circuit-breaker: disabled** | `EVE_ENV_HEALTH_CIRCUIT_BREAK_ENABLED=false` → no scale action |
| **Issue signature change** | Same severity but different issue type → triggers re-notification |
| **Dedup: no re-notify within window** | `notified_at` < 4 hours ago, same signature → no notification |
| **Concurrent env diagnosis** | 15 environments → only 10 K8s calls in parallel (bounded concurrency) |
| **K8s API timeout on one env** | One env times out → others still checked, failed env logged |

**Mock structure**:

```typescript
const mockCoreApi = {
  listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
};
const mockAppsApi = {
  listNamespacedDeployment: vi.fn().mockResolvedValue({ items: [] }),
  patchNamespacedDeploymentScale: vi.fn().mockResolvedValue({}),
};
const mockDb = createMockDb(); // same pattern as managed-db-reconciler.service.spec.ts
```

### Unit Tests — PlatformNotifyService

**Where**: `apps/api/src/platform-notify/platform-notify.service.spec.ts`

| Test | What it verifies |
|------|-----------------|
| **Sentinel disabled** | System setting `sentinel.enabled = false` → returns early, no delivery |
| **Missing integration** | `sentinel.slack.integration_id` not set → logs error, returns |
| **Successful delivery** | Valid config → calls gateway `POST /internal/deliver` with markdown text |
| **Dedup: within window** | `notified_at` < 4h, same issue signature → no delivery |
| **Dedup: recovery bypasses** | Recovery event → always delivered regardless of `notified_at` |
| **Dedup: circuit-breaker bypasses** | Circuit-breaker event → always delivered |

### Unit Tests — PlatformResponderService

**Where**: `apps/api/src/platform-notify/platform-responder.service.spec.ts`

| Test | What it verifies |
|------|-----------------|
| **`health` keyword** | Returns full environment health report from DB |
| **`degraded` keyword** | Returns only non-healthy environments |
| **`help` keyword** | Returns available commands |
| **Unknown keyword** | Returns fallback "I can help with: ..." |
| **Empty health table** | Returns "No environments monitored yet" |

### Integration Tests

**Where**: `apps/api/test/integration/sentinel.integration.test.ts`

**Prerequisite**: Running stack (`./bin/eh test integration` or k3d) with migrations applied.

| Test | What it verifies |
|------|-----------------|
| **Health check table CRUD** | Insert, upsert, query by status — raw DB operations work |
| **`GET /system/env-health`** | Returns aggregated health report, requires `system:read` auth |
| **`POST /internal/platform-notify`** | Accepts structured alert, requires `x-eve-internal-token`, returns 200 |
| **`POST /internal/platform-notify` — unauthorized** | Missing/wrong internal token → 401 |
| **`POST /internal/platform-respond`** | Accepts keyword + channel, returns formatted response |
| **Settings CRUD for sentinel config** | `sentinel.enabled`, `sentinel.slack.*` keys can be set/read |

### Manual Verification Scenario

**Where**: `tests/manual/scenarios/31-sentinel-watchdog.md`

See [Verification Loop on k3d](#verification-loop-on-k3d) below.

---

## Verification Loop on k3d

A step-by-step verification that exercises the full sentinel pipeline on the local k3d stack. Run after implementing each phase to confirm it works end-to-end.

### Prerequisites

```bash
# 1. Stack must be running and healthy
./bin/eh status                    # k8s_owner: true, cluster running
eve system health --json           # {"status":"ok"}

# 2. Create a test org + project with a real deployed environment
ORG_ID=$(eve org ensure sentinel-test --slug sentinel-test --json | jq -r '.id')
PROJECT_ID=$(eve project ensure --org "$ORG_ID" --name "Sentinel Test" \
  --slug stest --repo-url https://github.com/eve-horizon/eve-horizon-starter --json | jq -r '.id')

# 3. Deploy the test environment (creates the K8s namespace)
eve env deploy "$PROJECT_ID" test --tag local

# 4. Confirm environment is active with a namespace
eve env show "$PROJECT_ID" test --json
# → status: "active", namespace: "eve-sentineltest-stest-test"

# 5. Confirm watchdog can see pods
kubectl -n eve-sentineltest-stest-test get pods
```

### Phase 1 Verification: Detection

```bash
# A. Confirm healthy detection
# Wait for 2 watchdog ticks (4 minutes), then:
eve system env-health --json
# → environment shows status: "healthy"

# B. Inject a CrashLoopBackOff pod into the test namespace
kubectl apply -n eve-sentineltest-stest-test -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sentinel-crashloop-test
  labels:
    eve.project_id: "$PROJECT_ID"
    eve.env: "test"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sentinel-crashloop-test
  template:
    metadata:
      labels:
        app: sentinel-crashloop-test
        eve.project_id: "$PROJECT_ID"
        eve.env: "test"
    spec:
      containers:
      - name: crasher
        image: busybox:1.36
        command: ["/bin/sh", "-c", "exit 1"]
EOF

# C. Wait for restarts to accumulate (2-3 minutes), then:
kubectl -n eve-sentineltest-stest-test get pods
# → sentinel-crashloop-test-xxx  0/1  CrashLoopBackOff  5  2m

# D. Wait for next watchdog tick, then check:
eve system env-health --json
# → environment shows status: "degraded" or "critical"
# → issues_json includes { type: "crash_loop_backoff", pod: "sentinel-crashloop-test-xxx" }
# → consecutive_degraded_ticks incrementing

# E. Inject an ImagePullBackOff pod
kubectl apply -n eve-sentineltest-stest-test -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sentinel-imagepull-test
  labels:
    eve.project_id: "$PROJECT_ID"
    eve.env: "test"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sentinel-imagepull-test
  template:
    metadata:
      labels:
        app: sentinel-imagepull-test
        eve.project_id: "$PROJECT_ID"
        eve.env: "test"
    spec:
      containers:
      - name: puller
        image: nonexistent-registry.invalid/no-such-image:v999
        imagePullPolicy: Always
EOF

# F. Verify detection after next tick:
eve system env-health --json
# → issues now include both CrashLoopBackOff AND ImagePullBackOff
```

### Phase 2 Verification: Circuit-Breaker

```bash
# A. Wait for consecutive_degraded_ticks >= EVE_ENV_HEALTH_STABLE_TICKS (default 2)
# Monitor via:
eve system env-health --json | jq '.environments[] | select(.environment_slug | contains("sentinel"))'

# B. Once threshold reached, confirm circuit-breaker fired:
kubectl -n eve-sentineltest-stest-test get deployments
# → sentinel-crashloop-test    0/0  (scaled to 0)
# → sentinel-imagepull-test    0/0  (scaled to 0)
# → The app's real deployment should NOT be scaled to 0 (healthy)

# C. Confirm deploy_status updated:
eve env show "$PROJECT_ID" test --json
# → deploy_status: "failed"

# D. Confirm actions_taken_json recorded:
eve system env-health --json | jq '.environments[] | .actions_taken'
# → [{ type: "scale_to_zero", deployment: "sentinel-crashloop-test", at: "..." }]
```

### Phase 3 Verification: Notifications

```bash
# A. Configure sentinel with a real Slack test workspace/channel
# Outbound delivery still uses the real Slack provider path; EVE_SIMULATE_ENABLED
# only affects eve chat simulate, not /internal/deliver.
eve integrations list --org "$ORG_ID" --json
# Pick an active Slack integration ID and a disposable test channel ID, then:
eve system settings set sentinel.enabled true
eve system settings set sentinel.slack.integration_id <integration_id>
eve system settings set sentinel.slack.channel_id C_TEST_CHANNEL

# Watch both the test Slack channel and gateway logs:
kubectl -n eve logs deployment/eve-gateway --tail=50 | grep deliver

# B. Test notification endpoint directly:
curl -s -X POST http://api.eve.lvh.me/internal/platform-notify \
  -H "Content-Type: application/json" \
  -H "x-eve-internal-token: $(kubectl -n eve get secret eve-app -o jsonpath='{.data.EVE_INTERNAL_API_KEY}' | base64 -d)" \
  -d '{
    "severity": "critical",
    "type": "env.health.critical",
    "environment": { "org_slug": "sentinel-test", "project_slug": "stest", "env_name": "test" },
    "issues": [{ "type": "crash_loop_backoff", "pod": "test-pod", "age": "5m" }],
    "actions_taken": []
  }'
# → 200 OK

# C. Trigger a recovery — delete the broken deployments:
kubectl -n eve-sentineltest-stest-test delete deployment sentinel-crashloop-test sentinel-imagepull-test

# D. Wait for next tick, then:
eve system env-health --json
# → status: "healthy", consecutive_degraded_ticks: 0
# → Gateway logs and the Slack test channel should show a recovery notification
```

### Phase 4 Verification: Slack Responder

```bash
# A. Test the responder endpoint directly (gateway would call this):
curl -s -X POST http://api.eve.lvh.me/internal/platform-respond \
  -H "Content-Type: application/json" \
  -H "x-eve-internal-token: $(kubectl -n eve get secret eve-app -o jsonpath='{.data.EVE_INTERNAL_API_KEY}' | base64 -d)" \
  -d '{ "text": "health", "channel_id": "C_TEST", "thread_ts": "1234.5678" }'
# → 200 with formatted health report

# B. Test each keyword:
for cmd in health degraded resources help unknown; do
  echo "=== $cmd ==="
  curl -s -X POST http://api.eve.lvh.me/internal/platform-respond \
    -H "Content-Type: application/json" \
    -H "x-eve-internal-token: ..." \
    -d "{\"text\": \"$cmd\", \"channel_id\": \"C_TEST\", \"thread_ts\": \"1234\"}"
  echo
done
```

### Cleanup

```bash
# Remove test deployments (if not already cleaned up)
kubectl -n eve-sentineltest-stest-test delete deployment sentinel-crashloop-test sentinel-imagepull-test 2>/dev/null

# Optionally remove test project
eve project delete "$PROJECT_ID" --confirm
```

---

## k3d vs Staging: Gap Analysis

The local k3d stack cannot fully replicate staging. These gaps must be tested on staging after k3d verification passes.

### Gaps That Cannot Be Reproduced on k3d

| Gap | Why k3d Differs | Staging Behavior | Mitigation |
|-----|----------------|-----------------|------------|
| **Orchestrator RBAC** | k3d's `default` SA has no K8s permissions. **Must create `orchestrator-rbac.yaml` as a prerequisite** (Step 0b). Without this, the watchdog silently fails to query K8s on k3d too. | Staging overlay must also include the new RBAC manifests. | Create RBAC in base manifests so both environments get it. |
| **ImagePullBackOff (organic)** | k3d uses `imagePullPolicy: IfNotPresent` with pre-imported images — registry pulls never happen. ImagePullBackOff is impossible for normal app pods. | Staging pulls from GHCR/eve-native registry. Credential expiry, missing tags, or registry outages cause real ImagePullBackOff. | Inject synthetic ImagePullBackOff in k3d using `imagePullPolicy: Always` + nonexistent registry (see verification loop). Staging: verified organically. |
| **Multi-node scheduling** | k3d is single-node. Pods always schedule immediately. `Pending` due to resource exhaustion or affinity conflicts cannot occur. | Staging is multi-node, multi-AZ. Pods can be `Pending` due to insufficient capacity, node taints, or PVC AZ mismatch. | Unit test the `Pending` detection logic with mock pod data. Staging: wait for organic scheduling delays or create a pod with impossible `nodeSelector`. |
| **PVC AZ affinity** | k3d uses `local-path` storage. PVCs bind instantly on the single node. | Staging uses EBS (AZ-locked). PVC can be `Pending` if no node is available in the PV's AZ. | Not a launch blocker — `Pending` pods are detected as `warning` severity regardless of cause. |
| **Real Slack delivery** | k3d can still deliver to real Slack if you configure a valid integration; `EVE_SIMULATE_ENABLED` only affects `eve chat simulate`, not gateway outbound delivery. | Gateway delivers to real Slack workspace. | k3d: use a disposable test workspace/channel or skip this as a manual step and rely on unit/integration tests. Staging: verify actual Slack channel receives the message. |
| **Control plane maintenance** | k3d's API server never goes down during normal operation. | EKS control plane can be temporarily unavailable during upgrades. | Unit test the `k8sAvailable = false` path. Staging: test by temporarily scaling down the orchestrator during an EKS upgrade window (rare, manual). |
| **Transient K8s API errors** | k3d API responses are instant and reliable (local network). | Staging K8s API can have network timeouts, rate limiting, or 5xx errors. | Unit test error handling for K8s API failures. Add per-environment timeout (5s) with `AbortController` to prevent one slow call from blocking the tick. |
| **Scale (100+ environments)** | k3d typically has 0-5 app environments. | Staging may have 50+ active environments across many orgs. | Unit test bounded concurrency with 100 mock environments. Staging: monitor tick duration after deploy. |

### Gaps That CAN Be Reproduced on k3d

| Scenario | How to reproduce | Notes |
|----------|-----------------|-------|
| CrashLoopBackOff | `busybox` + `exit 1` deployment (see verification loop) | Restarts accumulate quickly (~20 in 2 min) |
| ImagePullBackOff | `imagePullPolicy: Always` + nonexistent registry | Enters backoff within seconds |
| Healthy → degraded transition | Inject broken pod, wait for tick | Tests state transition + notification |
| Degraded → healthy recovery | Delete broken pod, wait for tick | Tests recovery notification + tick counter reset |
| Circuit-breaker fires | Wait for stable ticks threshold | Tests scale-to-zero + deploy_status update |
| Notification delivery attempt | Configure sentinel settings with a real Slack test integration, trigger alert | Verify gateway log and test Slack channel |
| Responder keywords | Call `/internal/platform-respond` directly | All keywords testable |
| CLI `eve system env-health` | Call after watchdog has run | Verifies API endpoint + CLI formatting |
| Dedup suppression | Trigger same alert twice within 4h | Second should be suppressed |
| Multiple envs, partial failure | Deploy 2 envs, break only one | Verifies per-env isolation |

### Staging Verification Checklist (Post-k3d)

After k3d verification passes and the feature is deployed to staging:

```
[ ] 0. Confirm staging ownership first
       ./bin/eh status
       # Must show: Staging Owner: true

[ ] 1. Watchdog starts on orchestrator boot (check logs)
       kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml \
         --context <explicit-eks-context> -n eve \
         logs deployment/eve-orchestrator --tail=100 | grep -i sentinel

[ ] 2. Existing degraded environments detected automatically
       eve system env-health --json
       # Should detect the Canopy/MTO pods already in failure (if not cleaned up)

[ ] 3. Circuit-breaker fires on long-degraded environments
       # Canopy scrapers (15d in ImagePullBackOff) should be scaled to 0

[ ] 4. Real Slack notification arrives in #eve-horizon-notifications
       # Check channel for alert messages

[ ] 5. Recovery notification after fix
       eve env deploy <canopy-project> staging --tag <working-tag>
       # Wait for tick → should see recovery notification in Slack

[ ] 6. Responder works via Slack
       # In #eve-horizon-notifications, type "@EveBot health"
       # Should get threaded reply with health report

[ ] 7. Daily summary fires at 08:00 UTC
       # Check channel next morning

[ ] 8. Dedup: no spam
       # After initial alert, no re-alert for 4 hours (same env+issue)
       # Check channel is not flooded

[ ] 9. Performance: tick completes in time
       kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml \
         --context <explicit-eks-context> -n eve \
         logs deployment/eve-orchestrator --tail=200 | grep "health tick"
       # Should complete in < 30s for all environments
```

### Risk: What Could Go Wrong on Staging That Worked on k3d

1. **RBAC missing in staging overlay** — If `orchestrator-rbac.yaml` is added to `k8s/base/` but the staging kustomize overlay in `deployment-instance-repo` doesn't include it, the SA won't exist in staging. **Mitigation**: The RBAC goes in base manifests; kustomization.yaml in base must reference it; verify infra repo's staging overlay includes the base.

2. **K8s API rate limiting** — With 50+ environments, 50 `listNamespacedPod` calls every 2 minutes could hit K8s API rate limits on EKS. **Mitigation**: Bounded concurrency (10 parallel) + monitor API server metrics after deploy. If needed, increase tick interval to 5 minutes.

3. **Gateway formatting mismatch** — The gateway's `formatAgentReply()` is designed for agent chat messages, not sentinel alerts. Sentinel messages use markdown with emojis — the formatter might strip or mangle them. **Mitigation**: Test on staging with a real Slack delivery; if formatting is wrong, add a `raw: true` flag to the delivery payload to bypass `formatAgentReply()`.

4. **Notify endpoint missing from staging deploy** — New `POST /internal/platform-notify` and `POST /internal/platform-respond` endpoints need to be available after deploy. If the API image doesn't include the new code (stale tag), endpoints return 404. **Mitigation**: Verify with `curl` after deploy before enabling the watchdog.

5. **Circuit-breaker scales an in-use deployment** — A deployment that's been in CrashLoopBackOff for 20 days is clearly abandoned, but a deployment that just entered CrashLoopBackOff might be a botched deploy that someone is actively fixing. The stable ticks threshold (default 2 = 4 minutes) provides some protection, but it's short. **Mitigation**: Start with `EVE_ENV_HEALTH_STABLE_TICKS=3` (6 minutes) on staging and increase if needed. The circuit-breaker skip for `suspended` environments also helps — operators can `eve env suspend` to prevent circuit-breaking during active work.
