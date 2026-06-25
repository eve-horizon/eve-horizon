import { Inject, Injectable } from '@nestjs/common';
import type { CloudCostSnapshot, Db, EnvironmentCostSnapshot } from '@eve/db';
import {
  cloudCostSnapshotQueries,
  environmentCostSnapshotQueries,
  environmentQueries,
  orgQueries,
  projectQueries,
  spendQueries,
} from '@eve/db';
import { formatUtcMonth, parseUtcMonth, utcMonthStart } from './cost.service.js';

const OPENCOST_SOURCE = 'opencost';
const DEFAULT_CLOUD_SCOPE_KEY = 'eve-cluster';
const DEFAULT_STALE_AFTER_HOURS = 26;

export type AppCostMethod = 'bill_allocated_by_opencost' | 'opencost_direct' | 'none';

export interface AppCostEnvironment {
  environment_id: string;
  env_name: string | null;
  namespace: string | null;
  opencost_usd: string;
  cloud_usd: string;
  confidence: string;
  observed_at: string;
}

export interface AppCostApp {
  org_id: string;
  project_id: string;
  project_name: string | null;
  project_slug: string | null;
  llm_usd: string;
  llm_attempts: number;
  cloud_usd: string;
  total_usd: string;
  environments: AppCostEnvironment[];
}

export interface AppCostReport {
  org_id: string | null;
  window: { month: string; start: string; end: string | null };
  method: AppCostMethod;
  bill: {
    provider: string | null;
    source: string | null;
    amount: string | null;
    projected_amount: string | null;
    currency: string | null;
    confidence: string;
    coverage: string;
    observed_at: string | null;
    stale: boolean;
  } | null;
  infra: {
    source: string;
    cluster_env_total_usd: string | null;
    cluster_shared_usd: string | null;
    platform_overhead_usd: string | null;
    allocation_factor: string | null;
    observed_at: string | null;
    stale: boolean;
  };
  llm: { total_usd: string; attempts: number };
  totals: { cloud_usd: string; llm_usd: string; total_usd: string };
  orgs?: Array<{ org_id: string; org_slug: string | null; org_name: string | null }>;
  apps: AppCostApp[];
}

// ---------------------------------------------------------------------------
// Pure allocation math — exported for unit tests
// ---------------------------------------------------------------------------

export interface AllocationEnvRow {
  environment_id: string;
  amount_usd: number;
}

export interface AllocationResult {
  method: AppCostMethod;
  factor: number | null;
  platform_overhead_usd: number;
  byEnvironment: Map<string, number>;
}

/**
 * Allocate a bill-backed cluster total across environments using OpenCost
 * estimates as weights. The unallocated remainder (shared infra such as the
 * control plane and NAT) is returned explicitly as platform overhead.
 *
 * Without a bill, OpenCost estimates pass through unscaled.
 */
export function allocateAppCosts(
  envRows: AllocationEnvRow[],
  sharedUsd: number,
  billAmount: number | null,
): AllocationResult {
  const byEnvironment = new Map<string, number>();
  const envTotal = envRows.reduce((sum, row) => sum + Math.max(0, row.amount_usd), 0);
  const denominator = envTotal + Math.max(0, sharedUsd);

  if (envRows.length === 0 && sharedUsd <= 0) {
    return {
      method: billAmount != null ? 'bill_allocated_by_opencost' : 'none',
      factor: null,
      // With no usage signal at all, the entire bill is unallocatable overhead.
      platform_overhead_usd: billAmount ?? 0,
      byEnvironment,
    };
  }

  if (billAmount == null || denominator <= 0) {
    for (const row of envRows) {
      byEnvironment.set(row.environment_id, Math.max(0, row.amount_usd));
    }
    return {
      method: billAmount == null ? 'opencost_direct' : 'bill_allocated_by_opencost',
      factor: null,
      platform_overhead_usd: Math.max(0, sharedUsd),
      byEnvironment,
    };
  }

  const factor = billAmount / denominator;
  for (const row of envRows) {
    byEnvironment.set(row.environment_id, Math.max(0, row.amount_usd) * factor);
  }
  return {
    method: 'bill_allocated_by_opencost',
    factor,
    platform_overhead_usd: Math.max(0, sharedUsd) * factor,
    byEnvironment,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AppCostService {
  private readonly envSnapshots: ReturnType<typeof environmentCostSnapshotQueries>;
  private readonly cloudSnapshots: ReturnType<typeof cloudCostSnapshotQueries>;
  private readonly spend: ReturnType<typeof spendQueries>;
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly environments: ReturnType<typeof environmentQueries>;
  private readonly orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') db: Db) {
    this.envSnapshots = environmentCostSnapshotQueries(db);
    this.cloudSnapshots = cloudCostSnapshotQueries(db);
    this.spend = spendQueries(db);
    this.projects = projectQueries(db);
    this.environments = environmentQueries(db);
    this.orgs = orgQueries(db);
  }

  /** Org-scoped (member-visible) report, or cross-org when orgId is null (admin). */
  async getAppCosts(opts: { orgId?: string | null; month?: string; now?: Date } = {}): Promise<AppCostReport> {
    const now = opts.now ?? new Date();
    const windowStart = opts.month ? parseUtcMonth(opts.month) : utcMonthStart(now);
    const month = formatUtcMonth(windowStart);
    const windowEnd = new Date(Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + 1, 1));
    const orgId = opts.orgId ?? null;

    const [snapshotRows, bill, llmRows] = await Promise.all([
      this.envSnapshots.latestForMonth(windowStart, OPENCOST_SOURCE),
      this.cloudSnapshots.latestForScope({
        scopeType: 'cluster',
        scopeKey: process.env.EVE_CLOUD_COST_SCOPE_KEY ?? DEFAULT_CLOUD_SCOPE_KEY,
        windowStart,
      }),
      this.spend.sumSpendByProject({ org_id: orgId, since: windowStart, until: windowEnd }),
    ]);

    const envRows = snapshotRows.filter(
      (row): row is EnvironmentCostSnapshot & { environment_id: string } =>
        row.scope === 'environment' && row.environment_id != null,
    );
    const sharedUsd = snapshotRows
      .filter((row) => row.scope === 'shared_overhead')
      .reduce((sum, row) => sum + toNumber(row.amount_usd), 0);

    // Allocation always runs cluster-wide so each org sees its true share.
    const allocation = allocateAppCosts(
      envRows.map((row) => ({ environment_id: row.environment_id, amount_usd: toNumber(row.amount_usd) })),
      sharedUsd,
      bill ? toNumber(bill.amount) : null,
    );

    const scopedEnvRows = orgId ? envRows.filter((row) => row.org_id === orgId) : envRows;

    // Metadata for naming apps
    const [projects, activeEnvs] = await Promise.all([
      this.projects.list({ org_id: orgId ?? undefined, limit: 1000 }),
      this.environments.listActive(),
    ]);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const envById = new Map(activeEnvs.map((env) => [env.id, env]));

    // Group per project ("app")
    const apps = new Map<string, AppCostApp>();
    const ensureApp = (projectId: string, rowOrgId: string | null): AppCostApp => {
      let app = apps.get(projectId);
      if (!app) {
        const project = projectById.get(projectId);
        app = {
          org_id: project?.org_id ?? rowOrgId ?? orgId ?? 'unknown',
          project_id: projectId,
          project_name: project?.name ?? null,
          project_slug: project?.slug ?? null,
          llm_usd: '0',
          llm_attempts: 0,
          cloud_usd: '0',
          total_usd: '0',
          environments: [],
        };
        apps.set(projectId, app);
      }
      return app;
    };

    let unattributedCloud = 0;
    for (const row of scopedEnvRows) {
      const cloudUsd = allocation.byEnvironment.get(row.environment_id) ?? 0;
      if (row.project_id == null) {
        unattributedCloud += cloudUsd;
        continue;
      }
      const app = ensureApp(row.project_id, row.org_id);
      const env = envById.get(row.environment_id);
      app.environments.push({
        environment_id: row.environment_id,
        env_name: env?.name ?? row.environment_slug,
        namespace: env?.namespace ?? null,
        opencost_usd: money(toNumber(row.amount_usd)),
        cloud_usd: money(cloudUsd),
        confidence: row.confidence,
        observed_at: row.observed_at.toISOString(),
      });
    }

    let llmTotal = 0;
    let llmAttempts = 0;
    for (const row of llmRows) {
      const app = ensureApp(row.project_id, row.org_id);
      const usd = toNumber(row.base_total_usd);
      app.llm_usd = money(usd);
      app.llm_attempts = row.attempts;
      llmTotal += usd;
      llmAttempts += row.attempts;
    }

    let cloudTotal = 0;
    for (const app of apps.values()) {
      const cloud = app.environments.reduce((sum, env) => sum + toNumber(env.cloud_usd), 0);
      cloudTotal += cloud;
      app.cloud_usd = money(cloud);
      app.total_usd = money(cloud + toNumber(app.llm_usd));
      app.environments.sort((a, b) => toNumber(b.cloud_usd) - toNumber(a.cloud_usd));
    }

    const sortedApps = [...apps.values()].sort((a, b) => toNumber(b.total_usd) - toNumber(a.total_usd));

    const infraObservedAt = latestDate(snapshotRows.map((row) => row.observed_at));
    const staleMs = DEFAULT_STALE_AFTER_HOURS * 60 * 60 * 1000;

    // Members see their org's share plus provenance, never cluster-wide
    // bill figures. Admin (orgId null) gets the full picture.
    const isAdminScope = orgId == null;

    const report: AppCostReport = {
      org_id: orgId,
      window: {
        month,
        start: windowStart.toISOString(),
        end: latestDate(snapshotRows.map((row) => row.window_end))?.toISOString() ?? null,
      },
      method: snapshotRows.length === 0 && !bill ? 'none' : allocation.method,
      bill: bill ? billSummary(bill, now, staleMs, isAdminScope) : null,
      infra: {
        source: OPENCOST_SOURCE,
        cluster_env_total_usd: isAdminScope
          ? money(envRows.reduce((sum, row) => sum + toNumber(row.amount_usd), 0))
          : null,
        cluster_shared_usd: isAdminScope ? money(sharedUsd) : null,
        platform_overhead_usd: isAdminScope ? money(allocation.platform_overhead_usd + unattributedCloud) : null,
        allocation_factor: allocation.factor != null ? allocation.factor.toFixed(6) : null,
        observed_at: infraObservedAt?.toISOString() ?? null,
        stale: infraObservedAt == null ? true : now.getTime() - infraObservedAt.getTime() > staleMs,
      },
      llm: { total_usd: money(llmTotal), attempts: llmAttempts },
      totals: {
        cloud_usd: money(cloudTotal),
        llm_usd: money(llmTotal),
        total_usd: money(cloudTotal + llmTotal),
      },
      apps: sortedApps,
    };

    if (!orgId) {
      const orgIds = new Set(sortedApps.map((app) => app.org_id));
      const orgs = await this.orgs.list({ limit: 1000 });
      report.orgs = orgs
        .filter((org) => orgIds.has(org.id))
        .map((org) => ({ org_id: org.id, org_slug: org.slug ?? null, org_name: org.name ?? null }));
    }

    return report;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function billSummary(bill: CloudCostSnapshot, now: Date, staleMs: number, includeAmounts: boolean) {
  return {
    provider: bill.provider,
    source: bill.source,
    amount: includeAmounts ? bill.amount : null,
    projected_amount: includeAmounts ? bill.projected_amount : null,
    currency: bill.currency,
    confidence: bill.confidence,
    coverage: bill.coverage,
    observed_at: bill.observed_at.toISOString(),
    stale: now.getTime() - bill.observed_at.getTime() > staleMs,
  };
}

function toNumber(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  return Number.isFinite(n) ? n : 0;
}

function money(value: number): string {
  return value.toFixed(4);
}

function latestDate(values: Date[]): Date | null {
  if (values.length === 0) return null;
  return new Date(Math.max(...values.map((value) => value.getTime())));
}
