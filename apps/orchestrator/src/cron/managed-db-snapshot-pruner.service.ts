import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CronJob } from 'cron';
import { managedDbSnapshotQueries, type Db } from '@eve/db';
import { createSnapshotStorageClient } from '@eve/shared';

/**
 * Managed DB Snapshot Pruner.
 *
 * Periodically deletes expired snapshots (S3 objects + DB records)
 * and marks stale in-progress snapshots as failed.
 *
 * Disabled by default; enable with EVE_MANAGED_DB_SNAPSHOT_PRUNER_ENABLED=true.
 */
@Injectable()
export class ManagedDbSnapshotPrunerService implements OnModuleInit, OnModuleDestroy {
  private cronJob: CronJob | null = null;
  private running = false;

  private readonly snapshots: ReturnType<typeof managedDbSnapshotQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.snapshots = managedDbSnapshotQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_MANAGED_DB_SNAPSHOT_PRUNER_ENABLED !== 'true') {
      console.log('[snapshot-pruner] Disabled (set EVE_MANAGED_DB_SNAPSHOT_PRUNER_ENABLED=true to enable)');
      return;
    }

    const cron = process.env.EVE_MANAGED_DB_SNAPSHOT_PRUNER_CRON ?? '0 0 * * * *'; // Every hour

    try {
      this.cronJob = new CronJob(
        cron,
        () => {
          this.tick().catch((err) => {
            console.error('[snapshot-pruner] Tick failed:', err instanceof Error ? err.message : String(err));
          });
        },
        null,
        true,
        'UTC',
      );
      console.log(`[snapshot-pruner] Started (cron: ${cron})`);
    } catch (err) {
      console.error('[snapshot-pruner] Failed to start:', err instanceof Error ? err.message : String(err));
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.cronJob?.stop();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      let expiredCount = 0;
      let staleCount = 0;

      // 1. Delete expired snapshots
      const expired = await this.snapshots.findExpiredSnapshots(100);
      if (expired.length > 0) {
        const storage = createSnapshotStorageClient();
        for (const snapshot of expired) {
          // Delete storage object
          if (storage && snapshot.s3_bucket && snapshot.s3_key) {
            try {
              await storage.client.deleteObject(snapshot.s3_bucket, snapshot.s3_key);
            } catch {
              // Ignore storage errors (object may already be gone)
            }
          }
          // Delete DB record
          await this.snapshots.deleteSnapshot(snapshot.id);
          expiredCount++;
        }
      }

      // 2. Mark stale in-progress snapshots as failed (older than 2 hours)
      const stale = await this.snapshots.findStaleInProgressSnapshots(120);
      for (const snapshot of stale) {
        await this.snapshots.failSnapshot(snapshot.id, 'Timed out (stale in_progress > 2 hours)');
        staleCount++;
      }

      if (expiredCount > 0 || staleCount > 0) {
        console.log(`[snapshot-pruner] Pruned ${expiredCount} expired, ${staleCount} stale`);
      }
    } finally {
      this.running = false;
    }
  }
}
