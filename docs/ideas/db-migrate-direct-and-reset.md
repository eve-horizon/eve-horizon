# Direct DB Migrations & Environment Reset

> **Status**: Superseded by `docs/plans/deploy-recovery-and-db-reset-plan.md`
> **Date**: 2026-02-15
> **Motivation**: App developers need to run Eve's migration primitive against local databases (Docker Compose, bare Postgres) and reset managed databases in Eve environments without a destroy/reprovision cycle.

## Problem

Three related pain points:

### 1. Migrations only work through the API

`eve db migrate --env <name>` sends SQL files to the Eve API, which resolves the environment's database and runs them server-side. This means:

- Developers can't use Eve's migration system in local dev (Docker Compose)
- CI pipelines can't run migrations against a test database without a running Eve API
- The `packages/migrate` standalone runner exists (`eve-migrate`) but isn't exposed through the CLI

### 2. No way to reset a managed database without destroy/reprovision

When an app's schema gets into a bad state (e.g. Prisma P3018 "relation already exists"), the current workflow is:

```bash
eve db destroy --env sandbox --force   # Async soft-delete, wait for reconciler
# ... wait 30-60s for reconciler to DROP DATABASE ...
eve env deploy proj_xxx sandbox        # Re-provisions fresh tenant
eve db migrate --env sandbox           # Re-apply migrations
```

Three commands with an async wait. In dev, you want one command.

### 3. No schema wipe without tenant destruction

Sometimes you just need a clean schema — drop all tables, re-run migrations — without destroying the managed DB tenant (which loses the connection URL, triggers async reprovisioning, etc.).

## Design

### Part 1: Direct Mode for `eve db migrate`

Add a `--url` flag that runs migrations locally against any Postgres connection string, bypassing the API entirely.

```bash
# Local Docker Compose dev
eve db migrate --url postgres://app:secret@localhost:5432/myapp

# CI test database
eve db migrate --url $TEST_DATABASE_URL

# Explicit migrations path (default: db/migrations)
eve db migrate --url postgres://... --path ./db/migrations

# Eve environment (unchanged, existing behavior)
eve db migrate --env staging
```

**Implementation**: When `--url` is present, the CLI imports `@eve/migrate`'s core logic directly instead of calling the API. No network round-trip, no auth required, no Eve project context needed.

The `@eve/migrate` package already does exactly what's needed:

1. Connect to `DATABASE_URL`
2. Create `schema_migrations` tracking table
3. Read SQL files from directory
4. Validate filenames (`YYYYMMDDHHmmss_description.sql`)
5. Check checksums (fail-fast on tampered migrations)
6. Apply new migrations in transactions
7. Record name + checksum in tracking table

The CLI just needs to wire `--url` to this existing logic instead of the API call.

#### Companion commands in direct mode

These should also work with `--url`:

```bash
# List applied migrations
eve db migrations --url postgres://localhost:5432/myapp

# Run ad-hoc SQL
eve db sql --url postgres://localhost:5432/myapp --sql "SELECT count(*) FROM users"

# Show schema
eve db schema --url postgres://localhost:5432/myapp
```

#### Docker Compose integration

An Eve-compatible app's `docker-compose.yml` might look like:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
    ports:
      - "5432:5432"
```

The developer workflow becomes:

```bash
docker compose up -d db
eve db migrate --url postgres://app:secret@localhost:5432/myapp
# ... develop ...
eve db new add_user_preferences
# ... edit the migration file ...
eve db migrate --url postgres://app:secret@localhost:5432/myapp
```

#### Shorthand: `EVE_DB_URL` environment variable

To avoid repeating the connection string:

```bash
export EVE_DB_URL=postgres://app:secret@localhost:5432/myapp
eve db migrate          # Uses EVE_DB_URL when no --env or --url
eve db migrations       # Same
eve db sql --sql "..."  # Same
```

Precedence: `--url` > `--env` > `EVE_DB_URL` > error.

#### `.env` file support

Eve CLI should read `.env` in the current directory (if present) for `EVE_DB_URL`. This makes the workflow zero-config after initial setup:

```bash
# .env
EVE_DB_URL=postgres://app:secret@localhost:5432/myapp
```

```bash
eve db migrate   # Just works
```

### Part 2: `eve db reset`

Reset an Eve-managed database to a clean state and re-run migrations. Single command, synchronous.

```bash
# Eve environment — wipe schema + re-migrate
eve db reset --env sandbox

# Direct mode — same thing against any database
eve db reset --url postgres://app:secret@localhost:5432/myapp

# Skip re-migration (just wipe)
eve db reset --env sandbox --no-migrate

# Production guard
eve db reset --env production
# Error: Cannot reset production environment. Use --danger-reset-production to confirm.
eve db reset --env production --danger-reset-production
```

**Implementation** (API-mode via `--env`):

1. `POST /projects/{id}/envs/{name}/db/reset` (new endpoint)
2. Server executes: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
3. Drops `schema_migrations` table (it's in public schema)
4. If `--no-migrate` is NOT set, immediately runs pending migrations from the request body
5. Returns `{ reset: true, migrations_applied: [...] }`

**Implementation** (direct-mode via `--url`):

1. CLI connects directly using `@eve/migrate`
2. Runs `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
3. Re-runs the migration logic from `packages/migrate`

**Why `DROP SCHEMA` instead of `DROP DATABASE`**:

- No superuser privileges required (the app user owns public schema)
- No reconnection needed (you can't drop a database you're connected to)
- Preserves the database, roles, and connection credentials
- Works identically for managed DBs and local Postgres
- Extensions in other schemas survive

### Part 3: `eve db wipe`

Destructive schema drop without re-migration. Useful when you want to start completely fresh or switch migration strategies.

```bash
eve db wipe --env sandbox --force
eve db wipe --url postgres://... --force
```

This is just `eve db reset --no-migrate` with a more explicit name. Could be an alias or a separate command — leaning toward alias to keep the command surface small.

**Decision**: Make `wipe` an alias for `reset --no-migrate --force`. One less command to document.

### Part 4: Production guards

| Command | Non-production | Production |
|---------|---------------|------------|
| `eve db migrate` | Runs immediately | Runs immediately (migrations are forward-only, safe) |
| `eve db reset` | Requires `--force` | Requires `--danger-reset-production` |
| `eve db sql --write` | Warning banner | Requires `--danger-write-production` |

Environment detection: the API knows environment names. In direct mode (`--url`), there are no guards — you own the database, you own the consequences.

## Implementation Plan

### Phase 1: Direct mode (CLI-only, no API changes)

1. Extract migration runner logic from `packages/migrate/src/index.ts` into a reusable function (not just a `migrate()` entrypoint that calls `process.exit`)
2. Add `--url` flag to `eve db migrate`, `eve db migrations`, `eve db sql`, `eve db schema`
3. Add `EVE_DB_URL` env var support with `.env` file loading
4. When `--url` is present, run migrations locally via the extracted function
5. Update CLI help text

**Estimated scope**: ~100 lines of CLI changes + refactor of `packages/migrate` to export a function.

### Phase 2: Reset command (CLI + API)

1. Add `eve db reset` CLI command
2. Add `POST /projects/{id}/envs/{name}/db/reset` API endpoint
3. Direct mode: CLI runs DROP SCHEMA + migrate locally
4. API mode: server runs DROP SCHEMA + migrate server-side
5. Production guards

**Estimated scope**: ~50 lines CLI + ~30 lines API endpoint.

### Phase 3: Documentation & starter template

1. Update `references/cli.md` in eve-skillpacks
2. Add "Database Development" section to starter README
3. Add `.env.example` with `EVE_DB_URL` to starter template
4. Update `docs/system/db.md`

## What This Enables

### For app developers

```bash
# Local dev loop (no Eve API needed)
docker compose up -d db
eve db migrate --url postgres://app:secret@localhost:5432/myapp
pnpm dev

# Schema got messy? One command.
eve db reset --url postgres://app:secret@localhost:5432/myapp

# Deploy to Eve — same migration files, different target
git push  # Pipeline runs: eve db migrate --env production
```

### For CI

```yaml
# GitHub Actions
- run: eve db migrate --url ${{ secrets.TEST_DB_URL }}
- run: pnpm test
```

### For Eve environments

```bash
# Dev environment schema went sideways
eve db reset --env dev

# Instead of the old way:
# eve db destroy --env dev --force
# (wait 60s)
# eve env deploy proj_xxx dev
# eve db migrate --env dev
```

## Open Questions

1. **Should `eve db new` also work without project context?** Currently it just creates a file — no API needed. Already works. No change needed.

2. **Should direct mode support non-Postgres databases?** Not in v1. The `packages/migrate` runner uses the `postgres` npm package. If we add MySQL/SQLite later, it would be a new driver in that package.

3. **Should `eve db reset` also reset the `schema_migrations` table explicitly?** No — `DROP SCHEMA public CASCADE` already drops it since it lives in public. The subsequent migrate recreates it.

4. **Connection string in shell history**: `--url` puts the password in shell history. Mitigate with `EVE_DB_URL` env var and `.env` file support. Could also add `--url-env <VAR_NAME>` to read from a named env var.
