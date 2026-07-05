import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import {
  cloudCostSnapshotQueries,
  type CloudCostCoverage,
  type CloudCostScopeType,
  type Db,
} from '@eve/db';
import { AwsCostExplorerProvider } from './aws-cost-explorer-provider.js';
import type { CloudCostProvider, CloudCostScopeConfig } from './cloud-cost-provider.js';

const DEFAULT_CRON = '0 7 * * *';
const DEFAULT_PROVIDER = 'aws';
const DEFAULT_SCOPE_TYPE: CloudCostScopeType = 'cluster';
const DEFAULT_SCOPE_KEY = 'eve-cluster';
const DEFAULT_SCOPE_LABEL = 'Eve staging cluster';
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_COVERAGE: CloudCostCoverage = 'undercount';
const DEFAULT_AWS_ACCOUNT_ID = ''; // set via EVE_AWS_COST_ACCOUNT_ID
const DEFAULT_AWS_PROJECT_TAG_VALUE = 'eve-horizon';
const DEFAULT_AWS_ENVIRONMENT_TAG_VALUE = 'staging';

@Injectable()
export class CloudCostCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloudCostCollectorService.name);
  private cronJob: CronJob | null = null;
  private readonly snapshots: ReturnType<typeof cloudCostSnapshotQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.snapshots = cloudCostSnapshotQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_CLOUD_COST_ENABLED !== 'true') {
      this.logger.log('[cloud-cost] Collector disabled (set EVE_CLOUD_COST_ENABLED=true to enable)');
      return;
    }

    const cron = process.env.EVE_CLOUD_COST_CRON ?? DEFAULT_CRON;
    try {
      this.cronJob = new CronJob(
        cron,
        () => {
          this.collect().catch((err) => {
            this.logger.error(`[cloud-cost] Collection failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        null,
        true,
        'UTC',
      );
      this.logger.log(`[cloud-cost] Collector enabled (cron="${cron}")`);
    } catch (err) {
      this.logger.error(`[cloud-cost] Failed to start cron: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (process.env.EVE_CLOUD_COST_COLLECT_ON_START === 'true') {
      this.collect().catch((err) => {
        this.logger.error(`[cloud-cost] Startup collection failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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

  async collect(provider?: CloudCostProvider, now = new Date(), scope?: CloudCostScopeConfig): Promise<void> {
    if (!provider && process.env.EVE_CLOUD_COST_ENABLED !== 'true') {
      this.logger.log('[cloud-cost] Collector disabled (set EVE_CLOUD_COST_ENABLED=true to enable)');
      return;
    }

    const scopeConfig = scope ?? this.buildScopeFromEnv();
    const costProvider = provider ?? this.createProvider(scopeConfig.provider);
    if (costProvider.provider !== scopeConfig.provider || costProvider.source !== scopeConfig.source) {
      throw new Error(
        `Cloud cost provider mismatch: configured ${scopeConfig.provider}/${scopeConfig.source}, ` +
        `got ${costProvider.provider}/${costProvider.source}`,
      );
    }

    let result;
    try {
      result = await costProvider.fetchMonthToDate(scopeConfig, now);
    } catch (err) {
      this.logger.warn(`[cloud-cost] Provider fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!result) {
      this.logger.warn('[cloud-cost] Provider returned no finalized cost data; leaving last-good snapshot untouched');
      return;
    }

    await this.snapshots.upsert({
      provider: scopeConfig.provider,
      source: scopeConfig.source,
      account_id: scopeConfig.accountId ?? null,
      billing_account_id: scopeConfig.billingAccountId ?? null,
      scope_type: scopeConfig.scopeType,
      scope_key: scopeConfig.scopeKey,
      scope_label: scopeConfig.scopeLabel,
      window_start: result.windowStart,
      window_end: result.windowEnd,
      mtd_through: result.mtdThrough,
      amount: formatCloudAmount(result.amount),
      projected_amount: result.projectedAmount == null ? null : formatCloudAmount(result.projectedAmount),
      currency: result.currency,
      confidence: result.confidence,
      coverage: result.coverage,
      filter_json: result.filter,
      breakdown_json: result.breakdown,
      observed_at: now,
    });

    this.logger.log(
      `[cloud-cost] Collection complete: ${scopeConfig.provider}/${scopeConfig.source} ` +
      `${scopeConfig.scopeType}:${scopeConfig.scopeKey} amount=${formatCloudAmount(result.amount)} ${result.currency}`,
    );
  }

  private createProvider(provider: string): CloudCostProvider {
    if (provider === 'aws') {
      return new AwsCostExplorerProvider();
    }
    throw new Error(`Unsupported cloud cost provider: ${provider}`);
  }

  private buildScopeFromEnv(): CloudCostScopeConfig {
    const provider = normalizeIdentifier(process.env.EVE_CLOUD_COST_PROVIDER ?? DEFAULT_PROVIDER, 'EVE_CLOUD_COST_PROVIDER');
    if (provider !== 'aws') {
      throw new Error(`Unsupported cloud cost provider: ${provider}`);
    }

    return {
      provider,
      source: 'aws_cost_explorer',
      accountId: optionalEnv('EVE_AWS_COST_ACCOUNT_ID') ?? DEFAULT_AWS_ACCOUNT_ID,
      scopeType: normalizeScopeType(process.env.EVE_CLOUD_COST_SCOPE_TYPE ?? DEFAULT_SCOPE_TYPE),
      scopeKey: optionalEnv('EVE_CLOUD_COST_SCOPE_KEY') ?? DEFAULT_SCOPE_KEY,
      scopeLabel: optionalEnv('EVE_CLOUD_COST_SCOPE_LABEL') ?? DEFAULT_SCOPE_LABEL,
      currency: DEFAULT_CURRENCY,
      coverage: normalizeCoverage(process.env.EVE_CLOUD_COST_COVERAGE ?? DEFAULT_COVERAGE),
      filter: {
        tags: {
          Project: optionalEnv('EVE_AWS_COST_PROJECT_TAG_VALUE') ?? DEFAULT_AWS_PROJECT_TAG_VALUE,
          Environment: optionalEnv('EVE_AWS_COST_ENVIRONMENT_TAG_VALUE') ?? DEFAULT_AWS_ENVIRONMENT_TAG_VALUE,
        },
      },
    };
  }
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function normalizeIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9_-]+$/i.test(normalized)) {
    throw new Error(`${name} must be an identifier`);
  }
  return normalized;
}

function normalizeScopeType(value: string): CloudCostScopeType {
  if (value === 'cluster' || value === 'environment' || value === 'account' || value === 'project') {
    return value;
  }
  throw new Error('EVE_CLOUD_COST_SCOPE_TYPE must be cluster, environment, account, or project');
}

function normalizeCoverage(value: string): CloudCostCoverage {
  if (value === 'undercount' || value === 'complete' || value === 'partial' || value === 'unknown') {
    return value;
  }
  throw new Error('EVE_CLOUD_COST_COVERAGE must be undercount, complete, partial, or unknown');
}

function formatCloudAmount(value: number): string {
  return value.toFixed(6);
}
