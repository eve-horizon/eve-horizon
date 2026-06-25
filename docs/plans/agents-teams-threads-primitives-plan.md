# Agents + Teams + Threads Primitives Plan

> Status: Completed
> Last Updated: 2026-02-04
> Purpose: Add core data model + APIs for agents, teams, threads, routes, schedules.
> Order: 1 (foundation)

## Dependencies
- v3 plan: docs/ideas/channel-integrations-unified-plan-v3.md
- Agent Runtime plan (agent-runtime-org-plan.md)

## Goals
- First-class agents and teams with repo-first config.
- Threads/messages as the continuity layer for chat and mission control.
- Routes as the single routing primitive (agents/teams/workflows/pipelines).

## Non-goals
- UI for mission control (separate plan).
- Full multi-provider gateway (Slack plan handles Slack first).

## Data Model
Add tables:
- `agents` (id, project_id, name, role, workflow, harness_profile, policies_json, access_json)
- `teams` (id, project_id, lead_agent_id, dispatch_json)
- `team_members` (team_id, agent_id)
- `threads` (id, project_id, key, channel, peer, policy_json, summary, workspace_key)
- `thread_messages` (id, thread_id, direction, actor_type, actor_id, body, job_id, created_at)
- `thread_subscriptions` (id, thread_id, subscriber_type, subscriber_id)
- `schedules` (id, project_id, cron, event_type, payload_json, enabled)
- `agent_state` (agent_id, project_id, summary, last_heartbeat_at)

## Config Sync (Repo-First)
- Manifest points to repo paths:
  - `x-eve.agents.config_path` -> `agents.yaml`
  - `x-eve.agents.teams_path` -> `teams.yaml`
  - `chat.config_path` -> `chat.yaml`
- New API: `POST /projects/:id/agents/sync`
  - Stores raw YAML + parsed objects + git_sha/branch/ref
  - Rejects missing/invalid config

## Routing / Orchestrator
- Route matching uses `chat.yaml` (compiled into DB).
- Targets:
  - `agent:<id>`
  - `team:<id>`
  - `workflow:<name>`
  - `pipeline:<name>`
- Team dispatch creates root job + child jobs (one per agent).

## API Surface
- `GET /projects/:id/agents`
- `GET /projects/:id/teams`
- `GET /projects/:id/routes`
- `GET /projects/:id/threads`
- `GET /threads/:id`
- `POST /threads/:id/messages`
- `GET /projects/:id/schedules`
- `POST /projects/:id/schedules`

## Work Breakdown

### Phase 1: Schema + Sync
- [x] Add DB tables + migrations.
- [x] Implement `agents sync` endpoint.
- [x] Parse + validate YAML schemas.

### Phase 2: Routing + Threads
- [x] Route matcher (chat.yaml -> targets).
- [x] Thread create/resolve + message logs.
- [x] Event types: `chat.message.received`, `chat.message.sent`.

### Phase 3: Team Dispatch
- [x] Fanout dispatch (root + child jobs).
- [x] Lead summarization job (optional).

### Phase 4: Schedules
- [x] Cron schedules -> events.
- [x] Agent heartbeat workflow.

## Tests
- Unit: YAML validation, route matching, team dispatch.
- Integration: create thread, post message, dispatch jobs.

## Spec Appendix

### agents.yaml (schema sketch)
```yaml
version: 1
agents:
  <agent_id>:
    skill: <skill_name>           # OpenSkills skill dir
    workflow: <workflow_name>
    harness_profile: <profile>    # from manifest x-eve.agents.profiles
    access:
      envs: [staging, production]
      services: [api, web]
      api_specs: [api]
    policies:
      permission_policy: auto_edit|never|yolo
      git: { commit: never|manual, push: never|on_success }
    schedule:
      heartbeat_cron: "*/15 * * * *"
```

Validation rules:
- `agents.<id>.skill` must exist under `skills_root`.
- `access.envs` must be defined in manifest.
- `access.services` must exist under manifest `services`.

### teams.yaml (schema sketch)
```yaml
version: 1
teams:
  <team_id>:
    lead: <agent_id>
    members: [<agent_id>, ...]
    dispatch:
      mode: fanout|council|relay
      max_parallel: 3
      merge_strategy: lead_summarize
```

### chat.yaml (schema sketch)
```yaml
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: team:mission_control | agent:<id> | workflow:<name> | pipeline:<name>
    permissions:
      project_roles: [member, admin, owner]
      envs: [staging]
```

Routing precedence:
1) Exact command routes (regex) in order
2) First match wins
3) `default_route` fallback if configured

Thread key policy (default):
- `thread_key = <provider>:<account_id>:<channel_or_peer>`
- Reset rules: idle timeout or explicit reset command
