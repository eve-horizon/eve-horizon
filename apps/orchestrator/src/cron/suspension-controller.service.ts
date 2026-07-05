import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import {
  orgQueries,
  balanceLedgerQueries,
  projectQueries,
  environmentQueries,
  type Db,
} from '@eve/db';

/**
 * Suspension Controller (Phase 11: Budget-Triggered Scale-to-Zero)
 *
 * Evaluates all orgs with a billing_config.hard_cap_amount on a schedule.
 * When an org's balance drops to zero or below suspend_below_amount,
 * all active environments belonging to that org are suspended.
 *
 * Auto-resume is intentionally NOT implemented. Once balance is restored,
 * the controller logs a notice, but an admin must manually resume each
 * environment. This prevents accidental cost spikes from automatic restarts.
 *
 * Env vars:
 * - EVE_SUSPENSION_CONTROLLER_ENABLED=true|false (default: false)
 * - EVE_SUSPENSION_CONTROLLER_CRON="*\/2 * * * *" (default: every 2 minutes)
 */
@Injectable()
export class SuspensionControllerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SuspensionControllerService.name);
  private job: CronJob | null = null;
  private running = false;

  private orgs: ReturnType<typeof orgQueries>;
  private balances: ReturnType<typeof balanceLedgerQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private environments: ReturnType<typeof environmentQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.orgs = orgQueries(db);
    this.balances = balanceLedgerQueries(db);
    this.projects = projectQueries(db);
    this.environments = environmentQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_SUSPENSION_CONTROLLER_ENABLED !== 'true') {
      this.logger.log(
        '[suspension] Suspension controller disabled (set EVE_SUSPENSION_CONTROLLER_ENABLED=true to enable)',
      );
      return;
    }

    const cron = process.env.EVE_SUSPENSION_CONTROLLER_CRON ?? '*/2 * * * *';

    try {
      this.job = new CronJob(
        cron,
        () => {
          this.tick().catch((err) => {
            this.logger.error(`[suspension] Tick failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        null,
        true,
        'UTC',
      );
      this.logger.log(`[suspension] Suspension controller enabled (cron="${cron}")`);
    } catch (err) {
      this.logger.error(`[suspension] Failed to register cron (${cron}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.job) {
      try {
        this.job.stop();
      } catch (err) {
        this.logger.warn(`[suspension] Failed stopping cron: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.job = null;
    }
  }

  /**
   * Single evaluation tick. Idempotent and serialised via the `running` flag
   * to prevent overlapping evaluations if a tick takes longer than the interval.
   */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const allOrgs = await this.orgs.list({ limit: 1000 });

      for (const org of allOrgs) {
        try {
          await this.evaluateOrg(org);
        } catch (err) {
          this.logger.error(`[suspension] Error evaluating org ${org.id} (${org.slug}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async evaluateOrg(org: { id: string; slug: string; billing_config: Record<string, unknown> | null }): Promise<void> {
    const billing = org.billing_config;
    if (!billing) return;

    const hardCap = billing.hard_cap_amount;
    if (hardCap === undefined || hardCap === null) return;

    // Parse thresholds. hard_cap_amount is the absolute maximum; when balance
    // reaches zero the org is out of budget. suspend_below_amount is an
    // optional early-warning threshold that triggers suspension before zero.
    const suspendBelow = typeof billing.suspend_below_amount === 'string'
      ? parseFloat(billing.suspend_below_amount)
      : typeof billing.suspend_below_amount === 'number'
        ? billing.suspend_below_amount
        : 0;

    const balance = await this.balances.getBalance(org.id);
    if (!balance) {
      // No balance row — org has never been credited. Nothing to enforce.
      return;
    }

    const currentBalance = parseFloat(balance.balance);

    const shouldSuspend = currentBalance <= 0 || currentBalance < suspendBelow;

    if (shouldSuspend) {
      await this.suspendOrgEnvironments(org, currentBalance, suspendBelow);
    } else {
      // Balance is healthy. Log a notice if the org has any auto-suspended envs
      // so operators know the org is eligible for manual resume.
      await this.logResumeEligibility(org);
    }
  }

  private async suspendOrgEnvironments(
    org: { id: string; slug: string },
    currentBalance: number,
    suspendBelow: number,
  ): Promise<void> {
    const orgProjects = await this.projects.list({ org_id: org.id, limit: 1000 });

    let suspendedCount = 0;

    for (const project of orgProjects) {
      const activeEnvs = await this.environments.listActive(project.id);

      for (const env of activeEnvs) {
        const reason =
          currentBalance <= 0
            ? `Budget exhausted: org ${org.slug} balance is ${currentBalance.toFixed(4)}`
            : `Below suspension threshold: org ${org.slug} balance ${currentBalance.toFixed(4)} < ${suspendBelow.toFixed(4)}`;

        await this.environments.suspend(env.id, reason);
        suspendedCount++;

        this.logger.log(
          `[suspension] Suspended env "${env.name}" (${env.id}) for project ${project.slug}: ${reason}`,
        );

        // TODO: Scale-to-zero — invoke K8s API to scale deployments in env.namespace to 0 replicas.
        // The namespace-hardening module (packages/shared/src/k8s/) provides patterns for
        // K8s manifest generation. When implemented, this would call something like:
        //   await scaleNamespaceToZero(env.namespace);
        // For now this is a soft suspension (DB status only).
        if (env.namespace) {
          this.logger.log(
            `[suspension] STUB: Would scale namespace "${env.namespace}" to zero replicas`,
          );
        }
      }
    }

    if (suspendedCount > 0) {
      this.logger.log(
        `[suspension] Suspended ${suspendedCount} environment(s) for org ${org.slug} (balance: ${currentBalance.toFixed(4)})`,
      );
    }
  }

  /**
   * Check if a previously-suspended org now has a healthy balance and log a
   * notice. We intentionally do NOT auto-resume — that requires manual admin
   * action to prevent unexpected cost spikes.
   */
  private async logResumeEligibility(org: { id: string; slug: string }): Promise<void> {
    const orgProjects = await this.projects.list({ org_id: org.id, limit: 1000 });

    let suspendedCount = 0;
    for (const project of orgProjects) {
      const envs = await this.environments.list({ project_id: project.id, limit: 1000 });
      for (const env of envs) {
        if (env.status === 'suspended' && (env.suspension_reason?.startsWith('Budget exhausted') || env.suspension_reason?.startsWith('Below suspension threshold'))) {
          suspendedCount++;
        }
      }
    }

    if (suspendedCount > 0) {
      this.logger.log(
        `[suspension] Org ${org.slug} is now eligible for resume: ${suspendedCount} environment(s) still suspended. Manual resume required.`,
      );
    }
  }
}
