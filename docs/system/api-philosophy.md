# API Philosophy

> Status: Current
> Last Updated: 2026-01-13

## Overview

Eve Horizon's REST API is the **single source of truth** for all operations. The CLI, web UI, and any future clients are thin wrappers that call the API. No client should ever bypass the API to access the database directly.

## CLI-First Development Philosophy

The primary interface for Eve Horizon is the CLI, used by **humans** and **AI agents** alike. The REST API is the substrate that powers this CLI experience and any future UI. This means:

- Design endpoints to be **CLI-friendly** (clear resource hierarchies, predictable pagination, consistent errors).
- The CLI is **thin**: argument parsing + HTTP calls + output formatting (including `--json`).
- The dev/ops CLI (`./bin/eh`) is **not** a runtime client; it exists only for local development and operations.

See the published CLI docs in [`packages/cli/README.md`](../../packages/cli/README.md) and the contract in [`openapi.md`](./openapi.md).

## Current (Implemented)

### 1. CLI as Thin Wrapper

The published CLI (`@eve/cli`) exists solely to:
- Parse command-line arguments
- Call the appropriate REST endpoint
- Format the response for human or machine consumption

The CLI **never**:
- Accesses the database directly
- Contains business logic
- Makes decisions about data validation

**Why?** This ensures consistent behavior across all interfaces. If validation changes, it changes once in the API. If execution behavior evolves, it evolves in one place.

### 1.1 CLI Distribution

The REST-only CLI is published as an npm package (`@eve/cli`) so users can run it via `npx` or a global install. It targets Node 22+ and is cross-platform.

Local dev/ops helpers live under `./bin/eh` and are not published. They manage local services (dev servers, Docker, DB) and do not perform runtime API operations.

### 2. OpenAPI as Source of Truth

OpenAPI is generated **code-first** from NestJS controllers and Zod schemas. The generated spec is the contract; all client behavior should align to it.

The canonical spec is checked in under `docs/system/openapi.json` (and `docs/system/openapi.yaml`).

### 3. REST Conventions

#### HTTP Methods

| Method | Purpose | Idempotent |
|--------|---------|------------|
| `GET` | Read resource(s) | Yes |
| `POST` | Create resource or action | No* |
| `PUT` | Full replacement | Yes |
| `PATCH` | Partial update | Yes |
| `DELETE` | Remove resource | Yes |

*Exception: `POST /resource/ensure` is idempotent by design.

#### Status Codes

| Code | Meaning | When to Use |
|------|---------|-------------|
| `200 OK` | Success | GET, PUT, PATCH, ensure operations |
| `201 Created` | Resource created | POST when creating new resource |
| `204 No Content` | Success with no body | DELETE |
| `400 Bad Request` | Invalid input | Validation failures, malformed JSON |
| `404 Not Found` | Resource doesn't exist | GET/PUT/DELETE on missing resource |
| `409 Conflict` | State conflict | Ensure with conflicting parameters |
| `422 Unprocessable Entity` | Semantic error | Valid JSON but business rule violation |
| `500 Internal Server Error` | Server failure | Unexpected errors |

#### URL Patterns

```
# Collection operations
GET    /resources              # List
POST   /resources              # Create
POST   /resources/ensure       # Find-or-create (idempotent)

# Instance operations
GET    /resources/{id}         # Read
PUT    /resources/{id}         # Replace
PATCH  /resources/{id}         # Update
DELETE /resources/{id}         # Remove

# Nested resources
GET    /resources/{id}/children
POST   /resources/{id}/children
```

### 4. Ensure Pattern

The `/ensure` endpoint implements find-or-create semantics:

1. If a resource matching the unique key exists and parameters match, return it (200)
2. If a resource exists but parameters conflict, return 409
3. If no resource exists, create it and return 200

This makes setup scripts idempotent:
```bash
# Safe to run multiple times
eve org ensure "My Org"
eve project ensure --name "my-project" --repo-url "https://..."
```

#### Org name uniqueness

Org names are **case-insensitive unique** (enforced by a unique index on `LOWER(name)`).
`POST /orgs/ensure` accepts `{ "name": "..." }` without an id and will return the
existing org if the name is already taken. Soft-deleted orgs are undeleted.

### 5. Pagination

List endpoints return paginated results with offset/limit:

```json
{
  "data": [...],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "count": 50
  }
}
```

Query parameters:
- `limit` - Max items to return (default: 10)
- `offset` - Items to skip before returning (default: 0)

List results are ordered by `created_at` descending (newest first).

### 6. Error Responses

Errors currently use NestJS default error shapes. We may add a standardized error envelope later, but it is not enforced yet.

### 7. Soft Delete

Resources support soft delete via a `deleted` boolean:
- Deleted resources are excluded from lists by default
- Include `?include_deleted=true` to show deleted items
- `PATCH` supports `{ "deleted": true }` to mark deleted

### 8. Timestamps

All resources include timestamps:
- `created_at` - ISO 8601 format, UTC
- `updated_at` - ISO 8601 format, UTC
- No `deleted_at` yet; deletion is a boolean flag

### 9. IDs

- **Global entities** (org, project): TypeID format (`org_xxx`, `proj_xxx`)
- **Scoped entities** (job, attempt): Human-friendly numbers (`123`, `1`)
- Full IDs available for cross-context references (`proj_xxx:123:1`)

See [job-api.md](./job-api.md) for detailed ID specification.

## Planned (Not Implemented)

- Standardized error envelope (currently uses NestJS defaults).

## Legacy / Removed

- Workflow‑specific REST patterns (workflows removed in simplified config model).

## Implementation Checklist

When adding a new endpoint:

1. Define request/response schemas in `@eve/shared`
2. Implement validation with Zod
3. Return appropriate status codes
4. Include in OpenAPI spec
5. Document in this file if it introduces new patterns

When modifying CLI commands:

1. Remove any direct DB access
2. Use `curl` or the Node CLI to call API endpoints
3. Handle HTTP status codes appropriately
4. Format output for both human (`--json=false`) and machine (`--json`) consumption
