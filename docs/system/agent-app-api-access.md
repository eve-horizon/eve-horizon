# Agent App API Access

How Eve agents discover, call, and authenticate with app-published APIs.

## Overview

Eve apps publish HTTP APIs via `x-eve.api_spec` in their manifest. Agents
access these APIs through the `eve api` CLI — no custom tool injection, no
harness-specific adapters.

```
Agent (any harness)
  └─ eve api call coordinator GET /api/nodes
       └─ CLI resolves auth (EVE_JOB_TOKEN)
            └─ HTTP request to app service
                 └─ App verifies token via Eve API or JWKS
```

## For App Developers

### 1. Declare Your API in the Manifest

Add `x-eve.api_spec` to your service in `.eve/manifest.yaml`:

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

On deploy, Eve fetches your OpenAPI spec from `spec_url` and registers it.
The spec is then available via `eve api spec coordinator`.

### 2. Verify Agent Tokens

When an agent calls your API, the request includes an `Authorization: Bearer`
header with an `EVE_JOB_TOKEN`. Verify it using one of these approaches:

**Option A: Remote verification (simplest)**

Call the Eve API to validate the token — no key management needed:

```typescript
import { verifyEveTokenRemote, eveAuthMiddleware } from '@eve-horizon/auth';

// One-liner middleware for Express:
app.use('/api', eveAuthMiddleware({ strategy: 'remote' }));

// Or verify manually:
const claims = await verifyEveTokenRemote(token);
// claims.project_id, claims.job_id, claims.permissions
```

The middleware calls `GET $EVE_API_URL/auth/token/verify` with the token and
attaches the claims to `req.agent`.

**Option B: Local JWKS verification (faster)**

Fetch Eve's public keys once and verify tokens locally:

```typescript
import { verifyEveToken, eveAuthMiddleware } from '@eve-horizon/auth';

// Express middleware with local verification:
app.use('/api', eveAuthMiddleware({ strategy: 'local' }));

// Or verify manually:
const claims = await verifyEveToken(token);
```

JWKS is fetched from `$EVE_API_URL/.well-known/jwks.json` and cached for 15
minutes.

**Option C: Roll your own**

The token is a standard RS256 JWT. Any JWT library can verify it against the
JWKS endpoint. Claims include:

| Claim | Description |
|-------|-------------|
| `type` | `"job"` for agent tokens |
| `user_id` | The user who created the job |
| `org_id` | Organization ID |
| `project_id` | Project ID |
| `job_id` | Job ID |
| `permissions` | Array of granted permissions |
| `exp` | Expiry (Unix timestamp, max 24h) |

### 3. Authorize Requests

The token claims tell you who is calling and with what context. Use
`project_id` to scope access — agents should only access resources within
their project:

```typescript
async function requireProjectAccess(req, res, next) {
  if (!req.agent) return res.status(401).json({ error: 'Not authenticated' });
  if (req.agent.project_id !== req.params.projectId) {
    return res.status(403).json({ error: 'Cross-project access denied' });
  }
  next();
}
```

## For Agent Developers

### Discovering APIs

From inside a job, list available APIs:

```bash
eve api list                    # List all APIs in the project
eve api spec coordinator        # Read the OpenAPI spec
eve api examples coordinator    # Get curl examples with auth
```

### Calling APIs

Use `eve api call` — auth is handled automatically via `EVE_JOB_TOKEN`:

```bash
# Read operations
eve api call coordinator GET /api/projects/xxx/nodes

# Write operations
eve api call coordinator POST /api/nodes \
  --json '{"type":"requirement","title":"User can reset password"}'

# Update operations
eve api call coordinator PATCH /api/nodes/node_yyy \
  --json '{"description":"Must also support SMS reset"}'

# Debug: see the curl command without executing
eve api call coordinator GET /api/nodes --print-curl
```

### Automatic API Instructions

When creating a job that should use app APIs, use `--with-apis`:

```bash
eve job create \
  --description "Triage intake item INTAKE-xxx" \
  --with-apis coordinator
```

This appends an instruction block to the job description telling the agent
which APIs are available and how to use them. The agent sees:

```
---
**Available App APIs:**
- `coordinator` (openapi) — Use `eve api call coordinator <METHOD> <path>` to interact.
  Run `eve api spec coordinator` to see all endpoints.
  Auth is handled automatically via EVE_JOB_TOKEN.
```

Multiple APIs: `--with-apis coordinator,analytics`.

## Server-Side `with_apis`

`app_apis` is a first-class field in `JobHintsSchema`. The server validates that
each referenced API exists in the project and generates the instruction block.
The CLI `--with-apis` flag is a thin wrapper that passes `app_apis` through hints.

### How It Works

| Entry Point | How `app_apis` Reaches the Server |
|-------------|-----------------------------------|
| CLI `--with-apis` | Passed as `hints.app_apis` in the job create payload |
| Workflow `with_apis` | Extracted from the workflow definition at invocation time |
| SDK `createJob` | Provided in the `hints` object directly |
| API `POST /jobs` | Included in the `hints` body field |

In all cases, the server:

1. Validates each API name exists in the project's registered APIs
2. Generates the instruction block (API name, type, usage commands)
3. Appends the block to the job description

### Workflow-Level `with_apis`

Workflows declare APIs at the workflow level. All steps inherit them:

```yaml
workflows:
  my-workflow:
    with_apis:
      - coordinator
      - analytics
    steps:
      - name: step1
        agent:
          name: agent1
      - name: step2
        depends_on: [step1]
        agent:
          name: agent2
```

Each child job in the workflow receives the API instruction block. See
[workflows.md](./workflows.md) for the full workflow schema.

### Programmatic Usage

When creating jobs via the SDK or API, pass `app_apis` in hints:

```typescript
await eve.createJob({
  description: "Process data",
  hints: {
    app_apis: ["coordinator", "analytics"]
  }
});
```

```bash
# Equivalent via API
curl -X POST "$EVE_API_URL/projects/$PROJECT_ID/jobs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Process data",
    "hints": { "app_apis": ["coordinator", "analytics"] }
  }'
```

## Example: PM Coordinator + Agent

The PM coordinator app creates a triage job:

```typescript
await eve.createJob({
  description: `Triage intake item ${item.id}.
    Read the current spec tree and compare against this intake item.
    Create new requirements or flag deltas for PM review.`,
  withApis: ['coordinator'],
});
```

The pm-intake agent (running in any harness) executes:

```bash
# Discover endpoints
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

## Token Verification Endpoint

Apps can verify tokens by calling the Eve API directly:

```
GET /auth/token/verify
Authorization: Bearer <token>

200 OK
{
  "valid": true,
  "type": "job",
  "user_id": "user_abc",
  "org_id": "org_xyz",
  "project_id": "proj_123",
  "job_id": "myproj-a3f2dd12",
  "permissions": ["read", "write"],
  "role": "member"
}

401 Unauthorized
{ "error": "Invalid or expired token" }
```

## Code Surface

| Area | Files | Purpose |
|------|-------|---------|
| CLI `--with-apis` | `packages/cli/src/commands/job.ts` | Passes `app_apis` through hints to server |
| Server `app_apis` hints | `apps/api/src/jobs/jobs.service.ts` | Validates APIs, generates instruction block |
| CLI api commands | `packages/cli/src/commands/api.ts` | `list`, `spec`, `call`, `examples` |
| Token verify endpoint | `apps/api/src/auth/auth.controller.ts` | `GET /auth/token/verify` |
| JWKS endpoint | `apps/api/src/auth/auth.keys.controller.ts` | `GET /.well-known/jwks.json` |
| App auth SDK | `packages/app-auth/src/index.ts` | `verifyEveToken`, `verifyEveTokenRemote`, middleware |
| Token schema | `packages/shared/src/schemas/auth.ts` | `AuthTokenVerifyResponseSchema` |
