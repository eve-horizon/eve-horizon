import { generateCloudCostSnapshotId } from '@eve/shared';
import type { Db } from '../client.js';

export type CloudCostScopeType = 'cluster' | 'environment' | 'account' | 'project';
export type CloudCostConfidence = 'estimate' | 'reconciled' | 'unavailable';
export type CloudCostCoverage = 'undercount' | 'complete' | 'partial' | 'unknown';

export interface CloudCostSnapshot {
  id: string;
  provider: string;
  source: string;
  account_id: string | null;
  billing_account_id: string | null;
  scope_type: CloudCostScopeType;
  scope_key: string;
  scope_label: string;
  org_id: string | null;
  project_id: string | null;
  environment_id: string | null;
  window_start: Date;
  window_end: Date;
  mtd_through: string | null;
  amount: string;
  projected_amount: string | null;
  currency: string;
  confidence: CloudCostConfidence;
  coverage: CloudCostCoverage;
  filter_json: Record<string, unknown>;
  breakdown_json: Record<string, unknown>;
  observed_at: Date;
}

export interface UpsertCloudCostSnapshotInput {
  id?: string;
  provider: string;
  source: string;
  account_id?: string | null;
  billing_account_id?: string | null;
  scope_type: CloudCostScopeType;
  scope_key: string;
  scope_label: string;
  org_id?: string | null;
  project_id?: string | null;
  environment_id?: string | null;
  window_start: Date;
  window_end: Date;
  mtd_through?: string | null;
  amount: string;
  projected_amount?: string | null;
  currency?: string;
  confidence?: CloudCostConfidence;
  coverage?: CloudCostCoverage;
  filter_json?: Record<string, unknown>;
  breakdown_json?: Record<string, unknown>;
  observed_at?: Date;
}

export interface LatestCloudCostScopeInput {
  provider?: string;
  source?: string;
  scopeType: CloudCostScopeType;
  scopeKey: string;
  windowStart: Date;
}

export interface LatestCloudCostMonthInput {
  provider?: string;
  source?: string;
  scopeType?: CloudCostScopeType;
  windowStart: Date;
}

export interface CloudCostFreshness {
  observed_at: Date | null;
}

export function cloudCostSnapshotQueries(db: Db) {
  return {
    async upsert(input: UpsertCloudCostSnapshotInput): Promise<CloudCostSnapshot> {
      const id = input.id ?? generateCloudCostSnapshotId();
      const accountId = input.account_id ?? null;
      const billingAccountId = input.billing_account_id ?? null;
      const orgId = input.org_id ?? null;
      const projectId = input.project_id ?? null;
      const environmentId = input.environment_id ?? null;
      const mtdThrough = input.mtd_through ?? null;
      const projectedAmount = input.projected_amount ?? null;
      const currency = input.currency ?? 'USD';
      const confidence = input.confidence ?? 'estimate';
      const coverage = input.coverage ?? 'undercount';
      const filterJson = input.filter_json ?? {};
      const breakdownJson = input.breakdown_json ?? {};
      const observedAt = input.observed_at ?? new Date();

      const [row] = await db<CloudCostSnapshot[]>`
        INSERT INTO cloud_cost_snapshots (
          id, provider, source, account_id, billing_account_id,
          scope_type, scope_key, scope_label, org_id, project_id, environment_id,
          window_start, window_end, mtd_through, amount, projected_amount,
          currency, confidence, coverage, filter_json, breakdown_json, observed_at
        ) VALUES (
          ${id}, ${input.provider}, ${input.source}, ${accountId}, ${billingAccountId},
          ${input.scope_type}, ${input.scope_key}, ${input.scope_label}, ${orgId}, ${projectId}, ${environmentId},
          ${input.window_start}, ${input.window_end}, ${mtdThrough}, ${input.amount}, ${projectedAmount},
          ${currency}, ${confidence}, ${coverage}, ${db.json(filterJson as never)}, ${db.json(breakdownJson as never)}, ${observedAt}
        )
        ON CONFLICT (provider, source, scope_type, scope_key, window_start) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          billing_account_id = EXCLUDED.billing_account_id,
          scope_label = EXCLUDED.scope_label,
          org_id = EXCLUDED.org_id,
          project_id = EXCLUDED.project_id,
          environment_id = EXCLUDED.environment_id,
          window_end = EXCLUDED.window_end,
          mtd_through = EXCLUDED.mtd_through,
          amount = EXCLUDED.amount,
          projected_amount = EXCLUDED.projected_amount,
          currency = EXCLUDED.currency,
          confidence = EXCLUDED.confidence,
          coverage = EXCLUDED.coverage,
          filter_json = EXCLUDED.filter_json,
          breakdown_json = EXCLUDED.breakdown_json,
          observed_at = EXCLUDED.observed_at
        RETURNING *
      `;
      return row!;
    },

    async latestForScope(input: LatestCloudCostScopeInput): Promise<CloudCostSnapshot | null> {
      const provider = input.provider ?? null;
      const source = input.source ?? null;
      const rows = await db<CloudCostSnapshot[]>`
        SELECT * FROM cloud_cost_snapshots
        WHERE window_start = ${input.windowStart}
          AND scope_type = ${input.scopeType}
          AND scope_key = ${input.scopeKey}
          AND (${provider}::text IS NULL OR provider = ${provider})
          AND (${source}::text IS NULL OR source = ${source})
        ORDER BY observed_at DESC, provider ASC, source ASC
        LIMIT 1
      `;
      return rows[0] ?? null;
    },

    async latestForMonth(input: LatestCloudCostMonthInput): Promise<CloudCostSnapshot[]> {
      const provider = input.provider ?? null;
      const source = input.source ?? null;
      const scopeType = input.scopeType ?? null;
      return db<CloudCostSnapshot[]>`
        SELECT * FROM cloud_cost_snapshots
        WHERE window_start = ${input.windowStart}
          AND (${provider}::text IS NULL OR provider = ${provider})
          AND (${source}::text IS NULL OR source = ${source})
          AND (${scopeType}::text IS NULL OR scope_type = ${scopeType})
        ORDER BY provider ASC, scope_type ASC, scope_key ASC, observed_at DESC
      `;
    },

    async freshnessForScope(input: Omit<LatestCloudCostScopeInput, 'windowStart'> & { windowStart: Date }): Promise<CloudCostFreshness> {
      const provider = input.provider ?? null;
      const source = input.source ?? null;
      const [row] = await db<Array<{ observed_at: Date | null }>>`
        SELECT MAX(observed_at) AS observed_at
        FROM cloud_cost_snapshots
        WHERE window_start = ${input.windowStart}
          AND scope_type = ${input.scopeType}
          AND scope_key = ${input.scopeKey}
          AND (${provider}::text IS NULL OR provider = ${provider})
          AND (${source}::text IS NULL OR source = ${source})
      `;
      return { observed_at: row?.observed_at ?? null };
    },
  };
}
