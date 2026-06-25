# Platform Agents: System Health, Remediation, Infrastructure, DNS & Cost Management

> Status: Plan
> Created: 2026-02-09
> Last Updated: 2026-02-10 (added DNS integration — platform subdomains + custom domains)
>
> Dependencies:
> - Agents/Teams/Threads primitives (already implemented)
> - Agent runtime (already implemented)
> - Skills infrastructure (already implemented)
> - Agent packs system (already implemented — see `eve-software-factory` for reference)
> - Resource Management v2 (Phases 0-8) — billing, pricing, receipts, balances, usage metering (now implemented)
>
> Architecture references:
> - `docs/ideas/platform-resource-plane.md` (Part 3: Self-Managing Platform)
> - `docs/plans/resource-management-v2.md` (cost tracking architecture)
> - `docs/system/agents.md` (agent design)
> - `docs/system/agent-runtime.md` (runtime architecture)
> - `../eve-software-factory/` (agent pack reference implementation)

## Thesis

Eve already runs agents that do software engineering work. The platform itself should be managed by agents that do infrastructure work. This plan delivers **six platform agents** across two tiers — running as real Eve agents, dogfooding the platform's own primitives.

**Tier 1 (Foundations)**: System Health + Auto-Remediation — detect problems, apply known fixes.

**Tier 2 (Infrastructure & Cost)**: Infra Provisioner, Cluster Scaler, Cost Optimizer, Capacity Planner — manage cloud resources, control costs, and keep the platform right-sized.

These agents are not monitoring dashboards. They watch, diagnose, decide, and act. They reduce human toil by handling the repetitive operational patterns that eat operator time.

## Goals

1. **System Health Agent**: Periodic health checks — stuck jobs, failing workers, resource exhaustion, queue depth anomalies, budget breaches. Produces diagnostic reports and alerts.
2. **Auto-Remediation Agent**: Reacts to failure events — safely cancels/requeues work and creates replacement jobs following explicit playbooks. Escalates unknown patterns.
3. **Infra Provisioner Agent**: Reacts to resource demand signals — provisions cloud resources (K8s nodes, PVCs, databases) and manages DNS (platform subdomains, custom domain validation, TLS certificates) following declarative runbooks. Validates before applying.
4. **Cluster Scaler Agent**: Monitors K8s cluster utilization and scales node pools up/down based on workload pressure, budget constraints, and time-of-day patterns.
5. **Cost Optimizer Agent**: Analyzes spend data, identifies waste (idle environments, oversized resource classes, underutilized PVCs), and recommends or executes cost reductions.
6. **Capacity Planner Agent**: Analyzes usage trends, projects growth, and produces provisioning recommendations — weekly reports that feed into operator and provisioner decisions.
7. **DNS Integration**: Platform-managed subdomains (`<app>.<project>.<org>.eve.example.com`) via wildcard DNS + cert-manager, and custom domain support with DNS validation, TLS provisioning, and ingress routing.
8. **Cron + schedules hardening**: Make cron emission HA-safe (atomic dedupe) and schedules useful (`payload_json` merge) so platform agents can be triggered reliably.
8. **System-scoped agent model**: Agents that operate across org boundaries with elevated permissions, isolated from tenant agents.
9. **Skills as playbooks**: Operational knowledge packaged as skills — version-controlled, reviewable, improvable.

## Non-Goals

- Agent self-improvement loop (PR updates to playbooks) — aspirational, not in this plan.
- Platform admin UI for agent management — CLI first.
- Multi-cloud provisioning (AWS + GCP + Azure) — start with the current cloud provider only.
- Full FinOps dashboards — agents produce reports; dashboards are a separate concern.

## Current Reality

### What Exists

**Agent Infrastructure:**
- **Agent model**: Project-scoped agents with slug, role, workflow, harness_profile, policies, access. Stored in `agents` table and synced from `agents.yaml`.
- **Agent packs**: The pack system (`pack.yaml` + `agents.yaml` + `teams.yaml` + `skills/`) is implemented. `eve agents sync` resolves packs, merges configs, and syncs to the API. SHA-pinned, cached, deterministic. See `eve-software-factory` for the reference implementation.
- **Agent runtime**: Org-scoped warm pods (StatefulSet) with shard-based routing. Heartbeat mechanism. Handles `/invoke` with `HarnessInvocation` payloads.
- **Skills**: OpenSkills SKILL.md format. Loaded from `.agents/skills/` at runtime. Mature infrastructure.
- **Agent CLI** (`eve-agent-cli`): Proxy CLI wrapping harness binaries (mclaude, zai, codex, etc.) with structured JSONL event streaming, LLM call telemetry, and permission control.

**Event & Trigger System:**
- **Event spine + router**: Events are stored in Postgres (`events`). Orchestrator `EventRouterService` claims `pending` events and triggers pipelines/workflows by matching manifest `trigger` blocks.
- **Cron triggers (implemented)**: Orchestrator `CronSchedulerService` registers manifest cron triggers at startup and emits `cron.tick` events with payload `{ schedule, trigger_name }` and a dedupe key.
- **Schedules table (implemented, but basic)**: The `schedules` table exists (migration `00032`) and is registered by the orchestrator at startup; ticks emit events of `schedule.event_type` with payload `{ schedule, schedule_id }` (currently does **not** merge `payload_json`).
- **System failure events (already emitted)**: Orchestrator emits `system.job.failed` and `system.pipeline.failed` into the event spine.

**Resource Management & Billing (NEW — just landed):**
- **Execution receipts v2**: Every completed job attempt gets a receipt with full breakdown — LLM tokens (by model/provider, byok vs managed), compute (vcpu-seconds, memory-gib-seconds), timing phases (queue wait, orchestrator, runner, workspace, secrets, hooks, harness), and cost (base USD + billed in org currency with FX + markup).
- **Balance ledger**: Per-org prepaid credit system. `org_balances` table with `balance`, `lifetime_in`, `lifetime_out`. Immutable `balance_transactions` audit trail (credit, charge, refund, adjustment). Receipts auto-charge balances on attempt completion.
- **Pricing rate cards**: Immutable versioned rate cards (`pricing_rate_cards`) with time-based effective lookup. Default card covers LLM tokens (managed + byok rates by provider) and compute rates by resource class.
- **Exchange rates**: `exchange_rates` table with multi-source snapshots. FX updater cron service fetches BTC/sats (coingecko, 5-min) and fiat (ECB, daily).
- **Usage metering**: Usage sweeper cron service scans K8s namespaces for non-job resources (pods, PVCs), writes `usage_records`, and creates balance charges. Runs every 5 minutes.
- **Budget enforcement**: Per-job `max_cost` limits (terminates attempt on breach). Per-org `hard_cap_amount` (blocks job admission). Environment suspension when budget exhausted.
- **Environment lifecycle**: `environments.status` column (`active` | `suspended` | `terminated`). Suspension controller cron service evaluates org budgets every 2 minutes.
- **Managed models**: Platform-hosted LLM inference via GMI Cloud (deepseek-r1, llama-3.3-70b, kimi-k2). Model availability is controlled in `system_settings["managed_model_availability"]` and resolved in `InferenceService`.
- **Resource classes**: Named compute profiles (`job.c1`: 1 vCPU/2 GiB, `job.c2`: 2 vCPU/4 GiB) with K8s resource requests/limits. Configurable via `system_settings["resource_classes"]`.
- **K8s namespace hardening**: Generates ResourceQuota, LimitRange, and NetworkPolicy manifests per namespace. Configurable defaults (4 CPU, 8Gi memory, 10 PVCs, 50Gi storage). Default-deny network policy with explicit allow rules.
- **Spend aggregation**: Per-project and per-org spend rollups. Top-jobs-by-cost breakdown. Multi-attempt comparison with receipt inclusion.

**CLI for Platform Agents (NEW — just landed):**
- `eve admin balance show/credit/transactions <org>` — balance management
- `eve admin receipts recompute --since 7d [--dry-run]` — receipt recomputation
- `eve admin usage list/summary --org <org>` — usage records
- `eve admin pricing seed-defaults` — initialize rate cards
- `eve org spend <org> --since 7d` — org-level spend
- `eve project spend <project> --since 7d` — project-level spend with top jobs
- `eve job receipt <id>` — view billing receipt
- `eve job diagnose <id>` — comprehensive job troubleshooting
- `eve job compare <id> <a> <b> --receipt` — compare attempts
- `eve env suspend/resume/diagnose/health/services/logs` — environment lifecycle
- `eve models list` — discover available models
- `eve system status/pods/logs/events/jobs` — platform status (existing)

### What's Missing

- **System project + platform agents**: No `eve-platform/platform-ops` bootstrap and no standard "platform ops" agent pack wired into a system project.
- **Cross-project routing for platform agents**: Triggers are evaluated against the *event's* `project_id`. A central system project will not see tenant-project events unless we add event fan-out/global routing, or we make the agents poll.
- **Job-token access to `/system/*`**: `SystemController` enforces `org_admin/system_admin` roles and currently blocks job tokens even if they have `system:read`.
- **Controlled elevation for system agents**: Worker-minted job tokens are currently minted with a fixed permission set. We need an allowlisted escalation path for system agents (and guardrails to prevent tenant jobs from minting elevated tokens).
- **Agent-targeted automation**: No manifest-native way to say "this cron/system trigger should create a job assigned to agent X" (workflows currently create jobs with `assignee = null`).
- **Job-token access to `/admin/*`**: Admin endpoints (balance, usage, receipts, pricing) require system_admin role. Platform agents need allowlisted access.
- **Budget/spend events**: Budget breaches and suspension events are logged but not emitted to the event spine. Cost optimizer and capacity planner need these signals.
- **Cloud provider integration**: No API/CLI for K8s node pool scaling, cloud resource provisioning, or infrastructure-as-code execution.
- **HA hardening**: Cron emission is per-process; dedupe is best-effort (check-then-insert) and can still race without a DB uniqueness constraint.

---

## Phase 0: Harden Cron + Schedules

**Goal**: Make time-based activation reliable, HA-safe, and useful for platform agents. The CronSchedulerService and schedules table already exist — this phase hardens them for production use.

### Current State (Implemented)

Orchestrator already includes a cron scheduler (`apps/orchestrator/src/cron/cron-scheduler.service.ts`, wired via `CronModule`) that registers two kinds of timers at startup:

1. **Manifest cron triggers**: scans latest manifests for `pipelines.*.trigger.cron.schedule` and `workflows.*.trigger.cron.schedule`, registers in-memory cron jobs, and emits `cron.tick` events with payload `{ schedule, trigger_name }`.
2. **DB schedules**: loads enabled rows from `schedules` and registers in-memory cron jobs that emit events of `schedule.event_type`.

The `schedules` table (migration `00032_add_agent_runtime_primitives.sql`) is:

```sql
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Gaps

1. **HA/idempotency**: each orchestrator replica will emit cron events; `eventQueries.create` dedupe is best-effort (check-then-insert) without a DB uniqueness constraint.
2. **Schedule payload passthrough**: schedule ticks currently ignore `schedules.payload_json`, so schedules cannot easily drive manifest cron triggers (missing `trigger_name`).
3. **Reload behavior**: cron jobs are registered only at orchestrator startup; manifest changes and new schedules require restart (or a reload hook).
4. **Validation/guardrails**: schedule creation should enforce minimum interval (>= 1 minute) and validate cron syntax.

### Implementation

1. **Make event dedupe atomic**. The current index is non-unique on `(dedupe_key)` only (migration `00014`). Add a partial unique index on `(project_id, dedupe_key) WHERE dedupe_key IS NOT NULL`, and update `eventQueries.create` (currently check-then-insert in `packages/db/src/queries/events.ts`) to use `INSERT ... ON CONFLICT` so concurrent schedulers cannot double-insert.
2. **Merge `payload_json` for schedule ticks**. In `CronSchedulerService.handleScheduleTick`, build `payload_json` as `{ schedule: schedule.cron, schedule_id: schedule.id, ...schedule.payload_json }`. This lets schedule rows drive manifest cron triggers by setting `event_type: cron.tick` and `payload_json.trigger_name: <workflow-or-pipeline-name>`.
3. **Decide reload strategy** (pick one for MVP). MVP: document “restart orchestrator after manifest sync / schedule changes”. Better: add an internal “reload cron” hook that diffs and updates registered jobs.
4. **Add schedule validation** in API. Validate cron syntax, reject schedules more frequent than once per minute, and (optionally) add a `timezone` column; current implementation uses UTC.

**Tests**:
- Integration: manifest cron trigger emits `cron.tick` and routes to a workflow.
- Integration: schedule row with `event_type=cron.tick` + `payload.trigger_name` routes to workflow.
- Concurrency: two scheduler instances do not create duplicate events (unique index enforced).

---

## Phase 1: System Org/Project + System Agent Execution Model

**Goal**: Create a real “platform ops” project that can run agents on a schedule and (eventually) react to platform events safely.

### 1) System Org and Project

Create (idempotently) a dedicated system org + project:

```
org: eve-platform
  project: platform-ops
```

Implementation options:

1. **Preferred**: Add an admin API + CLI command, e.g. `eve admin bootstrap-platform`, that creates the org/project if missing (system_admin only).
2. **Alternative**: Piggyback on `bootstrapAdmin` (only if you are confident bootstrap runs on every deploy/migration path).

### 2) Mark System Projects

Add flags so the platform can distinguish “system” from tenant scope.

**DB migration** (`00042_add_system_org_project_scope.sql`):

Note: `00005_add_system_scope.sql` already exists (adds `'system'` to secrets scope enum) — this migration is for org/project-level system flags. Migrations 00037-00041 are taken by the resource management v2 stack.

```sql
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
```

### 3) System Agent Job Tokens (Permissions + Guardrails)

**Current behavior**:

- The worker mints a per-job token via `POST /internal/auth/mint-job-token` and writes it to `~/.eve/credentials.json` inside the harness HOME, so the agent can run `eve` CLI commands during job execution.
- The worker currently requests a fixed permission set (jobs/threads/envdb/secrets/builds/pipelines read/write).

**Needed changes**:

1. Allow the worker to request a different permission set for **system agents** (at minimum: `system:read` and `jobs:admin`; optionally `events:write`).
2. Add server-side allowlisting: the internal minting endpoint (`apps/api/src/auth/auth.internal.controller.ts`) currently accepts any permissions without validation. Add a check: reject elevated permission requests (`system:*`, `jobs:admin`) unless the job's project is system (`projects.is_system = true`).
3. **Cross-project access for remediation**: The auto-remediation agent needs to create replacement jobs and cancel jobs in *tenant* projects, not just the system project. System agent tokens must be allowed to call `POST /projects/{tenant_project_id}/jobs` and `POST /projects/{tenant_project_id}/jobs/{id}/cancel`. This requires either: (a) a special `jobs:admin:cross_project` permission that bypasses project scoping, or (b) system project tokens are implicitly allowed cross-project access on allowlisted endpoints. Option (b) is simpler and mirrors how `is_system` works elsewhere.
4. Recommended hardening (may be separate plan): enforce project scoping for job tokens on job/project/org endpoints, and make system projects the explicit escape hatch.

### 4) Make `/system/*` and `/admin/*` Usable From Job Tokens

Today, `/system/*` endpoints require `RequirePermission('system:read')` but `SystemController.extractUser()` (`apps/api/src/system/system.controller.ts`) also enforces `org_admin` or `system_admin` roles via a `ForbiddenException` — this blocks job tokens which have permissions but no roles. Update `extractUser()` so job tokens that carry `system:read` permission bypass the role check.

Similarly, the new `/admin/*` endpoints (balance, usage, receipts, pricing) require system_admin role. Platform agents (especially cost optimizer and capacity planner) need read access to these. Add a `billing:read` permission that system agent tokens can carry, and update admin controllers to accept it alongside the role check.

Add a `domains:manage` permission for the infra provisioner to create/verify/delete domain records and configure ingress routing. System agent tokens for infra provisioner carry `domains:manage`; other system agents do not.

### 5) Agent-Targeted Automation (Workflows Need `assignee`)

To run the **configured** agents (skills + roles) from cron/system triggers, workflows need a way to create jobs assigned to a specific agent id.

Add an optional field on workflow definitions:

```yaml
workflows:
  system-health-check:
    assignee: system_health
```

Update `WorkflowsService.invoke()` (`apps/api/src/workflows/workflows.service.ts`, line 129) to set `job.assignee = definition.assignee` when present (currently hardcoded `null`). The job claiming path (`claimNextAssignedJob` in `packages/db/src/queries/jobs.ts`) already exists and filters for `assignee IS NOT NULL` + `execution_type = 'agent'`, so no changes needed on the claiming side.

Also add optional workflow fields to make the created job self-describing (currently hardcoded at lines 123-124 as `[Workflow] ${name}` / `Workflow invocation: ${name}`):

```yaml
workflows:
  system-health-check:
    title: "System Health Check"
    description: "Run the system-health skill and emit a report."
```

Update `WorkflowsService.invoke()` to use these overrides when present (fallback stays `[Workflow] ${name}` / `Workflow invocation: ${name}`).

**Tests**:
- Integration: workflow with `assignee` produces a job with that `assignee` and gets claimed via `claimNextAssignedJob`.
- Integration: system agent job token can call `eve system status` (job token path).
- Unit/integration: internal mint-job-token allowlist rejects elevated perms for non-system projects.

---

## Phase 2: System Signals (Events + Routing)

**Goal**: Make platform failures observable and triggerable by platform agents using the existing event spine and workflow triggers.

### 1) Start With What Already Exists

Already emitted by the orchestrator (and documented in `docs/system/events.md`):

- `system.job.failed`
  - `payload_json`: `{ job_id, attempt_id, run_id, step_name, execution_type, action_type, error_message, error_code, exit_code }`
  - `dedupe_key`: `job_failed:{job_id}:{attempt_id}`
- `system.pipeline.failed`
  - `payload_json`: `{ run_id, pipeline_name, env_name, git_sha, error_message, error_code }`
  - `dedupe_key`: `pipeline_failed:{run_id}`

These events are sufficient to trigger the first remediation workflows; avoid inventing a large new event taxonomy up front.

### 2) Solve Cross-Project Routing (Required for Event-Driven Remediation)

Problem: trigger matching loads the manifest for `event.project_id`. A central `eve-platform/platform-ops` project will not see tenant-project failure events unless we change routing.

**Recommended MVP**: *fan-out* a small allowlist of `source=system` failure events into the system project.

Fan-out rules:
- If the event’s project is a tenant project, create a second event row in the system project with the same `type` and `source`.
- Copy payload and add origin metadata: `origin_project_id`, `origin_org_id`, `origin_event_id`.
- Use a distinct dedupe namespace, e.g. `dedupe_key: fanout:{dedupe_key}`.
- If the origin project is already `is_system=true`, do not fan-out (prevents loops).

Implementation:
1. Resolve the system project id (cached) by `(org.slug='eve-platform', project.slug='platform-ops')` or by a system setting written at bootstrap.
2. In `emitJobFailureEvent` and `emitPipelineFailureEvent`, after writing the origin event, also write the fan-out event when the system project exists.
3. Reuse Phase 0’s atomic dedupe (`UNIQUE (project_id, dedupe_key)`) so fan-out remains HA-safe.

**Manifest trigger reminder**: `trigger.system.event` expects the suffix (e.g. `job.failed`), not the full `system.job.failed`.

### 3) Agent-Emitted Events (Required for Rate Limiting + Escalation)

The agents themselves emit events into the system project via `eve event emit`:

- `system.health.degraded` — emitted by System Health agent when overall status is degraded.
- `system.health.critical` — emitted by System Health agent when overall status is critical.
- `system.remediation.executed` — emitted by Auto-Remediation agent after each action (used for rate-limit tracking and audit trail). Payload: `{ origin_job_id, origin_project_id, playbook, action_taken }`.

These don't require platform code changes — the `eve event emit` CLI command already supports arbitrary event types.

### 4) Optional: Additional Platform-Emitted System Events (Defer)

Add new orchestrator-emitted system events only when platform agents need them (prefer polling first):

- `system.job.stuck` (sweep + dedupe window)
- `system.queue.backlog`
- `system.worker.unhealthy`
- `system.agent_runtime.unhealthy`

**Tests**:
- Integration: tenant `system.job.failed` inserts a second event in the system project with origin fields.
- Integration: a system-project workflow with `trigger.system.event: job.failed` runs from the fan-out event.
- Integration: dedupe prevents duplicates under concurrent orchestrators.

---

## Phase 3: Platform Ops Agent Pack

**Goal**: Package system-health and auto-remediation agents as a standard agent pack — same pattern as `eve-software-factory`.

### Pack Structure

New repo: `eve-platform-ops` (or a directory in the monorepo — deployment choice).

```
eve-platform-ops/
├── eve/
│   ├── pack.yaml               # Pack descriptor
│   ├── agents.yaml             # All platform agents
│   ├── teams.yaml              # Platform ops teams
│   ├── chat.yaml               # chat routes (optional)
│   └── x-eve.yaml              # harness profiles + defaults
├── skills/
│   ├── system-health/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── health-checks.md
│   │       ├── diagnostic-format.md
│   │       └── escalation-policy.md
│   ├── auto-remediation/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── playbooks/
│   │       │   ├── oom-killed.md
│   │       │   ├── budget-exceeded.md
│   │       │   ├── job-failed.md
│   │       │   ├── pipeline-failed.md
│   │       │   ├── stuck-job.md
│   │       │   ├── crashloop.md
│   │       │   ├── workspace-full.md
│   │       │   ├── timeout-exceeded.md
│   │       │   └── env-suspended.md
│   │       ├── safety-rails.md
│   │       └── escalation.md
│   ├── infra-provisioner/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── runbooks/
│   │       │   ├── add-k8s-node.md
│   │       │   ├── provision-pvc.md
│   │       │   ├── provision-database.md
│   │       │   ├── configure-platform-dns.md
│   │       │   ├── configure-custom-dns.md
│   │       │   └── provision-tls-cert.md
│   │       ├── cloud-providers.md
│   │       ├── dns-providers.md
│   │       └── safety-rails.md
│   ├── cluster-scaler/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── scaling-policies.md
│   │       ├── cooldown-rules.md
│   │       └── cost-bounds.md
│   ├── cost-optimizer/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── waste-patterns.md
│   │       ├── optimization-actions.md
│   │       └── safety-rails.md
│   └── capacity-planner/
│       ├── SKILL.md
│       └── references/
│           ├── trend-analysis.md
│           ├── report-format.md
│           └── growth-models.md
└── README.md
```

### pack.yaml

```yaml
version: 1
id: platform-ops
imports:
  agents: eve/agents.yaml
  teams: eve/teams.yaml
  chat: eve/chat.yaml
  x_eve: eve/x-eve.yaml
```

### agents.yaml

The `skill` field is required by `AgentEntrySchema` (`packages/shared/src/schemas/agent-config.ts:30`) and maps the agent to a skill directory in the pack's `skills/` folder. It's stored in the parsed YAML (in `project_agent_configs.parsed_agents`) but NOT as a separate column in the `agents` table — the pack resolver uses it at sync time to discover skill paths.

```yaml
version: 1
agents:
  # --- Tier 1: Foundations ---

  system_health:
    slug: system-health
    skill: system-health
    harness_profile: system-runner
    description: >
      Periodic health checks across the platform. Detects stuck jobs,
      failing workers, queue depth anomalies, resource exhaustion,
      budget breaches, and environment health issues.
      Produces diagnostic reports and alerts operators.
    role: >
      You are a platform health monitor. Your job is to detect problems
      early and produce clear, actionable diagnostic reports. Be specific
      about what's wrong and what should be done. Do not take remediation
      actions yourself — that's the auto-remediation agent's job.
    workflow: assistant
    policies:
      permission_policy: never    # Read-only — never edits code

  auto_remediation:
    slug: auto-remediation
    skill: auto-remediation
    harness_profile: system-runner
    description: >
      Reacts to system failure events and applies known fixes.
      Follows explicit playbooks — never improvises. Escalates
      unknown patterns to operators.
    role: >
      You are the auto-remediation agent. When activated by a failure event,
      match the failure against known playbooks and execute the prescribed fix.
      Never improvise — if no playbook matches, escalate to operators.
      Always log what you did and why.
    workflow: assistant
    policies:
      permission_policy: auto_edit   # Can take action (cancel/recreate jobs, etc.)

  # --- Tier 2: Infrastructure & Cost Management ---

  infra_provisioner:
    slug: infra-provisioner
    skill: infra-provisioner
    harness_profile: system-runner
    description: >
      Provisions cloud infrastructure in response to demand signals.
      Adds K8s nodes, creates PVCs, provisions databases, configures DNS.
      Follows declarative runbooks — validates before applying.
    role: >
      You are the infrastructure provisioner. When triggered by a resource
      demand signal or operator request, follow the matching runbook exactly.
      Always validate the current state before making changes. Dry-run first
      when the runbook requires it. Log every action for audit.
      Never provision resources outside the declared budget envelope.
    workflow: assistant
    policies:
      permission_policy: auto_edit   # Executes infrastructure commands

  cluster_scaler:
    slug: cluster-scaler
    skill: cluster-scaler
    harness_profile: system-runner
    description: >
      Monitors K8s cluster utilization and scales node pools up or down.
      Respects budget constraints, cooldown periods, and minimum capacity.
      Produces scaling decision logs.
    role: >
      You are the cluster scaler. Analyze current node utilization, pending
      pod pressure, and budget constraints. Decide whether to scale up,
      scale down, or hold. Follow scaling policies strictly — never scale
      below minimum capacity, never exceed budget bounds, always respect
      cooldown periods between scaling actions.
    workflow: assistant
    policies:
      permission_policy: auto_edit   # Executes scaling commands

  cost_optimizer:
    slug: cost-optimizer
    skill: cost-optimizer
    harness_profile: system-runner
    description: >
      Analyzes spend data across orgs and projects. Identifies waste —
      idle environments, oversized resource classes, underutilized PVCs,
      stale managed model usage. Recommends or executes cost reductions.
    role: >
      You are the cost optimizer. Query spend data, usage records, and
      environment status. Identify waste patterns from references/waste-patterns.md.
      For safe optimizations (e.g., suspending idle environments), execute
      directly. For impactful changes (e.g., downsizing resource classes),
      produce recommendations and escalate to operators.
    workflow: assistant
    policies:
      permission_policy: auto_edit   # Can suspend environments, adjust settings

  capacity_planner:
    slug: capacity-planner
    skill: capacity-planner
    harness_profile: system-runner
    description: >
      Analyzes usage trends over time. Projects growth for compute, storage,
      and LLM token consumption. Produces weekly capacity reports with
      provisioning recommendations.
    role: >
      You are the capacity planner. Query historical usage records, spend
      aggregations, and resource utilization. Identify trends (growth,
      seasonal patterns, anomalies). Produce a structured report with
      specific provisioning recommendations and projected costs.
      Do not take action — your output feeds operator decisions
      and the infra provisioner's demand signals.
    workflow: assistant
    policies:
      permission_policy: never    # Read-only — analysis and reports only
```

### teams.yaml

```yaml
version: 1
teams:
  platform_ops:
    lead: system_health
    members: [auto_remediation]
    dispatch:
      mode: relay                  # Health check → remediation (sequential)

  infra_ops:
    lead: capacity_planner
    members: [cluster_scaler, infra_provisioner]
    dispatch:
      mode: relay                  # Plan → scale → provision (sequential)

  cost_ops:
    lead: cost_optimizer
    members: [capacity_planner]
    dispatch:
      mode: relay                  # Optimize → plan (sequential)
```

**Note on team vs. workflow triggers**: Teams are for *manual/on-demand* runs — e.g., an operator saying "check health and fix what you find" or "optimize costs and plan capacity" in a single operation. The primary production activation path uses **independent workflows** (Phase 4/5 manifest): health runs on cron, remediation fires on system events, cost optimizer runs weekly, etc. Both patterns coexist: team definitions enable ad-hoc combined runs, while per-workflow triggers handle the automated steady-state.

### x-eve.yaml

```yaml
agents:
  profiles:
    system-runner:
      - harness: claude
        model: opus-4.5
        reasoning_effort: low      # Health checks are structured, not creative
      - harness: codex
        model: gpt-5.2-codex
        reasoning_effort: medium

  defaults:
    harness: claude
    harness_profile: system-runner
    git:
      commit: never
      push: never                  # Platform agents don't push code
```

### System Health Skill (skills/system-health/SKILL.md)

```markdown
---
name: system-health
description: Platform health monitoring and diagnostics
---

# System Health Monitoring

You are the System Health agent. Run these checks and produce a diagnostic report.

## Checks (in order)

### 0. Core Service Status
Query: `eve system status --json`
Action: Record API/orchestrator/worker health and queue counts.

### 1. Pod Health (Crashloops / Restarts)
Query: `eve system pods --json`
Action: Flag any non-ready pods, CrashLoopBackOff, or high restart counts.

### 2. Recent Failure Signals (System Project Inbox)
Query: `eve event list --type system.job.failed --limit 50 --json`
Query: `eve event list --type system.pipeline.failed --limit 50 --json`
Action: Filter to the last 5 minutes (by `created_at`) and group by `payload.error_code`.

Note: Phase 2 fan-out is required for tenant failures to appear in the system project.

### 3. Budget & Spend Health
Query: `eve admin balance show <org_id> --json` (for each active org)
Query: `eve org spend <org_id> --since 1h --json`
Action: Flag orgs approaching hard_cap (balance < 20% of lifetime_in). Flag orgs with spend acceleration (hourly rate > 2x daily average). Flag suspended environments.

### 4. Long-Running / Stuck Jobs (Best-Effort)
Query: `eve system jobs --phase active --limit 200 --json`
Action: Identify candidates running >30 minutes (use timestamps as a coarse signal), then run `eve job diagnose <job_id>` for the top offenders.

### 5. Resource Utilization (Environment Health)
Query: `eve admin usage summary --org <org_id> --since 1h --json` (for each active org)
Query: `eve env health <project_id> <env_name>` (for active environments)
Action: Flag environments with high resource utilization. Flag environments with many restarts or unhealthy pods.

### 6. DNS & TLS Health
Query: `eve admin domains list --json`
Action: For each active domain:
- Check TLS cert expiry — flag if < 14 days remaining.
- Check DNS resolution — flag if the domain doesn't resolve to the platform ingress IP.
- Check pending validations — flag custom domains stuck in `pending_validation` for > 24 hours.
- Flag any `error` status domains with the error reason.

### 7. Logs (Only if degraded/critical)
Query: `eve system logs orchestrator --tail 200`
Query: `eve system logs worker --tail 200`
Action: Include the smallest relevant excerpts (never secrets) and a suggested next action.

## Report Format

See references/diagnostic-format.md for the full JSON schema.

## Escalation

- **healthy**: No action needed. Log report.
- **degraded**: Log report + emit `system.health.degraded` (e.g., `eve event emit --type system.health.degraded --source system --payload '{...}'`).
- **critical**: Log report + emit `system.health.critical` + notify operators (chat route or out-of-band paging).

See references/escalation-policy.md for notification channels and thresholds.
```

### Auto-Remediation Skill (skills/auto-remediation/SKILL.md)

```markdown
---
name: auto-remediation
description: Automated remediation for known platform failure patterns
---

# Auto-Remediation

You are the auto-remediation agent. When you receive a failure event,
follow this decision process:

## Step 1: Classify the Failure

Read the triggering event payload. Classify it:

| Pattern | Indicators | Playbook |
|---------|-----------|----------|
| OOM Killed | `event_type=system.job.failed` and (`exit_code=137` or error contains "OOMKilled") | oom-killed.md |
| Budget Exceeded | `event_type=system.job.failed` and error contains "BUDGET_EXCEEDED" | budget-exceeded.md |
| Job Failed | `event_type=system.job.failed` (non-OOM, non-budget) | job-failed.md |
| Pipeline Failed | `event_type=system.pipeline.failed` | pipeline-failed.md |
| Stuck Job | Health report flags a job as stuck (or future `system.job.stuck`) | stuck-job.md |
| CrashLoop | Repeated failures on same job/pipeline within 1 hour | crashloop.md |
| Workspace Full | error contains "No space left on device" | workspace-full.md |
| Timeout | error contains timeout indicators (or future `system.job.timeout`) | timeout-exceeded.md |
| Env Suspended | Health report flags suspended environments | env-suspended.md |
| Unknown | None of the above | → Escalate |

## Step 2: Execute Playbook

Load the matching playbook from references/playbooks/ and follow it exactly.

## Step 3: Log Decision

Always produce a remediation log (see references/safety-rails.md for format and limits).

## Safety Rails

- Max 2 replacement runs per origin job
- Max 10 auto-remediations per hour (across all jobs)
- Never recreate work for a job that was manually cancelled
- Never change org-level settings without operator approval
- If same job fails 3 times with same pattern, escalate — stop auto-recreating work

### Rate-Limit Tracking

Each remediation job invocation is ephemeral — the agent has no persistent memory.
To enforce rate limits, the agent MUST query recent history at the start of each run:

1. **Per-origin-job limit**: `eve job list --project <origin_project_id> --labels remediation:<origin_job_id> --limit 5 --json` — count replacement jobs tagged with the origin.
2. **Hourly global limit**: `eve event list --type system.remediation.executed --limit 20 --json` — count remediation events emitted in the last hour.

The agent emits a `system.remediation.executed` event (via `eve event emit`) after each successful remediation action. This event serves as both the audit trail and the rate-limit counter.

See references/safety-rails.md for full details.
```

### System CLI Commands (for agent use)

Use existing CLI-first primitives (once Phase 1 enables job tokens for `/system/*` and `/admin/*`):

```bash
# Platform status / k8s visibility (via API)
eve system status --json
eve system pods --json
eve system logs orchestrator --tail 200
eve system logs worker --tail 200
eve system events --limit 50 --json

# Cross-project job view (admin)
eve system jobs --phase active --limit 200 --json

# Event inbox (system project)
eve event list --type system.job.failed --limit 50 --json
eve event list --type system.pipeline.failed --limit 50 --json

# Budget & spend (admin — requires billing:read permission)
eve admin balance show <org_id> --json
eve admin balance transactions <org_id> --since 1h --json
eve org spend <org_id> --since 1h --json
eve project spend <project_id> --since 1h --json
eve admin usage summary --org <org_id> --since 1h --json

# Environment health
eve env health <project_id> <env_name>
eve env diagnose <project_id> <env_name>
eve env services <project_id> <env_name>
eve env suspend <project_id> <env_name> --reason "..."
eve env resume <project_id> <env_name>

# Job receipts & cost analysis
eve job receipt <job_id> --json
eve job compare <job_id> <attempt_a> <attempt_b> --receipt

# Model discovery
eve models list --json

# DNS / domain management
eve domain list --project <project_id> --json               # List all domains for a project
eve domain add --project <project_id> --env <env> --type platform --json  # Auto-assign platform subdomain
eve domain add --project <project_id> --env <env> --type custom --hostname app.example.com --json  # Register custom domain
eve domain verify <domain_id> --json                        # Check DNS validation status
eve domain status <domain_id> --json                        # TLS cert status, ingress health
eve domain remove <domain_id>                               # Remove domain + clean up ingress/cert
eve admin domains list --json                               # All domains across all projects (admin)
eve admin domains pending --json                            # Domains awaiting DNS validation

# Deep dives / actions
eve job diagnose <job-id>
eve job cancel <job-id> --reason "Stuck >30 min, no activity"
eve job create --project <origin_project_id> --description "Replacement for <job-id>: ..." --priority 0
```

Notes:
- `eve event list` is per-project; Phase 2 fan-out makes the system project the single failure inbox.
- There is no first-class "retry job" endpoint today; retries are modeled as replacement jobs.
- **Cross-project access**: `eve job create --project <origin_project_id>` and `eve job cancel` target tenant projects from the system project context. This requires Phase 1 cross-project token permissions (item 3).
- **Admin access**: `eve admin balance/usage` and `eve org/project spend` require Phase 1 `billing:read` permission on system agent tokens.

**Tests**:
- Unit: System health skill with fixture data produces correct report.
- Unit: Auto-remediation playbook matching with known failure patterns.
- Integration: Cron fires → system health workflow invoked → job assigned to `system_health`.
- Integration: Tenant `system.job.failed` → fan-out into system project (Phase 2) → remediation workflow invoked → job assigned to `auto_remediation`.
- Integration: Rate limit exceeded → remediation skipped with log.
- Integration: Unknown failure pattern → escalation, no action taken.

---

## Phase 4: System Project + Pack Installation

**Goal**: Wire the system project to consume the platform-ops pack via the standard `eve agents sync` flow.

### System Project Manifest

The system project's `.eve/manifest.yaml` declares the pack and wires workflow triggers:

```yaml
x-eve:
  packs:
    - source: eve-platform-ops      # GitHub shorthand (or local path)
      ref: <40-char-sha>            # SHA-pinned

workflows:
  system-health-check:
    title: "System Health Check"
    description: "Run the system-health skill and emit a report."
    assignee: system_health
    trigger:
      cron:
        schedule: "*/5 * * * *"
    hints:
      timeout_seconds: 120
      # Note: If the previous health check is still running when the next cron fires,
      # a new job is created (no built-in singleton guard). The 120s timeout prevents
      # accumulation. For hardening, consider adding a dedupe_key on the workflow to
      # skip creation if an active job with the same assignee exists.

  remediate-job-failed:
    title: "Auto-Remediate: Job Failed"
    description: "Follow auto-remediation playbooks for a job failure."
    assignee: auto_remediation
    trigger:
      system:
        event: job.failed           # Matches event type "system.job.failed"

  remediate-pipeline-failed:
    title: "Auto-Remediate: Pipeline Failed"
    description: "Follow auto-remediation playbooks for a pipeline failure."
    assignee: auto_remediation
    trigger:
      system:
        event: pipeline.failed      # Matches event type "system.pipeline.failed"

  remediate-health-degraded:
    title: "Auto-Remediate: Health Degraded"
    description: "Respond to degraded health report events."
    assignee: auto_remediation
    trigger:
      system:
        event: health.degraded      # Matches event type "system.health.degraded"

  # --- Tier 2 workflows (Phase 5) ---
  # These are defined here for completeness but only activate after Phase 5 skills are written.

  cost-optimization-sweep:
    title: "Cost Optimization Sweep"
    description: "Analyze spend data and identify waste across all orgs."
    assignee: cost_optimizer
    trigger:
      cron:
        schedule: "0 6 * * 1"      # Weekly Monday 06:00 UTC
    hints:
      timeout_seconds: 300

  capacity-planning-report:
    title: "Weekly Capacity Report"
    description: "Analyze usage trends and produce provisioning recommendations."
    assignee: capacity_planner
    trigger:
      cron:
        schedule: "0 7 * * 1"      # Weekly Monday 07:00 UTC (after cost sweep)
    hints:
      timeout_seconds: 300

  cluster-scaling-check:
    title: "Cluster Scaling Check"
    description: "Evaluate node utilization and decide whether to scale."
    assignee: cluster_scaler
    trigger:
      cron:
        schedule: "*/15 * * * *"   # Every 15 minutes
    hints:
      timeout_seconds: 120

  provision-on-demand:
    title: "Provision Resources on Demand"
    description: "Respond to resource demand signals from capacity planner or operators."
    assignee: infra_provisioner
    trigger:
      system:
        event: resource.requested   # Matches "system.resource.requested"
    hints:
      timeout_seconds: 600

  provision-domain:
    title: "Provision Domain"
    description: "Validate DNS, provision TLS certificate, and configure ingress for a custom domain."
    assignee: infra_provisioner
    trigger:
      system:
        event: domain.requested     # Matches "system.domain.requested"
    hints:
      timeout_seconds: 300
```

Notes:
- For `trigger.system.event`, do **not** include the `system.` prefix.
- `remediate-job-failed` requires Phase 2 fan-out (or global routing) to get tenant failures into the system project.
- Tier 2 workflows activate after Phase 5 skills are authored. They can be commented out until then.

### Installation Flow

Standard pack flow — no special logic:

```bash
# During deploy (or manually)
eve project sync --project platform-ops --dir <repo-dir>
eve agents sync --project platform-ops --ref <sha> --repo-dir <repo-dir>
```

This:
1. Syncs the system project manifest to the API (so cron/system triggers are evaluated by the orchestrator).
2. Resolves the `eve-platform-ops` pack from source + ref.
3. Loads agents, teams, chat routes, and x-eve config from the pack.
4. Discovers skills in `skills/` (system-health, auto-remediation, infra-provisioner, cluster-scaler, cost-optimizer, capacity-planner).
5. Merges pack config with any project-level overrides.
6. Validates (slug uniqueness, team references, etc.).
7. Writes lockfile (`.eve/packs.lock.yaml`) used by job workspaces to install pack skills.
8. POSTs effective config to the API (`/projects/{id}/agents/sync`).

**Elevation comes from the project, not the pack**: The same `eve-platform-ops` pack installed in a normal project gets normal job tokens. Installed in the system project (`projects.is_system = true`), the worker is allowed to mint job tokens with `system:read` / `jobs:admin` / `billing:read` (Phase 1 allowlist). The pack itself stays generic.

### Deploy Integration

Add pack sync to the deploy workflow after bootstrap + migrations:

```yaml
# In deploy-staging.yml
- name: Bootstrap platform project
  run: |
    eve admin bootstrap-platform    # (to be implemented) creates org/project + marks as system

- name: Sync platform-ops manifest + agents
  run: |
    eve project sync --project platform-ops --dir <repo-dir>
    eve agents sync --project platform-ops --ref ${{ github.sha }} --repo-dir <repo-dir>
```

### Agent Runtime for System Agents

System agents run in the same agent runtime infrastructure under the `eve-platform` org's runtime pods. The agent runtime is already org-scoped, so this works naturally:

- System org gets its own StatefulSet pod(s).
- Resource allocation is configurable via system settings.
- For initial deployment, a single pod with capacity 2-3 is sufficient.

**Cold-start consideration**: The system health agent runs every 5 minutes. If the `eve-platform` org's agent runtime has no warm pods (e.g., after a deploy or scale-to-zero), each invocation pays a cold-start penalty. For MVP, accept this. For production, ensure the system org's StatefulSet has `replicas: 1` as a minimum (never scales to zero). Alternatively, if the health check runs as an ephemeral job (not agent runtime), cold start is the worker spinning up a runner pod — which is the normal job execution path.

### Monitoring the Monitor

The system health agent should not be the only thing watching itself. Add a simple liveness check:

```yaml
# In deploy-staging.yml or a k8s CronJob
- name: Platform agent liveness
  run: |
    # Check that system-health ran in the last 10 minutes
    LAST_RUN=$(eve job list --project platform-ops --assignee system_health --limit 1 --json | jq -r '.jobs[0].created_at')
    # Use date -d on Linux (GNU coreutils); GitHub Actions runners are Linux
    AGE_SECONDS=$(( $(date +%s) - $(date -d "$LAST_RUN" +%s) ))
    if [ "$AGE_SECONDS" -gt 600 ]; then
      echo "::warning::System health agent hasn't run in ${AGE_SECONDS}s"
      exit 1
    fi
```

Note: This uses `date -d` (GNU coreutils, Linux-only). On macOS use `date -jf '%Y-%m-%dT%H:%M:%S' "$LAST_RUN" +%s`. GitHub Actions runners are Linux, so this works in CI.

---

## Design Decisions

### Why an agent pack and not bespoke deployment?

The agent pack system (`pack.yaml` + `agents.yaml` + `skills/`) already solves agent packaging, versioning, and installation. The `eve-software-factory` repo proves the pattern works. Using it for platform agents means:

- **No special deployment logic**. `eve agents sync` handles resolution, merge, validation, and API sync. No custom kustomize jobs or deployment scripts.
- **SHA-pinned reproducibility**. The pack ref is a git SHA. Every deploy gets the exact same agents + skills. No drift.
- **Separation of concerns**. Platform code (Phases 0-2: cron, system scope, events) is in the main repo. Operational knowledge (Phase 3: skills, playbooks, agent config) is in the pack repo. Different cadences, different reviewers.
- **Reusability**. The same pack can be installed in any system project — different clusters, different deployments. The elevation comes from `is_system` on the project, not from the pack.
- **Standard tooling**. `eve packs status`, lockfile, cache — all work out of the box.

### Why real Eve agents and not conventional services?

Three reasons:

1. **Dogfooding**: If our own platform agents can't run reliably as Eve agents, we have a product problem. Finding and fixing these issues makes the platform better for everyone.

2. **Skill-based knowledge**: Remediation playbooks as skills are version-controlled, human-readable, and improvable. A conventional service would encode this knowledge in compiled code — harder to review, harder to update, harder to extend.

3. **Composability**: Platform agents use the same primitives as tenant agents — jobs, events, triggers, threads. No separate monitoring stack to maintain. The auto-remediation agent can create child jobs, post to chat, and use the same CLI as any other agent.

### Why six agents instead of one or two?

Each agent has a distinct permission profile and responsibility boundary:

| Agent | Reads | Writes | Risk Level |
|-------|-------|--------|------------|
| System Health | Everything incl. DNS/cert status | Nothing (read-only) | None |
| Capacity Planner | Usage, spend, metrics | Nothing (reports only) | None |
| Auto-Remediation | Events, jobs | Cancel/create jobs | Medium |
| Cost Optimizer | Spend, usage, envs | Suspend environments, adjust settings | Medium |
| Cluster Scaler | Node metrics, budgets | Scale node pools | High |
| Infra Provisioner | Demand signals, domain requests | Provision cloud resources, DNS, TLS certs | High |

Mixing observation and action in one agent creates ambiguous responsibility and harder-to-audit behavior. Six agents with clear boundaries mean: each agent's permissions are minimal for its job, each agent's safety rails are specific to its risk level, and each agent can be independently disabled/upgraded/rate-limited.

### Why explicit playbooks instead of letting the LLM improvise?

Platform remediation is not a creative task. It's a decision tree:
1. Classify the failure pattern.
2. Look up the prescribed fix.
3. Execute exactly that fix.
4. Log what happened.

Improvisation in infrastructure is how you get unexpected side effects. The playbooks are deliberately rigid. If a failure doesn't match a known pattern, the correct action is escalation, not experimentation.

Over time, new playbooks can be added (by humans or proposed by agents via PRs). The knowledge compounds, but always through review.

### Why `is_system` flag instead of a separate RBAC role?

The elevation model is deliberately simple: if your project is marked `is_system`, your agents get system scope. This avoids:
- A complex permission matrix for platform vs. tenant agents.
- Per-agent elevation flags that could be misconfigured.
- A separate RBAC dimension that interacts with the existing role system.

The `is_system` flag is set at bootstrap and not exposed to users. It's an infrastructure concern, not a user concern.

---

## Phase 5: Infrastructure & Cost Management Skills (Tier 2 Content)

**Goal**: Author the skills (SKILL.md + references) for the four Tier 2 agents. Pure content — no platform code changes.

### Infra Provisioner Skill (skills/infra-provisioner/SKILL.md)

```markdown
---
name: infra-provisioner
description: Cloud infrastructure provisioning via declarative runbooks
---

# Infrastructure Provisioner

You provision cloud resources in response to demand signals. Follow runbooks exactly.

## Decision Process

1. **Read the trigger payload** — extract resource type, quantity, org/project scope, budget envelope.
2. **Validate current state** — check what already exists. Never duplicate resources.
3. **Match runbook** — find the matching runbook in references/runbooks/.
4. **Dry-run first** — when the runbook specifies it, execute a dry-run and log the plan.
5. **Execute** — apply the change. Log every command and its output.
6. **Verify** — confirm the resource is healthy and accessible.
7. **Emit event** — `eve event emit --type system.resource.provisioned --payload '{...}'`.

## Available Runbooks

| Resource | Runbook | Triggers |
|----------|---------|----------|
| K8s node | add-k8s-node.md | Cluster scaler demand signal, operator request |
| PVC | provision-pvc.md | Environment creation, storage exhaustion |
| Database | provision-database.md | New project with db-ref, operator request |
| Platform subdomain | configure-platform-dns.md | Environment deploy with service exposure |
| Custom domain | configure-custom-dns.md | `eve domain add --type custom` or `system.domain.requested` event |
| TLS certificate | provision-tls-cert.md | Domain validated, cert expiring < 7 days |

## Safety Rails

- Never provision resources exceeding the org's remaining budget.
- Never modify resources in namespaces outside the requesting project's scope.
- Always use the declared cloud provider from references/cloud-providers.md.
- Max 5 provisioning actions per hour (check via `eve event list --type system.resource.provisioned`).
- If a runbook is missing for the requested resource type, escalate — do not improvise.
```

### Cluster Scaler Skill (skills/cluster-scaler/SKILL.md)

```markdown
---
name: cluster-scaler
description: K8s cluster autoscaling based on workload pressure and budget constraints
---

# Cluster Scaler

You evaluate K8s cluster utilization and decide whether to scale node pools.

## Decision Process

1. **Gather metrics**:
   - `eve system pods --json` — count pending vs running pods, check for scheduling failures.
   - `eve system status --json` — overall platform health and queue depth.
   - `eve admin usage summary --org <system_org> --since 1h --json` — recent compute consumption.

2. **Evaluate against policies** (see references/scaling-policies.md):
   - **Scale up** if: pending pods > threshold OR CPU allocation > 80% of cluster capacity.
   - **Scale down** if: CPU allocation < 30% for > 30 minutes AND no pending pods AND cooldown expired.
   - **Hold** otherwise.

3. **Check budget constraints** (see references/cost-bounds.md):
   - Query total cluster cost projection: current nodes × hourly rate × remaining month.
   - Never scale up if projected monthly cost would exceed the budget ceiling.

4. **Check cooldown** (see references/cooldown-rules.md):
   - Last scaling action must be > N minutes ago (default: 10 min for scale-up, 30 min for scale-down).
   - Query: `eve event list --type system.cluster.scaled --limit 5 --json`.

5. **Execute scaling decision**:
   - Scale up: `eve event emit --type system.resource.requested --payload '{"type": "k8s-node", ...}'` (triggers infra provisioner).
   - Scale down: Cordon + drain the least-utilized node, then decommission.
   - Hold: Log decision and metrics for capacity planner.

6. **Emit audit event**: `eve event emit --type system.cluster.scaled --payload '{...}'`.

## Safety Rails

- Never scale below minimum node count (see references/scaling-policies.md).
- Never scale up if budget ceiling would be exceeded.
- Always respect cooldown periods between scaling actions.
- Never drain a node that hosts system-critical pods (eve-platform namespace).
```

### Cost Optimizer Skill (skills/cost-optimizer/SKILL.md)

```markdown
---
name: cost-optimizer
description: Spend analysis and waste identification across the platform
---

# Cost Optimizer

You analyze spend data and identify opportunities to reduce costs.

## Analysis Process

1. **Gather spend data** (per org):
   - `eve org spend <org_id> --since 7d --json` — weekly spend with top jobs.
   - `eve admin balance show <org_id> --json` — current balance and burn rate.
   - `eve admin usage summary --org <org_id> --since 7d --json` — resource consumption.

2. **Identify waste patterns** (see references/waste-patterns.md):
   - **Idle environments**: Environments with zero job activity for > 48 hours.
   - **Oversized resource classes**: Jobs using `job.c2` but consuming < 500m CPU on average.
   - **Stale PVCs**: PVCs not mounted by any pod for > 7 days.
   - **Redundant managed model usage**: Jobs using expensive managed models for tasks that cheaper models handle equally well (compare receipt token counts vs completion quality).
   - **Failed job waste**: High retry counts on jobs that consistently fail (cost without value).

3. **Classify actions** (see references/optimization-actions.md):
   - **Auto-execute** (safe): Suspend idle dev/staging environments. Log and emit event.
   - **Recommend** (needs approval): Downsize resource classes. Switch model defaults. Adjust budget caps.
   - **Escalate** (operator decision): Terminate environments. Reduce org capacity. Change pricing.

4. **Produce report**: Structured JSON with findings, recommended actions, projected savings.

5. **Emit events**:
   - `system.cost.optimization.executed` — for auto-executed actions.
   - `system.cost.optimization.recommended` — for recommendations requiring approval.

## Safety Rails

- Never suspend production environments (only dev/staging with zero recent activity).
- Never reduce org balances or credits.
- Max 3 auto-executed optimizations per run.
- All recommendations include projected monthly savings and risk assessment.
```

### Capacity Planner Skill (skills/capacity-planner/SKILL.md)

```markdown
---
name: capacity-planner
description: Usage trend analysis and provisioning recommendations
---

# Capacity Planner

You analyze historical usage data and produce capacity recommendations. You are read-only — you never take action.

## Analysis Process

1. **Gather historical data** (4-week window):
   - `eve admin usage summary --org <org_id> --since 28d --json` — per org.
   - `eve org spend <org_id> --since 28d --json` — spend trends.
   - `eve admin balance transactions <org_id> --since 28d --json` — credit/charge patterns.

2. **Compute trends** (see references/trend-analysis.md):
   - Weekly compute consumption (vcpu-hours, memory-gib-hours).
   - Weekly storage consumption (gb-hours).
   - Weekly LLM token consumption (by model, managed vs byok).
   - Weekly spend (base USD, billed amount).

3. **Project growth** (see references/growth-models.md):
   - Linear extrapolation for steady-state orgs.
   - Exponential fit for fast-growing orgs.
   - Flag anomalies (sudden spikes, unexpected drops).

4. **Produce recommendations**:
   - Node capacity: current utilization % → projected need in 2/4/8 weeks.
   - Storage: current PVC utilization → projected exhaustion date.
   - Budget: current burn rate → projected balance exhaustion date.
   - Model costs: managed model spend trajectory → suggested rate card adjustments.

5. **Output**: Structured capacity report (see references/report-format.md).

## Report Format

```json
{
  "report_date": "2026-02-09",
  "window_days": 28,
  "orgs": [{
    "org_id": "...",
    "compute": { "current_vcpu_hours_weekly": 120, "trend": "growing", "projected_4w": 180 },
    "storage": { "current_gb": 50, "projected_exhaustion": "2026-04-15" },
    "budget": { "balance": 450.00, "weekly_burn": 85.00, "projected_exhaustion": "2026-03-17" },
    "recommendations": ["Scale node pool from 3→4 nodes by March 1", "Budget top-up needed by March 17"]
  }]
}
```
```

---

## Phase 6: Cloud Provider & DNS Integration (Tier 2 Platform Code)

**Goal**: Add the platform-side capabilities that Tier 2 agents need — K8s node pool scaling, cloud resource management CLI wrappers, resource demand events, and DNS integration (platform subdomains + custom domains).

### 1) Resource Demand Events

Add new system events emitted by agents or operators:

- `system.resource.requested` — payload: `{ type, quantity, org_id, project_id, budget_envelope, requester }`
- `system.resource.provisioned` — payload: `{ type, resource_id, org_id, project_id, cost_per_hour }`
- `system.cluster.scaled` — payload: `{ direction, node_count_before, node_count_after, reason }`
- `system.cost.optimization.executed` — payload: `{ action, target, projected_savings_usd }`
- `system.cost.optimization.recommended` — payload: `{ action, target, projected_savings_usd, risk }`
- `system.domain.requested` — payload: `{ hostname, type, project_id, environment_name }` (triggers infra provisioner)
- `system.domain.validated` — payload: `{ domain_id, hostname, project_id }`
- `system.domain.active` — payload: `{ domain_id, hostname, cert_expiry }`
- `system.domain.error` — payload: `{ domain_id, hostname, error_type, error_message }`

These don't require platform code changes — agents emit them via `eve event emit`. But they must be documented in `docs/system/events.md` so trigger matching works.

### 2) K8s Node Pool Scaling

Platform agents need a way to scale K8s node pools. Options:

1. **Cloud provider CLI** (preferred for MVP): The infra provisioner and cluster scaler invoke cloud-specific commands via the harness:
   - k3s: `kubectl` to add/remove nodes from the cluster
   - EKS: `aws eks update-nodegroup-config --scaling-config minSize=N,maxSize=M,desiredSize=D`
   - GKE: `gcloud container clusters resize`
   - Custom: configurable via `system_settings["cloud_provider"]`

2. **Eve CLI wrapper** (future): `eve admin cluster scale --nodes N` that abstracts the cloud provider. Deferred — the agents can use raw cloud CLIs via harness for now.

**What's needed now**: Ensure the system agent's harness environment includes cloud provider credentials (kubeconfig, AWS credentials, etc.) via platform secrets injection. The worker already supports `platform_secrets` resolution — extend to include cloud provider keys for system projects.

### 3) System Settings for Cloud Provider

```json
// system_settings["cloud_provider"]
{
  "type": "k3s",              // k3s | eks | gke | custom
  "region": "us-east-1",
  "node_pool": "default",
  "min_nodes": 1,
  "max_nodes": 10,
  "node_type": "t3.medium",
  "budget_ceiling_monthly_usd": 500,
  "credentials_secret_ref": "platform.cloud.kubeconfig"
}
```

### 4) Namespace Hardening Integration

The namespace hardening system (already landed in `packages/shared/src/k8s/`) generates ResourceQuota, LimitRange, and NetworkPolicy manifests. The infra provisioner should apply these when provisioning new namespaces:

```bash
# Agent can query current hardening config
eve admin settings get namespace_hardening --json

# And apply via kubectl (the manifests are generated server-side)
```

### 5) DNS Integration

Eve apps need friendly, discoverable domain names. This section covers two flows: **platform-managed subdomains** (automatic, zero-config) and **custom domains** (user-managed, with validation).

#### Platform-Managed Subdomains

Every deployed environment automatically gets a subdomain under the Eve platform domain:

```
<service>.<env>.<project>.<org>.eve.example.com
```

For single-service environments (the common case), the service prefix is omitted:

```
<env>.<project>.<org>.eve.example.com
```

**How it works:**

1. **Wildcard DNS**: A single `*.eve.example.com` DNS record points to the platform's ingress controller IP. No per-subdomain DNS records needed.
2. **Wildcard TLS**: cert-manager with a DNS-01 challenge solver provisions a wildcard certificate for `*.eve.example.com` (and `*.*.eve.example.com`, etc.). All platform subdomains share this cert.
3. **Ingress rules**: When a service is deployed to an environment, the worker creates an Ingress resource with:
   - `host: <service>.<env>.<project>.<org>.eve.example.com`
   - `tls` referencing the wildcard cert secret
   - Backend pointing to the service's ClusterIP

This is zero-config for the user. The URL is deterministic from the project/env/service names and is returned in `eve env services` output.

**Implementation:**

- The deploy pipeline (worker) already creates K8s resources for environment services. Extend the service provisioning step to also create/update an Ingress resource.
- The wildcard cert is a one-time cluster setup (cert-manager ClusterIssuer + Certificate). Document in staging overlay or provision via the infra provisioner's bootstrap runbook.
- No `domains` table entry needed for platform subdomains — the URL is derived, not stored. But environment metadata should include the resolved URL for CLI display.

#### Custom Domains

Users can map their own domain names to their Eve deployments:

```bash
eve domain add --project my-app --env production --type custom --hostname app.mycompany.com
```

**Validation flow:**

1. **Register**: User calls `eve domain add --type custom --hostname <fqdn>`. Platform creates a `domains` row with status `pending_validation` and generates a validation record:
   - CNAME validation: `_eve-verify.<fqdn>` → `<token>.verify.eve.example.com`
   - Alternative: TXT record on `_eve-verify.<fqdn>` with a platform-signed token.

2. **User configures DNS**: The user adds the validation record at their registrar. They also add a CNAME (or A record) pointing their domain to the platform ingress:
   - `app.mycompany.com` CNAME `ingress.eve.example.com`

3. **Verify**: The infra provisioner (or a periodic check) validates:
   - The verification record exists and contains the correct token.
   - The domain resolves to the platform ingress IP.
   - Update domain status: `pending_validation` → `validated`.

4. **Provision TLS**: cert-manager provisions a certificate for the custom domain using HTTP-01 challenge (the domain already points to our ingress, so HTTP-01 works). Status: `validated` → `cert_provisioning` → `active`.

5. **Configure Ingress**: Create/update an Ingress resource with:
   - `host: app.mycompany.com`
   - `tls` with the custom domain's cert secret
   - Backend pointing to the environment's service.

6. **Ongoing**: System health agent monitors cert expiry and DNS resolution. If the user removes their CNAME, the domain goes to `dns_error` status but the record is preserved (user can re-point and it auto-heals).

**Domain lifecycle states:**

```
pending_validation → validated → cert_provisioning → active
                  ↘ validation_failed (retryable)
active → dns_error (auto-recoverable) → active
active → cert_error (auto-recoverable via re-issue) → active
active → removed (explicit user action)
```

#### Database Migration (`00043_add_domains.sql`)

```sql
CREATE TABLE domains (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id),
  environment_name TEXT NOT NULL,             -- which env this domain routes to
  hostname TEXT NOT NULL,                      -- e.g. "app.mycompany.com"
  type TEXT NOT NULL CHECK (type IN ('platform', 'custom')),
  status TEXT NOT NULL DEFAULT 'pending_validation'
    CHECK (status IN ('pending_validation', 'validated', 'cert_provisioning',
                      'active', 'dns_error', 'cert_error', 'validation_failed', 'removed')),
  validation_token TEXT,                      -- for custom domain ownership proof
  validation_record TEXT,                     -- the DNS record the user must create
  cert_secret_name TEXT,                      -- K8s secret name for the TLS cert
  ingress_name TEXT,                          -- K8s Ingress resource name
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  UNIQUE (hostname)                           -- one hostname globally
);

CREATE INDEX idx_domains_project ON domains(project_id);
CREATE INDEX idx_domains_status ON domains(status);
```

#### Domain API Endpoints

```
POST   /projects/:id/domains          -- register a new domain (platform or custom)
GET    /projects/:id/domains          -- list domains for a project
GET    /projects/:id/domains/:did     -- get domain details
POST   /projects/:id/domains/:did/verify  -- trigger validation check
DELETE /projects/:id/domains/:did     -- remove domain + clean up ingress/cert

GET    /admin/domains                 -- all domains across all projects (admin/system)
GET    /admin/domains/pending         -- domains awaiting validation (admin/system)
```

#### System Settings for DNS

```json
// system_settings["dns"]
{
  "platform_domain": "eve.example.com",
  "ingress_ip": "203.0.113.10",
  "wildcard_cert_secret": "wildcard-example-tls",
  "cert_issuer": "letsencrypt-prod",
  "validation_method": "cname",           // "cname" or "txt"
  "max_custom_domains_per_project": 5,
  "auto_platform_subdomain": true          // auto-create platform subdomain on deploy
}
```

#### Manifest Integration

Users can declare domains in their project manifest:

```yaml
# .eve/manifest.yaml
environments:
  production:
    domains:
      - type: custom
        hostname: app.mycompany.com
      - type: custom
        hostname: www.mycompany.com
    # Platform subdomain is automatic — no declaration needed
```

`eve project sync` reads the manifest domains and calls the domain registration API. This makes domains declarative and version-controlled alongside the rest of the project config.

**Tests**:
- Integration: `system.resource.requested` event triggers infra provisioner workflow.
- Integration: Cluster scaler scaling decision emits correct audit event.
- Unit: Cloud provider settings parsing and validation.
- Integration: `eve domain add --type custom` creates domain record with `pending_validation` status and validation token.
- Integration: Domain verification succeeds when DNS records are correct → status transitions to `validated`.
- Integration: Platform subdomain Ingress is created on environment deploy with correct host and TLS.
- Integration: Custom domain cert provisioning triggers cert-manager Certificate resource creation.
- Unit: Platform subdomain URL derivation from org/project/env/service names.
- Unit: Domain hostname uniqueness constraint prevents duplicate registrations.

---

## Phase 7: Tier 2 Activation

**Goal**: Activate the Tier 2 workflows in the system project manifest and validate end-to-end.

1. Uncomment Tier 2 workflows in the system project manifest.
2. Verify all six agents are synced and claiming jobs correctly.
3. Run manual validation scenarios:
   - Trigger cost optimizer via `eve workflow invoke cost-optimization-sweep`.
   - Trigger capacity planner via `eve workflow invoke capacity-planning-report`.
   - Simulate cluster pressure → observe cluster scaler decision.
   - Emit `system.resource.requested` → observe infra provisioner action.
4. Monitor for 48 hours — verify cron triggers fire, agents produce expected outputs, rate limits hold.

---

## Parallelization Map

```
                                                   Tier 1
Phase 0 (Cron + Schedules)   ──→  Phase 4 (System Project + Pack Install)
Phase 1 (System Scope)       ──→  Phase 4
Phase 2 (Signals + Routing)  ──→  Phase 4
Phase 3 (Tier 1 Skills)      ──→  Phase 4
                                                   Tier 2
                              Phase 4  ──→  Phase 5 (Infra + Cost Skills)
                              Phase 4  ──→  Phase 6 (Cloud Provider + DNS Integration)
                                            Phase 5 + Phase 6  ──→  Phase 7 (Tier 2 Activation)
```

**Tier 1** (Phases 0-4):
- Phases 0, 1, 2, and 3 are **all independent** and can proceed in parallel.
  - Phase 0: Cron + schedules hardening (platform code).
  - Phase 1: System scope migration + token changes (platform code).
  - Phase 2: System failure signals + fan-out routing (platform code).
  - Phase 3: Agent pack repo — Tier 1 skills + config (pure content, no platform code).
- Phase 4 integrates Tier 1: system project installs the pack, wires triggers, deploys.

**Tier 2** (Phases 5-7):
- Phase 5 and Phase 6 are independent and can proceed in parallel after Phase 4.
  - Phase 5: Infra + cost skills (pure content — runbooks, policies, reports).
  - Phase 6: Cloud provider integration (platform code — K8s scaling API, cloud CLI wrappers).
- Phase 7 activates Tier 2: uncomment workflows, validate, deploy.

---

## Security Notes

- System agents run with elevated permissions. The `is_system` flag must be protected:
  - Only settable at bootstrap or by system admin via direct DB update.
  - Not exposed in user-facing API endpoints. Explicitly exclude `is_system` from org/project create/update DTOs.
  - `eve admin` commands for managing system projects require system admin role.
  - The internal `mint-job-token` endpoint must validate `is_system` server-side (not trust the caller's claim).

- **Tier 1 agents** (health + remediation):
  - Auto-remediation actions logged as system events with full audit trail.
  - Rate limits prevent cascading failures (remediation causing more failures causing more remediation).
  - System agent job tokens have explicit permission lists — not blanket admin access.

- **Tier 2 agents** (infra + cost):
  - Cloud provider credentials are the highest-sensitivity secrets on the platform. Stored in `platform_secrets`, injected only into system project harness environments.
  - Infra provisioner and cluster scaler can create/destroy cloud resources — their safety rails are the most critical. Budget ceilings, min-node floors, and cooldown periods are enforced in skills, not just in code.
  - Cost optimizer can suspend environments — restricted to dev/staging with zero recent activity. Production environments are never auto-suspended.
  - Capacity planner is strictly read-only — the safest Tier 2 agent.

- **DNS / custom domains**:
  - Custom domain validation prevents domain takeover — users must prove ownership before the platform routes traffic.
  - Hostname uniqueness constraint prevents two projects from claiming the same domain.
  - Platform subdomains are deterministic from project/env/service names — no user-controlled input in the DNS record itself (prevents subdomain injection).
  - TLS certs for custom domains use HTTP-01 challenge (domain must point to our ingress), not DNS-01 (which would require access to the user's DNS provider).
  - Stale domain records (user removed their CNAME) are detected by system health agent and flagged, not auto-deleted — preserves user intent.
  - `max_custom_domains_per_project` prevents abuse of cert provisioning (Let's Encrypt rate limits).

- All playbooks and runbooks are version-controlled in the skillpacks repo. Changes require PR review. This is the governance model for platform operational policy.

## Future

Once all six agents are running, the next opportunities:

- **Agent self-improvement loop**: Agents propose PR updates to their own playbooks/runbooks based on patterns they encounter. Human review required.
- **Multi-cloud provisioning**: Extend infra provisioner runbooks for AWS, GCP, Azure.
- **FinOps dashboards**: Consume agent reports to build operator dashboards (separate project).
- **Predictive scaling**: Cluster scaler uses capacity planner's growth projections for proactive scaling instead of reactive.
- **Multi-level DNS**: Support for deeper subdomain hierarchies (e.g., `api.v2.staging.my-app.acme.eve.example.com`) and configurable platform domain per deployment (e.g., customer white-label domains like `*.apps.acmecorp.com`).
- **DNS provider integrations**: Automated DNS validation for custom domains via provider APIs (Cloudflare, Route53, Google Cloud DNS) instead of requiring manual user action.
