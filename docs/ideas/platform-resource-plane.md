# Platform Resource Plane: Metering, Budgets, and Self-Managing Infrastructure

> Status: Idea (Architecture)
> Last Updated: 2026-02-09
>
> Related:
> - `docs/ideas/nostrworld-agentic-paas.md` (nostrworld vision)
> - `docs/ideas/nostr-integration.md` (Nostr identity, DVMs, payments)
> - `docs/system/deployment.md` (K8s runtime, namespaces)
> - `docs/system/job-api.md` (jobs, attempts, scheduling)
> - `docs/system/auth.md` (identity, RBAC)
> - `docs/system/events.md` (event spine)
> - `docs/system/worker-types.md` (routing, resource classes)
> - `docs/system/manifest.md` (services, environments, pipelines)
> - `docs/system/chat-gateway.md` (gateway pattern)
> - `docs/system/extension-points.md` (pluggable interfaces)

## Thesis

Eve Horizon manages *work* (jobs, pipelines, deployments) but does not manage
*resources* (compute time, memory, storage, capacity). Any multi-tenant
deployment — nostrworld or otherwise — requires a resource management plane:
who is using what, how much does it cost, and when to stop.

This doc defines the base platform primitives needed so that nostrworld (or any
billing/multi-tenant layer) becomes a thin protocol skin, not a platform fork.

It also proposes that Eve's own agents become the primary operators of the
platform — provisioning cloud resources, diagnosing failures, and self-healing
infrastructure without human intervention.

---

## Part 1: Resource Management Gaps

### 1.1 Usage Metering & Ledger

**Problem**: No usage tracking exists. Jobs complete; we record success/failure.
Zero resource consumption data.

**Design**:

A `usage_records` table as an append-only ledger:

```sql
CREATE TABLE usage_records (
  id           typeid PRIMARY KEY,        -- ur_xxx
  org_id       typeid NOT NULL REFERENCES orgs(id),
  project_id   typeid REFERENCES projects(id),
  env_name     text,
  resource_type text NOT NULL,            -- job_compute, env_compute, storage, managed_db
  resource_class text,                    -- job.c1, svc.s1, disk.std, db.p1
  quantity     numeric NOT NULL,          -- units consumed
  unit         text NOT NULL,             -- vcpu_seconds, gib_seconds, gb_hours
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  source_type  text NOT NULL,             -- job_attempt, deployment, pvc, managed_resource
  source_id    text NOT NULL,             -- attempt UUID, deployment ID, PVC name
  created_at   timestamptz DEFAULT now()
);
```

**Sources that emit records**:
- **Job attempts**: Worker writes a record on attempt completion with
  `started_at`, `finished_at`, and the resource class of the runner pod.
- **Deployments**: A periodic sweep (or K8s informer) records active pod-hours
  per environment namespace.
- **PVCs**: Periodic sweep records provisioned GB-hours.
- **Managed resources**: Provisioning agent records allocated tier and uptime.

**Key principle**: Bill by *requested* resources (K8s requests), not actual CPU.
This is deterministic, fair, and aligned with quota enforcement.

### 1.2 Resource Classes (Compute SKUs)

**Problem**: Worker types route by toolchain (python, rust). No way for a job to
request a compute tier. Runner pods all get the same resource profile.

**Design**:

Resource classes are named SKUs that map to K8s resource requests:

```yaml
# Platform configuration (not per-project)
resource_classes:
  job.c1:
    target: runner
    requests: { cpu: "1", memory: "2Gi" }
    limits:   { cpu: "2", memory: "4Gi" }
    billing:  { unit: vcpu_seconds, rate_sats: 1 }

  job.c2:
    target: runner
    requests: { cpu: "2", memory: "4Gi" }
    limits:   { cpu: "4", memory: "8Gi" }
    billing:  { unit: vcpu_seconds, rate_sats: 2 }

  job.m1:
    target: runner
    requests: { cpu: "2", memory: "8Gi" }
    limits:   { cpu: "4", memory: "16Gi" }
    billing:  { unit: vcpu_seconds, rate_sats: 3 }

  svc.s1:
    target: service
    requests: { cpu: "250m", memory: "512Mi" }
    billing:  { unit: vcpu_hours, rate_sats: 10 }

  svc.m1:
    target: service
    requests: { cpu: "1", memory: "2Gi" }
    billing:  { unit: vcpu_hours, rate_sats: 40 }

  disk.std:
    target: pvc
    billing:  { unit: gb_hours, rate_sats: 1 }

  db.p1:
    target: managed_db
    billing:  { unit: hours, rate_sats: 100 }
```

**Job-level usage**:

```bash
eve job create --description "Run integration tests" \
  --resource-class job.c2 \
  --worker-type python-worker
```

Worker type selects the *image* (toolchain). Resource class selects the *size*
(compute). They compose orthogonally.

**Runner pod creation** reads the resource class and sets:

```yaml
resources:
  requests: { cpu: "2", memory: "4Gi" }
  limits:   { cpu: "4", memory: "8Gi" }
```

**Manifest-level defaults**:

```yaml
x-eve:
  defaults:
    resource_class: job.c1
  environments:
    production:
      resource_class: svc.m1
```

### 1.3 Balances & Budget Enforcement

**Problem**: No concept of org budgets. Admission is role-based only.

**Design**:

```sql
CREATE TABLE org_balances (
  org_id        typeid PRIMARY KEY REFERENCES orgs(id),
  balance_sats  bigint NOT NULL DEFAULT 0,
  lifetime_in   bigint NOT NULL DEFAULT 0,  -- total credits received
  lifetime_out  bigint NOT NULL DEFAULT 0,  -- total charges applied
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE org_budget_limits (
  org_id            typeid PRIMARY KEY REFERENCES orgs(id),
  hard_cap_sats     bigint,               -- reject above this
  soft_cap_sats     bigint,               -- alert above this
  daily_max_sats    bigint,
  per_job_max_sats  bigint,
  suspend_at_sats   bigint DEFAULT 0,     -- suspend envs when balance drops below
  updated_at        timestamptz DEFAULT now()
);

CREATE TABLE balance_transactions (
  id            typeid PRIMARY KEY,       -- bt_xxx
  org_id        typeid NOT NULL REFERENCES orgs(id),
  type          text NOT NULL,            -- credit, charge, refund, adjustment
  amount_sats   bigint NOT NULL,
  description   text,
  source_type   text,                     -- payment, usage_sweep, manual, promo
  source_id     text,
  created_at    timestamptz DEFAULT now()
);
```

**Admission control** (two enforcement points):

1. **Job creation**: Estimate cost from resource class + timeout. Reject if
   `balance - estimate < suspend_at` or if `daily charges + estimate > daily_max`.
2. **Env deploy**: Estimate hourly cost from service resource classes. Reject if
   balance can't cover a minimum run window (configurable, e.g. 1 hour).

**Runtime enforcement**: A periodic sweep compares `balance_sats` against
`suspend_at_sats`. Orgs below threshold trigger environment suspension.

**Payment provider interface** (pluggable):

```typescript
interface PaymentProvider {
  name: string;
  // Verify an inbound payment and return the credited amount
  verifyPayment(proof: PaymentProof): Promise<{ amount_sats: number }>;
  // Generate a payment request (invoice, address, etc.)
  createInvoice(amount_sats: number, memo: string): Promise<PaymentRequest>;
}
```

Implementations: `LightningProvider`, `StripeProvider`, `ManualProvider` (admin
credits). The payment method is Nostr/Lightning in nostrworld but the ledger is
generic.

### 1.4 Namespace Resource Quotas

**Problem**: Namespaces exist per environment but have no quotas or network
isolation.

**Design**:

When the worker creates or updates a namespace, apply:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: env-quota
  namespace: eve-{orgSlug}-{projectSlug}-{envName}
spec:
  hard:
    requests.cpu: "4"        # derived from org limits / env tier
    requests.memory: "8Gi"
    persistentvolumeclaims: "5"
    requests.storage: "20Gi"
```

Plus a `LimitRange` so pods without explicit requests get bounded defaults:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: env-limits
spec:
  limits:
    - default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      type: Container
```

Plus a `NetworkPolicy` denying cross-namespace traffic by default:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-cross-tenant
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {}    # same namespace only
```

Quota values derive from the org's budget limits and the resource classes
requested in the manifest.

### 1.5 Environment Suspension

**Problem**: Environments are deployed or not. No graceful degradation.

**Design**:

Add `status` to the environment model: `active` | `suspended` | `terminated`.

**Suspension** (triggered by budget exhaustion or admin action):
1. Scale all deployments in the namespace to 0 replicas.
2. Remove ingress resources (block external traffic).
3. Preserve PVCs and ConfigMaps (data survives).
4. Record `suspended_at` timestamp.

**Resume** (triggered by balance top-up or admin action):
1. Restore deployment replicas from stored state.
2. Re-create ingress resources.
3. Record `resumed_at`.

**Termination** (after retention window expires):
1. Delete all resources in the namespace.
2. Delete namespace.
3. Record final usage records for the retention period.

**Retention policy**: Configurable per org tier. Default 7 days suspended before
termination. Data can be exported before termination via a scheduled job.

---

## Part 2: Identity & Transport Extensibility

### 2.1 External Identity Provider Framework

**Problem**: Auth supports GitHub SSH and Supabase JWT. Adding Nostr (or
any new provider) requires bespoke code throughout the auth stack.

**Design**:

A pluggable identity verification interface:

```typescript
interface IdentityProvider {
  name: string;                          // 'ssh', 'nostr', 'oauth'

  // Verify a credential and return a principal
  verify(credential: ProviderCredential): Promise<VerifiedIdentity>;

  // Extract credential from an HTTP request (for request-level auth)
  extractFromRequest?(req: Request): ProviderCredential | null;
}

interface VerifiedIdentity {
  provider: string;                      // 'ssh', 'nostr'
  external_id: string;                   // pubkey hex, email, etc.
  display_name?: string;
  metadata?: Record<string, unknown>;    // provider-specific
}
```

**Implementations**:
- `SshIdentityProvider` (current) — verify SSH signature against registered keys.
- `NostrIdentityProvider` — verify Nostr event signature (NIP-98 for HTTP, event
  signature for relay messages).
- `OAuthIdentityProvider` — verify OAuth tokens (future).

**Auto-provisioning**: On first verified request from an unknown identity,
optionally create a user and default org. Controlled by platform config:

```yaml
identity:
  auto_provision: true       # create user on first contact
  auto_org: true             # create a personal org for new users
  require_deposit: true      # require initial payment before provisioning
```

**Registration in `external_identities`**:

The table already exists. Add `nostr` as a provider type. The `external_id`
stores the hex pubkey.

### 2.2 Request-Level Auth Chain

**Problem**: API only accepts `Authorization: Bearer <jwt>`. No support for
signature-based request auth.

**Design**:

The auth guard becomes a chain of authenticators, tried in order:

1. **Bearer JWT** (current) — extract from `Authorization: Bearer` header.
2. **Signature-based** — extract from provider-specific headers (e.g., NIP-98
   `Authorization: Nostr <base64-event>`).
3. **Internal API key** (current) — `X-Eve-Internal-Key` for worker → API.

Each authenticator returns a principal or `null` (skip to next). First match
wins.

This is a framework change, not a Nostr-specific one. Any future auth method
(API keys, mTLS, webhook signatures) plugs into the same chain.

### 2.3 Gateway Plugin Architecture

**Problem**: The gateway is Slack-specific. Adding Nostr requires refactoring
the gateway into a plugin system.

**Design**:

```typescript
interface GatewayPlugin {
  name: string;                         // 'slack', 'nostr', 'email'
  capabilities: string[];               // ['chat', 'identity', 'events']

  // Lifecycle
  initialize(config: PluginConfig): Promise<void>;
  shutdown(): Promise<void>;

  // Inbound: external event → normalized Eve event
  onRawEvent(raw: unknown): Promise<NormalizedEvent | null>;

  // Outbound: Eve → external
  sendMessage(target: MessageTarget, content: MessageContent): Promise<void>;

  // Identity: resolve external user to Eve identity
  resolveIdentity?(externalId: string): Promise<ExternalIdentity | null>;
}
```

The gateway service becomes a plugin host:
- Loads plugins based on org integration config.
- Routes inbound events to the correct plugin.
- Outbound messages dispatched through the plugin that owns the target.

**Slack becomes the first plugin.** Its current code moves behind the interface.
Nostr becomes the second. Email, Telegram, Discord follow the same pattern.

**Plugin registration** (per-org, via integrations API):

```bash
eve integrations connect nostr \
  --org org_xxx \
  --relays "wss://relay.damus.io,wss://nos.lol" \
  --pubkey npub1...
```

---

## Part 3: Self-Managing Platform (Platform Agents)

### 3.1 The Idea

Eve already runs agents that do software engineering work. The platform itself
should be managed by agents that do *infrastructure* work. Platform agents are
Eve agents with elevated permissions that operate on the platform's own
resources.

This is not "monitoring with dashboards." This is agents that watch, diagnose,
decide, and act — acquiring cloud resources, provisioning databases, rotating
certificates, fixing failures, and scaling capacity.

### 3.2 Platform Agent Taxonomy

#### Infra Provisioner Agent

**Role**: Acquire and configure cloud resources on demand.

**Capabilities**:
- Provision managed databases (Cloud SQL, RDS) when an org requests `db.p1`.
- Provision object storage buckets for artifact storage.
- Provision node pools for specialized workloads (GPU, high-memory).
- Resize existing resources based on usage patterns.
- Decommission resources when orgs are terminated.

**How it works**:
1. An org deploys a manifest with a managed Postgres service (`x-eve.role: managed_db`).
2. The worker emits a `system.resource.requested` event with the resource spec.
3. Infra Provisioner Agent claims the event as a job.
4. Agent uses cloud provider CLI/API tools (via MCP or shell) to provision.
5. Agent writes connection credentials to Eve secrets for the org/project scope.
6. Agent emits `system.resource.provisioned` event with the resource ID.
7. The deployer reads the credentials from secrets and injects into the service.

**Skills**: Cloud provider CLIs (aws, gcloud, az), Terraform/Pulumi modules,
database admin tools. Packaged as a skill pack.

**Isolation**: Runs in a dedicated namespace (`eve-platform-agents`) with its
own service account and cloud IAM role. Never shares credentials with tenant
workloads.

**Example flow — new org needs a database**:

```
Org "acme" deploys manifest with: db: { x-eve: { role: managed_db, class: db.p1 } }
  → Worker emits: system.resource.requested { org: acme, type: managed_db, class: db.p1 }
  → Infra Provisioner claims job
  → Agent: gcloud sql instances create acme-db-001 --tier db-f1-micro --region us-central1
  → Agent: gcloud sql users set-password postgres --instance acme-db-001 --password <generated>
  → Agent: eve secrets set DB_HOST acme-db-001.xxx --scope project --project proj_acme
  → Agent: eve secrets set DB_PASSWORD <generated> --scope project --project proj_acme
  → Agent emits: system.resource.provisioned { resource_id: acme-db-001, type: managed_db }
  → Worker re-deploys the service with interpolated secrets
```

#### System Health Agent

**Role**: Watch platform health and diagnose issues before humans notice.

**Capabilities**:
- Monitor orchestrator, worker, and API health endpoints.
- Watch for stuck jobs (active too long, no log output).
- Watch for failing pipelines (repeated failures on same trigger).
- Monitor K8s node health, pod evictions, OOM kills.
- Monitor disk usage on PVCs and workspace volumes.
- Aggregate and summarize error patterns from system logs.

**How it works**:
1. Runs as a persistent agent (warm pod) with a heartbeat schedule.
2. Periodically queries `eve system health`, job queues, and K8s state.
3. When anomalies are detected, creates a diagnostic job with findings.
4. Publishes summary events: `system.health.degraded`, `system.health.recovered`.
5. Optionally notifies admins via chat (Slack, Nostr DM) with a summary.

**Example**:

```
Health Agent periodic check:
  → eve job list --all --phase active  →  finds 3 jobs stuck > 30 min
  → eve job diagnose <id>  →  runner pod OOMKilled
  → Creates issue: "3 jobs OOMKilled in last hour on runner pool 'default'.
    Recommendation: increase default resource class to job.c2 or add a
    memory-optimized node pool."
  → Sends Slack DM to platform admin with summary
```

#### Auto-Remediation Agent

**Role**: Fix known failure patterns automatically.

**Capabilities**:
- Retry failed jobs with adjusted parameters (more memory, different worker).
- Restart stuck deployments (pods in CrashLoopBackOff).
- Clear stale PVCs and orphaned runner pods.
- Rotate expiring certificates before they expire.
- Run database vacuum/maintenance on managed instances.
- Apply security patches to worker images and trigger rolling updates.

**How it works**:
1. Subscribes to `system.job.failed` and `system.pipeline.failed` events.
2. Matches failure patterns against a remediation playbook (skill pack).
3. For known patterns, executes the fix directly.
4. For unknown patterns, escalates to System Health Agent for diagnosis.
5. Records all actions in an audit log.

**Remediation playbook** (as a skill):

```markdown
# Remediation: OOMKilled Runner

## Pattern
- `error_code: runner_oom` OR exit code 137
- Resource class below job.m1

## Action
1. Retry the job with resource_class: job.m1
2. If retry also OOMs, escalate to admin
3. Record pattern for future default adjustment

## Approval
- Auto-approve: retry with higher resource class
- Require approval: changing org default resource class
```

**Safety rails**:
- Maximum retries per job (default: 2).
- Maximum auto-remediations per hour (rate limit).
- Escalation after N consecutive failures of the same type.
- All actions logged as `system.remediation.*` events.
- Human-in-the-loop for destructive actions (delete data, downgrade resources).

#### Capacity Planning Agent

**Role**: Predict resource needs and scale proactively.

**Capabilities**:
- Analyze usage trends across orgs (daily/weekly patterns).
- Predict when node pools will hit capacity.
- Recommend node pool scaling or resource class adjustments.
- Identify underutilized resources (orgs paying for capacity they don't use).
- Generate cost optimization reports.

**How it works**:
1. Periodically queries the usage ledger and K8s metrics.
2. Builds simple trend models (moving averages, peak detection).
3. Publishes recommendations as jobs for admin review.
4. With approval, executes scaling actions via Infra Provisioner.

#### Cost Optimization Agent

**Role**: Help orgs and the platform spend less.

**Capabilities**:
- Identify jobs that consistently use far less resources than requested.
- Suggest resource class downgrades.
- Identify environments running 24/7 that could be suspended overnight.
- Spot duplicate or redundant deployments.
- For cloud-backed resources, identify cheaper alternatives.

**Output**: Periodic reports delivered via chat or as jobs for review. Never
acts autonomously on cost optimization — always recommends.

### 3.3 Platform Agent Architecture

#### Separation from Tenant Agents

Platform agents are not tenant agents. They run in a dedicated project
(`eve-platform`) owned by a system org (`org_eve`):

```
org: eve-platform (system org, not visible to tenants)
  project: platform-ops
    agents:
      - infra-provisioner
      - system-health
      - auto-remediation
      - capacity-planning
      - cost-optimization
```

**Permissions**: Platform agents get a special `platform_admin` role that can:
- Read/write secrets across all orgs (for provisioning).
- Create/modify resources in any namespace (for remediation).
- Access K8s API directly (via service account).
- Access cloud provider APIs (via IAM role/service account).

Tenant agents never get `platform_admin`. The boundary is enforced by RBAC.

#### Event-Driven Activation

Platform agents activate via the same event spine as everything else:

```yaml
# Platform ops manifest
triggers:
  - event: system.resource.requested
    action: { type: job, agent: infra-provisioner }
  - event: system.job.failed
    action: { type: job, agent: auto-remediation }
  - event: system.health.check
    source: cron
    schedule: "*/5 * * * *"
    action: { type: job, agent: system-health }
  - event: system.usage.sweep
    source: cron
    schedule: "0 * * * *"
    action: { type: job, agent: capacity-planning }
```

No new event types needed. The existing event spine + trigger system handles it.

#### Skills as Operational Playbooks

Platform agent capabilities are packaged as skill packs:

```
eve-platform-skills/
  infra-provisioning/
    SKILL.md          # Cloud resource provisioning procedures
    references/
      gcp-sql.md      # GCP Cloud SQL provisioning steps
      aws-rds.md      # AWS RDS provisioning steps
      terraform/       # Reusable Terraform modules
  remediation/
    SKILL.md          # Failure pattern matching and fixes
    references/
      oom-playbook.md
      crashloop-playbook.md
      cert-rotation.md
  health-monitoring/
    SKILL.md          # Health check procedures and thresholds
    references/
      thresholds.yaml  # Alert thresholds
      escalation.yaml  # Escalation policies
```

Skill packs mean the platform's operational knowledge is version-controlled,
reviewable, and improvable — by humans or by the agents themselves.

#### Agent Self-Improvement Loop

Platform agents can propose improvements to their own playbooks:

1. Agent encounters a failure pattern not in the remediation skill.
2. Agent diagnoses the root cause and finds a fix.
3. Agent creates a PR adding the pattern to the remediation skill pack.
4. Human reviews and merges (or another agent reviews, per review policy).
5. Next occurrence is handled automatically.

This is Eve's existing job → PR → review flow applied to the platform itself.
The operational knowledge compounds over time.

### 3.4 Cloud Provider Abstraction

Platform agents need to talk to cloud providers. Rather than building a
provider abstraction layer in platform code, let agents use provider CLIs
and Terraform/Pulumi directly:

**Why agents, not code**:
- Cloud APIs change frequently; agent skills update faster than compiled code.
- Each cloud provider has unique quirks; agents can reason about edge cases.
- New providers (Hetzner, Fly, etc.) are added as skill packs, not code.
- Agents can read provider documentation and adapt.

**Safety**: Cloud operations are gated by:
- IAM roles with minimum necessary permissions.
- Budget limits (don't provision a db-n1-highmem-96 without approval).
- Approval workflows for expensive or irreversible operations.
- Dry-run mode for testing playbooks.

---

## Part 4: Implementation Phases

### Phase 0: Usage Foundation

- `usage_records` table and write path from job attempts.
- Record `started_at`, `finished_at`, resource class for every attempt.
- `eve admin usage` CLI command to query usage per org.
- No enforcement yet — observability only.

### Phase 1: Resource Classes + Runner Sizing

- Resource class configuration (platform-level).
- `resource_class` field on jobs (in hints or top-level).
- Runner pod creation reads resource class → sets K8s requests/limits.
- Usage records include resource class.
- `eve admin resource-classes` CLI for management.

### Phase 2: Balances + Budget Enforcement

- `org_balances`, `org_budget_limits`, `balance_transactions` tables.
- Admission control on job creation and env deploy.
- Manual credit via `eve admin balance credit --org ... --amount ...`.
- Payment provider interface (manual provider first).
- Budget alerts via system events.

### Phase 3: Namespace Hardening

- `ResourceQuota` and `LimitRange` applied on namespace creation.
- `NetworkPolicy` for cross-tenant isolation.
- Quota values derived from org budget limits.
- `eve admin quota` CLI for inspection.

### Phase 4: Environment Suspension

- `status` field on environments (active/suspended/terminated).
- Suspension action (scale to 0, remove ingress).
- Resume action.
- Budget-triggered suspension via periodic sweep.
- Retention policy and termination.

### Phase 5: Identity Extensibility

- `IdentityProvider` interface.
- Refactor SSH auth behind the interface.
- Request-level auth chain (Bearer → Signature → Internal).
- Auto-provisioning on first verified request.
- `external_identities` gains a generic provider type.

### Phase 6: Gateway Plugins

- `GatewayPlugin` interface.
- Refactor Slack behind the interface.
- Plugin registration per org.
- Plugin lifecycle (connect, health, disconnect).

### Phase 7: Platform Agents (Foundation)

- `eve-platform` system org + project.
- System Health Agent (periodic health checks, diagnostic jobs).
- Auto-Remediation Agent (subscribe to failure events, retry with fixes).
- Platform agent skill packs (health monitoring, basic remediation).

### Phase 8: Platform Agents (Provisioning)

- Infra Provisioner Agent for managed databases.
- `system.resource.requested` / `system.resource.provisioned` events.
- Cloud provider skills (GCP, AWS).
- Credential injection into org/project secrets.

### Phase 9: Platform Agents (Intelligence)

- Capacity Planning Agent.
- Cost Optimization Agent.
- Agent self-improvement loop (PR playbook updates).
- Usage trend analysis and recommendations.

---

## Open Questions

- **Resource class granularity**: Handful of named tiers (simple, agent-friendly)
  vs continuous CPU/memory specification (flexible, harder to price)?
  Recommendation: named tiers. Agents reason better about `job.c2` than
  `1.5 vCPU, 3.5Gi`.

- **Usage sweep frequency**: Real-time (per-event) vs periodic (hourly sweep)?
  Recommendation: Job compute is real-time (on attempt completion). Environment
  uptime is hourly sweep. Balance checks on job creation are real-time.

- **Platform agent blast radius**: How much autonomy for auto-remediation?
  Recommendation: Start conservative — retry with higher resources is auto.
  Anything that deletes data or changes topology requires approval. Widen
  over time as playbooks prove reliable.

- **Multi-cloud provisioning**: Single cloud first (GKE for nostrworld) or
  abstract from day one? Recommendation: single cloud first. The agent skill
  pack model makes adding clouds incremental — new skills, not new code.

- **Self-provisioning loop**: Can the Infra Provisioner Agent provision
  *itself* (e.g., add nodes to handle its own increased load)?
  Recommendation: yes, with a hard ceiling and human approval for scaling
  beyond thresholds. The agent should be able to scale the runner node pool
  but not the system node pool.

## The North Star

If we get this right:
- Eve is a metered, multi-tenant compute platform independent of any payment method.
- Resource accounting is a core primitive, not a billing afterthought.
- Platform agents are the primary operators — humans set policy, agents execute.
- Adding a new billing method (Lightning, Stripe, credits) is a payment provider plugin.
- Adding a new identity method (Nostr, OAuth, API keys) is an identity provider plugin.
- Adding a new chat channel (Nostr, Telegram, Discord) is a gateway plugin.
- Nostrworld becomes: Nostr identity provider + Lightning payment provider + Nostr gateway plugin + GKE overlay. That's it.
