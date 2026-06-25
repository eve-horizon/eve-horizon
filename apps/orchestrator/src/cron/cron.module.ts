import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CloudCostCollectorService } from './cloud-cost-collector.service';
import { CronSchedulerService } from './cron-scheduler.service';
import { EnvCostCollectorService } from './env-cost-collector.service';
import { EnvHealthWatchdogService } from './env-health-watchdog.service';
import { FxUpdaterService } from './fx-updater.service';
import { ManagedDbReconcilerService } from './managed-db-reconciler.service';
import { ManagedDbSnapshotPrunerService } from './managed-db-snapshot-pruner.service';
import { ManagedDbSnapshotSchedulerService } from './managed-db-snapshot-scheduler.service';
import { ManagedDbSweeperService } from './managed-db-sweeper.service';
import { SuspensionControllerService } from './suspension-controller.service';
import { UsageSweeperService } from './usage-sweeper.service';

/**
 * Cron module for Phase 5.
 *
 * Provides the cron scheduler service that manages cron-based triggers.
 * The service scans project manifests for cron trigger definitions and
 * schedules them to emit events when they fire.
 */
@Module({
  imports: [DatabaseModule],
  providers: [CloudCostCollectorService, CronSchedulerService, EnvCostCollectorService, EnvHealthWatchdogService, FxUpdaterService, ManagedDbReconcilerService, ManagedDbSnapshotPrunerService, ManagedDbSnapshotSchedulerService, ManagedDbSweeperService, SuspensionControllerService, UsageSweeperService],
  exports: [CloudCostCollectorService, CronSchedulerService, EnvCostCollectorService, EnvHealthWatchdogService, FxUpdaterService, ManagedDbReconcilerService, ManagedDbSnapshotPrunerService, ManagedDbSnapshotSchedulerService, ManagedDbSweeperService, SuspensionControllerService, UsageSweeperService],
})
export class CronModule {}
