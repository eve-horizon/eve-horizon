import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { CloudCostScopeType, CloudCostSnapshot, Db, EnvironmentCostSnapshot } from '@eve/db';
import { cloudCostSnapshotQueries, environmentCostSnapshotQueries } from '@eve/db';

const DEFAULT_SOURCE = 'opencost';
const DEFAULT_CLOUD_SCOPE_TYPE: CloudCostScopeType = 'cluster';
const DEFAULT_CLOUD_SCOPE_KEY = 'eve-cluster';
const DEFAULT_STALE_AFTER_HOURS = 26;
const SOURCE_PATTERN = /^[a-z0-9_-]+$/i;

export interface EnvironmentCostApiRow {
  environment_id: string;
  org_id: string | null;
  project_id: string | null;
  environment_slug: string | null;
  amount_usd: string;
  shared_amount_usd: string | null;
  confidence: string;
  observed_at: string;
}

export interface EnvironmentCostApiResponse {
  window: {
    month: string;
    start: string;
    end: string | null;
  };
  source: string;
  total_usd: string;
  env_total_usd: string;
  shared_usd: string;
  env_count: number;
  observed_at: string | null;
  stale: boolean;
  stale_after_hours: number;
  environments: EnvironmentCostApiRow[];
}

export interface CloudCostApiResponse {
  window: {
    month: string;
    start: string;
    end: string | null;
    mtd_through: string | null;
  };
  provider: string | null;
  source: string | null;
  scope: {
    type: CloudCostScopeType;
    key: string;
    label: string | null;
  };
  amount: string | null;
  projected_amount: string | null;
  currency: string | null;
  confidence: string;
  coverage: string;
  observed_at: string | null;
  stale: boolean;
  stale_after_hours: number;
  filter: Record<string, unknown>;
  breakdown: Record<string, unknown>;
}

@Injectable()
export class CostService {
  private readonly snapshots: ReturnType<typeof environmentCostSnapshotQueries>;
  private readonly cloudSnapshots: ReturnType<typeof cloudCostSnapshotQueries>;

  constructor(@Inject('DB') db: Db) {
    this.snapshots = environmentCostSnapshotQueries(db);
    this.cloudSnapshots = cloudCostSnapshotQueries(db);
  }

  async listEnvironmentCosts(opts: {
    month?: string;
    source?: string;
    staleAfterHours?: number;
    now?: Date;
  } = {}): Promise<EnvironmentCostApiResponse> {
    const now = opts.now ?? new Date();
    const windowStart = opts.month ? parseUtcMonth(opts.month) : utcMonthStart(now);
    const month = formatUtcMonth(windowStart);
    const source = parseSource(opts.source ?? DEFAULT_SOURCE);
    const staleAfterHours = normalizeStaleAfterHours(opts.staleAfterHours);

    const [rows, totals, freshness] = await Promise.all([
      this.snapshots.latestForMonth(windowStart, source),
      this.snapshots.totalForMonth(windowStart, source),
      this.snapshots.freshnessForMonth(windowStart, source),
    ]);

    const observedAt = freshness.observed_at;
    const stale = observedAt == null
      ? true
      : now.getTime() - observedAt.getTime() > staleAfterHours * 60 * 60 * 1000;

    const windowEnd = latestDate(rows.map((row) => row.window_end));
    const environments = rows
      .filter((row) => row.scope === 'environment' && row.environment_id)
      .map((row) => ({
        environment_id: row.environment_id!,
        org_id: row.org_id,
        project_id: row.project_id,
        environment_slug: row.environment_slug,
        amount_usd: row.amount_usd,
        shared_amount_usd: row.shared_amount_usd,
        confidence: row.confidence,
        observed_at: toIso(row.observed_at),
      }));

    return {
      window: {
        month,
        start: toIso(windowStart),
        end: windowEnd ? toIso(windowEnd) : null,
      },
      source,
      total_usd: totals.total_usd,
      env_total_usd: totals.env_total_usd,
      shared_usd: totals.shared_usd,
      env_count: totals.env_count,
      observed_at: observedAt ? toIso(observedAt) : null,
      stale,
      stale_after_hours: staleAfterHours,
      environments,
    };
  }

  async getCloudCost(opts: {
    scopeType?: string;
    scopeKey?: string;
    month?: string;
    provider?: string;
    source?: string;
    staleAfterHours?: number;
    now?: Date;
  } = {}): Promise<CloudCostApiResponse> {
    const now = opts.now ?? new Date();
    const windowStart = opts.month ? parseUtcMonth(opts.month) : utcMonthStart(now);
    const month = formatUtcMonth(windowStart);
    const scopeType = parseScopeType(opts.scopeType ?? DEFAULT_CLOUD_SCOPE_TYPE);
    const scopeKey = parseScopeKey(opts.scopeKey ?? process.env.EVE_CLOUD_COST_SCOPE_KEY ?? DEFAULT_CLOUD_SCOPE_KEY);
    const provider = opts.provider == null ? undefined : parseSource(opts.provider);
    const source = opts.source == null ? undefined : parseSource(opts.source);
    const staleAfterHours = normalizeStaleAfterHours(opts.staleAfterHours);

    const row = await this.cloudSnapshots.latestForScope({
      provider,
      source,
      scopeType,
      scopeKey,
      windowStart,
    });

    if (!row) {
      return {
        window: {
          month,
          start: toIso(windowStart),
          end: null,
          mtd_through: null,
        },
        provider: provider ?? null,
        source: source ?? null,
        scope: {
          type: scopeType,
          key: scopeKey,
          label: null,
        },
        amount: null,
        projected_amount: null,
        currency: null,
        confidence: 'unavailable',
        coverage: 'unknown',
        observed_at: null,
        stale: true,
        stale_after_hours: staleAfterHours,
        filter: {},
        breakdown: {},
      };
    }

    const stale = now.getTime() - row.observed_at.getTime() > staleAfterHours * 60 * 60 * 1000;

    return {
      window: {
        month,
        start: toIso(windowStart),
        end: toIso(row.window_end),
        mtd_through: normalizeDateOnly(row.mtd_through),
      },
      provider: row.provider,
      source: row.source,
      scope: {
        type: row.scope_type,
        key: row.scope_key,
        label: row.scope_label,
      },
      amount: row.amount,
      projected_amount: row.projected_amount,
      currency: row.currency,
      confidence: row.confidence,
      coverage: row.coverage,
      observed_at: toIso(row.observed_at),
      stale,
      stale_after_hours: staleAfterHours,
      filter: parseJsonRecord(row.filter_json),
      breakdown: parseJsonRecord(row.breakdown_json),
    };
  }
}

export function parseUtcMonth(month: string): Date {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new BadRequestException('month must use YYYY-MM format');
  }

  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new BadRequestException('month must use YYYY-MM format');
  }

  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

export function utcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function formatUtcMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseSource(source: string): string {
  const normalized = source.trim();
  if (!normalized || normalized.length > 64 || !SOURCE_PATTERN.test(normalized)) {
    throw new BadRequestException('source must be a non-empty identifier');
  }
  return normalized;
}

function parseScopeType(value: string): CloudCostScopeType {
  if (value === 'cluster' || value === 'environment' || value === 'account' || value === 'project') {
    return value;
  }
  throw new BadRequestException('scope_type must be cluster, environment, account, or project');
}

function parseScopeKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[a-z0-9_.:/-]+$/i.test(normalized)) {
    throw new BadRequestException('scope_key must be a non-empty scope identifier');
  }
  return normalized;
}

function normalizeStaleAfterHours(value: number | undefined): number {
  if (value == null || Number.isNaN(value) || value <= 0) {
    return DEFAULT_STALE_AFTER_HOURS;
  }
  return Math.min(Math.floor(value), 24 * 30);
}

function latestDate(values: Date[]): Date | null {
  if (values.length === 0) return null;
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function toIso(value: Date): string {
  return value.toISOString();
}

function normalizeDateOnly(value: string | Date | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function parseJsonRecord(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value;
}

export type { CloudCostSnapshot, EnvironmentCostSnapshot };
