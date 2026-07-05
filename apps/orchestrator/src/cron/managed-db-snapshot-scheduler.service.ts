import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import { managedDbSnapshotQueries, type Db } from '@eve/db';
import {
  generateManagedDbSnapshotId,
  createSnapshotStorageClient,
  buildSnapshotS3Key,
  executeSnapshot,
  resolveManagedDbSnapshotRetention,
  snapshotRetentionToExpiresAt,
} from '@eve/shared';

// Use cron-parser to evaluate schedule expressions
import { CronExpressionParser } from 'cron-parser';

/**
 * Managed DB Snapshot Scheduler.
 *
 * Every tick, evaluates managed_db_tenants with backup_schedule set.
 * If a tenant's schedule is due (last_snapshot_at + interval < now), creates a snapshot.
 *
 * Disabled by default; enable with EVE_MANAGED_DB_SNAPSHOT_SCHEDULER_ENABLED=true.
 */
@Injectable()
export class ManagedDbSnapshotSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManagedDbSnapshotSchedulerService.name);
  private cronJob: CronJob | null = null;
  private running = false;

  private readonly snapshots: ReturnType<typeof managedDbSnapshotQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.snapshots = managedDbSnapshotQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_MANAGED_DB_SNAPSHOT_SCHEDULER_ENABLED !== 'true') {
      this.logger.log('[snapshot-scheduler] Disabled (set EVE_MANAGED_DB_SNAPSHOT_SCHEDULER_ENABLED=true to enable)');
      return;
    }

    const cron = process.env.EVE_MANAGED_DB_SNAPSHOT_SCHEDULER_CRON ?? '0 */5 * * * *'; // Every 5 min

    try {
      this.cronJob = new CronJob(
        cron,
        () => {
          this.tick().catch((err) => {
            this.logger.error(`[snapshot-scheduler] Tick failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        null,
        true,
        'UTC',
      );
      this.logger.log(`[snapshot-scheduler] Started (cron: ${cron})`);
    } catch (err) {
      this.logger.error(`[snapshot-scheduler] Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.cronJob?.stop();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      // Find all ready tenants with backup_schedule set
      const tenants = await this.db<Array<{
        id: string;
        org_id: string;
        project_id: string;
        env_id: string;
        org_slug: string;
        project_slug: string;
        env_name: string;
        instance_id: string;
        credential_secret_ref: string | null;
        class: string;
        backup_retention: string | null;
        backup_schedule: string | null;
        last_snapshot_at: Date | null;
      }>>`
        SELECT t.id, t.org_id, t.project_id, t.env_id, o.slug AS org_slug, p.slug AS project_slug, e.name AS env_name,
               t.instance_id, t.credential_secret_ref, t.class,
               t.backup_retention, t.backup_schedule, t.last_snapshot_at
        FROM managed_db_tenants t
        JOIN orgs o ON o.id = t.org_id
        JOIN projects p ON p.id = t.project_id
        JOIN environments e ON e.id = t.env_id
        WHERE status = 'ready'
          AND backup_schedule IS NOT NULL
          AND deleted_at IS NULL
      `;

      const maxConcurrentPerInstance = 2;
      let created = 0;

      for (const tenant of tenants) {
        if (!tenant.credential_secret_ref || !tenant.backup_schedule) continue;

        // Check if schedule is due
        if (!this.isScheduleDue(tenant.backup_schedule, tenant.last_snapshot_at)) continue;

        // Check concurrency limits
        const inProgressByTenant = await this.snapshots.countInProgressByTenant(tenant.id);
        if (inProgressByTenant > 0) continue;

        const inProgressByInstance = await this.snapshots.countInProgressByInstance(tenant.instance_id);
        if (inProgressByInstance >= maxConcurrentPerInstance) continue;

        // Create scheduled snapshot (credential_secret_ref already checked above)
        await this.createScheduledSnapshot(tenant as typeof tenant & { credential_secret_ref: string });
        created++;
      }

      if (created > 0) {
        this.logger.log(`[snapshot-scheduler] Created ${created} scheduled snapshot(s)`);
      }
    } finally {
      this.running = false;
    }
  }

  private isScheduleDue(schedule: string, lastSnapshotAt: Date | null): boolean {
    try {
      const expr = CronExpressionParser.parse(schedule, { tz: 'UTC' });
      const prev = expr.prev().toDate();

      // If no previous snapshot, it's due
      if (!lastSnapshotAt) return true;

      // If the previous cron fire time is after the last snapshot, it's due
      return prev > lastSnapshotAt;
    } catch {
      return false;
    }
  }

  private async createScheduledSnapshot(tenant: {
    id: string;
    org_id: string;
    project_id: string;
    env_id: string;
    org_slug: string;
    project_slug: string;
    env_name: string;
    instance_id: string;
    class: string;
    backup_retention: string | null;
    credential_secret_ref: string;
  }): Promise<void> {
    try {
      const snapshotStorage = createSnapshotStorageClient();
      if (!snapshotStorage) {
        this.logger.warn('[snapshot-scheduler] Storage not configured, skipping snapshot');
        return;
      }
      const snapshotId = generateManagedDbSnapshotId();

      const retention = resolveManagedDbSnapshotRetention(undefined, {
        dbClass: tenant.class,
        tenantRetention: tenant.backup_retention,
      });

      const s3Key = buildSnapshotS3Key(
        tenant.org_slug,
        tenant.project_slug,
        tenant.env_name,
        snapshotId,
      );

      // Create snapshot record
      await this.snapshots.createSnapshot({
        id: snapshotId,
        tenant_id: tenant.id,
        org_id: tenant.org_id,
        project_id: tenant.project_id,
        env_id: tenant.env_id,
        instance_id: tenant.instance_id,
        created_by: 'system:scheduler',
        trigger: 'scheduled',
        s3_bucket: snapshotStorage.bucket,
        s3_key: s3Key,
        retention,
        expires_at: snapshotRetentionToExpiresAt(retention),
      });

      // Parse connection URL
      const url = new URL(tenant.credential_secret_ref);
      const dbConfig = {
        host: url.hostname,
        port: parseInt(url.port, 10) || 5432,
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, ''),
      };

      // Execute snapshot asynchronously
      executeSnapshot(dbConfig, { client: snapshotStorage.client, bucket: snapshotStorage.bucket, key: s3Key })
        .then(async (result) => {
          await this.snapshots.completeSnapshot(snapshotId, {
            size_bytes: result.sizeBytes,
            db_size_bytes: result.dbSizeBytes,
            pg_version: result.pgVersion,
          });
          await this.snapshots.updateTenantLastSnapshotAt(tenant.id);
          this.logger.log(`[snapshot-scheduler] Snapshot ${snapshotId} completed`);
        })
        .catch(async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          await this.snapshots.failSnapshot(snapshotId, message);
          this.logger.error(`[snapshot-scheduler] Snapshot ${snapshotId} failed: ${message}`);
        });
    } catch (err) {
      this.logger.error(`[snapshot-scheduler] Failed to create snapshot for tenant ${tenant.id}:`, err instanceof Error ? err.stack : String(err));
    }
  }
}
