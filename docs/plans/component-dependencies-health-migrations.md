# Plan: Component Model Enhancement - Dependencies, Health Checks, and Migrations

> **Status**: Deprecated — superseded by `docs/plans/manifest-v2-compose-plan.md` and job‑service migrations.
> **Created**: 2026-01-22
> Legacy note: examples use `components` and `type: database`. Current manifests use
> `services` + `x-eve.role` / `x-eve.external`. See `docs/system/manifest.md`.

## Goal

Enhance the Eve manifest component model to support:
1. **Configurable migrations path** (supabase interoperability)
2. **Component health checks** (docker-compose style)
3. **Component dependencies** (depends_on semantics)
4. **Deploy hooks** (opt-in migrations on deploy)
5. **Clean database component model** (eve-managed vs external)
6. **Remove services.yaml** (deprecated)

## Design Principles

- Docker-compose familiar patterns where appropriate
- Explicit over implicit
- Intuitive from reading the manifest alone
- Simple cases stay simple, complex cases possible

---

## Proposed Manifest Structure

```yaml
name: my-app

# Database component - Eve managed
components:
  db:
    type: database           # First-class database type
    image: postgres:16
    port: 5432
    env:
      POSTGRES_USER: eve
      POSTGRES_PASSWORD: ${secret.DB_PASSWORD}
      POSTGRES_DB: app
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "eve"]
      interval: 5s
      timeout: 3s
      retries: 5
    migrations:
      path: supabase/migrations   # Supabase-style path
      on_deploy: true             # Opt-in auto-migrate

  # OR external database
  db:
    type: database
    external: true
    connection_url: ${secret.DATABASE_URL}
    migrations:
      path: supabase/migrations
      on_deploy: true

  # Buildable API component
  api:
    build:
      context: ./apps/api
      dockerfile: Dockerfile
    port: 3000
    env:
      DATABASE_URL: postgres://eve:${secret.DB_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: healthy      # Wait for DB healthcheck
        migrations: true        # Wait for migrations too
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  # Web frontend - depends on API
  web:
    build:
      context: ./apps/web
    port: 80
    depends_on:
      api:
        condition: healthy
```

---

## Key Design Decisions

### 1. Database Component Types

```yaml
# Eve-managed (deployed to K8s)
db:
  type: database
  image: postgres:16
  ...

# External (connection only, no deployment)
db:
  type: database
  external: true
  connection_url: ${secret.DATABASE_URL}
```

**Rationale**: Clear distinction. External DBs don't get deployed but still participate in dependency graph and can have migrations run against them.

### 2. Health Checks (Docker-Compose Style)

```yaml
healthcheck:
  test: ["CMD", "pg_isready", "-U", "eve"]  # Or "CMD-SHELL" for shell syntax
  interval: 5s
  timeout: 3s
  retries: 5
  start_period: 10s  # Optional grace period
```

**Rationale**: Exact docker-compose syntax - familiar, battle-tested, well-documented.

### 3. Dependencies with Conditions

```yaml
depends_on:
  db:
    condition: healthy      # started | healthy
    migrations: true        # Also wait for migrations (Eve extension)
```

**Conditions**:
- `started` - Component is running (default)
- `healthy` - Component healthcheck passes
- `migrations: true` - Also wait for component's migrations to complete (Eve extension)

### 4. Migrations per Database Component

```yaml
db:
  type: database
  migrations:
    path: supabase/migrations    # Relative to repo root
    on_deploy: true              # Run automatically after deploy
```

**Rationale**:
- Migrations belong to their database component, not global
- `path` supports supabase convention (`supabase/migrations`) or eve convention (`.eve/migrations`)
- `on_deploy: true` opts into automatic migration execution
- Explicit opt-in, not automatic - user controls when migrations run

### 5. Deploy Lifecycle

When `eve env deploy` runs:

1. **Build phase** - Build images for components with `build:` section
2. **Deploy phase** - Deploy components in dependency order:
   - Start components with no dependencies first
   - Wait for `condition: started` or `condition: healthy`
   - Run migrations if `migrations.on_deploy: true`
   - Wait for `migrations: true` dependencies
   - Continue to dependent components
3. **Health verification** - All components healthy = deploy complete

### 6. Remove services.yaml

- Delete references in `apps/worker/src/invoke/invoke.service.ts`
- Archive `docs/ideas/job-services.md`
- All service configuration lives in `manifest.yaml` components

### 7. Forward Compatibility

The component schema is designed for future extension:

```yaml
# Today: database and buildable components
db:
  type: database
  image: postgres:16
  port: 5432

# Future: arbitrary images (supabase auth, redis, minio, etc.)
auth:
  type: auth                    # Any string, not restricted enum
  image: supabase/gotrue:v2.151.0
  ports: [9999, 9998]           # Multiple ports supported
  command: ["gotrue", "serve"]  # Unknown fields ignored (passthrough)
```

**Schema decisions:**
- `type` is `string`, not enum — new types don't require schema changes
- `port` accepts `number | number[]` — multi-port images work out of the box
- `.passthrough()` on ComponentSchema — unknown fields preserved, not rejected

This allows adding `command`, `args`, `volumes`, etc. later without breaking existing manifests.

---

## Design Decisions (Confirmed)

1. **Health checks**: Use K8s readiness/liveness probes. Eve generates probe config from manifest `healthcheck` section and queries K8s for pod ready status.

2. **Migration failure**: Roll back the entire deployment. If migrations fail, delete newly deployed components and restore previous state. Clean failure mode.

3. **Migration runner**: Use a short-lived container (Job) in the same namespace. This ensures:
   - Network access to eve-managed DB via service DNS (`db.eve-myapp-test.svc.cluster.local`)
   - Network access to external DBs (if cluster has egress)
   - Proper secret access (same namespace, same secret mounts)
   - Clean execution environment (no state pollution)

---

## Migration Execution: Two Paths

Migrations can be applied in two ways:

### 1. CLI-Triggered Migrations (Manual)

Run migrations on-demand from your local machine:

```bash
# Using manifest path (supabase/migrations)
eve db migrate --env test

# Or explicit path override
eve db migrate --env test --path ./custom/migrations
```

**How it works:**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Local CLI     │     │    Eve API      │     │   K8s Cluster   │
│                 │     │                 │     │                 │
│ 1. Read SQL     │────▶│ 2. Receive      │────▶│ 3. Create Job   │
│    files from   │     │    migrations   │     │    in namespace │
│    local path   │     │    payload      │     │                 │
│                 │     │                 │     │ 4. Run against  │
│                 │◀────│                 │◀────│    database     │
│ 5. Show result  │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Path resolution order:**
1. `--path` flag if provided
2. `migrations.path` from manifest (e.g., `supabase/migrations`)
3. Default: `.eve/migrations`

**Migration file naming (Supabase convention):**
```
YYYYMMDDHHmmss_short_description.sql
└────────────┘ └────────────────┘
  UTC timestamp    human-readable
  (required)       (required)
```

Examples: `20240603101431_create_users.sql`, `20240715143022_add_profiles.sql`

**Example:**
```bash
$ eve db migrate --env test
Reading migrations from supabase/migrations...
Found 3 pending migrations:
  - 20240115093042_create_users.sql
  - 20240120141530_add_profiles.sql
  - 20240125162201_add_indexes.sql
Applying migrations...
  ✓ 20240115093042_create_users.sql (applied)
  ✓ 20240120141530_add_profiles.sql (applied)
  ✓ 20240125162201_add_indexes.sql (applied)
All migrations complete.
```

**Validation (fail-fast):**
```bash
$ eve db migrate --env test
Error: Invalid migration filename: 20240115_create_users.sql
       Expected format: YYYYMMDDHHmmss_description.sql (14-digit UTC timestamp)
       Example: 20240115093042_create_users.sql
```

### 2. Deploy-Triggered Migrations (Automatic)

Run migrations automatically during `eve env deploy` when `on_deploy: true`:

```yaml
db:
  type: database
  migrations:
    path: supabase/migrations
    on_deploy: true           # ← Enables automatic migrations
```

**How it works:**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Git Repo      │     │    Deployer     │     │   K8s Cluster   │
│   (in cluster)  │     │    (Worker)     │     │                 │
│                 │     │                 │     │                 │
│ 1. Clone repo   │────▶│ 2. Read SQL     │────▶│ 3. ConfigMap    │
│                 │     │    from path    │     │    with SQLs    │
│                 │     │                 │     │                 │
│                 │     │                 │     │ 4. Migration    │
│                 │     │                 │◀────│    Job runs     │
│                 │     │ 5. Wait for     │     │                 │
│                 │     │    completion   │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Key difference:** Deploy migrations read from the cloned repo in the cluster, not from your local machine. This ensures the migrations match the deployed code version.

---

## Migration Runner Design

```yaml
# Generated K8s Job for migrations
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate-{env}-{timestamp}
  namespace: eve-{project}-{env}
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: eve-migrate-runner:latest  # Lightweight image with psql/migration tools
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: ...
          command: ["eve-migrate", "--path", "/migrations"]
          volumeMounts:
            - name: migrations
              mountPath: /migrations
      volumes:
        - name: migrations
          configMap:
            name: migrations-{env}  # Migration SQL files
```

**Flow**:
1. Deploy creates ConfigMap with migration SQL files from repo
2. Creates migration Job
3. Waits for Job completion (success/failure)
4. On success: mark migrations complete, continue deploy
5. On failure: roll back entire deployment

---

## Implementation Plan

### Phase 1: Schema and Types

**Files to modify:**
- `packages/shared/src/schemas/manifest.ts` - Add component schema

```typescript
const HealthcheckSchema = z.object({
  test: z.union([z.string(), z.array(z.string())]),
  interval: z.string().optional(),      // e.g., "5s"
  timeout: z.string().optional(),       // e.g., "3s"
  retries: z.number().optional(),       // default 3
  start_period: z.string().optional(),  // e.g., "10s"
});

const DependencySchema = z.object({
  condition: z.enum(['started', 'healthy']).default('started'),
  migrations: z.boolean().optional(),   // Eve extension
});

const MigrationsSchema = z.object({
  path: z.string(),                     // e.g., "supabase/migrations"
  on_deploy: z.boolean().default(false),
});

// Migration filename validation (Supabase convention)
const MIGRATION_FILENAME_REGEX = /^(\d{14})_(.+)\.sql$/;
// Matches: 20240603101431_create_users.sql
// Group 1: timestamp (14 digits)
// Group 2: description

function validateMigrationFilename(filename: string): void {
  const match = filename.match(MIGRATION_FILENAME_REGEX);
  if (!match) {
    throw new Error(
      `Invalid migration filename: ${filename}\n` +
      `Expected format: YYYYMMDDHHmmss_description.sql (14-digit UTC timestamp)\n` +
      `Example: 20240115093042_create_users.sql`
    );
  }
  // Validate timestamp is a valid date
  const ts = match[1];
  const year = parseInt(ts.slice(0, 4), 10);
  const month = parseInt(ts.slice(4, 6), 10);
  const day = parseInt(ts.slice(6, 8), 10);
  const hour = parseInt(ts.slice(8, 10), 10);
  const min = parseInt(ts.slice(10, 12), 10);
  const sec = parseInt(ts.slice(12, 14), 10);

  if (month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || min > 59 || sec > 59 || year < 2000) {
    throw new Error(
      `Invalid timestamp in migration filename: ${filename}\n` +
      `Timestamp ${ts} is not a valid UTC datetime`
    );
  }
}

const ComponentSchema = z.object({
  type: z.string().optional(),            // String, not enum - extensible for future types
  external: z.boolean().optional(),
  connection_url: z.string().optional(),
  image: z.string().optional(),
  build: z.object({
    context: z.string(),
    dockerfile: z.string().optional(),
  }).optional(),
  port: z.union([                         // Single or multiple ports
    z.number(),
    z.array(z.number()),
  ]).optional(),
  env: z.record(z.string()).optional(),
  healthcheck: HealthcheckSchema.optional(),
  depends_on: z.record(DependencySchema).optional(),
  migrations: MigrationsSchema.optional(),
}).passthrough();                         // Allow unknown fields for forward compatibility
```

### Phase 2: Deployment Orchestration (Worker)

**Files to modify:**
- `apps/worker/src/deployer/deployer.service.ts` - Main changes here

**Changes to `renderManifest()`:**

1. **Generate K8s probes from healthcheck config:**
```typescript
// Convert docker-compose healthcheck to K8s readinessProbe
const probe = this.healthcheckToK8sProbe(component.healthcheck);
// Add to container spec: readinessProbe, livenessProbe
```

2. **Topological sort components by depends_on:**
```typescript
// Sort components so dependencies deploy first
const sortedComponents = this.topologicalSort(components);
```

3. **Deploy in phases with health polling:**
```typescript
for (const component of sortedComponents) {
  // Deploy component
  await this.deployComponent(namespace, component);

  // Wait for health if dependents need it
  if (this.hasDependentsWaitingForHealthy(component)) {
    await this.waitForHealthy(namespace, component);
  }

  // Run migrations if configured
  if (component.migrations?.on_deploy) {
    await this.runMigrations(namespace, component);
  }
}
```

4. **Add migration runner Job generation:**
```typescript
private async runMigrations(namespace: string, component: Component): Promise<void> {
  // Create ConfigMap with migration SQL files
  // Create Job to run migrations
  // Wait for Job completion
  // On failure: throw to trigger rollback
}
```

5. **Add rollback on failure:**
```typescript
try {
  await this.deployInOrder(namespace, components);
} catch (error) {
  await this.rollback(namespace, previousReleaseId);
  throw error;
}
```

### Phase 3: Health Check to K8s Probe Conversion

**Add to `deployer.service.ts`:**

```typescript
private healthcheckToK8sProbe(healthcheck: Healthcheck): K8sProbe | undefined {
  if (!healthcheck?.test) return undefined;

  const test = Array.isArray(healthcheck.test)
    ? healthcheck.test
    : ['CMD-SHELL', healthcheck.test];

  const [type, ...args] = test;

  // Convert CMD/CMD-SHELL to exec probe
  if (type === 'CMD' || type === 'CMD-SHELL') {
    return {
      exec: {
        command: type === 'CMD-SHELL'
          ? ['/bin/sh', '-c', args.join(' ')]
          : args,
      },
      initialDelaySeconds: this.parseDuration(healthcheck.start_period) ?? 0,
      periodSeconds: this.parseDuration(healthcheck.interval) ?? 10,
      timeoutSeconds: this.parseDuration(healthcheck.timeout) ?? 5,
      failureThreshold: healthcheck.retries ?? 3,
    };
  }

  return undefined;
}
```

### Phase 4: CLI Updates

**Files to modify:**
- `packages/cli/src/commands/db.ts` - Read migrations path from manifest

```typescript
// In handleMigrate():
async function handleMigrate(...) {
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);

  // 1. If --path provided, use it
  const pathFlag = getStringFlag(flags, ['path']);
  let migrationsPath: string;

  if (pathFlag) {
    migrationsPath = resolvePath(pathFlag);
  } else {
    // 2. Try to read from local manifest
    const manifest = loadLocalManifest();  // Read .eve/manifest.yaml
    const dbComponent = Object.values(manifest?.components ?? {})
      .find(c => c.type === 'database');

    if (dbComponent?.migrations?.path) {
      migrationsPath = resolvePath(dbComponent.migrations.path);
    } else {
      // 3. Fall back to .eve/migrations
      migrationsPath = resolvePath('.eve/migrations');
    }
  }

  // Validate and load migrations (fails fast on invalid filenames)
  const migrations = loadMigrations(migrationsPath);  // calls validateMigrationFilename() for each file
  // ... send to API
}

// For multi-database manifests, add --component flag:
// eve db migrate --env test --component analytics-db
```

**Multi-database support:**
```bash
# Single database (finds first type: database component)
eve db migrate --env test

# Multiple databases - specify which one
eve db migrate --env test --component analytics-db
```

- `packages/cli/src/commands/env.ts` - Show deployment progress

```bash
$ eve env deploy proj_xxx test --tag local
Deploying to test environment...
  [1/3] db: deploying...
  [1/3] db: healthy ✓
  [1/3] db: running migrations...
  [1/3] db: migrations complete ✓
  [2/3] api: deploying...
  [2/3] api: healthy ✓
  [3/3] web: deploying...
  [3/3] web: healthy ✓
Deploy complete.
```

### Phase 5: Cleanup

**Files to modify:**
- `apps/worker/src/invoke/invoke.service.ts` - Remove ServiceSpec type (lines 92-103)
- `docs/ideas/job-services.md` - Archive to docs/archive/

### Phase 6: Documentation

**Files to create/update:**
- `docs/system/manifest.md` - Add healthcheck, depends_on, migrations sections
- Update example repo manifest with new features

---

## Verification

### Unit Tests
- `packages/shared` - Schema validation for healthcheck, depends_on, migrations
- `packages/shared` - Migration filename validation:
  - Valid: `20240603101431_create_users.sql` ✓
  - Invalid: `20240115_create_users.sql` (8-digit date, missing time)
  - Invalid: `create_users.sql` (no timestamp)
  - Invalid: `20241315101431_foo.sql` (invalid month 13)
- `apps/worker` - Topological sort, healthcheck-to-probe conversion

### Integration Tests
- Deploy with depends_on ordering
- Health check polling
- Migration runner Job execution
- Rollback on migration failure

### E2E Test (example repo)
Update `eve-horizon-fullstack-example/.eve/manifest.yaml`:

```yaml
components:
  db:
    type: database
    image: postgres:16
    port: 5432
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "eve"]
      interval: 5s
      retries: 5
    migrations:
      path: supabase/migrations  # or .eve/migrations
      on_deploy: true

  api:
    build:
      context: ./apps/api
    port: 3000
    depends_on:
      db:
        condition: healthy
        migrations: true
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]

  web:
    build:
      context: ./apps/web
    port: 80
    depends_on:
      api:
        condition: healthy
```

### Manual Test Flow
```bash
# 1. Deploy with new manifest
eve env deploy proj_xxx test --tag local
# Should show: db → (healthy) → (migrations) → api → (healthy) → web

# 2. Verify migrations ran
eve db migrations --project proj_xxx --env test
# Should list applied migrations

# 3. Test rollback - break a migration and redeploy
# Should roll back and restore previous state

# 4. Test external DB
# Set db.external: true, db.connection_url: ${secret.DATABASE_URL}
# Should connect to external and run migrations
```

---

## Files Summary

| File | Action |
|------|--------|
| `packages/shared/src/schemas/manifest.ts` | Add component schemas |
| `apps/worker/src/deployer/deployer.service.ts` | Add dependency ordering, health probes, migrations |
| `apps/worker/src/deployer/k8s.service.ts` | Add Job creation, health polling |
| `packages/cli/src/commands/db.ts` | Read migrations path from manifest |
| `packages/cli/src/commands/env.ts` | Show deployment progress |
| `apps/worker/src/invoke/invoke.service.ts` | Remove ServiceSpec |
| `docs/system/manifest.md` | Document new features |
