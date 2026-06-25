# API Spec Component Integration

> Status: Draft
> Last Updated: 2026-01-22
> Breaking Change: Removes top-level `apis` manifest section
> Deprecated: Current API spec registration lives under `services[].x-eve.api_spec`; see `docs/system/manifest.md` and `docs/plans/manifest-v2-compose-plan.md`.

## Purpose

Move API spec configuration into individual services. Each service that exposes an API owns its spec configuration via `services[].x-eve.api_spec`.

## Design

### Service Schema Addition

```yaml
services:
  api:
    image: ghcr.io/example/api
    ports: [3000]
    x-eve:
      api_spec:
        type: openapi              # openapi | postgrest | graphql
        spec_url: /openapi.json    # Relative to service base URL
        on_deploy: true            # Default: true
```

### Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | enum | `openapi` | `openapi`, `postgrest`, or `graphql` |
| `spec_url` | string | varies by type | URL path to fetch spec |
| `spec_path` | string | - | Alternative: static spec file in repo |
| `on_deploy` | boolean | `true` | Auto-register after component is healthy |
| `auth` | enum | `eve` | Auth mode: `eve` or `none` |
| `name` | string | service name | Override the registered API name |

### Type-Specific Defaults

| Type | Default `spec_url` |
|------|-------------------|
| `openapi` | `/openapi.json` |
| `postgrest` | `/` |
| `graphql` | `/graphql` |

Minimal config for standard setups:

```yaml
api:
  x-eve:
    api_spec:
      type: openapi    # Defaults handle the rest

postgrest:
  x-eve:
    api_spec:
      type: postgrest  # spec_url defaults to /

graphql:
  x-eve:
    api_spec:
      type: graphql    # spec_url defaults to /graphql
```

### Base URL Resolution

Derived from Eve's routing system:

- `internal_base_url`: `http://{env}-{service}.{project}-{env}.svc.cluster.local:{port}`
- `external_base_url`: `http://{service}.{project}-{env}.{domain}`

No manual URL config needed.

### Static Spec Files

For services that don't serve their own spec:

```yaml
legacy-service:
  image: vendor/legacy:1.0
  x-eve:
    api_spec:
      type: openapi
    spec_path: ./specs/legacy-service.yaml  # local file:// only

Notes:
- `spec_path` currently works only for local `file://` repos (dev/testing).
```

### Multiple Specs Per Component

Use `api_specs` (plural) when needed:

```yaml
gateway:
  x-eve:
    api_specs:
      - name: rest
        type: postgrest
        spec_url: /rest/v1/
      - name: graphql
        type: graphql
        spec_url: /graphql/v1
```

## Deployment Flow

```
eve env deploy
├─► Build/push images
└─► For each service (dependency order):
    ├─► Apply K8s manifests
    ├─► Wait for healthy
    └─► Register API spec (if configured)
        ├─► Resolve base URLs from routing
        ├─► Fetch spec (URL or path)
        └─► Upsert into project_api_sources
```

## Example Manifests

### Simple API

```yaml
name: notes-app

services:
  api:
    image: ghcr.io/org/notes-api
    ports: [3000]
    x-eve:
      api_spec:
        type: openapi
    depends_on:
      db:
        condition: healthy

  db:
    image: postgres:16
```

### PostgREST + GraphQL

```yaml
name: data-api

services:
  db:
    image: postgres:16

  rest:
    image: postgrest/postgrest:v12
    ports: [3000]
    x-eve:
      api_spec:
        type: postgrest
    depends_on:
      db: { condition: healthy }

  graphql:
    image: supabase/pg_graphql
    ports: [8080]
    x-eve:
      api_spec:
        type: graphql
    depends_on:
      db: { condition: healthy }
```

## Implementation

### 1. Schema Updates

`packages/shared/src/schemas/manifest.ts`:

```typescript
export const ApiSpecSchema = z.object({
  type: z.enum(['openapi', 'postgrest', 'graphql']).default('openapi'),
  spec_url: z.string().optional(),
  spec_path: z.string().optional(),
  on_deploy: z.boolean().default(true),
  auth: z.enum(['eve', 'none']).default('eve'),
  name: z.string().optional(),
});

export const ComponentSchema = z.object({
  // ... existing fields ...
  api_spec: ApiSpecSchema.optional(),
  api_specs: z.array(ApiSpecSchema).optional(),
});
```

### 2. API Registration Service

`apps/api/src/environments/api-registration.service.ts`:

- `registerComponentApi(projectId, envName, component, apiSpec)`
- `resolveBaseUrls(projectId, envName, componentName)`
- `fetchSpec(url, type)` / `readSpecFromPath(path)`

### 3. Deploy Integration

After service health check + migration job runs, call registration if `api_spec` present.

### 4. Database Migration

```sql
ALTER TABLE project_api_sources
  ADD COLUMN component_name TEXT,
  ADD COLUMN internal_base_url TEXT,
  ADD COLUMN spec_source TEXT DEFAULT 'url';
```

### 5. Remove Top-Level APIs

- Delete `apis` parsing from manifest handling
- Remove any existing `apis`-related code
- Update CLI commands to work with component-based specs

## CLI

```bash
eve api list                     # List registered APIs
eve api spec <name>              # Get spec
eve api register <component>     # Manual registration
eve api examples <name>          # Curl examples
eve api call <name> GET /path    # Curl wrapper
```

## Tests

- Schema validation for field combinations
- API registration during deploy
- Type-specific spec fetching (OpenAPI, PostgREST introspection, GraphQL introspection)
- Base URL resolution from routing
