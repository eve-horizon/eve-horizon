import type { Db } from '../client.js';

export type EnvironmentCostScope = 'environment' | 'shared_overhead';
export type EnvironmentCostConfidence = 'estimate' | 'reconciled' | 'unavailable';

export interface EnvironmentCostSnapshot {
  id: string;
  aggregation_key: string;
  environment_id: string | null;
  org_id: string | null;
  project_id: string | null;
  environment_slug: string | null;
  scope: EnvironmentCostScope;
  source: string;
  window_start: Date;
  window_end: Date;
  amount_usd: string;
  shared_amount_usd: string | null;
  confidence: EnvironmentCostConfidence;
  breakdown_json: Record<string, unknown> | null;
  observed_at: Date;
}

export interface UpsertEnvironmentCostSnapshotInput {
  id: string;
  aggregation_key: string;
  environment_id?: string | null;
  org_id?: string | null;
  project_id?: string | null;
  environment_slug?: string | null;
  scope: EnvironmentCostScope;
  source: string;
  window_start: Date;
  window_end: Date;
  amount_usd: string;
  shared_amount_usd?: string | null;
  confidence?: EnvironmentCostConfidence;
  breakdown_json?: Record<string, unknown> | null;
  observed_at?: Date;
}

export interface EnvironmentCostTotals {
  total_usd: string;
  env_total_usd: string;
  shared_usd: string;
  env_count: number;
}

export interface EnvironmentCostFreshness {
  observed_at: Date | null;
}

export function environmentCostSnapshotQueries(db: Db) {
  return {
    async upsert(input: UpsertEnvironmentCostSnapshotInput): Promise<EnvironmentCostSnapshot> {
      const environmentId = input.environment_id ?? null;
      const orgId = input.org_id ?? null;
      const projectId = input.project_id ?? null;
      const environmentSlug = input.environment_slug ?? null;
      const sharedAmountUsd = input.shared_amount_usd ?? null;
      const confidence = input.confidence ?? 'estimate';
      const breakdownJson = input.breakdown_json ?? null;
      const observedAt = input.observed_at ?? new Date();

      const [row] = await db<EnvironmentCostSnapshot[]>`
        INSERT INTO environment_cost_snapshots (
          id, aggregation_key, environment_id, org_id, project_id,
          environment_slug, scope, source, window_start, window_end,
          amount_usd, shared_amount_usd, confidence, breakdown_json, observed_at
        ) VALUES (
          ${input.id}, ${input.aggregation_key}, ${environmentId}, ${orgId}, ${projectId},
          ${environmentSlug}, ${input.scope}, ${input.source}, ${input.window_start}, ${input.window_end},
          ${input.amount_usd}, ${sharedAmountUsd}, ${confidence}, ${db.json(breakdownJson as never)}, ${observedAt}
        )
        ON CONFLICT (aggregation_key, source, window_start) DO UPDATE SET
          environment_id = EXCLUDED.environment_id,
          org_id = EXCLUDED.org_id,
          project_id = EXCLUDED.project_id,
          environment_slug = EXCLUDED.environment_slug,
          scope = EXCLUDED.scope,
          window_end = EXCLUDED.window_end,
          amount_usd = EXCLUDED.amount_usd,
          shared_amount_usd = EXCLUDED.shared_amount_usd,
          confidence = EXCLUDED.confidence,
          breakdown_json = EXCLUDED.breakdown_json,
          observed_at = EXCLUDED.observed_at
        RETURNING *
      `;
      return row!;
    },

    async latestForMonth(windowStart: Date, source: string): Promise<EnvironmentCostSnapshot[]> {
      return db<EnvironmentCostSnapshot[]>`
        SELECT * FROM environment_cost_snapshots
        WHERE window_start = ${windowStart}
          AND source = ${source}
        ORDER BY
          CASE scope WHEN 'shared_overhead' THEN 1 ELSE 0 END,
          amount_usd DESC,
          environment_slug ASC NULLS LAST
      `;
    },

    async totalForMonth(windowStart: Date, source: string): Promise<EnvironmentCostTotals> {
      const [row] = await db<Array<{
        total_usd: string;
        env_total_usd: string;
        shared_usd: string;
        env_count: string;
      }>>`
        SELECT
          COALESCE(SUM(amount_usd), 0)::text AS total_usd,
          COALESCE(SUM(amount_usd) FILTER (WHERE scope = 'environment'), 0)::text AS env_total_usd,
          COALESCE(SUM(amount_usd) FILTER (WHERE scope = 'shared_overhead'), 0)::text AS shared_usd,
          COUNT(*) FILTER (WHERE scope = 'environment')::text AS env_count
        FROM environment_cost_snapshots
        WHERE window_start = ${windowStart}
          AND source = ${source}
      `;

      return {
        total_usd: row?.total_usd ?? '0',
        env_total_usd: row?.env_total_usd ?? '0',
        shared_usd: row?.shared_usd ?? '0',
        env_count: parseInt(row?.env_count ?? '0', 10),
      };
    },

    async freshnessForMonth(windowStart: Date, source: string): Promise<EnvironmentCostFreshness> {
      const [row] = await db<Array<{ observed_at: Date | null }>>`
        SELECT MAX(observed_at) AS observed_at
        FROM environment_cost_snapshots
        WHERE window_start = ${windowStart}
          AND source = ${source}
      `;
      return { observed_at: row?.observed_at ?? null };
    },
  };
}
