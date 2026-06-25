# Channel + Agents Unified Plan v3 (Mission Control)

> Status: Idea
> Last Updated: 2026-02-03
> Purpose: A fresh, elegant plan for multi-agent teams + channel integrations with low-latency execution.
>
> Inputs (context):
> - docs/plans/channel-integrations-unified-plan.md
> - docs/ideas/chat-mission-control.md
> - docs/ideas/chat-client-integrations.md
> - docs/ideas/channel-integrations-gap-analysis.md
> - docs/ideas/persistent-runner-pools.md
> - docs/ideas/env-workers-first-class.md
> - docs/system/events.md
> - docs/system/pipelines.md
> - docs/system/workflows.md
> - docs/system/manifest.md

## North Star (Elegant Core)
**One routing system. One execution system. One continuity system.**

```
message/schedule/event -> thread -> route -> job(s) -> runtime -> response -> thread
```

- **Threads** hold continuity and shared context.
- **Routes** map inputs to deterministic targets (agent/team/workflow/pipeline).
- **Jobs** remain the single execution unit and audit trail.
- **Agent Runtime** provides warm, low-latency execution for hundreds of agents.

## Primitives (Minimal + Composable)

### Agent
First-class persona with policy, access, and schedule. Agents are project-scoped.

### Team
A routing target that groups agents and defines dispatch (fanout, council, relay).
Agents can belong to multiple teams.

### Thread
Unified continuity record for chat sessions and mission-control discussions.

### Message
Inbound/outbound log tied to a thread and (optionally) a job attempt.

### Route
A single routing primitive that replaces assistant/command split.

### Schedule
Cron-based event source (heartbeats, standups, reminders).

### Agent Runtime (Org App)
A long-lived service that hosts many agents in-process and executes jobs with
near-zero startup latency.

## Configuration (Repo-First, Manifest Points to Agents)
The manifest should **point to** agent/team definitions in the repo, not embed them.
This keeps the manifest lightweight while keeping agent definitions versioned,
reviewable, and portable.

### Project Modes (All Valid)
1) **Services-only**: standard app services, no agents.
2) **Agents-only**: only agent definitions + skills, no services.
3) **Hybrid**: services + agents in one repo (default).

### Manifest Sketch (Pointer Only)

```yaml
x-eve:
  agents:
    version: 3
    config_path: ./agents/agents.yaml
    teams_path: ./agents/teams.yaml        # optional (can be inside agents.yaml)
    skills_root: ./agents                  # OpenSkills-compatible agent definitions

chat:
  config_path: ./agents/chat.yaml
```

### Repo Layout (OpenSkills + YAML Config)
Agents are defined as **OpenSkills** skills (SKILL.md). A small YAML file maps
agent IDs to skills and defines access/schedule/policy. Teams live alongside.

```
agents/
  agents.yaml          # roster + access + schedules
  teams.yaml           # team definitions (optional)
  chat.yaml            # chat routing (routes + permissions)
  agent_main/
    SKILL.md           # OpenSkills agent definition (persona + instructions)
    references/
  agent_research/
    SKILL.md
```

`agents.yaml` example:

```yaml
version: 1
agents:
  agent_main:
    skill: agent_main
    workflow: assistant
    harness_profile: primary-orchestrator
    access:
      envs: [staging, production]
      services: [api, web]
      api_specs: [api]
    policies:
      permission_policy: auto_edit
      git: { commit: manual, push: never }
    schedule:
      heartbeat_cron: "*/15 * * * *"

  agent_research:
    skill: agent_research
    workflow: assistant
    policies:
      permission_policy: never
      git: { commit: never, push: never }
```

`teams.yaml` example:

```yaml
version: 1
teams:
  mission_control:
    lead: agent_main
    members: [agent_main, agent_research]
    dispatch:
      mode: fanout
      max_parallel: 3
      merge_strategy: lead_summarize
```

`chat.yaml` example:

```yaml
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: team:mission_control
    permissions:
      project_roles: [member, admin, owner]

  - id: route_deploy_staging
    match: "^/deploy staging$"
    target: pipeline:deploy-staging
    permissions:
      project_roles: [admin, owner]
      envs: [staging]
```

## Agent Runtime (Org App)
The Agent Runtime is a warm, org-scoped service that executes jobs in-process.
It replaces per-message pod startup while preserving jobs as the audit trail.

### Runtime Modes
1) **Org Runtime (default)**
- Runs in an org control namespace.
- Uses `env_name` to act in environment context without living inside it.
- Safer: app deploys do not restart the runtime.

2) **Env Runtime (opt-in)**
- Runs inside a specific app environment namespace.
- Direct access to env services via `svc.cluster.local`.
- Tradeoff: tied to env lifecycle and deploys.

### Sharding + Sticky Routing
To support hundreds of agents per org:
- **Consistent hashing** on `agent_id` assigns a runtime shard.
- **Sticky routing** keeps agents on the same pod for warm cache.
- **Failover** rehashes on pod loss and marks agent as migrated.
- **Capacity**: pods advertise max concurrent agents; rebalancer shifts low-activity agents.

## Shared Filesystem (Mission Control FS)
Provide a per-org RWX volume (e.g., EFS) mounted at `/org` in runtime pods.

Suggested layout:
- `/org/agents/<agent_id>/` - agent memory and notes
- `/org/threads/<thread_id>/` - thread summaries and transcripts
- `/org/docs/<doc_id>/` - shared artifacts
- `/org/shared/` - explicit shared space

Guidance:
- DB is authoritative; FS is for human-readable memory and docs.
- Job workspaces remain per-attempt and isolated (not under `/org`).

### Sandbox Compatibility (Required)
Current harness sandboxes allow access **only inside the workspace root**. To keep
sandboxing intact while exposing `/org`, mount the org FS **inside** each job
workspace (e.g., `{workspace}/.org`) rather than granting new global paths.

Example workspace layout:
```
/workspaces/{projectId}/{jobId}/{attemptNum}/
  repo/
  .org/            # bind-mount org RWX volume here
```

Notes:
- Keep `ctx.workspace` as the sandbox root for all harnesses.
- Expose `EVE_ORG_ROOT` pointing to `{workspace}/.org` for agent code.
- Avoid widening sandbox flags or danger modes.

## Execution Flows

### Message -> Team
1) Gateway normalizes message to event.
2) Thread resolved/created.
3) Route matched -> `team:mission_control`.
4) Orchestrator creates root job + child jobs per agent.
5) Agent Runtime executes child jobs in warm pods.
6) Lead agent summarizes and replies; thread updated.

### Command -> Pipeline
1) Route matches `pipeline:<name>`.
2) Permissions enforced (roles + env).
3) Pipeline run created; summary posted to thread.

### Heartbeats
1) Scheduler emits `agent.heartbeat` events.
2) Route targets the agent workflow.
3) Agent Runtime executes in warm pods; agent checks mentions and tasks.

## Access + Permissions
- **Default deny** for any route without explicit permissions.
- Explicit access lists per agent: `access.envs`, `access.services`, `access.api_specs`.
- Secrets resolve via standard Eve scopes (org/project/env).
- High-risk actions require explicit commands + pipeline approvals.

## Gateway + Identity (Hosted in Eve Cluster)
We run the **gateway as a first-class service inside the Eve cluster**. It is
multi-tenant, talks only to the Eve API, and owns provider connections.

### Provider Order
1) **Slack first** (required)
2) **Nostr later** (planned; design preserved in plugin interface)

### Slack (Hosted + Admin Approvals in Slack)
- Hosted OAuth flow managed by the gateway (tokens stored in Eve DB).
- Admin approvals happen **inside Slack** (buttons/commands).
- Unknown users trigger a `membership_request` and notify org admins.

Approval flow:
1) Slack user sends a message or `/eve join`.
2) Gateway creates `membership_request`.
3) Admins receive a Slack message with **Approve/Deny** actions + role selection.
4) On approve: Eve user is created/bound; permissions apply immediately.

#### Multi-Tenant Slack Mapping (One App, Many Workspaces)
For clusters hosting multiple companies/orgs, use **one Slack app per Eve cluster**,
installed into each company’s workspace. Each install maps to exactly one Eve org.

Flow:
1) OAuth install returns `team_id` + bot token.
2) Gateway stores integration as `provider=slack, account_id=team_id, org_id=org_x`.
3) Channel bindings are stored per org (`channel_id` -> `project_id` + `route`).
4) Identity mapping uses `(provider, team_id, user_id)` -> Eve user (org-scoped).
5) Routing resolves org by `team_id`; cross-org routing is not allowed.

This preserves isolation while keeping a single Slack app operationally simple.

### Nostr (Planned)
- Provider uses relay + pubkey identity (no OAuth).
- Link flow uses a signed challenge to bind pubkey to Eve user.
- Routes/permissions are identical to Slack once identity is linked.

### Identity Context (to Agent Runtime)
Each job includes a sanitized identity payload:
```
actor:
  provider: slack|nostr
  external_id: U123|npub1...
  eve_user_id: user_abc
  roles: { org: member, project: admin }
```
No provider tokens are exposed to jobs.

### Gateway Plugin Interface (Provider Adapters)
Providers are implemented as plugins with a minimal, stable interface.
This keeps Slack and future Nostr integrations consistent.

```
interface GatewayPlugin {
  name: string
  capabilities: ["chat"]
  auth: { mode: "oauth" | "token" | "pubkey" }

  connect(config): Promise<Connection>
  verify(req): Promise<VerifiedEvent>
  normalize(event): NormalizedMessage
  send(msg): Promise<DeliveryResult>
  health(): Promise<ProviderHealth>
}
```

Slack implementation:
- `auth.mode = "oauth"`
- `verify` validates Slack signatures or socket-mode tokens

Nostr implementation:
- `auth.mode = "pubkey"`
- `verify` validates relay signatures and pubkey ownership

## Updates (How Agents Change)
### Sync Semantics (Safety + Local Dev)
To avoid accidental mismatches, sync defaults to explicit refs and provides a safe
local escape hatch for k3d/dev.

- `eve project sync --ref <sha|branch|tag>` (required by default)
- `eve agents sync --ref <sha|branch|tag>` (required by default)
- `--local` uses the current working tree (local dev only)
- `--allow-dirty` required if the working tree is dirty

Rules:
- `--local` allowed only for local stacks (localhost / `*.lvh.me`) unless `--force-nonlocal`.
- Dirty syncs set `git_sha = null` (or `dirty = true`) and are **non-deployable**.
- Deploys must reference a clean, synced ref.

### What Changes
- **Config changes**: update `agents.yaml` / `teams.yaml` / `chat.yaml` -> `eve agents sync` updates DB.
- **Behavior changes**: update SKILL.md or references -> next job clone sees it.
- **Runtime reload**: runtime watches agent config revision and hot-reloads definitions.

## CLI Surface (Proposed)
Keep the CLI thin but cover agent-ops, chat, and testability.

Agent ops:
- `eve agents config` (resolve manifest pointers + show agents.yaml/teams.yaml/chat.yaml)
- `eve agents sync --ref <sha|branch|tag>` (default; deterministic)
- `eve agents sync --local --allow-dirty` (local dev only)

Chat + integrations:
- `eve integrations connect slack` (hosted OAuth or test mode)
- `eve integrations list|test`
- `eve chat simulate slack` (gateway test hook)

Observability:
- `eve threads list|show` (optional later)
- `eve chat routes list` (optional later)

## Testability (Simulated Slack)
Provide a test-only gateway endpoint so CI/manual tests can simulate Slack without
real credentials.

Manual scenario (sketch):
1) `eve project sync --local` + `eve agents sync --local`
2) `eve integrations connect slack --mode test --team-id TTEST`
3) `eve chat simulate slack --team-id TTEST --channel CTEST --user U123 --text "status"`
4) Verify event + job creation

## K8s Deployment Sketch (Org Runtime)

```
Namespace: eve-org-<org_slug>

Deployment: agent-runtime
  replicas: 3..10 (org size)
  service: agent-runtime.eve-org-<org_slug>
  volumes:
    - efs: /org (RWX)

Config:
  EVE_API_URL
  ORG_ID
  RUNTIME_MODE=org
  SHARD_COUNT=10
```

Optional env runtime: same container inside env namespace with `RUNTIME_MODE=env`.

## Data Model (Minimal Additions)

```
agents
  id, project_id, name, role, workflow, harness_profile, policies_json, access_json

teams
  id, project_id, lead_agent_id, dispatch_json

team_members
  team_id, agent_id

threads
  id, project_id, key, channel, peer, policy_json, summary, workspace_key

thread_messages
  id, thread_id, direction, actor_type, actor_id, body, job_id, created_at

thread_subscriptions
  id, thread_id, subscriber_type, subscriber_id, created_at

agent_state
  agent_id, project_id, summary, last_heartbeat_at

schedules
  id, project_id, cron, event_type, payload_json, enabled

agent_runtime_pods
  id, org_id, namespace, pod_name, status, last_seen_at, capacity_json

agent_placements
  agent_id, org_id, pod_id, shard_key, updated_at
```

Reuse existing tables:
- jobs, job_attempts, events, pipeline_runs
- external_identities, membership_requests, integrations

## Phased Rollout

### Phase 0: Schema + Routing
- Add agents/teams/threads/messages/schedules tables.
- Add route resolver (routes + permissions) in orchestrator.
- Compile legacy chat config into routes for compatibility.

### Phase 1: Agent Runtime MVP
- Org runtime deployment + sticky routing.
- Shared FS mount and thread summaries.
- Job execution via runtime (warm pods).

### Phase 2: Gateway + Identity
- Gateway plugins (Slack + WebChat first).
- External identity linking + membership approval flow.

### Phase 3: Mission Control UI
- Thread feed, job board, agent roster, notification queue.

### Phase 4: Memory + Standups
- Agent state summaries + daily standups via schedules.

## Why This Is Elegant
- **One continuity primitive** (thread).
- **One routing primitive** (route).
- **One execution primitive** (job).
- **Warm runtime** for low-latency at scale.
- **Repo-first configuration** with clean updates.
