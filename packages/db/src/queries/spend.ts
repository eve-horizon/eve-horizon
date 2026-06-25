import type { Db } from '../client.js';

type SpendWindow = {
  since?: Date;
  until?: Date;
};

function normalizeCurrency(currency: string | undefined | null): string {
  return (currency ?? 'usd').toLowerCase();
}

export function spendQueries(db: Db) {
  return {
    async sumProjectSpend(
      projectId: string,
      window: SpendWindow & { billed_currency?: string },
    ): Promise<{
      project_id: string;
      since: string | null;
      until: string | null;
      base_total_usd: string;
      billed_total: string;
      billed_currency: string;
      attempts: number;
    }> {
      const currency = normalizeCurrency(window.billed_currency);

      const [row] = await db<{
        base_total_usd: string;
        billed_total: string;
        attempts: number;
      }[]>`
        SELECT
          COALESCE(SUM(COALESCE(
            a.receipt_base_total_usd,
            NULLIF((a.receipt_json->'base_cost_usd'->'total_usd'->>'amount'), '')::numeric
          )), 0)::text AS base_total_usd,
          COALESCE(SUM(CASE
            WHEN LOWER(COALESCE(a.receipt_billed_currency, (a.receipt_json->'billed_cost'->'total'->>'currency'), 'usd')) = ${currency}
            THEN COALESCE(
              a.receipt_billed_total,
              NULLIF((a.receipt_json->'billed_cost'->'total'->>'amount'), '')::numeric
            )
            ELSE 0
          END), 0)::text AS billed_total,
          COUNT(*)::int AS attempts
        FROM job_attempts a
        JOIN jobs j ON j.id = a.job_id
        WHERE j.project_id = ${projectId}
          AND a.ended_at IS NOT NULL
          AND (${window.since ?? null}::timestamptz IS NULL OR a.ended_at >= ${window.since ?? null}::timestamptz)
          AND (${window.until ?? null}::timestamptz IS NULL OR a.ended_at <= ${window.until ?? null}::timestamptz)
      `;

      return {
        project_id: projectId,
        since: window.since ? window.since.toISOString() : null,
        until: window.until ? window.until.toISOString() : null,
        base_total_usd: row?.base_total_usd ?? '0',
        billed_total: row?.billed_total ?? '0',
        billed_currency: currency,
        attempts: row?.attempts ?? 0,
      };
    },

    async sumOrgSpend(
      orgId: string,
      window: SpendWindow & { billed_currency?: string },
    ): Promise<{
      org_id: string;
      since: string | null;
      until: string | null;
      base_total_usd: string;
      billed_total: string;
      billed_currency: string;
      attempts: number;
    }> {
      const currency = normalizeCurrency(window.billed_currency);

      const [row] = await db<{
        base_total_usd: string;
        billed_total: string;
        attempts: number;
      }[]>`
        SELECT
          COALESCE(SUM(COALESCE(
            a.receipt_base_total_usd,
            NULLIF((a.receipt_json->'base_cost_usd'->'total_usd'->>'amount'), '')::numeric
          )), 0)::text AS base_total_usd,
          COALESCE(SUM(CASE
            WHEN LOWER(COALESCE(a.receipt_billed_currency, (a.receipt_json->'billed_cost'->'total'->>'currency'), 'usd')) = ${currency}
            THEN COALESCE(
              a.receipt_billed_total,
              NULLIF((a.receipt_json->'billed_cost'->'total'->>'amount'), '')::numeric
            )
            ELSE 0
          END), 0)::text AS billed_total,
          COUNT(*)::int AS attempts
        FROM job_attempts a
        JOIN jobs j ON j.id = a.job_id
        JOIN projects p ON p.id = j.project_id
        WHERE p.org_id = ${orgId}
          AND a.ended_at IS NOT NULL
          AND (${window.since ?? null}::timestamptz IS NULL OR a.ended_at >= ${window.since ?? null}::timestamptz)
          AND (${window.until ?? null}::timestamptz IS NULL OR a.ended_at <= ${window.until ?? null}::timestamptz)
      `;

      return {
        org_id: orgId,
        since: window.since ? window.since.toISOString() : null,
        until: window.until ? window.until.toISOString() : null,
        base_total_usd: row?.base_total_usd ?? '0',
        billed_total: row?.billed_total ?? '0',
        billed_currency: currency,
        attempts: row?.attempts ?? 0,
      };
    },

    async sumSpendByProject(
      window: SpendWindow & { org_id?: string | null },
    ): Promise<Array<{
      project_id: string;
      org_id: string;
      base_total_usd: string;
      attempts: number;
    }>> {
      return db<Array<{
        project_id: string;
        org_id: string;
        base_total_usd: string;
        attempts: number;
      }>>`
        SELECT
          j.project_id AS project_id,
          p.org_id AS org_id,
          COALESCE(SUM(COALESCE(
            a.receipt_base_total_usd,
            NULLIF((a.receipt_json->'base_cost_usd'->'total_usd'->>'amount'), '')::numeric
          )), 0)::text AS base_total_usd,
          COUNT(*)::int AS attempts
        FROM job_attempts a
        JOIN jobs j ON j.id = a.job_id
        JOIN projects p ON p.id = j.project_id
        WHERE (${window.org_id ?? null}::text IS NULL OR p.org_id = ${window.org_id ?? null}::text)
          AND a.ended_at IS NOT NULL
          AND (${window.since ?? null}::timestamptz IS NULL OR a.ended_at >= ${window.since ?? null}::timestamptz)
          AND (${window.until ?? null}::timestamptz IS NULL OR a.ended_at <= ${window.until ?? null}::timestamptz)
        GROUP BY j.project_id, p.org_id
        ORDER BY j.project_id
      `;
    },

    async topJobsByCost(
      projectId: string,
      window: SpendWindow & { billed_currency?: string; limit?: number },
    ): Promise<Array<{
      job_id: string;
      title: string;
      base_total_usd: string;
      billed_total: string;
      billed_currency: string;
      attempts: number;
    }>> {
      const currency = normalizeCurrency(window.billed_currency);
      const limit = typeof window.limit === 'number' && Number.isFinite(window.limit) ? Math.max(1, Math.floor(window.limit)) : 10;

      return db<Array<{
        job_id: string;
        title: string;
        base_total_usd: string;
        billed_total: string;
        attempts: number;
      }>>`
        SELECT
          j.id AS job_id,
          j.title AS title,
          COALESCE(SUM(COALESCE(
            a.receipt_base_total_usd,
            NULLIF((a.receipt_json->'base_cost_usd'->'total_usd'->>'amount'), '')::numeric
          )), 0)::text AS base_total_usd,
          COALESCE(SUM(CASE
            WHEN LOWER(COALESCE(a.receipt_billed_currency, (a.receipt_json->'billed_cost'->'total'->>'currency'), 'usd')) = ${currency}
            THEN COALESCE(
              a.receipt_billed_total,
              NULLIF((a.receipt_json->'billed_cost'->'total'->>'amount'), '')::numeric
            )
            ELSE 0
          END), 0)::text AS billed_total,
          COUNT(*)::int AS attempts
        FROM job_attempts a
        JOIN jobs j ON j.id = a.job_id
        WHERE j.project_id = ${projectId}
          AND a.ended_at IS NOT NULL
          AND (${window.since ?? null}::timestamptz IS NULL OR a.ended_at >= ${window.since ?? null}::timestamptz)
          AND (${window.until ?? null}::timestamptz IS NULL OR a.ended_at <= ${window.until ?? null}::timestamptz)
        GROUP BY j.id, j.title
        ORDER BY (COALESCE(SUM(COALESCE(a.receipt_base_total_usd, NULLIF((a.receipt_json->'base_cost_usd'->'total_usd'->>'amount'), '')::numeric)), 0)) DESC
        LIMIT ${limit}
      `.then((rows) => rows.map((r) => ({
        job_id: r.job_id,
        title: r.title,
        base_total_usd: r.base_total_usd,
        billed_total: r.billed_total,
        billed_currency: currency,
        attempts: r.attempts,
      })));
    },

    async compareAttempts(
      jobId: string,
      attemptA: number,
      attemptB: number,
    ): Promise<{
      job_id: string;
      attempts: Array<{
        attempt_number: number;
        status: string;
        started_at: string;
        ended_at: string | null;
        base_total_usd: string;
        billed_total: string;
        billed_currency: string;
        receipt_json: Record<string, unknown> | null;
      }>;
    }> {
      const numbers = [attemptA, attemptB].map((n) => Math.max(1, Math.floor(n)));

      const rows = await db<Array<{
        attempt_number: number;
        status: string;
        started_at: Date;
        ended_at: Date | null;
        base_total_usd: string;
        billed_total: string;
        billed_currency: string;
        receipt_json: Record<string, unknown> | null;
      }>>`
        SELECT
          a.attempt_number,
          a.status,
          a.started_at,
          a.ended_at,
          COALESCE(COALESCE(
            a.receipt_base_total_usd,
            NULLIF((a.receipt_json->'base_cost_usd'->'total_usd'->>'amount'), '')::numeric
          ), 0)::text AS base_total_usd,
          COALESCE(COALESCE(
            a.receipt_billed_total,
            NULLIF((a.receipt_json->'billed_cost'->'total'->>'amount'), '')::numeric
          ), 0)::text AS billed_total,
          LOWER(COALESCE(
            a.receipt_billed_currency,
            (a.receipt_json->'billed_cost'->'total'->>'currency'),
            'usd'
          ))::text AS billed_currency,
          a.receipt_json
        FROM job_attempts a
        WHERE a.job_id = ${jobId}
          -- postgres Sql#array expects an element OID; 21 = int2/smallint
          AND a.attempt_number = ANY(${db.array(numbers, 21)})
        ORDER BY a.attempt_number ASC
      `;

      return {
        job_id: jobId,
        attempts: rows.map((r) => ({
          attempt_number: r.attempt_number,
          status: r.status,
          started_at: r.started_at.toISOString(),
          ended_at: r.ended_at ? r.ended_at.toISOString() : null,
          base_total_usd: r.base_total_usd,
          billed_total: r.billed_total,
          billed_currency: r.billed_currency,
          receipt_json: r.receipt_json,
        })),
      };
    },
  };
}
