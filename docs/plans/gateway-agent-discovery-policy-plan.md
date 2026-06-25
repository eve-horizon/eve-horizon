# Gateway Agent Discovery Policy Plan

> Status: Draft
> Last Updated: 2026-02-10
> Purpose: Define how agents opt in to chat gateway discovery and routing, replacing the current "all agents visible" model.

## Problem

Today every agent with a slug is visible and routable from every chat gateway. The org directory (`@eve agents list`) returns all agents across all projects. Any Slack user can `@eve <any-slug> do something`.

Most agents aren't chatbots. Security reviewers, linters, deployers, team-internal specialists — these are backend workers triggered by jobs, pipelines, or team dispatch. Exposing them in Slack is noise at best, confusing at worst.

Agents should **opt in** to chat gateway discovery.

## Design: Three-Layer Gateway Exposure Policy

Gateway exposure is controlled at three layers, each using the existing overlay merge model:

### Layer 1 — Pack Default (set by pack author)

```yaml
# eve/pack.yaml
version: 1
id: software-factory

gateway:
  default_policy: none
```

The `default_policy` applies to every agent in the pack that doesn't declare its own `gateway` block.

### Layer 2 — Agent Override (set by pack author or project overlay)

```yaml
# agents.yaml
agents:
  factory_intake:
    slug: factory-intake
    gateway:
      policy: routable
      clients: [slack]

  factory_pm:
    slug: factory-pm
    gateway:
      policy: discoverable

  reviewer_security:
    slug: reviewer-security
    # no gateway block → inherits pack default (none)
```

### Layer 3 — Project Overlay (final say by project owner)

```yaml
# project agents/agents.yaml overlay
agents:
  factory_intake:
    gateway:
      clients: [slack, nostr]    # project enables Nostr too

  reviewer_security:
    gateway:
      policy: routable           # project decides to expose this one
```

## Policy Values

| Policy | `@eve agents list` | `@eve <slug> msg` | Team / Pipeline / Route dispatch |
|--------|--------------------|--------------------|----------------------------------|
| `none` | Hidden | Rejected | Always works |
| `discoverable` | Visible | Rejected (with hint) | Always works |
| `routable` | Visible | Works | Always works |

**Key principle**: Gateway policy never affects internal dispatch. Teams, pipelines, and chat.yaml routes always work regardless of gateway policy. This only controls **direct** slug-based access from external chat clients.

### Default when omitted

- Pack has no `gateway.default_policy` → defaults to `none` (safe by default)
- Agent has no `gateway` block → inherits resolved pack default
- Standalone agents (no pack) with no `gateway` block → `none`

## Client Restrictions

Optional per-agent restriction on which chat clients can reach the agent:

```yaml
gateway:
  policy: routable
  clients: [slack]          # only Slack; omitted = all clients
```

Pack authors can express "this agent is designed for Slack interactions" without blocking future clients. The project overlay can widen or narrow.

## Resolution Order

```
Pack gateway.default_policy          (base)
  → Agent gateway.policy override    (pack author intent)
    → Project overlay                (project owner final say)
```

Standard deep-merge applies. Setting `gateway: null` in an overlay reverts to pack default.

## Example: Factory Pack

A factory pack ships with sensible defaults out of the box:

```yaml
# eve/pack.yaml
gateway:
  default_policy: none       # workers by default

# eve/agents.yaml
agents:
  factory_intake:
    slug: factory-intake
    gateway: { policy: routable }      # the chatbot
  factory_pm:
    slug: factory-pm
    gateway: { policy: discoverable }  # visible, reached via routes
  reviewer_security:
    slug: reviewer-security
    # inherits: none — invisible, triggered by team dispatch
  reviewer_simplicity:
    slug: reviewer-simplicity
    # inherits: none
  deployer:
    slug: deployer
    # inherits: none
```

Project owners install the pack and get a clean Slack experience — only `factory-intake` shows up in `@eve agents list`. If they want to expose more, one line in their overlay.

## Implementation

### Schema Changes

**`PackYamlSchema`** — add optional `gateway` block:

```typescript
gateway: z.object({
  default_policy: z.enum(['none', 'discoverable', 'routable']).default('none'),
}).optional()
```

**`AgentConfigSchema`** — add optional `gateway` block per agent:

```typescript
gateway: z.object({
  policy: z.enum(['none', 'discoverable', 'routable']).optional(),
  clients: z.array(z.string()).optional(),  // e.g. ['slack', 'nostr']
}).optional()
```

### Pack Resolver Changes

In `pack-resolver.ts`, after slug prefixing:

1. Read `pack.yaml` `gateway.default_policy` (default: `none`)
2. For each agent, resolve effective gateway policy:
   - Agent has `gateway.policy` → use it
   - Agent has no `gateway` → use pack `default_policy`
3. Store resolved `gateway_policy` and `gateway_clients` on each agent record

### Database Changes

`agents` table — add two columns:

```sql
ALTER TABLE agents
  ADD COLUMN gateway_policy TEXT NOT NULL DEFAULT 'none'
    CHECK (gateway_policy IN ('none', 'discoverable', 'routable')),
  ADD COLUMN gateway_clients TEXT[] DEFAULT NULL;
  -- NULL = all clients, non-null = restricted to listed clients
```

### API Changes

**`GET /internal/orgs/{org_id}/agents`** (agent directory):
- Filter out agents where `gateway_policy = 'none'`
- Accept optional `?client=slack` query param to further filter by `gateway_clients`
- Response includes `gateway_policy` field per agent

**`POST /internal/orgs/{org_id}/chat/route`** (slug-based routing):
- After resolving agent by slug, check `gateway_policy`:
  - `none` → reject with `"Agent '{slug}' is not available via chat"`
  - `discoverable` → reject with `"Agent '{slug}' is not directly addressable. Use a project route or team dispatch."`
  - `routable` → proceed
- Check `gateway_clients` against request's `provider` field:
  - If `gateway_clients` is non-null and doesn't include provider → reject

**`POST /projects/{project_id}/chat/route`** (project-level routing via chat.yaml):
- No change — chat.yaml routes bypass gateway policy (internal dispatch)

### Gateway Changes

- Slack controller passes `client: 'slack'` when calling org-level route endpoint
- Future providers pass their own client identifier
- `@eve agents list` response only shows `discoverable` + `routable` agents

### Agent Sync Changes

`eve agents sync` — resolve and persist effective gateway policy:

1. During pack resolution, compute effective policy per agent
2. Include `gateway_policy` and `gateway_clients` in sync payload
3. API upserts these fields into `agents` table

### Overlay Merge

Standard deep-merge already handles this:

```yaml
# Pack agent defines:
gateway: { policy: routable, clients: [slack] }

# Project overlay:
gateway: { clients: [slack, nostr] }

# Effective (deep merge):
gateway: { policy: routable, clients: [slack, nostr] }
```

To revert an agent to pack default:
```yaml
gateway: null    # removes override, falls back to pack.default_policy
```

## Migration / Backwards Compatibility

### Existing agents (no gateway field)

Agents synced before this feature have no `gateway_policy` set. The migration sets them to `routable` for backwards compatibility:

```sql
-- Migration: existing agents retain current behavior
UPDATE agents SET gateway_policy = 'routable' WHERE gateway_policy IS NULL;
```

After migration, agents without a `gateway` block in their YAML resolve to their pack's `default_policy` (or `none` if no pack). This means:

- **Existing standalone agents**: Next sync sets them to `none` (safe default)
- **Pack agents**: Next sync resolves from pack's `default_policy`

Pack authors should add `gateway` blocks before the next sync after this ships. The CLI prints a warning for agents whose effective policy changed.

### CLI Warning

```
⚠  Gateway policy changed for 3 agents:
   reviewer-security: routable → none (pack default)
   reviewer-simplicity: routable → none (pack default)
   deployer: routable → none (pack default)

   Add gateway.policy overrides to keep them routable.
```

## Execution Order

### Phase 1 — Schema + Pack Resolution
- Add `gateway` to `PackYamlSchema` and `AgentConfigSchema`
- Update pack resolver to compute effective gateway policy
- Add `gateway_policy` and `gateway_clients` to agents table
- Update agent sync to persist gateway fields
- Add CLI warning for policy changes

### Phase 2 — API Enforcement
- Filter agent directory by gateway policy
- Enforce policy check on org-level slug routing
- Add `client` filter param to directory endpoint
- Update gateway to pass client identifier

### Phase 3 — Client Restrictions (can defer)
- Wire `gateway_clients` filtering into directory and routing
- Add client identifier to all gateway providers
- Future: per-client configuration beyond simple allow/deny

## Open Questions

1. **`discoverable` worth the complexity?** — Could simplify to binary `hidden`/`routable`. The `discoverable` middle ground serves "I want people to know this agent exists but route through the intake" — real use case, but adds a concept to explain.

2. **Client restrictions timing** — Useful in a multi-gateway world but only one provider exists today. Could defer to Phase 3 or later.

3. **Default for packs without `gateway`** — Currently `none` (safe). Alternative: `routable` (backwards-compatible but noisy). Safe default forces pack authors to be intentional about which agents are chatbots.

## Success Criteria

- Pack authors can control which agents appear in chat gateways
- Project owners can override pack defaults via standard overlay
- `@eve agents list` only shows opt-in agents
- Internal dispatch (teams, pipelines, chat.yaml routes) unaffected by gateway policy
- Existing agents don't silently disappear (migration + CLI warning)
