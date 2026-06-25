# Per-Agent Eve API Permissions

> **Status**: Ready to implement
> **Created**: 2026-03-23
> **Motivation**: Eden agents get 403 on `projects:write` and `envdb:write` because all agents receive the same hardcoded `DEFAULT_AGENT_PERMISSIONS` in their job token, with no way to customize.

## Problem

Every agent gets the same job token permissions (from `packages/shared/src/api-client/auth-client.ts:17`):

```typescript
const DEFAULT_AGENT_PERMISSIONS = [
  'jobs:read', 'jobs:write',
  'projects:read',
  'threads:read', 'threads:write',
  'envdb:read',
  'secrets:read',
  'builds:read',
  'pipelines:read',
];
```

Eden's `map-generator` agent needs `projects:write` and `envdb:write` to deploy and run migrations. The project set up an `EVE_SERVICE_TOKEN` with the right scopes, but the CLI ignores it because `EVE_JOB_TOKEN` takes priority (`packages/cli/src/lib/context.ts:177`).

There is no mechanism — per-agent or per-project — to customize job token permissions.

### Prerequisite: consolidate `DEFAULT_AGENT_PERMISSIONS`

There are currently **two** definitions that have drifted apart:

| Location | Exported? | Includes `projects:read`? | Used by |
|----------|-----------|---------------------------|---------|
| `packages/shared/src/api-client/auth-client.ts:17` | No (private) | **Yes** | `mintJobToken()` — the actual runtime behavior |
| `apps/api/src/auth/permissions.ts:102` | Yes | No | Role expansion display, CLI reference |

The `auth-client.ts` version is what `mintJobToken` actually uses, so `projects:read` IS in every agent token today. The API copy is stale. Step 1 consolidates these into a single source of truth.

## Design

### Data flow

```
agents.yaml             DB agents table        Agent Runtime            mintJobToken
───────────             ───────────────        ─────────────            ────────────
access:                 access_json: {         resolveAgentPerms()      permissions =
  permissions:            permissions:           reads agent record       DEFAULT ∪
    - projects:write       [projects:write,      merges DEFAULT ∪        agent extras
    - envdb:write           envdb:write]         agent perms           → JWT
```

### Key decisions

1. **Per-agent, not per-project** — different agents need different permissions (map-generator needs write, a reviewer only needs read)
2. **Additive on defaults** — agent permissions are `DEFAULT_AGENT_PERMISSIONS ∪ declared`, never replacing. Prevents footguns where an agent loses `jobs:read`
3. **Validated at sync time** — unknown permissions rejected when `agents.yaml` is synced, not at execution time
4. **No DB migration** — `access_json` is JSONB (`agents` table, migration 00032), already stores the full `access` block. Adding `permissions` to the Zod schema is sufficient
5. **`mintJobToken` already supports this** — it accepts `options.permissions` (line 43); we just need to plumb agent-declared permissions to the call site
6. **Pre-existing tokens are honoured** — `resolveInvocationJobToken` returns an explicit or embedded token without re-minting. Agent-specific permissions only apply when minting fresh. This is correct: the agent-runtime pre-mints with the right permissions via `getInvocationWithJobToken`, embedding the token in `invocation.data.__eve_job_token` before the inline execution path sees it.

## Implementation

### Step 1: Consolidate `DEFAULT_AGENT_PERMISSIONS` into `packages/shared/src/permissions.ts`

The canonical permissions module already exports `ALL_PERMISSIONS`, `isValidPermission`, and `Permission`. Add the default agent set here as the single source of truth.

**File:** `packages/shared/src/permissions.ts`

```typescript
/** Default permissions granted to agent job tokens. */
export const DEFAULT_AGENT_PERMISSIONS: readonly Permission[] = [
  'jobs:read',
  'jobs:write',
  'projects:read',     // Needed for `eve api call/spec/list`
  'threads:read',
  'threads:write',
  'envdb:read',
  'secrets:read',
  'builds:read',
  'pipelines:read',
];
```

Then update the two existing copies to import from here:

**File:** `packages/shared/src/api-client/auth-client.ts`
```diff
-const DEFAULT_AGENT_PERMISSIONS = [
-  'jobs:read',
-  ...
-];
+import { DEFAULT_AGENT_PERMISSIONS } from '../permissions.js';
```

**File:** `apps/api/src/auth/permissions.ts`
```diff
-export const DEFAULT_AGENT_PERMISSIONS: readonly Permission[] = [
-  'jobs:read',
-  ...
-];
+// Re-exported from shared — single source of truth
+export { DEFAULT_AGENT_PERMISSIONS } from '@eve/shared';
```

This ensures both `@eve/shared` and the API's `permissions.ts` re-export resolve to the same list, and `projects:read` is included everywhere (matching actual runtime behavior).

### Step 2: Schema — add `permissions` to `AgentAccessSchema`

**File:** `packages/shared/src/schemas/agent-config.ts`

```typescript
const AgentAccessSchema = z.object({
  envs: z.array(z.string()).optional(),
  services: z.array(z.string()).optional(),
  api_specs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),   // NEW
}).passthrough();
```

### Step 3: Validate permissions at sync time

**File:** `apps/api/src/projects/projects.service.ts`

In `syncAgentsConfig()` (line ~750), after `validateAgentAccessAgainstManifest`, add permission validation. `isValidPermission` is already exported from `@eve/shared` (via `packages/shared/src/permissions.ts`).

```typescript
import { isValidPermission } from '@eve/shared';

for (const [agentId, agent] of Object.entries(agentEntries)) {
  const rawPerms = (agent.access as Record<string, unknown> | undefined)?.permissions;
  if (!rawPerms) continue;
  if (!Array.isArray(rawPerms)) {
    throw new BadRequestException(`Agent ${agentId} permissions must be an array`);
  }
  const stringPerms = rawPerms.filter((perm): perm is string => typeof perm === 'string');
  if (stringPerms.length !== rawPerms.length) {
    throw new BadRequestException(`Agent ${agentId} permissions must be an array of strings`);
  }
  const unknown = stringPerms.filter((perm) => !isValidPermission(perm));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Agent ${agentId} declares unknown permission(s): ${unknown.join(', ')}`
    );
  }
}
```

### Step 4: Thread `permissions` through token resolution

**File:** `packages/shared/src/invoke/eve-credentials.ts`

Add `permissions` param to both functions. Note: permissions are only used on the `mintJobToken` path — if an explicit or embedded token already exists, it's returned as-is (this is correct; see key decision #6).

```typescript
export async function resolveInvocationJobToken(
  invocation: HarnessInvocation,
  explicitToken?: string,
  permissions?: string[],        // NEW
): Promise<string | undefined> {
  const token = explicitToken?.trim() || getInvocationJobToken(invocation);
  if (token) return token;
  const minted = await mintJobToken(invocation.jobId, { permissions });
  return minted?.access_token;
}

export async function writeEveCredentials(
  invocation: HarnessInvocation,
  invocationToken?: string,
  jobUserHome?: string,
  permissions?: string[],        // NEW
): Promise<string | undefined> {
  // ... existing ...
  const token = await resolveInvocationJobToken(invocation, invocationToken, permissions);
  // ... rest unchanged ...
}
```

### Step 5: Agent DB query

**File:** `packages/db/src/queries/agents.ts`

Add lookup by project + agent ID. `agentQueries` is already exported from `@eve/db` (via `queries/agents.js` → `queries/index.js` → `index.js`).

```typescript
async findByProjectAndId(projectId: string, agentId: string): Promise<Agent | null> {
  const [row] = await db<Agent[]>`
    SELECT * FROM agents WHERE project_id = ${projectId} AND id = ${agentId} LIMIT 1
  `;
  return row ?? null;
},
```

### Step 6: Agent runtime resolves agent permissions

**File:** `apps/agent-runtime/src/invoke/invoke.service.ts`

The service already imports from `@eve/db` (line 45) but doesn't include `agentQueries`. Add it:

```typescript
import {
  // ... existing imports ...
  agentQueries,            // NEW
} from '@eve/db';
```

Add to constructor (line 147):

```typescript
private agents: ReturnType<typeof agentQueries>;

constructor(@Inject('DB') private readonly db: Db) {
  // ... existing ...
  this.agents = agentQueries(db);       // NEW
}
```

Add a helper to look up agent-declared permissions and merge with defaults:

```typescript
import { DEFAULT_AGENT_PERMISSIONS } from '@eve/shared';

private async resolveAgentPermissions(
  invocation: HarnessInvocation,
): Promise<string[] | undefined> {
  if (!invocation.agentId || !invocation.projectId) return undefined;

  const agent = await this.agents.findByProjectAndId(
    invocation.projectId, invocation.agentId,
  );
  if (!agent) return undefined;

  const rawAccessPerms = (agent.access_json as Record<string, unknown> | undefined)?.permissions;
  if (!Array.isArray(rawAccessPerms)) return undefined;
  const accessPerms = rawAccessPerms.filter((p): p is string => typeof p === 'string');
  if (accessPerms.length === 0) return undefined;

  return [...new Set([...DEFAULT_AGENT_PERMISSIONS, ...accessPerms])];
}
```

Modify `getInvocationWithJobToken()` (line 673) to resolve and pass permissions:

```typescript
private async getInvocationWithJobToken(
  invocation: HarnessInvocation,
): Promise<HarnessInvocation> {
  const permissions = await this.resolveAgentPermissions(invocation);
  const token = await resolveInvocationJobToken(invocation, undefined, permissions);
  if (!token) return invocation;
  return {
    ...invocation,
    data: {
      ...(invocation.data ?? {}),
      __eve_job_token: token,
    },
  };
}
```

Also update the inline execution path (line 1052-1056):

```typescript
const permissions = await this.resolveAgentPermissions(invocationWithOptions);
const invocationToken = getInvocationJobToken(invocationWithOptions);
const jobToken = await writeEveCredentials(
  invocationWithOptions,
  invocationToken,
  jobUserHome,
  permissions,
);
```

## Usage — Eden example

```yaml
# agents.yaml
version: 1
agents:
  map-generator:
    name: Map Generator
    slug: map-generator
    skill: generate-maps
    harness_profile: claude
    access:
      envs: [sandbox]
      permissions:
        - projects:write
        - envdb:write
        - envs:write
```

The job token will include `DEFAULT_AGENT_PERMISSIONS ∪ [projects:write, envdb:write, envs:write]`.

After this, Eden can **remove** its `EVE_SERVICE_TOKEN` workaround entirely.

## Files changed

| File | Change |
|------|--------|
| `packages/shared/src/permissions.ts` | Add `DEFAULT_AGENT_PERMISSIONS` as single source of truth |
| `packages/shared/src/api-client/auth-client.ts` | Import `DEFAULT_AGENT_PERMISSIONS` from `../permissions.js` (remove local copy) |
| `apps/api/src/auth/permissions.ts` | Re-export `DEFAULT_AGENT_PERMISSIONS` from `@eve/shared` (remove local copy) |
| `packages/shared/src/schemas/agent-config.ts` | Add `permissions` to `AgentAccessSchema` |
| `packages/shared/src/invoke/eve-credentials.ts` | Thread `permissions` param |
| `packages/db/src/queries/agents.ts` | Add `findByProjectAndId` |
| `apps/api/src/projects/projects.service.ts` | Validate permissions at sync |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Import `agentQueries`, resolve agent permissions, pass to mint |

## Testing

1. **Unit**: Unknown permissions rejected at sync time
2. **Unit**: `resolveAgentPermissions` merges defaults + agent-specific and deduplicates
3. **Unit**: Agent with no `permissions` in access → returns `undefined` and runtime falls back to default permissions
4. **Unit**: `DEFAULT_AGENT_PERMISSIONS` includes `projects:read` and is the same constant in `@eve/shared` and `apps/api`
5. **Integration**: `syncAgentsConfig` rejects unknown permission values and accepts only catalog permissions from `ALL_PERMISSIONS`
6. **Integration**: Sync agents.yaml with permissions, verify `access_json` contains them and job token is minted with merged set
7. **Manual**: Eden map-generator with `projects:write` + `envdb:write` → deploy succeeds without `EVE_SERVICE_TOKEN`
