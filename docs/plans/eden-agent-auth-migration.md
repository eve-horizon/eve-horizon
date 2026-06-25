# Eden: Agent Auth Migration Guide

> **For**: The Eden testing/development agent
> **Context**: The Eve platform now includes agent identity in job tokens and a unified auth middleware. This doc explains what changed and what Eden should do.

## What Changed in the Platform

### 1. Agent Identity in Job Tokens

Job tokens now include two new claims when the job targets a specific agent:

```json
{
  "type": "job",
  "agent_slug": "map-generator",
  "email": "map-generator@eve.agent",
  "job_id": "eden-08c64625",
  "org_id": "org_example",
  "project_id": "proj_01xyz...",
  "permissions": ["jobs:read", "jobs:write", "projects:read", ...]
}
```

- **`agent_slug`**: Stable identifier for which agent is calling (e.g. `"map-generator"`, `"reviewer"`). Same across all jobs by that agent.
- **`email`**: `{agent_slug}@eve.agent` — stable per agent. Use this for RLS policies, audit logs, or ownership records instead of the old `{job_id}@eve.agent` pattern (which changed every job).

These claims flow through both verification paths:
- **Local JWKS** (`verifyEveToken()`): Decoded from JWT payload
- **Remote** (`verifyEveTokenRemote()` / `GET /auth/token/verify`): Returned in the response

### 2. New Unified Auth Middleware: `eveAuth()`

A new `eveAuth()` middleware handles **both** user SSO tokens and agent job tokens in a single middleware. It replaces the old pattern of maintaining two separate route trees.

```typescript
import { eveAuth, eveIdentityGuard, eveAuthConfig, eveAuthMe } from '@eve-horizon/auth';

// One middleware for everything
app.use(eveAuth());
app.get('/auth/config', eveAuthConfig());
app.get('/auth/me', eveAuthMe());
app.get('/protected', eveIdentityGuard(), (req, res) => {
  const identity = req.eveIdentity;
  // identity.isAgent === true  → agent request
  // identity.isAgent === false → user request
  // identity.agentSlug         → which agent (e.g. "map-generator")
  // identity.email             → real email (users) or "map-generator@eve.agent" (agents)
  // identity.orgId             → always set
  // identity.role              → org role
});
```

The `EveIdentity` interface:

```typescript
interface EveIdentity {
  id: string;           // User ID or actor user ID
  email: string;        // Real email (users) or {agent_slug}@eve.agent (agents)
  orgId: string;        // Organization scope
  role: 'owner' | 'admin' | 'member';
  isAgent: boolean;     // True for agent job tokens
  agentSlug?: string;   // Agent name (agents only)
  jobId?: string;       // Job ID (agents only)
  projectId?: string;   // Project ID (agents only)
  permissions?: string[];
}
```

### 3. SDK Version

These changes are in `@eve-horizon/auth` — the next SDK publish (`sdk-v*` tag) will include them. Until then, apps using the SDK from the monorepo workspace get them immediately.

## What Eden Should Do

Eden is currently a **frontend-only React SPA** using Supabase auth. It doesn't use `@eve-horizon/auth` on the backend. Here's the recommended migration path:

### Option A: If Eden Adds a Backend Server (Express/NestJS)

If Eden adds a Node.js backend (e.g., for the Supabase Edge Functions or a proper API server):

1. **Install** `@eve-horizon/auth`
2. **Use `eveAuth()`** as global middleware — handles both Supabase-linked users and Eve agent tokens
3. **Use `req.eveIdentity.isAgent`** to branch logic:
   - Agents get automatic access based on `permissions` in their token
   - Users go through normal Supabase auth + RLS
4. **Use `req.eveIdentity.agentSlug`** for per-agent behavior (e.g., "map-generator can write, reviewer can only read")

### Option B: If Eden Stays Frontend-Only (Current State)

The Supabase Edge Functions already forward `Authorization` headers to the Eve API. The agent identity improvement means:

1. **Agent emails are now stable** — `map-generator@eve.agent` instead of `eden-08c64625@eve.agent`. If Eden stores agent emails in Supabase tables (e.g., as `owner` or `created_by`), they're now meaningful identifiers.

2. **The invite edge function** (`supabase/functions/invite-to-project/index.ts`) already forwards the auth header to Eve API endpoints. Agent tokens with `agent_slug` claims flow through automatically — no changes needed.

3. **If Eden needs to distinguish agents from users** in edge functions, decode the JWT payload:
   ```typescript
   // In a Supabase Edge Function
   const token = req.headers.get('authorization')?.replace('Bearer ', '');
   if (token) {
     const payload = JSON.parse(atob(token.split('.')[1]));
     if (payload.type === 'job') {
       // This is an agent request
       console.log('Agent:', payload.agent_slug);  // e.g. "map-generator"
       console.log('Email:', payload.email);        // e.g. "map-generator@eve.agent"
     }
   }
   ```

### What NOT to Do

- **Don't synthesize agent emails yourself** — the platform now does this. `{agent_slug}@eve.agent` is the canonical format.
- **Don't check `type === 'user'` to reject agents** — use `eveAuth()` which handles both.
- **Don't maintain two middleware stacks** — `eveAuth()` replaces the old `eveUserAuth()` + `eveAuthMiddleware()` split.

## Testing

After the platform is deployed with these changes (next `release-v*` tag), agent job tokens will automatically include `agent_slug`. You can verify by decoding the JWT:

```bash
# In an agent workspace, decode the job token
echo $EVE_JOB_TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
# Should show: "agent_slug": "map-generator", "email": "map-generator@eve.agent"
```

Or via the verify endpoint:
```bash
eve api call -- GET /auth/token/verify
# Response includes agent_slug field for agent tokens
```
