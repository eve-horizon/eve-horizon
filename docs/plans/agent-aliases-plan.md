# Agent Aliases — Short Names for Chat Addressing

> **Status**: Implemented
> **Created**: 2026-03-10
> **Updated**: 2026-03-10
> **Relates to**: [ingress-aliases-plan.md](./ingress-aliases-plan.md), [agents-teams-threads-primitives-plan.md](./agents-teams-threads-primitives-plan.md)

## Problem

Agent slugs are always prefixed with `{projectSlug}-` by the pack resolver to ensure org-wide uniqueness. An agent with slug `pm` in project `pmbot` becomes `pmbot-pm`. In Slack, users must type `@eve pmbot-pm hello` — clunky and unintuitive.

This is the same problem ingress aliases solve for HTTP: instead of `web.acme-myapp-prod.lvh.me`, you declare `alias: eve-pm` and get `eve-pm.lvh.me`. We apply the same pattern to agent chat addressing.

## Design

Add an `alias` column to the `agents` table — a short vanity name that bypasses the prefixed slug for chat addressing.

| Concept | Example | Purpose |
|---------|---------|---------|
| **Slug** | `pmbot-pm` | Mechanical, always prefixed, guaranteed unique — canonical identifier |
| **Alias** | `pm` | Human-chosen, optional, org-scoped vanity name (first-come-first-served) |

Alias is optional; if omitted, the agent remains reachable only by its canonical prefixed slug.

No separate table needed. Unlike ingress aliases (which need a two-phase reserve/bind lifecycle for environment scoping), agents are delete-all/insert-all on sync, so alias cleanup is automatic.

### Resolution Order

Backwards-compatible — existing slugs resolve first:

```
@eve pmbot-pm hello     →  1. slug match ✓  →  route to agent
@eve pm hello           →  1. slug miss     →  2. alias match ✓  →  route to agent
@eve unknown hello      →  1. slug miss     →  2. alias miss     →  3. org default  →  route
@eve unknown hello      →  1. slug miss     →  2. alias miss     →  3. no default   →  error
```

### Shared Namespace

Aliases and slugs share the same routing namespace. If project A has slug `pm` and project B tries alias `pm`, the sync is rejected. This prevents ambiguous resolution.

This namespace is org-scoped (across projects) and case-insensitive.

### Reserved Names

Platform-reserved words that cannot be used as aliases:

```
agents, help, status, eve, admin, system, health
```

Alias matching is case-insensitive and normalized (for example, `PM`, ` pm `, and `Pm` all resolve as `pm`).

These conflict with existing gateway management commands (e.g., `@eve agents list`).

## YAML Declaration

In an AgentPack's `agents.yaml`:

```yaml
version: 1
agents:
  pm:
    name: "PM Coordinator"
    slug: pm
    alias: pm              # users type: @eve pm hello
    skill: pm-coordinator
    gateway:
      policy: routable
  tech-lead:
    name: "Tech Lead"
    slug: tech-lead
    alias: tech            # users type: @eve tech review this
    skill: tech-lead
    gateway:
      policy: routable
```

After sync with project slug `pmbot`:
- Canonical slugs: `pmbot-pm`, `pmbot-tech-lead` (still work)
- Aliases: `pm`, `tech` (short, human-friendly)

The pack resolver does NOT prefix aliases — that is the entire point. `prefixAgentSlugs()` only touches `agent.slug`; `alias` is preserved exactly as authored in `agents.yaml`.

## Implementation

### Phase 1: Foundation (no dependencies between these)

#### 1a. Migration — `packages/db/migrations/00076_add_agent_alias.sql`

```sql
ALTER TABLE agents ADD COLUMN IF NOT EXISTS alias TEXT;

-- Project-scoped uniqueness (DB safety net; org-scoped checks happen during sync)
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_project_alias
  ON agents(project_id, alias) WHERE alias IS NOT NULL;

-- Fast lookup for chat routing (joined with projects for org scoping)
CREATE INDEX IF NOT EXISTS idx_agents_alias
  ON agents(alias) WHERE alias IS NOT NULL;
```

Org-scoped uniqueness is enforced at the application level during sync — same pattern as slug uniqueness (which uses `listByOrgAndSlugs()` rather than a DB constraint).

#### 1b. Schema — `packages/shared/src/schemas/agent-config.ts`

Add `alias` to `AgentEntrySchema`:

```typescript
const AgentEntrySchema = z.object({
  name: z.string().optional(),
  slug: AgentSlugSchema.optional(),
  alias: AgentSlugSchema.optional(),   // short vanity name for chat
  // ... rest unchanged
});
```

Add reserved names:

```typescript
export const RESERVED_AGENT_ALIASES = new Set([
  'agents', 'help', 'status', 'eve', 'admin', 'system', 'health',
]);

export function isReservedAgentAlias(alias: string): boolean {
  return RESERVED_AGENT_ALIASES.has(alias.trim().toLowerCase());
}
```

#### 1c. DB Types + Queries — `packages/db/src/queries/agents.ts`

Add `alias: string | null` to `Agent` and `OrgAgentDirectoryItem` interfaces.

Add `alias` to `insert()` column list and `listDirectoryByOrg()` SELECT.

New query methods:

```typescript
async findByOrgAndAlias(orgId: string, alias: string): Promise<Agent | null> {
  const normalizedAlias = alias.trim().toLowerCase();
  const [row] = await db<Agent[]>`
    SELECT a.*
    FROM agents a
    JOIN projects p ON p.id = a.project_id
    WHERE p.org_id = ${orgId} AND lower(a.alias) = ${normalizedAlias}
    LIMIT 1
  `;
  return row ?? null;
},

async listByOrgAndAliases(orgId: string, aliases: string[]): Promise<Agent[]> {
  const normalizedAliases = aliases.map((a) => a.trim().toLowerCase());
  if (normalizedAliases.length === 0) return [];
  return db<Agent[]>`
    SELECT a.*
    FROM agents a
    JOIN projects p ON p.id = a.project_id
    WHERE p.org_id = ${orgId} AND lower(a.alias) = ANY(${normalizedAliases})
  `;
},
```

#### 1d. Response Schema — `packages/shared/src/schemas/agents.ts`

Add `agent_alias: z.string().nullable().optional()` to `OrgAgentDirectoryItemSchema` and `AgentSummarySchema`.

### Phase 2: Consumers (depends on Phase 1)

#### 2a. Sync Validation — `apps/api/src/projects/projects.service.ts`

In `syncAgentsConfig()`, after the existing slug uniqueness check (lines 642-664), add alias validation:

1. Normalize alias values early (`trim().toLowerCase()`).
1. Check aliases within sync payload for duplicates
2. Check against reserved names via `isReservedAgentAlias()`
3. Check alias doesn't collide with a slug in the same payload
4. Check org-scoped alias uniqueness via `listByOrgAndAliases()`
5. Check alias doesn't collide with existing slugs in the same org via `listByOrgAndSlugs()`

Add `alias: agent.alias ?? null` to the agent insert call (line 690).

#### 2b. Chat Routing — `apps/api/src/chat/chat.gateway.controller.ts`

In `routeBySlug()` (line 82), add alias as second resolution step:

```typescript
let agent = await this.agents.findByOrgAndSlug(orgId, slugHint);
let slugSource: 'hint' | 'alias' | 'default' = 'hint';

if (!agent) {
  agent = await this.agents.findByOrgAndAlias(orgId, slugHint);
  if (agent) slugSource = 'alias';
}

if (!agent) {
  // existing default fallback unchanged
}
```

#### 2c. Listen/Unlisten — `apps/api/src/chat/chat.service.ts`

Both `subscribeAgentToThread()` (line 373) and `unsubscribeAgentFromThread()` (line 407) resolve agents by slug. Add alias fallback:

```typescript
let agent = await this.agents.findByOrgAndSlug(orgId, agentSlug);
if (!agent) {
  agent = await this.agents.findByOrgAndAlias(orgId, agentSlug);
}
```

#### 2d. Directory — `apps/api/src/orgs/orgs.service.ts`

Add `agent_alias` to the directory response mapping (line 335-346).

#### 2e. Gateway Display — `apps/gateway/src/chat/gateway-chat.service.ts`

In `handleAgentsList()` (line 388-421), show alias as the preferred short name:

```
pmbot-pm (-> pm) -- pmbot (PM Coordinator)
devbot-code (-> code) -- devbot (Code Review Agent)
```

If an agent has no alias, continue to show the canonical slug only.

## Files Modified

| File | Change |
|------|--------|
| `packages/db/migrations/00076_add_agent_alias.sql` | New migration |
| `packages/shared/src/schemas/agent-config.ts` | Add `alias` to schema, reserved names |
| `packages/db/src/queries/agents.ts` | Add alias to types, queries, insert |
| `packages/shared/src/schemas/agents.ts` | Add `agent_alias` to directory/summary schemas |
| `apps/api/src/projects/projects.service.ts` | Alias validation in sync, pass to insert |
| `apps/api/src/chat/chat.gateway.controller.ts` | Alias resolution fallback in routing |
| `apps/api/src/chat/chat.service.ts` | Alias resolution in listen/unlisten |
| `apps/api/src/orgs/orgs.service.ts` | Include alias in directory response |
| `apps/gateway/src/chat/gateway-chat.service.ts` | Show alias in agent list display |

## What This Does NOT Change

- **Slug prefixing**: `prefixAgentSlugs()` is untouched. Aliases live alongside the prefixed slug as a separate field.
- **Gateway pass-through**: The gateway sends `agent_slug_hint` exactly as today. Alias resolution happens API-side.
- **Default agent routing**: Org `default_agent_slug` continues to work as the final fallback.
- **Existing slug addressing**: All existing prefixed slugs continue to resolve first.

## Verification

1. `pnpm build` — compiles clean
2. Targeted test sweep: schema validation (alias presence, reserved-name checks), migration/query behavior, sync validation and alias collision handling, chat routing order (slug then alias), and listen/unlisten via alias.
3. `./bin/eh test integration` — agent sync with alias, routing by alias, and collision detection
4. Manual: sync agents with aliases and verify `@eve pm hello` in the target chat gateway
