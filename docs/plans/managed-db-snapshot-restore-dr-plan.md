# Managed DB Snapshot & Restore — Disaster Recovery Plan

> Status: Draft
> Last Updated: 2026-03-05
> Purpose: Close the DR gap for Eve-managed databases with per-tenant snapshot/restore, scheduled backups via manifest cron, and S3-based persistence.

## Why This Plan

Eve-managed databases (`x-eve.role: managed_db`) currently have no per-tenant backup or restore capability. The system-level RDS instance has 7-day automated backups, but restoring a single tenant DB requires restoring the entire instance — a blunt instrument that disrupts all tenants.

The existing DBaaS plan (Phase 5) calls for "snapshot-before-destroy" but defers the implementation. This plan closes the full DR gap:

1. **On-demand snapshots** — `eve db snapshot` creates a point-in-time `pg_dump` stored in S3.
2. **Scheduled snapshots** — manifest-level cron triggers periodic backups without app code.
3. **Restore** — `eve db restore` recovers a tenant DB from any stored snapshot.
4. **Snapshot-on-delete** — automatic safety net before `eve db destroy` on production-class DBs.
5. **Lifecycle management** — retention policies, listing, pruning.

---

## 1) Current State

### What Exists

| Layer | Backup Coverage | Granularity |
|-------|----------------|-------------|
| RDS automated backups | 7-day retention, 03:00-04:00 UTC window | Entire RDS instance |
| `eve db reset --force` | Drops and recreates schema | Destructive, no snapshot |
| `eve db destroy --force` | DROP DATABASE + DROP ROLE | No snapshot before drop |
| App object store (`x-eve.object_store`) | S3-compatible bucket provisioning | Per-service buckets |

### What's Missing

- No `pg_dump`-based per-tenant snapshots
- No `eve db snapshot` or `eve db restore` CLI commands
- No scheduled/cron backup support
- No snapshot-on-delete in the reconciler
- No snapshot storage, listing, or retention management
- No documented RTO/RPO targets

---

## 2) Design Principles

1. **pg_dump over RDS snapshots** — Tenant DBs are logical databases on a shared instance. `pg_dump` gives per-tenant granularity without touching other tenants. Fast, cheap, portable.
2. **S3 as the snapshot store** — Reuse the existing app object store infrastructure. Platform provisions a system-level snapshot bucket per deployment.
3. **Manifest-driven scheduling** — App teams declare backup frequency in their manifest. The platform handles execution. No app code required.
4. **CLI-first** — Every operation is available via `eve db snapshot|restore|snapshots`. Agents and humans use the same interface.
5. **Production-first defaults** — `db.p2+` classes get daily snapshots and snapshot-on-delete by default. `db.p1` is opt-in only.

---

## 3) Snapshot Storage Model

### 3.1 Storage Location

Snapshots are stored in an Eve-managed S3 bucket, one per deployment:

```
s3://${deployment_id}-db-snapshots/
  └── {org_slug}/
      └── {project_slug}/
          └── {env_name}/
              └── {timestamp}_{snapshot_id}.dump
```

The bucket is provisioned by Terraform in the infra repo (same pattern as the registry bucket `example-registry-*`). Eve services access it via IRSA or static credentials depending on the deployment model.

**Local development (k3d)**: Use MinIO (same as app object store). The `BucketProvisioner` in `apps/worker/src/deployer/bucket-provisioner.ts` already supports both `s3` and `minio` backends via `EVE_STORAGE_BACKEND`. The snapshot service should reuse these env vars rather than introducing a parallel configuration path.

### 3.2 Snapshot Metadata

Each snapshot gets a metadata record in the `managed_db_snapshots` table:

```sql
CREATE TABLE IF NOT EXISTS managed_db_snapshots (
  id            TEXT PRIMARY KEY,         -- dbsnap_xxx (TypeID, generated in app code via typeid('dbsnap'))
  tenant_id     TEXT NOT NULL REFERENCES managed_db_tenants(id),
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  project_id    TEXT NOT NULL REFERENCES projects(id),
  env_id        TEXT NOT NULL REFERENCES environments(id),
  instance_id   TEXT NOT NULL REFERENCES managed_db_instances(id),
  created_by    TEXT,                     -- user_id or 'system' for scheduled/pre_delete

  -- Snapshot details
  trigger       TEXT NOT NULL,            -- 'manual' | 'scheduled' | 'pre_delete' | 'pre_reset'
  status        TEXT NOT NULL DEFAULT 'in_progress',  -- 'in_progress' | 'completed' | 'failed'
  s3_bucket     TEXT,                     -- Bucket name (enables multi-deployment portability)
  s3_key        TEXT,                     -- Full S3 object key
  size_bytes    BIGINT,                   -- Compressed dump size
  db_size_bytes BIGINT,                   -- Logical DB size at snapshot time
  pg_version    TEXT,                     -- Postgres version at snapshot time (for restore compat)
  error_message TEXT,

  -- Lifecycle
  retention     TEXT NOT NULL DEFAULT '30d',  -- Retention duration
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,

  CONSTRAINT valid_trigger CHECK (trigger IN ('manual', 'scheduled', 'pre_delete', 'pre_reset')),
  CONSTRAINT valid_status CHECK (status IN ('in_progress', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_tenant ON managed_db_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_expires ON managed_db_snapshots(expires_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_snapshots_tenant_created ON managed_db_snapshots(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_org ON managed_db_snapshots(org_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_status ON managed_db_snapshots(status) WHERE status = 'in_progress';
```

> **Implementation note**: The codebase generates TypeIDs in application code via `typeid('dbsnap')` (see `packages/shared/src/ids.ts`), not via SQL `DEFAULT` expressions. Add a `generateManagedDbSnapshotId()` export alongside the existing `generateManagedDbInstanceId()` and `generateManagedDbTenantId()` functions.

### 3.3 Retention Defaults

| DB Class | Default Retention | Snapshot-on-Delete | Default Schedule |
|----------|------------------|--------------------|------------------|
| `db.p1`  | 7 days           | Off                | Off (opt-in)     |
| `db.p2`  | 30 days          | On                 | Daily 02:00 UTC  |
| `db.p3`  | 90 days          | On                 | Daily 02:00 UTC  |

For tighter `db.p3` recovery targets, set an explicit `backup.schedule` at manifest level.

Override retention per-snapshot via `--retention 90d` on manual snapshots.

---

## 4) Manifest Integration — Scheduled Snapshots

### 4.1 Manifest Schema Extension

Add a `backup` block to the managed DB service config:

```yaml
services:
  db:
    x-eve:
      role: managed_db
      managed:
        class: db.p2
        engine: postgres
        engine_version: "16"
        backup:
          schedule: "0 2 * * *"       # Standard cron expression (daily at 02:00 UTC)
          retention: 30d              # How long to keep snapshots
          snapshot_on_delete: true    # Snapshot before eve db destroy
          snapshot_on_reset: true     # Snapshot before eve db reset
```

### 4.2 Defaults by Class

When `backup` is omitted, the platform applies class-based defaults:

- **`db.p1`**: No scheduled backup, no snapshot-on-delete (dev tier).
- **`db.p2`+**: `schedule: "0 2 * * *"`, `retention: 30d`, `snapshot_on_delete: true`, `snapshot_on_reset: true`.

To explicitly disable on a production class:

```yaml
backup:
  schedule: false
  snapshot_on_delete: false
```

### 4.3 Per-Environment Override

```yaml
environments:
  production:
    overrides:
      services:
        db:
          x-eve:
            managed:
              backup:
                schedule: "0 */6 * * *"   # Every 6 hours for production
                retention: 90d
```

### 4.4 How Scheduling Works

The orchestrator's cron subsystem evaluates managed DB backup schedules:

1. On each cron tick, the orchestrator queries all `managed_db_tenants` with `status = 'ready'` and an active backup schedule.
2. For each tenant whose schedule is due (based on `last_snapshot_at` and UTC), it creates a snapshot job (internal, not user-visible as a pipeline run).
3. The snapshot job runs `pg_dump` against the tenant DB, streams the output to S3 via `@aws-sdk/lib-storage` (multipart upload), and updates the snapshot record.
4. On completion, the cron records the last snapshot time on the tenant record to avoid duplicate runs.

This reuses the same cron infrastructure that drives the usage sweeper, suspension controller, and fx updater.

**Implementation note**: The `managed_db_tenants` table does not currently have `last_snapshot_at` or `backup_schedule` columns. The migration must add:

```sql
ALTER TABLE managed_db_tenants
  ADD COLUMN IF NOT EXISTS backup_schedule TEXT,          -- cron expression, NULL = no schedule
  ADD COLUMN IF NOT EXISTS backup_retention TEXT,         -- e.g. '30d', NULL = class default
  ADD COLUMN IF NOT EXISTS snapshot_on_delete BOOLEAN,    -- NULL = class default
  ADD COLUMN IF NOT EXISTS snapshot_on_reset BOOLEAN,     -- NULL = class default
  ADD COLUMN IF NOT EXISTS last_snapshot_at TIMESTAMPTZ;  -- set by scheduler after successful snapshot
```

These columns are populated by the deployment reconciler when it reads the manifest's `backup` block. The scheduler cron queries them directly — no manifest parsing at cron time.

---

## 5) Snapshot Execution

### 5.1 pg_dump Strategy

```
PGPASSWORD=<admin_pass> pg_dump --format=custom --compress=6 --no-owner --no-acl \
  --dbname=<tenant_db> --host=<instance_host> --port=<port> --username=<admin_user>
```

- **Format**: `custom` (`-Fc`) — supports parallel restore, selective table restore, and is smaller than plain SQL.
- **Compression**: `--compress=6` in pg_dump custom format for a balanced speed/size ratio.
- **No owner/ACL**: Tenant DB users are platform-managed; ownership is re-applied on restore.
- **Streaming upload**: Pipe `pg_dump` stdout directly to S3 multipart upload via `@aws-sdk/lib-storage` `Upload` class. No local temp file needed.
- **Auth**: Pass credentials via `PGPASSWORD` env var (not `--password`). The admin credentials are derived from the orchestrator's `DATABASE_URL` — same approach used by `connectToInstance()` in the reconciler.

**Node.js implementation**: Use `child_process.spawn('pg_dump', [...args])` and pipe `child.stdout` as a `Readable` stream into the S3 `Upload`. Handle `child.stderr` for error capture and `child.on('exit', code)` for failure detection.

### 5.2 Snapshot Job Flow

```
1. Create snapshot record (status: in_progress)
2. Query tenant DB size (`pg_database_size`) and approximate row count (`pg_stat_user_tables`).
3. Start pg_dump, stream to S3 via multipart upload
4. On success: update snapshot record (status: completed, size_bytes, completed_at)
5. On failure: update snapshot record (status: failed, error_message)
6. Emit event: system.db.snapshot.completed or system.db.snapshot.failed
```

### 5.3 Concurrency Guards

- Only one snapshot per tenant at a time (checked via `FOR UPDATE SKIP LOCKED` on queue rows and `status = 'in_progress'` query guard).
- Snapshot does not acquire locks beyond `pg_dump`'s default `ACCESS SHARE` — safe to run on live databases.
- Timeout: 30 minutes per snapshot (covers up to ~50GB compressed). Configurable per class.

---

## 6) Restore Execution

### 6.1 Restore Strategy

```
pg_restore --format=custom --no-owner --no-acl --clean --if-exists \
  --dbname=<tenant_db> --host=<instance_host> --port=<port> --username=<admin_user>
```

- **`--clean --if-exists`**: Drop existing objects before restoring. Safe for full-DB restore.
- **No owner/ACL**: Re-apply tenant role ownership after restore.
- **Stream from S3**: Download snapshot directly into `pg_restore` stdin.

### 6.2 Restore Flow

```
1. Validate snapshot exists and status = 'completed'
2. Create pre-restore safety snapshot (trigger: 'pre_reset', unless --skip-safety-snapshot)
3. Terminate active connections to tenant DB
4. Run pg_restore from S3 snapshot
5. Re-apply tenant role ownership (GRANT ALL ON ALL TABLES/SEQUENCES/FUNCTIONS)
6. Verify restore (table count + basic connectivity check)
7. Emit event: system.db.restore.completed or system.db.restore.failed
```

### 6.3 Cross-Environment Restore

Restoring a snapshot to a different environment is supported:

```bash
eve db restore --env staging --snapshot dbsnap_xxx --source-env production [--source-project <id>]
```

This enables:
- Cloning production data to staging for debugging
- Disaster recovery to a different environment
- Data seeding for new environments

Credentials are remapped to the target tenant's role automatically.

### 6.4 Portable Export & Import

Snapshots are standard `pg_dump` custom-format files. The CLI provides explicit export/import commands for moving data outside the Eve ecosystem:

#### Download (Eve → local file)

```bash
# Download a snapshot as a portable pg_dump file
eve db snapshot download <snapshot_id> --output ./myapp-production-20260305.dump
```

The downloaded file works with any standard `pg_restore`:

```bash
# Restore to any Postgres instance — no Eve required
pg_restore --clean --if-exists --no-owner --no-acl \
  -d postgres://user:pass@external-host:5432/mydb \
  ./myapp-production-20260305.dump
```

#### Export (Eve → external Postgres, direct)

```bash
# Stream a snapshot directly into an external database
eve db export --snapshot <snapshot_id> --url postgres://user:pass@host:5432/target_db
  [--clean]                                   # Drop existing objects first
  [--force]
```

This pipes S3 → `pg_restore` → external DB in one step. No local file needed.

#### Import (external dump → Eve managed DB)

```bash
# Import a pg_dump file into an Eve-managed DB
eve db import --env <name> --file ./external-backup.dump
  [--project <id>]
  [--skip-safety-snapshot]                    # Skip pre-import backup
  [--clean]                                   # Drop existing objects first
  [--force]

# Import directly from an external Postgres database
eve db import --env <name> --source-url postgres://user:pass@host:5432/source_db
  [--project <id>]
  [--skip-safety-snapshot]
  [--force]
```

The `--source-url` variant runs `pg_dump` against the external database and streams directly into the Eve-managed tenant DB. This is the primary path for migrating onto Eve from an existing Postgres deployment.

#### Cross-Instance Migration (Eve → Eve)

For migrating between Eve instances (e.g., staging cluster → production cluster):

```bash
# On source instance:
eve db snapshot --env production
eve db snapshot download dbsnap_xxx --output ./migration.dump

# On target instance:
eve db import --env production --file ./migration.dump --force
```

Or, if both instances are network-reachable:

```bash
# Direct pipe: source Eve snapshot → target Eve managed DB
eve db export --snapshot dbsnap_xxx --url postgres://user:pass@target-host:5432/target_db
```

The download/import path is preferred for cross-instance migration since it doesn't require network connectivity between clusters and creates an auditable artifact.

---

## 7) CLI Surface

### 7.1 New Commands

```bash
# Create a snapshot
eve db snapshot --env <name> [--project <id>]
  [--retention 30d]                           # Override default retention
  [--json]

# List snapshots
eve db snapshots --env <name> [--project <id>]
  [--limit 20] [--status completed|failed|all]
  [--json]

# Show snapshot details
eve db snapshot show <snapshot_id>
  [--json]

# Restore from snapshot
eve db restore --env <name> --snapshot <snapshot_id>
  [--project <id>]
  [--source-env <name>]
  [--source-project <id>]
  [--skip-safety-snapshot]                    # Skip pre-restore backup
  [--force]                                   # Required confirmation flag
  [--json]

# Delete a snapshot
eve db snapshot delete <snapshot_id>
  [--force]
  [--json]

# Download snapshot as portable file
eve db snapshot download <snapshot_id>
  --output <path>                             # Local file path

# Show backup schedule and status
eve db backup-status --env <name> [--project <id>]
  [--json]

# Export snapshot to external Postgres
eve db export --snapshot <snapshot_id>
  --url <postgres_url>                        # Target database
  [--clean] [--force]

# Import into Eve-managed DB from file or external DB
eve db import --env <name>
  (--file <path> | --source-url <postgres_url>)
  [--project <id>] [--clean]
  [--skip-safety-snapshot] [--force]
```

### 7.2 Integration with Existing Commands

```bash
# eve db destroy gains --skip-snapshot flag
eve db destroy --env staging --force                # Snapshots if class >= db.p2
eve db destroy --env staging --force --skip-snapshot  # Skip safety snapshot

# eve db reset gains --skip-snapshot flag
eve db reset --env staging --force                  # Snapshots if configured
eve db reset --env staging --force --skip-snapshot  # Skip safety snapshot
```

### 7.3 Output Examples

```
$ eve db snapshot --env production
Creating snapshot of example/myapp/production (db.p2, 1.2 GB)...
Snapshot: dbsnap_01abc123 (in_progress)
Uploading to s3://${deployment_id}-db-snapshots/example/myapp/production/20260305T020000_dbsnap_01abc123.dump
Done. 342 MB compressed (1.2 GB logical). Retention: 30d.

$ eve db snapshots --env production
ID                  Trigger     Size     DB Size   Created              Expires
dbsnap_01abc123     scheduled   342 MB   1.2 GB    2026-03-05 02:00     2026-04-04
dbsnap_01abc100     scheduled   340 MB   1.2 GB    2026-03-04 02:00     2026-04-03
dbsnap_01abc099     manual      338 MB   1.1 GB    2026-03-03 15:30     2026-04-02

$ eve db backup-status --env production
Environment: production (db.p2)
Schedule:    0 2 * * * (daily at 02:00 UTC)
Retention:   30d
Last:        2026-03-05 02:00 (dbsnap_01abc123, 342 MB)
Next:        2026-03-06 02:00
Snapshots:   28 stored (9.4 GB total)
Snapshot-on-delete: enabled
Snapshot-on-reset:  enabled
```

---

## 8) API Endpoints

These endpoints live in the existing `ManagedDbController` (`apps/api/src/environments/managed-db.controller.ts`), extending the current `/projects/:id/envs/:name/db/managed` route tree.

```
# Snapshots (permission: envdb:read / envdb:write)
POST   /projects/:id/envs/:name/db/snapshots              # Create snapshot (envdb:write)
GET    /projects/:id/envs/:name/db/snapshots               # List snapshots (envdb:read)
GET    /projects/:id/envs/:name/db/snapshots/:snapshotId   # Show snapshot (envdb:read)
DELETE /projects/:id/envs/:name/db/snapshots/:snapshotId   # Delete snapshot (envdb:write)

# Restore (permission: envdb:write)
POST   /projects/:id/envs/:name/db/restore
       Body: { snapshot_id, source_env?, source_project?, skip_safety_snapshot? }

# Backup status (permission: envdb:read)
GET    /projects/:id/envs/:name/db/backup-status

# Export / Import (permission: envdb:write)
GET    /projects/:id/envs/:name/db/snapshots/:snapshotId/download  # Returns signed S3 URL
POST   /projects/:id/envs/:name/db/export
       Body: { snapshot_id, target_url, clean? }
POST   /projects/:id/envs/:name/db/import
       Body: { source_url?, clean?, skip_safety_snapshot? }
       (or multipart file upload)
```

**Permission model**: Reuses the existing `envdb:read` and `envdb:write` permissions from `ManagedDbController`. Snapshot creation, deletion, restore, export, and import require `envdb:write`. Listing and viewing require `envdb:read`.

---

## 9) Infrastructure Requirements

### 9.1 S3 Bucket (Terraform — Infra Repo)

Add a `db-snapshots` module to the infra repo:

```hcl
module "db_snapshots" {
  source      = "./modules/s3-bucket"
  bucket_name = "${var.deployment_id}-db-snapshots"

  lifecycle_rules = [
    {
      id      = "expire-old-snapshots"
      prefix  = ""
      enabled = true
      expiration_days = 90  # Hard ceiling — app-level retention is typically shorter
    },
    {
      id      = "abort-incomplete-multipart"
      prefix  = ""
      enabled = true
      abort_incomplete_multipart_upload_days = 1  # Clean up failed streaming uploads
    }
  ]

  encryption = {
    sse_algorithm = "aws:kms"
    kms_key_id    = var.kms_key_id
  }

  # IRSA access for Eve services
  iam_role_arn = module.eve_irsa.role_arn
}
```

### 9.2 IRSA Policy

Add S3 permissions for the snapshot bucket to the Eve service IRSA role:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:GetObject",
    "s3:DeleteObject",
    "s3:ListBucket",
    "s3:AbortMultipartUpload",
    "s3:ListMultipartUploadParts",
    "s3:ListBucketMultipartUploads"
  ],
  "Resource": [
    "arn:aws:s3:::${deployment_id}-db-snapshots",
    "arn:aws:s3:::${deployment_id}-db-snapshots/*"
  ]
}
```

### 9.3 Worker / Orchestrator Images

The worker and orchestrator images need `pg_dump` and `pg_restore` binaries. **These are NOT currently installed** — the worker Dockerfile (`apps/worker/Dockerfile`) uses `node:22-slim` and installs git, kubectl, BuildKit, etc. but not `postgresql-client`.

**Required change** — add to both the worker and orchestrator Dockerfiles:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
```

The `postgresql-client` package on Debian Bookworm (node:22-slim base) provides pg_dump/pg_restore for Postgres 15. For Postgres 16 tenant DBs, install from the PGDG repo instead:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends gnupg lsb-release \
  && echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/*
```

**Where the snapshot runs**: Since scheduled snapshots and snapshot-on-delete run in the orchestrator process (cron services), the orchestrator image is the primary target. The worker needs the binaries only if snapshots are triggered as worker jobs. For Phase 1, installing in the orchestrator is sufficient.

---

## 10) Reconciler Changes

### 10.1 Snapshot-on-Delete

In `ManagedDbReconcilerService.handleDeleting()` (`apps/orchestrator/src/cron/managed-db-reconciler.service.ts`):

The current flow calls `deleteLocalDb()` which does: terminate connections → DROP DATABASE → DROP ROLE, then `markTenantDeleted()`.

```
Before (current):
  1. deleteLocalDb(instance, tenant):
     a. Terminate connections
     b. DROP DATABASE IF EXISTS
     c. DROP ROLE IF EXISTS
  2. markTenantDeleted(id)

After:
  1. Check if snapshot_on_delete is enabled (tenant.snapshot_on_delete or class default)
  2. If enabled AND tenant.credential_secret_ref exists (DB was actually provisioned):
     a. Create snapshot (trigger: 'pre_delete'), wait for completion (timeout: 5 min)
     b. If snapshot fails: log warning, proceed with delete (don't block teardown)
  3. deleteLocalDb(instance, tenant) — unchanged
  4. markTenantDeleted(id) — unchanged
```

**Note**: The reconciler uses CAS-based operation locks (`acquireOperationLock`/`transitionStatus`). The snapshot step runs within the existing lock — no new lock acquisition needed.

### 10.2 Scheduled Snapshot Cron

New cron job in the orchestrator (`ManagedDbSnapshotScheduler`), registered in `CronModule` alongside the existing 6 cron services:

```
Enable: EVE_MANAGED_DB_SNAPSHOT_SCHEDULER_ENABLED=true
Cron:   */60 * * * * *  (every minute)

Every tick:
  1. Guard: if already running, skip (same pattern as ManagedDbReconcilerService)
  2. Query managed_db_tenants WHERE status = 'ready'
       AND backup_schedule IS NOT NULL AND deleted_at IS NULL
  3. For each tenant: evaluate cron expression against last_snapshot_at
     - Use `cron-parser` (already in deps via the CronSchedulerService)
  4. If due AND no in_progress snapshot exists for this tenant:
     - Create snapshot (trigger: 'scheduled')
  5. Respect max concurrent snapshots per instance (default: 2)
     - Query COUNT(*) from managed_db_snapshots WHERE instance_id = ? AND status = 'in_progress'
```

**Pattern reference**: Follow the exact NestJS lifecycle pattern from `ManagedDbSweeperService` — `OnModuleInit`/`OnModuleDestroy`, env-gated enable, `CronJob` from `cron` package, `this.running` overlap guard.

### 10.3 Snapshot Expiry Pruner

New cron job (`ManagedDbSnapshotPruner`):

```
Enable: EVE_MANAGED_DB_SNAPSHOT_PRUNER_ENABLED=true
Cron:   0 */1 * * *  (every hour, on the hour)

Every tick:
  1. Query managed_db_snapshots WHERE expires_at < NOW() AND status = 'completed'
     LIMIT 100  (batch to avoid long-running transactions)
  2. For each: delete S3 object (ignore 404 — idempotent)
  3. Delete snapshot records
  4. Also clean up failed/stale snapshots: status = 'in_progress' AND created_at < NOW() - INTERVAL '2 hours'
     (mark as 'failed' with error_message 'timed out')
  5. Log pruned count per category (expired, stale)
```

**S3 lifecycle belt-and-suspenders**: The S3 bucket lifecycle rule (90-day hard ceiling) acts as a safety net if the pruner fails. The pruner handles app-level retention (7d/30d/90d per class), while S3 lifecycle handles the absolute maximum.

---

## 11) Events

| Event | When | Payload |
|-------|------|---------|
| `system.db.snapshot.started` | Snapshot begins | `{ tenant_id, snapshot_id, trigger }` |
| `system.db.snapshot.completed` | Snapshot succeeds | `{ tenant_id, snapshot_id, size_bytes, duration_ms }` |
| `system.db.snapshot.failed` | Snapshot fails | `{ tenant_id, snapshot_id, error }` |
| `system.db.restore.started` | Restore begins | `{ tenant_id, snapshot_id }` |
| `system.db.restore.completed` | Restore succeeds | `{ tenant_id, snapshot_id, duration_ms }` |
| `system.db.restore.failed` | Restore fails | `{ tenant_id, snapshot_id, error }` |

These events can trigger workflows (e.g., notify on failure, run post-restore migrations).

---

## 12) Execution Plan

### Phase 1: Foundations

1. **Migration**: `managed_db_snapshots` table + `ALTER TABLE managed_db_tenants` to add backup columns (`backup_schedule`, `backup_retention`, `snapshot_on_delete`, `snapshot_on_reset`, `last_snapshot_at`).
2. **TypeID**: Add `generateManagedDbSnapshotId()` to `packages/shared/src/ids.ts`.
3. **Dockerfile**: Install `postgresql-client-16` in the orchestrator Dockerfile.
4. **S3 bucket**: Terraform module in infra repo (production). MinIO bucket creation for local k3d (reuse `BucketProvisioner` pattern).
5. **Snapshot service**: Core `pg_dump` → S3 streaming upload in a shared service (usable by both API and orchestrator).
6. **DB queries**: Snapshot CRUD in `packages/db/src/queries/managed-db-snapshots.ts`.
7. **API endpoints**: Create, list, show, delete snapshots.
8. **CLI commands**: `eve db snapshot` and `eve db snapshots`.

**Acceptance**: Manual snapshot of a managed DB appears in S3, metadata in DB, listed via CLI.

### Phase 2: Restore

1. Restore service: S3 download → `pg_restore` with connection termination and re-grant.
2. Pre-restore safety snapshot.
3. `eve db restore` CLI command.
4. Cross-environment restore support.

**Acceptance**: Restore from snapshot produces a working tenant DB. Safety snapshot exists.

### Phase 3: Scheduling & Automation

1. Manifest schema extension: `backup` block in `ManagedDbConfigSchema` (`packages/shared/src/schemas/manifest.ts`).
2. Deploy reconciler: read `backup` from manifest, populate `backup_schedule`/`backup_retention`/`snapshot_on_delete`/`snapshot_on_reset` on the tenant row.
3. Orchestrator cron: `ManagedDbSnapshotScheduler` (registered in `CronModule`).
4. Snapshot expiry pruner cron: `ManagedDbSnapshotPruner`.
5. Snapshot-on-delete in reconciler `handleDeleting()`.
6. Snapshot-on-reset in `EnvDbService.reset()` (`apps/api/src/environments/env-db.service.ts`) — **note**: reset runs in the API process, not the orchestrator, so the snapshot service must be available in both.
7. `eve db backup-status` CLI command + API endpoint.
8. `--skip-snapshot` flag on `eve db destroy` and `eve db reset`.

**Acceptance**: Scheduled snapshots fire on cron, old snapshots are pruned, `destroy` creates safety snapshot.

### Phase 4: Observability & Hardening

1. Events for snapshot/restore lifecycle.
2. Snapshot metrics in analytics (count, total size, failure rate).
3. Alerting hooks for failed scheduled snapshots.
4. Manual test scenario: scheduled backup, manual restore, destroy with snapshot.
5. Documentation updates (system docs, CLI reference, eve-skillpacks).

**Acceptance**: Full DR cycle tested end-to-end. Docs updated. Agents can discover and use snapshot/restore via CLI.

---

## 13) RTO/RPO Targets

| DB Class | RPO (Data Loss Window) | RTO (Recovery Time) | How |
|----------|----------------------|--------------------|----|
| `db.p1`  | Up to 7 days (RDS only) | Hours (manual) | RDS instance restore + tenant extraction |
| `db.p2`  | Up to 24 hours | Minutes | Latest daily snapshot → `eve db restore` |
| `db.p3`  | Up to 24 hours | Minutes | Daily snapshot (default) or manifest-defined schedule → `eve db restore` |
| Custom   | Per cron schedule | Minutes | Manifest-defined schedule → `eve db restore` |

Post-restore, app-level migrations may need to run depending on schema drift since snapshot time.

---

## 14) Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `pg_dump` of large DB blocks tenant connections | Degraded performance during backup | `pg_dump` uses `ACCESS SHARE` locks only; no write blocking. Monitor duration. |
| S3 upload failure mid-stream | Orphaned multipart uploads, incomplete snapshot | `AbortMultipartUpload` on failure. S3 lifecycle rule to clean incomplete uploads after 1 day. |
| Restore to wrong environment | Data contamination | CLI requires `--force` flag. Restore remaps credentials to target tenant. |
| Snapshot storage costs grow unbounded | Unexpected S3 bill | Retention defaults + pruner cron + S3 lifecycle hard ceiling (90d). |
| Scheduled snapshot runs during peak traffic | Performance impact | Default schedule at 02:00 UTC (off-peak). Max 2 concurrent snapshots per instance. |
| Snapshot-on-delete blocks teardown | Slow environment cleanup | Snapshot failure logs warning but doesn't block delete. Best-effort safety net. |
| pg_dump/pg_restore version mismatch | Restore fails with "unsupported version" | Record `pg_version` in snapshot metadata. Validate compatibility before restore. pg_restore is forwards-compatible (newer tool restores older dumps) but not the reverse. |
| Tenant deleted before snapshot completes | Orphaned S3 objects, dangling metadata | Pruner handles stale `in_progress` snapshots (>2 hours). S3 lifecycle provides hard ceiling. Snapshot-on-delete runs before DROP. |
| Concurrent snapshot + restore on same tenant | Data corruption during restore | Restore terminates connections and requires `--force`. Concurrency guard prevents two snapshots. Restore should also check for in-progress snapshots and refuse if one exists. |

---

## 15) Code Organisation

The snapshot/restore logic is needed in multiple services:
- **API**: Manual snapshots (CLI-triggered), pre-reset snapshots, restore, download/export/import
- **Orchestrator**: Scheduled snapshots (cron), pre-delete snapshots (reconciler), pruner

To avoid duplication, place the core execution logic in a shared location:

| Component | Location | Why |
|-----------|----------|-----|
| DB queries (`managed-db-snapshots.ts`) | `packages/db/src/queries/` | Same pattern as `managed-db.ts` |
| Snapshot executor (pg_dump → S3 stream) | `packages/shared/src/managed-db/snapshot-executor.ts` | Pure function: takes DB config + S3 config, returns stream |
| S3 client factory | `packages/shared/src/managed-db/snapshot-storage.ts` | Reuses `EVE_STORAGE_*` env vars from `BucketProvisioner` |
| Zod schemas (API request/response) | `packages/shared/src/schemas/managed-db.ts` | Extend existing file |
| API controller + service | `apps/api/src/environments/` | Extend `ManagedDbController` and `ManagedDbService` |
| Cron services | `apps/orchestrator/src/cron/` | New files alongside existing crons |

---

## 16) Success Criteria

This plan is successful when:

1. App teams can add `backup.schedule` to their manifest and get automated snapshots without writing any code.
2. `eve db snapshot` and `eve db restore` work reliably for manual DR operations.
3. Production-class DBs (`db.p2+`) are automatically protected by daily snapshots and snapshot-on-delete.
4. Snapshot storage is self-managing — old snapshots are pruned, costs are predictable.
5. The full DR cycle (snapshot → catastrophic loss → restore) completes in under 5 minutes for typical databases.
