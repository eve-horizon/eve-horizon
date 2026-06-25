import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CronJob } from 'cron';
import {
  usageRecordQueries,
  balanceLedgerQueries,
  type Db,
} from '@eve/db';
import {
  generateUsageRecordId,
  generateSweepId,
  generateBalanceTransactionId,
} from '@eve/shared';

/**
 * Managed DB billing rates (USD per unit).
 *
 * These translate managed database consumption into monetary charges:
 * - managed_db_hours:db.p1:       $0.05/hour  (Starter)
 * - managed_db_hours:db.p2:       $0.15/hour  (Standard)
 * - managed_db_hours:db.p3:       $0.50/hour  (Performance)
 * - managed_db_storage_gb_hours:  ~$0.073/GB-month
 */
const MANAGED_DB_RATES: Record<string, number> = {
  'managed_db_hours:db.p1': 0.05,
  'managed_db_hours:db.p2': 0.15,
  'managed_db_hours:db.p3': 0.50,
  'managed_db_storage_gb_hours': 0.0001,
};

/**
 * Managed DB billing sweeper.
 *
 * Periodically scans active managed_db_tenants (status='ready') and writes
 * usage_records + balance charges for hourly runtime based on instance class.
 *
 * Disabled by default; enable with `EVE_MANAGED_DB_SWEEPER_ENABLED=true`.
 *
 * Env vars:
 * - EVE_MANAGED_DB_SWEEPER_ENABLED=true|false
 * - EVE_MANAGED_DB_SWEEPER_CRON="*\/5 * * * *" (default: every 5 minutes)
 */
@Injectable()
export class ManagedDbSweeperService implements OnModuleInit, OnModuleDestroy {
  private cronJob: CronJob | null = null;

  private readonly usageRecords: ReturnType<typeof usageRecordQueries>;
  private readonly ledger: ReturnType<typeof balanceLedgerQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.usageRecords = usageRecordQueries(db);
    this.ledger = balanceLedgerQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_MANAGED_DB_SWEEPER_ENABLED !== 'true') {
      console.log('[managed-db-sweeper] Disabled (set EVE_MANAGED_DB_SWEEPER_ENABLED=true to enable)');
      return;
    }

    const cron = process.env.EVE_MANAGED_DB_SWEEPER_CRON ?? '*/5 * * * *';

    try {
      this.cronJob = new CronJob(
        cron,
        () => {
          this.sweep().catch((err) => {
            console.error(
              '[managed-db-sweeper] Sweep failed:',
              err instanceof Error ? err.message : String(err),
            );
          });
        },
        null,
        true,
        'UTC',
      );
      console.log(`[managed-db-sweeper] Enabled (cron="${cron}")`);
    } catch (err) {
      console.error(
        '[managed-db-sweeper] Failed to start cron:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cronJob) {
      try {
        this.cronJob.stop();
      } catch {
        // Ignore stop errors during shutdown.
      }
      this.cronJob = null;
    }
  }

  /**
   * Main sweep: enumerate ready managed DB tenants, write usage records + charges.
   */
  async sweep(): Promise<void> {
    const sweepId = generateSweepId();
    const now = new Date();
    console.log(`[managed-db-sweeper] Starting sweep ${sweepId}`);

    // Get all ready tenants (active, billable).
    const allTenants = await this.db<Array<{
      id: string;
      org_id: string;
      project_id: string;
      env_id: string;
      class: string;
      ready_at: Date;
    }>>`
      SELECT id, org_id, project_id, env_id, class, ready_at
      FROM managed_db_tenants
      WHERE status = 'ready' AND deleted_at IS NULL AND ready_at IS NOT NULL
    `;

    let recordsCreated = 0;
    let chargesCreated = 0;

    for (const tenant of allTenants) {
      try {
        const { records, charges } = await this.sweepTenant(sweepId, now, tenant);
        recordsCreated += records;
        chargesCreated += charges;
      } catch (err) {
        console.warn(
          `[managed-db-sweeper] Failed to sweep tenant ${tenant.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    console.log(
      `[managed-db-sweeper] Sweep ${sweepId} complete: ${allTenants.length} tenants, ${recordsCreated} records, ${chargesCreated} charges`,
    );
  }

  /**
   * Sweep a single tenant: compute hours since ready_at and write
   * a class-based hourly usage record + balance charge.
   */
  private async sweepTenant(
    sweepId: string,
    now: Date,
    tenant: { id: string; org_id: string; project_id: string; env_id: string; class: string; ready_at: Date },
  ): Promise<{ records: number; charges: number }> {
    let records = 0;
    let charges = 0;
    const sourceId = `${sweepId}:${tenant.id}`;

    // Compute hours since ready_at.
    const hours = Math.max(0, (now.getTime() - tenant.ready_at.getTime()) / (1000 * 3600));

    if (hours > 0) {
      // Class-based hourly usage.
      const created = await this.writeUsageRecord({
        orgId: tenant.org_id,
        projectId: tenant.project_id,
        envId: tenant.env_id,
        resourceType: 'managed_db_hours',
        resourceClass: tenant.class,
        quantity: hours.toFixed(4),
        unit: 'hours',
        startedAt: tenant.ready_at,
        endedAt: now,
        sourceType: 'managed_db_sweep',
        sourceId,
      });
      if (created) {
        records++;
        const rateKey = `managed_db_hours:${tenant.class}`;
        const charged = await this.chargeForRecord(created, tenant.org_id, rateKey);
        if (charged) charges++;
      }
    }

    return { records, charges };
  }

  /**
   * Write a single usage record (idempotent via UNIQUE constraint).
   */
  private async writeUsageRecord(input: {
    orgId: string;
    projectId: string;
    envId: string;
    resourceType: string;
    resourceClass?: string;
    quantity: string;
    unit: string;
    startedAt: Date;
    endedAt?: Date;
    sourceType: string;
    sourceId: string;
  }): Promise<{ id: string; resourceType: string; quantity: string; unit: string } | null> {
    // Check idempotency first.
    const existing = await this.usageRecords.findBySource(
      input.sourceType,
      input.sourceId,
      input.resourceType,
    );
    if (existing) return null; // Already recorded this sweep for this tenant + resource type.

    const record = await this.usageRecords.create({
      id: generateUsageRecordId(),
      org_id: input.orgId,
      project_id: input.projectId,
      env_id: input.envId,
      resource_type: input.resourceType,
      resource_class: input.resourceClass,
      quantity: input.quantity,
      unit: input.unit,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      source_type: input.sourceType,
      source_id: input.sourceId,
    });

    return {
      id: record.id,
      resourceType: record.resource_type,
      quantity: record.quantity,
      unit: record.unit,
    };
  }

  /**
   * Create a balance charge for a usage record.
   */
  private async chargeForRecord(
    record: { id: string; resourceType: string; quantity: string; unit: string },
    orgId: string,
    rateKey: string,
  ): Promise<boolean> {
    const rate = MANAGED_DB_RATES[rateKey];
    if (!rate) return false;

    const quantity = parseFloat(record.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return false;

    const chargeUsd = (quantity * rate).toFixed(10);
    if (parseFloat(chargeUsd) <= 0) return false;

    // Ensure the org has a balance row.
    try {
      await this.ledger.ensureBalance(orgId, 'usd');
    } catch (err) {
      console.warn(
        `[managed-db-sweeper] Failed to ensure balance for ${orgId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }

    try {
      await this.ledger.createTransaction({
        id: generateBalanceTransactionId(),
        org_id: orgId,
        type: 'charge',
        amount: chargeUsd,
        currency: 'usd',
        description: `Managed DB: ${record.quantity} ${record.unit} (${rateKey})`,
        source_type: 'usage_record',
        source_id: record.id,
      });
      return true;
    } catch (err) {
      // Idempotent: duplicate source_id will throw unique violation.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return false;
      }
      console.warn(`[managed-db-sweeper] Failed to charge for record ${record.id}:`, msg);
      return false;
    }
  }
}
