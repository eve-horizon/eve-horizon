# Channel + Multi-Agent Unified Plan v2 (Mission Control)

> Status: Idea
> Last Updated: 2026-02-03
> Purpose: A unified, elegant plan for channel integrations and multi-agent teams, aligned with Eve's primitives.
>
> Inputs:
> - docs/plans/channel-integrations-unified-plan.md
> - docs/ideas/chat-mission-control.md
> - docs/ideas/chat-client-integrations.md
> - docs/ideas/chat-gateway-clawdbot.md
> - docs/ideas/channel-integrations-gap-analysis.md
> - docs/system/unified-architecture.md
> - docs/system/events.md
> - docs/system/pipelines.md
> - docs/system/workflows.md
> - docs/system/manifest.md
> - docs/system/job-api.md
> - docs/system/agent-harness-design.md

## Core Principle
Everything is a **thread**, a **route**, and a **job**.

```
message/schedule/event -> thread -> route -> job(s) -> response -> thread
```

- **Thread** provides continuity and shared context.
- **Route** provides deterministic, permissioned mapping to execution.
- **Job** remains the single execution unit for all work.

This keeps the event spine and job model intact while adding the minimal primitives
needed for OpenClaw-style teams, mission control, and multi-channel messaging.

## Design Goals
- Multi-agent teams with persistent identity, memory, and coordination.
- Channel integrations as first-class event sources, with outbound replies.
- A shared mission-control surface (tasks, comments, activity, notifications).
- Permissioned routing with strong defaults (deny by default for unsafe actions).
- Minimal new primitives; reuse jobs, workflows, pipelines, events.

## Minimal New Primitives (v2)

### 1) Agent (roster entry)
A named persona with policy, skills, and runtime profile. Agents are project-scoped.

```
agent:
  id: agent_main
  name: Jarvis
  role: squad_lead
  workflow: assistant
  harness_profile: primary-orchestrator
  policies: { permission_policy: auto_edit, git: { commit: manual, push: never } }
  context: { thread_summary: true, last_n_messages: 12, agent_state: true }
  schedule: { heartbeat_cron: "*/15 * * * *" }
```

Why: provides persistent identity, role clarity, and policy defaults.

### 2) Team
A grouping of agents with a dispatch policy (fanout, council, relay). Teams are
routing targets and power multi-agent collaboration.

```
team:
  id: mission_control
  lead: agent_main
  members: [agent_product, agent_research, agent_writer]
  dispatch:
    mode: fanout
    max_parallel: 3
    merge_strategy: lead_summarize
```

### 3) Thread (unified conversation context)
A single continuity primitive for chat sessions, internal mission-control threads,
and job-linked discussions.

```
thread:
  id: thr_xxx
  key: slack:workspace:C12345
  channel: slack
  peer: C12345
  policy: { scope: per_peer, reset: { mode: idle, minutes: 120 } }
  summary: "Last 3 decisions..."
  workspace_key: session:thr_xxx
```

Threads are the system of record for multi-turn context, not job logs.

### 4) Message (thread log)
Unified inbound/outbound messages with optional job linkage.

```
message:
  id: msg_xxx
  thread_id: thr_xxx
  direction: inbound|outbound
  actor: { type: user|agent|system, id: user_abc }
  body: "Status update..."
  job_id: myproj-a3f2dd12
```

### 5) Subscription + Notification
Thread participation is explicit and drives @mentions and activity alerts.

- auto-subscribe on comment, assignment, or mention
- notifications delivered via channel or internal UI

### 6) Schedule (event spine source)
Cron-defined schedules that emit events (e.g., heartbeats, standups).

```
schedule:
  id: sch_agent_main_heartbeat
  cron: "*/15 * * * *"
  event_type: agent.heartbeat
  payload: { agent_id: agent_main }
```

## Agent Runtime (Org App)
The Agent Runtime is a long-lived Eve-compatible service that hosts many agents
in-process. It replaces per-job pod startup with warm execution, while keeping
jobs as the system of record.

Key properties:
- Agents are first-class entities, but **not** 1:1 pods.
- Runtime pods are warm and reused; agents are scheduled onto them.
- Each chat turn still creates a job attempt for auditability.
- Execution happens inside the runtime process (low latency).

### Runtime Modes

1) **Org Runtime (default)**
- Runs in an org control namespace.
- Uses `env_name` on jobs to operate "in env context" without living inside it.
- Safer: app deploys do not restart the runtime.

2) **Env Runtime (opt-in)**
- Runs inside a specific app environment namespace.
- Direct access to `svc.cluster.local` for env services.
- Tradeoff: tied to app deployments and env lifecycle.

### Shared Filesystem (Mission Control FS)
Provide a per-org RWX volume (e.g., EFS) for durable agent memory and shared docs.
Mount at `/org` in runtime pods.

Suggested layout:
- `/org/agents/<agent_id>/` - agent memory and working notes
- `/org/threads/<thread_id>/` - thread summaries and transcripts
- `/org/docs/<doc_id>/` - shared artifacts
- `/org/shared/` - explicit shared space

Guidance:
- Keep authoritative records in DB; use FS for human-readable memory and docs.
- Job workspaces remain per-attempt and isolated (do not live under `/org`).

## Configuration (Repo-First, Elegant)
Agents and teams are configured in the **project repo** (manifest-first). This keeps
agent definitions versioned, reviewable, and portable.

### Project Modes (All Valid)
1) **Services-only**: standard app services, no agents defined.
2) **Agents-only**: repo contains only agents + skills; no services.
3) **Hybrid**: services + agents in one repo (default for product teams).

### Where Agents/Teams Live
Use `.eve/manifest.yaml` as the single source of truth:

```yaml
x-eve:
  agents:
    version: 2
    roster:
      agent_main:
        name: Jarvis
        role: squad_lead
        workflow: assistant
        harness_profile: primary-orchestrator
        access:
          envs: [staging, production]
          services: [api, web]
          api_specs: [api]
        policies:
          permission_policy: auto_edit
          git: { commit: manual, push: never }
    teams:
      mission_control:
        lead: agent_main
        members: [agent_main]
        dispatch: { mode: fanout, max_parallel: 2 }

chat:
  default_route: route_default
  routes:
    - id: route_default
      match: ".*"
      target: team:mission_control
      permissions:
        project_roles: [member, admin, owner]
```

Optional (future): a repo-local `agents/` directory for prompts/templates/docs:
```
agents/
  agent_main/
    SYSTEM.md
    SOP.md
    references/
```
This stays optional; the manifest remains canonical.

### How Agents Access Services
- Agents operate **in an env context** via `env_name` on jobs.
- Access is explicit:
  - `access.envs` limits which envs an agent can target.
  - `access.services` limits which manifest services can be called.
  - `access.api_specs` grants access to service API specs (`x-eve.api_spec`).
- Default scope is **same project**; cross-project access is an explicit allowlist (future).
- Secrets resolve via standard Eve scopes (org/project/env).

### How Agents Are Updated
- **Config changes**: update manifest → `eve project sync` updates DB.
- **Behavior changes**: update repo (skills/prompts/docs) → next job clone sees it.
- **Runtime reload**: Agent Runtime watches manifest revision and hot-reloads
  agent/team definitions without redeploy.

## Refactor: Unify Chat Assistants + Commands -> Routes
Replace `chat.assistants` + `chat.commands` with a single `chat.routes` list.
This unifies command routing, default assistants, and team dispatch.

```
chat:
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

Targets can be:
- `agent:<id>`
- `team:<id>`
- `workflow:<name>`
- `pipeline:<name>`

Backward compatibility: keep `chat.assistants`/`chat.commands` as sugar that
compiles to routes in the sync layer.

## Manifest Extensions (v2)
Extend `x-eve.agents` to include a roster and teams while keeping existing
harness profiles intact.

```yaml
x-eve:
  agents:
    version: 2

    profiles: # existing harness profiles (unchanged)
      primary-orchestrator:
        - harness: mclaude
          model: opus-4.5
          reasoning_effort: high

    roster:
      agent_main:
        name: Jarvis
        role: squad_lead
        workflow: assistant
        harness_profile: primary-orchestrator
        policies:
          permission_policy: auto_edit
          git: { commit: manual, push: never }
        context:
          thread_summary: true
          last_n_messages: 12
          agent_state: true
        schedule:
          heartbeat_cron: "*/15 * * * *"

      agent_product:
        name: Shuri
        role: product_analyst
        workflow: assistant
        harness_profile: primary-orchestrator
        policies:
          permission_policy: never
          git: { commit: never, push: never }

    teams:
      mission_control:
        lead: agent_main
        members: [agent_product]
        dispatch:
          mode: fanout
          max_parallel: 2
          merge_strategy: lead_summarize

chat:
  default_route: route_default
  routes:
    - id: route_default
      match: ".*"
      target: team:mission_control
      permissions:
        project_roles: [member, admin, owner]
```

## Execution Flow (Unified)

### A) Channel message -> Team fanout
1) Gateway receives inbound message and normalizes payload.
2) Create/resolve thread (by channel+peer policy).
3) Match route -> `team:mission_control`.
4) Orchestrator creates a **root job** and **child jobs** per agent.
5) Agent Runtime executes child jobs in warm pods.
6) Agent jobs write to the thread; lead agent summarizes and responds.

### B) Command -> Pipeline
1) Message matches a route with `target: pipeline:deploy-staging`.
2) Permissions enforced (roles + env).
3) Pipeline run created; outputs summarized to the thread.

### C) Heartbeats
1) Scheduler emits `agent.heartbeat` events.
2) Route targets the agent workflow with `agent_state` injected.
3) Agent Runtime executes heartbeat jobs in warm pods.
4) Agent checks assignments, mentions, and updates thread/jobs.

## Mission Control (UI and API)
Mission Control is a UI on top of **threads + jobs + agents + messages**.
No new "task" primitive is needed.

- **Tasks** = Jobs (phase -> board columns)
- **Comments** = Messages
- **Activity** = Events + Messages + Job transitions
- **Docs** = Job artifacts or message attachments
- **Notifications** = Thread subscriptions + mentions

## Permissions and Safety
- Default deny for any route without explicit permissions.
- Role-based checks on routes (org/project roles, env constraints).
- Safe agent defaults for arbitrary prompts:
  - `permission_policy: never`
  - `git.commit: never`, `git.push: never`
  - `workspace.mode: isolated` (or session-only with no push)

## Data Model Sketch (Minimal Additions)

```
agents
  id, project_id, name, role, workflow, harness_profile, policies_json

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

## API Surface (Sketch)
- Agents/Teams:
  - `GET /projects/{id}/agents`
  - `GET /projects/{id}/teams`
- Threads/Messages:
  - `GET /projects/{id}/threads`
  - `GET /threads/{id}`
  - `POST /threads/{id}/messages`
  - `POST /threads/{id}/subscribe`
- Routes:
  - `GET /projects/{id}/routes`
- Schedules:
  - `GET /projects/{id}/schedules`
  - `POST /projects/{id}/schedules`

## Refactors (Allowed in Pre-MVP)
- Rename `chat_sessions` -> `threads`.
- Merge `chat_messages` into `thread_messages` (same table).
- Replace `chat_assistants` + `chat_commands` with `chat.routes`.
- Extend `x-eve.agents` to include roster + teams; keep existing profiles.

## Phased Rollout

### Phase 0: Schema + Routing
- Add agents, teams, threads, messages, subscriptions, schedules tables.
- Add route resolver (routes + permissions) in the orchestrator.
- Compile legacy `chat.*` into routes for compatibility.

### Phase 1: Gateway v2 + Identity
- Gateway plugin system (Slack + WebChat first).
- External identity linking + membership approval flow.
- Thread creation + message logging + outbound replies.

### Phase 2: Multi-Agent Dispatch
- Team dispatch policies (fanout, council, relay).
- Child job graph generation with lead summarization.
- Agent state + heartbeat scheduling.

### Phase 3: Mission Control UI
- Thread feed, job board, agent roster, notification queue.
- Activity stream from events + messages + job transitions.

### Phase 4: Memory + Standups
- Thread summaries + agent state summaries.
- Daily standup workflow (schedule -> summary -> post).

## Runtime Sharding + Sticky Routing
To support hundreds of agents per org without hundreds of pods:

- **Consistent hashing** on `agent_id` assigns each agent to a runtime pod shard.
- **Sticky routing** keeps an agent on the same pod for warm memory/cache.
- **Failover**: if a pod is unhealthy, rehash to the next shard and mark the agent
  as migrated.
- **Capacity**: pods advertise max concurrent agents; rebalancer shifts low-activity
  agents if needed.

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

Optional env runtime:
- Same container, deployed inside env namespace with `RUNTIME_MODE=env`.
- Only handles jobs targeting that env.

## Why This Is Elegant
- **One continuity primitive** (thread) instead of separate chat/session/task systems.
- **One execution primitive** (job), with teams producing job graphs.
- **One routing primitive** (route) for commands and assistants.
- **One event spine** for all triggers (channels + schedules).

## Open Questions
- Should thread summaries live in DB only, or also persist to workspace files?
- Do we need per-team routing policies (e.g., only lead can respond)?
- How do we expose agent state to jobs safely without leaking secrets?
- Should thread subscriptions be auto-synced to channel membership?
