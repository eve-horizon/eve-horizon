# Agents & Teams (Current)

> Status: Current
> Last Updated: 2026-05-19
> Purpose: Describe agent primitives, team dispatch, and repo-first sync.

## Overview

Eve defines **agents** (personas with skills + policies), **teams** (dispatch groups), and **routes** (chat targets). Configuration is repo-first and synced into the API via `eve agents sync`.

## Repo-First Config

Manifest references YAML paths:

```yaml
x-eve:
  agents:
    config_path: agents/agents.yaml
    teams_path: agents/teams.yaml
    skills_root: skills/
  chat:
    config_path: agents/chat.yaml
```

Only `agents.config_path` is required for agents-only projects. If `teams_path`
or `chat.config_path` is omitted and the default local files are absent, the CLI
sends empty-but-valid defaults (`teams: {}` and `routes: []`). If a manifest
explicitly names `agents.config_path`, `agents.teams_path`, `x-eve.chat.config_path`,
or legacy top-level `chat.config_path`, the named file must exist.

The sync endpoint stores raw YAML + parsed objects + git metadata.

```bash
eve project sync --project <proj_id> --ref <git_sha> --dir <path>
```

Use `--local` for dev and `--allow-dirty` only for non-deployable experiments.
Use `eve agents config --repo-dir <path> --json` to inspect the locally resolved
policy plus `agents`, `teams`, and `chat_routes` summary arrays before syncing.

## agents.yaml (Shape)

```yaml
version: 1
agents:
  mission_control:
    slug: mission-control
    description: "Primary ops agent for deploys and incident response"
    skill: eve-mission-control
    workflow: assistant
    harness_profile: primary-orchestrator
    toolchains: [python]
    access:
      envs: [staging]
    policies:
      permission_policy: auto_edit
      git: { commit: manual, push: never }
    schedule:
      heartbeat_cron: "*/15 * * * *"
    gateway:
      policy: routable
      clients: [slack, app]
```

### Agent Slugs (Org-Unique)

Agents may declare a `slug` for cross-project addressing (e.g., Slack `@eve <agent-slug> <command>`). Slugs must be **unique across the org**; sync will fail if a slug already exists in another project.

Orgs may set a `default_agent_slug` used when a message doesn’t start with a known slug.
Set via `eve org update <org_id> --default-agent <slug>`.

Slack can also attach listeners with `@eve agents listen <agent-slug>` for passive ingestion.

### Gateway Exposure Policy

Agents can opt into gateway discovery/routing with `gateway.policy`:

- `none`: hidden (not listed, not routable)
- `discoverable`: listed but not routable
- `routable`: listed and routable via `@eve <agent-slug> <command>`

If `gateway.clients` is set, only those client identities can directly route to the agent. Use `app` for embedded app conversations, `slack` for Slack, and `webchat` for direct browser-to-gateway WebSocket chat. Omitting `clients` allows all providers.

Embedded app direct targets (`{ kind: "agent", agent_slug }`) reuse the same policy check as gateway chat: the agent must be `routable`, and `gateway.clients` must include `app` when present. Team targets apply the check to the team lead.

### Agent Toolchains

Agents can declare `toolchains` with valid values `python`, `media`, `rust`,
`java`, and `kotlin`. Agent jobs receive the requested toolchains in the runner
pod. Workflow agent steps resolve toolchains as `step.toolchains > agent config
toolchains > workflow.toolchains > []`; pipeline agent steps resolve
`step.toolchains > pipeline.toolchains > []`.

## teams.yaml (Shape)

```yaml
version: 1
teams:
  ops:
    lead: mission_control
    members: [reviewer]
    dispatch:
      mode: fanout
      max_parallel: 3
```

Dispatch modes:
- **fanout**: root + child jobs per agent
- **council/relay**: coordinated multi-agent dispatch modes

## Embedded App Conversations

Eve-hosted apps can use the project-scoped conversations facade to route browser or backend-proxied turns into the same agent/team/chat routing substrate:

```text
POST /projects/{project_id}/conversations
POST /projects/{project_id}/conversations/{app_key}/turns
GET  /projects/{project_id}/conversations/{app_key}/stream
```

The facade uses provider `app` and `account_id = app_id`, which lets `chat.yaml` routes target embedded app origins separately from Slack, Nostr, WebChat, or generic API clients. See [Chat Routing](./chat-routing.md) and [Eve SDK](./eve-sdk.md#embedded-conversation-pane).

## Related Docs

- [Chat Routing](./chat-routing.md)
- [Threads](./threads.md)
- [Agent Runtime](./agent-runtime.md)
