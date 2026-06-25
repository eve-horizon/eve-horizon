# Plan: Supabase-Style Migrations for Eve Projects

> **Status**: Implemented ✅
> **Created**: 2026-01-28
> **Completed**: 2026-01-28

## Implementation Summary

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | `x-eve.files` directive for ConfigMap file mounting | ✅ Done |
| Phase 2 | `eve-migrate` standalone migration runner | ✅ Done |
| Phase 3 | CLI commands (`eve db migrate/migrations/new`) | ✅ Done |
| Phase 4 | Sister repo updates (fullstack-example, starter) | ✅ Done |
| Phase 5 | Documentation | ✅ Done |

---

## Goal

Make database migrations first-class in Eve-compatible projects:

1. **Job service pattern** - Migrations run as pipeline steps using a dedicated container
2. **`x-eve.files`** - Mount local files into containers via ConfigMaps
3. **`eve-migrate` image** - Pre-built container with migration tracking (only applies pending)
4. **CLI commands** - For local development and manual operations

## Design Overview

```yaml
# .eve/manifest.yaml
services:
  db:
    image: postgres:16
    x-eve:
      role: database

  migrate:
    image: ghcr.io/eve-horizon/migrate:latest
    environment:
      DATABASE_URL: postgres://eve:${secret.POSTGRES_PASSWORD}@${ENV_NAME}-db:5432/eve
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      role: job
      files:
        - source: db/migrations
          target: /migrations

pipelines:
  deploy-test:
    steps:
      - name: deploy
        action: { type: deploy }
      - name: migrate
        depends_on: [deploy]
        action:
          type: job
          service: migrate
```

---

## Part 1: `x-eve.files` - Mount Files via ConfigMaps

### Problem

K8s Jobs don't have access to the worker's filesystem. Docker Compose style volumes (`./path:/mount`) don't work.

### Solution

New `x-eve.files` directive that creates ConfigMaps from repo files:

```yaml
services:
  migrate:
    image: ghcr.io/eve-horizon/migrate:latest
    x-eve:
      role: job
      files:
        - source: db/migrations    # Path relative to repo root
          target: /migrations      # Mount path in container
```

### How It Works

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     Worker      │       │   K8s Cluster   │       │    Job Pod      │
│                 │       │                 │       │                 │
│ /workspace/     │ ────▶ │   ConfigMap     │ ────▶ │ /migrations/    │
│   db/migrations/│       │   (file data)   │       │   *.sql files   │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

1. Worker reads files from `source` path in cloned workspace
2. Creates ConfigMap with file contents
3. Mounts ConfigMap at `target` path in container

### Implementation

**Schema addition** (`packages/shared/src/schemas/manifest.ts`):

```typescript
const XEveFilesEntrySchema = z.object({
  source: z.string().min(1),  // Relative path in repo
  target: z.string().min(1),  // Absolute path in container
});

const XEveSchema = z.object({
  role: z.enum(['database', 'job', 'worker']).optional(),
  ingress: IngressConfigSchema.optional(),
  api_spec: ApiSpecConfigSchema.optional(),
  files: z.array(XEveFilesEntrySchema).optional(),  // NEW
}).passthrough();
```

**Deployer changes** (`apps/worker/src/deployer/deployer.service.ts`):

```typescript
// In runJobService():
const xeveFiles = xeve?.files as Array<{ source: string; target: string }> | undefined;

if (xeveFiles && repoPath) {
  for (const [index, fileEntry] of xeveFiles.entries()) {
    const configMapName = `${jobName}-files-${index}`;
    const sourcePath = path.join(repoPath, fileEntry.source);

    // Read files from workspace
    const files = await this.readFilesForConfigMap(sourcePath);

    // Create ConfigMap
    await this.k8sService.createConfigMap(namespace, configMapName, files);

    // Add to volumes/mounts
    volumes.push({ name: configMapName, configMap: { name: configMapName } });
    volumeMounts.push({ name: configMapName, mountPath: fileEntry.target });
  }
}
```

### Limitations

- **1MB total size** per ConfigMap (K8s limit)
- **Text files only** (binary files need base64 encoding)
- For larger files → bake into image at build time

### Works for All Services

`x-eve.files` works for any service type, not just jobs:

```yaml
services:
  api:
    image: ghcr.io/org/api:latest
    x-eve:
      files:
        - source: config/production.yaml
          target: /etc/app/config.yaml

  migrate:
    image: ghcr.io/eve-horizon/migrate:latest
    x-eve:
      role: job
      files:
        - source: db/migrations
          target: /migrations
```

---

## Part 2: `eve-migrate` Container Image

### Existing Code

We already have migration tracking logic in `EnvDbService`:

```typescript
// apps/api/src/environments/env-db.service.ts:193-247
async migrate(projectId, envName, migrations, context) {
  // Creates schema_migrations table if not exists
  // Checks each migration by name
  // Computes SHA-256 checksum
  // Skips if already applied (same checksum)
  // Fails if checksum changed
  // Applies new migrations in transaction
}
```

**Tracking table**:
```sql
CREATE TABLE schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### New: Standalone Migration Runner

Create a lightweight container that:
1. Reads SQL files from `/migrations` directory
2. Connects directly to database
3. Uses same tracking logic (schema_migrations table)
4. Only applies pending migrations

**Location**: `packages/migrate/` (new package)

**Entry point** (`packages/migrate/src/index.ts`):

```typescript
import { createDb } from '@eve/db';
import { readdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

const MIGRATION_REGEX = /^(\d{14})_(.+)\.sql$/;

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  const migrationsDir = process.env.MIGRATIONS_DIR || '/migrations';

  if (!databaseUrl) {
    throw new Error('DATABASE_URL required');
  }

  const db = createDb(databaseUrl);

  // Ensure tracking table
  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Get applied migrations
  const applied = await db<{ name: string; checksum: string }[]>`
    SELECT name, checksum FROM schema_migrations
  `;
  const appliedMap = new Map(applied.map(m => [m.name, m.checksum]));

  // Read and validate migration files
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (!MIGRATION_REGEX.test(file)) {
      throw new Error(
        `Invalid migration filename: ${file}\n` +
        `Expected: YYYYMMDDHHmmss_description.sql`
      );
    }
  }

  // Apply pending migrations
  for (const file of files) {
    const sql = readFileSync(`${migrationsDir}/${file}`, 'utf-8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    const existing = appliedMap.get(file);
    if (existing) {
      if (existing !== checksum) {
        throw new Error(`Migration ${file} has changed (checksum mismatch)`);
      }
      console.log(`✓ ${file} (already applied)`);
      continue;
    }

    console.log(`→ ${file} (applying...)`);
    await db.begin(async tx => {
      await tx.unsafe(sql);
      await tx`
        INSERT INTO schema_migrations (name, checksum)
        VALUES (${file}, ${checksum})
      `;
    });
    console.log(`✓ ${file} (applied)`);
  }

  await db.end();
  console.log('\nMigrations complete.');
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
```

**Dockerfile** (`packages/migrate/Dockerfile`):

```dockerfile
FROM node:22-slim
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY dist/ ./dist/

ENV MIGRATIONS_DIR=/migrations
CMD ["node", "dist/index.js"]
```

**Published to**: `ghcr.io/eve-horizon/migrate:latest`

---

## Part 3: Migration File Convention

```
db/migrations/
├── 20260128100000_create_users.sql
├── 20260128100100_create_notes.sql
└── 20260128100200_add_user_roles.sql
```

**Naming**: `YYYYMMDDHHmmss_description.sql`
- 14-digit UTC timestamp
- Underscore separator
- Lowercase description with underscores
- `.sql` extension

**Validation regex**: `/^(\d{14})_([a-z0-9_]+)\.sql$/`

---

## Part 4: CLI Commands (Local Development)

For local development and manual operations:

```bash
# Apply migrations (calls API)
eve db migrate --env test

# List applied migrations
eve db migrations --env test

# Create new migration file
eve db new "add_user_roles"
# → Created db/migrations/20260128143022_add_user_roles.sql
```

### Implementation

**Add to `packages/cli/src/commands/db.ts`**:

```typescript
case 'migrate':
  return handleMigrate(positionals, flags, context, jsonOutput);
case 'migrations':
  return handleMigrations(positionals, flags, context, jsonOutput);
case 'new':
  return handleNew(positionals, flags, context);
```

**`handleMigrate`**:
1. Read files from `db/migrations/` (or `--path`)
2. Validate filenames
3. POST to `/projects/:id/envs/:name/migrate` with file contents
4. Display results

**`handleMigrations`**:
1. GET `/projects/:id/envs/:name/migrations`
2. Display formatted table

**`handleNew`**:
1. Generate timestamp filename
2. Create file with template
3. Print path

---

## Part 5: Complete Manifest Example

```yaml
# .eve/manifest.yaml
schema: eve/compose/v2
project: my-app

services:
  db:
    image: postgres:16
    ports: [5432]
    environment:
      POSTGRES_USER: eve
      POSTGRES_PASSWORD: ${secret.POSTGRES_PASSWORD}
      POSTGRES_DB: app
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "eve"]
      interval: 5s
      retries: 5
    x-eve:
      role: database

  migrate:
    image: ghcr.io/eve-horizon/migrate:latest
    environment:
      DATABASE_URL: postgres://eve:${secret.POSTGRES_PASSWORD}@${ENV_NAME}-db:5432/app
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      role: job
      files:
        - source: db/migrations
          target: /migrations

  api:
    build:
      context: ./apps/api
    image: ghcr.io/org/api:latest
    ports: [3000]
    environment:
      DATABASE_URL: postgres://eve:${secret.POSTGRES_PASSWORD}@${ENV_NAME}-db:5432/app
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      ingress:
        public: true
        port: 3000

environments:
  test:
    type: persistent
  staging:
    type: persistent

pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
      - name: release
        depends_on: [build]
        action: { type: release }
      - name: deploy
        depends_on: [release]
        action: { type: deploy }
      - name: migrate
        depends_on: [deploy]
        action:
          type: job
          service: migrate
      - name: smoke-test
        depends_on: [migrate]
        script:
          run: ./scripts/smoke-test.sh
```

---

## Implementation Plan

### Phase 1: `x-eve.files` Support

**Files to modify**:
- `packages/shared/src/schemas/manifest.ts` - Add files schema
- `apps/worker/src/deployer/deployer.service.ts` - Create ConfigMaps from workspace files
- `apps/worker/src/deployer/k8s.service.ts` - Add createConfigMap method

### Phase 2: `eve-migrate` Container

**Files to create**:
- `packages/migrate/` - New package
- `packages/migrate/src/index.ts` - Migration runner
- `packages/migrate/Dockerfile` - Container image
- `.github/workflows/publish-migrate.yml` - CI/CD for image

### Phase 3: CLI Commands

**Files to modify**:
- `packages/cli/src/commands/db.ts` - Add migrate, migrations, new
- `packages/cli/src/lib/migrations.ts` - New utilities file

### Phase 4: Update Sister Repos

**eve-horizon-fullstack-example**:
- Create `db/migrations/` with proper files
- Update manifest to use `eve-migrate` + `x-eve.files`
- Remove inline psql migrate service

**eve-horizon-starter**:
- Add `db/migrations/.gitkeep`
- Document migration workflow in README

### Phase 5: Documentation

- `docs/system/manifest.md` - Document `x-eve.files`
- `packages/cli/README.md` - Document CLI commands
- `packages/migrate/README.md` - Document container usage

---

## Files Summary

| File | Action |
|------|--------|
| `packages/shared/src/schemas/manifest.ts` | Add `x-eve.files` schema |
| `apps/worker/src/deployer/deployer.service.ts` | ConfigMap creation from files |
| `apps/worker/src/deployer/k8s.service.ts` | Add createConfigMap |
| `packages/migrate/` | New migration runner package |
| `packages/migrate/src/index.ts` | Migration logic |
| `packages/migrate/Dockerfile` | Container image |
| `packages/cli/src/commands/db.ts` | CLI commands |
| `packages/cli/src/lib/migrations.ts` | Validation utilities |
| `../eve-horizon-fullstack-example/db/migrations/` | Migration files |
| `../eve-horizon-fullstack-example/.eve/manifest.yaml` | Use new pattern |

---

## Verification

### Unit Tests
- Migration filename validation
- ConfigMap size limits
- Checksum computation

### Integration Tests
- `x-eve.files` creates ConfigMap correctly
- `eve-migrate` applies only pending migrations
- Checksum mismatch detection
- CLI commands work

### E2E Test
```bash
# Deploy with migrations
eve pipeline run deploy --env test

# Verify migrations applied
eve db migrations --env test
eve db schema --env test
```
