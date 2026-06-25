# Phase 3A Plan - Env DB First-Class + REST API Sources

> Status: Draft
> Last Updated: 2026-01-21
> Breaking changes are expected and encouraged. Delete or refactor any code that does not conform to this plan.
> Note: API specs now live under `services[].x-eve.api_spec` and migrations are job services per `docs/plans/manifest-v2-compose-plan.md`.
> Deprecated: Migration sections in this plan predate job-service migrations and are retained for historical context only.
> For current manifest structure, see `docs/system/manifest.md`.

## Purpose

Make the environment database simple, safe, and ergonomic, and make app APIs the source of
resources/tools via normal REST patterns (OpenAPI, PostgREST, Supabase GraphQL).

## Goals

- Env DB is easy: migrations, schema introspection, RLS visibility, safe SQL execution.
- Apps describe capabilities via OpenAPI or standard API styles (PostgREST, Supabase GraphQL).
- Agents and CLI use curl (or simple helpers) against app APIs with Eve auth.
- JSON handling is first-class (jq installed in workers, CLI helpers emit `--json` output).
- User context is preserved end-to-end for RLS enforcement.

## Non-goals

- MCP or custom tool registries.
- Eve-managed resource store.
- Arbitrary SQL execution without guardrails.

## Core Principles

- **App owns domain logic**: Eve does not define tools; APIs do.
- **User context propagation**: user JWT -> job/workflow -> API -> DB session -> RLS.
- **Small surface**: cache specs, provide DB ergonomics, avoid new control planes.

## Design Overview

### 1) API Sources (OpenAPI / PostgREST / Supabase GraphQL)

Each project/env declares one or more API sources that represent its capabilities.
Eve caches specs for discovery and CLI exploration; agents call APIs directly.

Supported source types:
- `openapi` (REST with OpenAPI spec)
- `postgrest` (REST auto-generated from Postgres)
- `supabase-graphql` (GraphQL endpoint over Postgres)

**Base URL handling**
- OpenAPI `servers` entries are often wrong in deployed envs.
- Eve treats `base_url` from the manifest as the canonical runtime base.
- Specs can include a `{EVE_API_BASE}` placeholder for clarity; CLI substitutes it.

### 2) Usage Model (Skills + Curl)

- Skills document how to call the app API (curl examples + endpoint links).
- Agents use curl (or `eve api call`) with `Authorization: Bearer $EVE_JOB_TOKEN`.
- CLI can fetch and display specs and generate curl examples with `jq`-friendly output.

### 3) Auth + RLS Model

- Job creation stores `actor_user_id` from the initiating JWT.
- `EVE_JOB_TOKEN` embeds user claims (user_id, org_id, scopes/roles).
- App APIs validate Eve JWT (JWKS) and set DB session context:
  - `SET LOCAL app.user_id`, `app.org_id`, `app.env_name`.
- RLS policies enforce per-user and per-org access.
- Supabase compatibility: align default claim shapes with Supabase conventions and support optional
  Supabase-compatible JWT signing in a later phase.
- DB writes require `db.write` scope, granted only when the workflow declares `db_access: read_write`.

### 4) Env DB Ergonomics

**Migrations (Supabase-style)**
- Migrations live in `.eve/migrations/` as ordered SQL files.
- `eve env deploy` applies pending migrations by default.
- `schema_migrations` table lives inside the env DB.
- Each migration runs in a transaction; failures abort the deploy.

**Introspection**
- `eve db schema` exposes tables, columns, views, and functions.
- `eve db rls` shows which tables have RLS enabled + policies.

**SQL execution**
- `eve db sql` runs parameterized SQL as the calling user.
- No superuser access; RLS must apply.
- Default mode is read-only; writes allowed only with explicit job/workflow hint.
- Write enablement flow:
  - Workflow frontmatter sets `db_access: read_write`.
  - API sets `hints.db_access = "read_write"` and mints a job token with `db.write`.
  - `eve db sql --write` and API SQL writes require `db.write` scope.

## Manifest Additions (minimal)

```yaml
apis:
  app:
    type: openapi
    base_url: http://api.{project}-{env}.lvh.me
    spec_url: http://api.{project}-{env}.lvh.me/openapi.json
    auth: eve

  db:
    type: postgrest
    base_url: http://db.{project}-{env}.lvh.me
    auth: eve

  graphql:
    type: supabase-graphql
    base_url: http://db.{project}-{env}.lvh.me/graphql
    auth: eve

migrations:
  path: .eve/migrations
```

## Data Model

- `project_api_sources` (or cached inside `project_manifests`):
  - `project_id`, `env_name`, `name`, `type`, `base_url`, `spec_url`,
    `auth_mode`, `cached_schema_json`, `last_synced_at`.
- `schema_migrations` table in env DB.

## API Surface

**API Sources**
- `GET /projects/:id/apis`
- `GET /projects/:id/apis/:name`
- `GET /projects/:id/apis/:name/spec`
- `POST /projects/:id/apis/:name/refresh`

**DB**
- `GET /projects/:id/envs/:name/db/schema`
- `GET /projects/:id/envs/:name/db/rls`
- `POST /projects/:id/envs/:name/db/sql`
- `POST /projects/:id/envs/:name/migrate`
- `GET /projects/:id/envs/:name/migrations`

## CLI

- `eve api list|show|spec|refresh`
- `eve api examples <name>` (prints curl templates from spec)
- `eve api call <name> <method> <path>` (curl wrapper with auth + jq helpers)
- `eve db schema|rls|sql|migrate --env <name>`

### Eve CLI Curl Wrapper

`eve api call` is a thin wrapper around curl that standardizes auth and JSON handling:
- Resolves `base_url` from the manifest and substitutes `{EVE_API_BASE}` in specs.
- Adds `Authorization: Bearer <token>` (user JWT or `EVE_JOB_TOKEN`).
- Sets `Content-Type: application/json` for JSON bodies.
- Supports `--json <payload|file>` and `--jq <expr>` for jq-friendly output.
- Supports `--graphql` (or auto when api type is `supabase-graphql`) to send `{query, variables}`.
- Optional `--print-curl` to emit the raw curl command for copy/paste.
- Help is first-class and progressive (quick examples, then deeper flags and patterns).

Examples:

```bash
# Read notes with jq filtering
eve api call app GET /notes --jq '.items | map({id, title})'

# Create a note with inline JSON
eve api call app POST /notes --json '{"title":"Hello","body":"World"}'

# GraphQL query (Supabase style)
eve api call graphql POST /graphql --graphql '{ notes { id title } }'
```

**CLI clarity**
- The `eve` CLI is the single entrypoint (npm published).
- Commands are categorized as either thin REST wrappers (`eve api`, `eve db`) or local utilities
  (e.g., skills install). If `eve-worker` remains, it should be optional and internal.

## Example Node App (OpenAPI)

Minimal example that accepts Eve JWT and enforces RLS:

```json
// package.json (sketch)
{
  "name": "notes-api",
  "type": "module",
  "scripts": { "start": "node server.mjs" },
  "dependencies": {
    "express": "^4.19.0",
    "pg": "^8.11.0",
    "jose": "^5.2.0"
  }
}
```

```js
// server.mjs (sketch)
import express from "express";
import { Pool } from "pg";
import { jwtVerify, createRemoteJWKSet } from "jose";

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const jwks = createRemoteJWKSet(new URL(process.env.EVE_JWKS_URL));

async function eveAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });
  const { payload } = await jwtVerify(token, jwks);
  req.eve = payload;
  return next();
}

app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.0.0",
    info: { title: "Notes API", version: "1.0" },
    servers: [{ url: "{EVE_API_BASE}" }]
  });
});

app.post("/notes", eveAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local app.user_id = $1", [req.eve.user_id]);
    const result = await client.query(
      "insert into notes(title, body) values ($1, $2) returning id",
      [req.body.title, req.body.body]
    );
    await client.query("commit");
    res.json({ id: result.rows[0].id });
  } finally {
    client.release();
  }
});

app.listen(3000, () => console.log("API on :3000"));
```

## Tests

- API source list/show/spec caching.
- OpenAPI spec refresh + curl example generation.
- Migration apply (success + failure) with schema_migrations tracking.
- DB schema/RLS introspection returns consistent metadata.
- `eve db sql` runs under user context with RLS enforced.

## Risks + Open Questions

- Do we need an API proxy for private services, or is direct curl enough?
- How strict should SQL guardrails be (read-only default vs explicit write)?
- Should PostgREST/Supabase accept Eve JWT directly or via a translation proxy?
- Should `eve api examples` always substitute `base_url` regardless of OpenAPI `servers` values?
