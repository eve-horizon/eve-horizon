# Agent App API Access

> Status: Draft
> Last Updated: 2026-02-12
>
> Inputs:
> - `docs/plans/api-spec-component-integration.md` (existing — API spec registration)
> - `docs/system/app-service-eve-api-access.md` (existing — app-to-Eve auth)
> - `docs/plans/eve-pm-living-spec-plan.md` (motivating use case)
>
> Dependencies:
> - API spec registration via `x-eve.api_spec` (implemented)
> - `eve api` CLI commands (implemented)
> - Job token minting via `EVE_JOB_TOKEN` (implemented)

## Brief

Eve apps publish OpenAPI specs via `x-eve.api_spec` in the manifest. The
`eve api` CLI can already list, inspect, and call those APIs — including from
inside a job using `EVE_JOB_TOKEN` for auth. Almost everything works today.

The gap is small: agents don't know the APIs exist, and the app can't verify
the job token. This plan closes both gaps with minimal changes.

## What Already Works

```bash
# Inside any Eve job, an agent can already run:
eve api list                                          # discover project APIs
eve api spec coordinator                              # read OpenAPI spec
eve api examples coordinator                          # get curl examples with auth
eve api call coordinator GET /api/projects/xxx/tree   # call with EVE_JOB_TOKEN
eve api call coordinator POST /api/nodes \
  --json '{"type":"requirement","title":"..."}'       # write operations too
```

The `eve api call` command (line 310 of `packages/cli/src/commands/api.ts`)
already resolves auth:

```typescript
const authToken = tokenOverride ?? process.env.EVE_JOB_TOKEN ?? context.token;
```

And passes it as a Bearer token to the app's `base_url`. This is the entire
agent-side tool surface. No custom tool injection, no harness integration, no
new resource URI scheme needed. Every harness that can run `eve` CLI commands
gets app API access for free.

## The Two Gaps

### Gap 1: Agent Awareness

Agents don't know about `eve api` commands or which APIs are available for
their job. The agent's system prompt or job description needs to tell them.

**Solution**: When creating a job that should use app APIs, include the API
name in the job description or a structured metadata field. The app (e.g., PM
coordinator) is responsible for telling the agent what's available.

Convention for job descriptions:

```
Triage intake item INTAKE-xxx.

Available APIs: coordinator (eve api call coordinator ...)
Use `eve api spec coordinator` to see available endpoints.
Use `eve api call coordinator <METHOD> <path>` to make calls.
```

Optional: a `--with-apis` flag on `eve job create` that appends this block
automatically:

```bash
eve job create \
  --description "Triage intake item" \
  --with-apis coordinator
```

This just appends the "Available APIs" instruction block to the job
description. Pure sugar — no backend changes.

### Gap 2: App-Side Token Verification

When `eve api call coordinator GET /path` runs, the CLI sends the
`EVE_JOB_TOKEN` as `Authorization: Bearer <token>` to the app's base URL. The
app needs to verify this token.

The `EVE_JOB_TOKEN` is a standard JWT signed by the Eve API. Apps need:

1. The Eve API's public key (or JWKS endpoint) to verify the signature.
2. A thin middleware to extract the job context from the token claims.

**Solution**: Publish an `@eve-horizon/auth` SDK and document the verification
pattern. The token already contains `project_id`, `job_id`, and scoped
permissions — apps just need to verify and read it.

```typescript
// @eve-horizon/auth — thin verification helper
import { verifyEveToken } from '@eve-horizon/auth';

// Express/NestJS middleware
async function agentAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  try {
    const claims = await verifyEveToken(token);
    req.agent = {
      jobId: claims.job_id,
      projectId: claims.project_id,
      permissions: claims.permissions,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid agent token' });
  }
}
```

`verifyEveToken` fetches the JWKS from `EVE_API_URL/.well-known/jwks.json`
(with caching) and validates the signature + expiry. Standard JWT verification
— any library can do it, but the SDK makes it one-liner.

**Alternative (even simpler)**: The app calls the Eve API to validate:

```
GET $EVE_API_URL/auth/verify
Authorization: Bearer <token>
```

Returns 200 with claims if valid. This avoids JWKS management entirely — the
app trusts Eve to validate its own tokens. Adds one network hop but is trivial
to implement.

---

## Implementation

### Step 1: `--with-apis` CLI Flag (Small)

Add `--with-apis` to `eve job create`. It:

1. Calls `eve api list` to verify the named APIs exist.
2. Appends an instruction block to the job description.
3. No backend changes.

```bash
eve job create \
  --description "Triage intake item INTAKE-xxx" \
  --with-apis coordinator
```

Produces a description like:

```
Triage intake item INTAKE-xxx.

---
**Available App APIs:**
- `coordinator` (openapi) — Use `eve api call coordinator <METHOD> <path>` to interact.
  Run `eve api spec coordinator` to see all endpoints.
  Auth is handled automatically via EVE_JOB_TOKEN.
```

### Step 2: Token Verification Endpoint (Small)

Add a verify endpoint to the Eve API (if not already present):

```
GET /auth/verify
Authorization: Bearer <token>
→ 200 { project_id, job_id, org_id, permissions, exp }
→ 401 { error }
```

Apps call this to validate agent tokens without managing keys.

### Step 3: `@eve-horizon/auth` SDK (Small)

Thin package (~50 lines) providing:

- `verifyEveToken(token)` — JWKS-based local verification (faster)
- `verifyEveTokenRemote(token)` — calls Eve API verify endpoint (simpler)
- NestJS guard and Express middleware examples

### Step 4: Documentation (Small)

Write a `docs/system/agent-app-api-access.md` guide:

- How apps declare `x-eve.api_spec`
- How agents discover and call app APIs
- How apps verify agent tokens
- Full example: PM coordinator + pm-intake agent

---

## PM App: Concrete Example

The PM coordinator manifest:

```yaml
services:
  coordinator:
    build:
      context: ./apps/coordinator
    ports: [3000]
    x-eve:
      api_spec:
        type: openapi
        spec_url: /openapi.json
```

When the coordinator creates a job for pm-intake:

```typescript
await eve.createJob({
  description: `Triage intake item ${item.id}.
    Read the current spec tree and compare against this intake item.
    Create new requirements or flag deltas for PM review.`,
  withApis: ['coordinator'],   // appends API instruction block
});
```

The pm-intake agent (running in any harness) does:

```bash
# Read the OpenAPI spec to understand available endpoints
eve api spec coordinator

# Search existing requirements
eve api call coordinator GET '/api/projects/xxx/nodes/search?q=password+reset'

# Create a new requirement
eve api call coordinator POST '/api/projects/xxx/nodes' \
  --json '{"type":"requirement","parent_id":"sec_auth","title":"User can reset password via email"}'

# Update an existing requirement
eve api call coordinator PATCH '/api/nodes/node_yyy' \
  --json '{"description":"Must also support SMS reset per compliance audit"}'
```

All auth is handled by `EVE_JOB_TOKEN`. All discovery is via `eve api`. No
custom tool injection, no harness changes, no new resource URI schemes.

---

## Code Surface

| Area | Key Files | Change |
|---|---|---|
| CLI job create | `packages/cli/src/commands/jobs.ts` | Add `--with-apis` flag |
| CLI api commands | `packages/cli/src/commands/api.ts` | No changes needed |
| Auth verify | `apps/api/src/auth/` | Add verify endpoint (if missing) |
| App auth SDK | `packages/app-auth/` | New package (~50 lines) |
| Documentation | `docs/system/agent-app-api-access.md` | New guide |

---

## What This Does NOT Cover

- **Native tool injection into harnesses**: Not needed. `eve api call` works
  from any harness that can run CLI commands (all of them).
- **Filtered/scoped API access**: The app handles authorization. If an agent
  shouldn't call certain endpoints, the app's middleware rejects those calls.
- **Cross-project API access**: Scoped to the job's project. Cross-project
  access is a separate concern.
- **MCP server generation**: Future enhancement. Could generate an MCP server
  from a registered OpenAPI spec, but `eve api call` is sufficient for now.

---

## Why This is Enough

The temptation is to build native tool injection — convert OpenAPI specs into
harness-native tools, inject them into the agent's context, handle auth
transparently. But that's solving a problem that `eve api call` already solves:

| Concern | `eve api call` | Native tool injection |
|---|---|---|
| Discovery | `eve api list` | Tool index file |
| Spec reading | `eve api spec <name>` | Hydrated spec in workspace |
| Auth | `EVE_JOB_TOKEN` (automatic) | Scoped app token (new) |
| Call execution | `eve api call <name> METHOD /path` | `call_app_api` tool |
| Harness support | All (runs CLI) | Per-harness adapters |
| Implementation cost | ~1 day (flag + docs) | ~2 weeks (5 phases) |

The CLI approach is universal, debuggable (`--print-curl`), and already
tested. Native tool injection can be added later if agents calling `eve api`
proves to be a bottleneck — but start simple.
