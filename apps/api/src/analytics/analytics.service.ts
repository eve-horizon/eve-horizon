import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { orgQueries } from '@eve/db';
import type {
  AnalyticsSummary,
  AnalyticsJobStats,
  AnalyticsPipelineStats,
  AnalyticsEnvHealth,
} from '@eve/shared';

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<string, number> = {
  '1d': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
  '90d': 7_776_000_000,
};

function parseWindow(window: string): number {
  return WINDOW_MS[window] ?? WINDOW_MS['7d'];
}

function normaliseWindow(raw: string | undefined): string {
  if (raw && raw in WINDOW_MS) return raw;
  return '7d';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentCostRow {
  agent: string;
  attempts: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

// ---------------------------------------------------------------------------
// Empty result factory
// ---------------------------------------------------------------------------

function emptySummary(now: Date, windowStart: Date, window: string): AnalyticsSummary {
  return {
    as_of: now.toISOString(),
    window_start: windowStart.toISOString(),
    window_end: now.toISOString(),
    window,
    projects: 0,
    jobs: { created: 0, completed: 0, failed: 0, active: 0 },
    pipelines: { runs: 0, success_rate: 0, avg_duration_s: 0 },
    deployments: { total: 0, successful: 0, rollbacks: 0 },
    environments: { total: 0, healthy: 0, degraded: 0, unknown: 0 },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AnalyticsService {
  private orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.orgs = orgQueries(db);
  }

  // -----------------------------------------------------------------------
  // Org resolution
  // -----------------------------------------------------------------------

  private async resolveOrgId(orgIdOrSlug: string): Promise<string> {
    const byId = await this.orgs.findById(orgIdOrSlug);
    if (byId) return byId.id;
    const bySlug = await this.orgs.findBySlug(orgIdOrSlug);
    if (bySlug) return bySlug.id;
    throw new NotFoundException(`Organization ${orgIdOrSlug} not found`);
  }

  // -----------------------------------------------------------------------
  // Project IDs for org
  // -----------------------------------------------------------------------

  private async getProjectIds(orgId: string): Promise<string[]> {
    const rows = await this.db<{ id: string }[]>`
      SELECT id FROM projects
      WHERE org_id = ${orgId} AND deleted_at IS NULL
    `;
    return rows.map((r) => r.id);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  async getSummary(orgIdOrSlug: string, rawWindow?: string): Promise<AnalyticsSummary> {
    const window = normaliseWindow(rawWindow);
    const windowMs = parseWindow(window);
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getProjectIds(orgId);

    if (projectIds.length === 0) {
      return emptySummary(now, windowStart, window);
    }

    const [jobStats, pipelineStats, envStats] = await Promise.all([
      this.getJobStats(projectIds, windowStart),
      this.getPipelineStats(projectIds, windowStart),
      this.getEnvStats(projectIds),
    ]);

    return {
      as_of: now.toISOString(),
      window_start: windowStart.toISOString(),
      window_end: now.toISOString(),
      window,
      projects: projectIds.length,
      jobs: jobStats,
      pipelines: pipelineStats,
      deployments: { total: 0, successful: 0, rollbacks: 0 },
      environments: envStats,
    };
  }

  // -----------------------------------------------------------------------
  // Job stats
  // -----------------------------------------------------------------------

  async getJobStats(projectIds: string[], windowStart: Date): Promise<AnalyticsJobStats> {
    if (projectIds.length === 0) {
      return { created: 0, completed: 0, failed: 0, active: 0 };
    }

    const [created, completed, failed, active] = await Promise.all([
      this.db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM jobs
        WHERE project_id = ANY(${projectIds})
          AND created_at >= ${windowStart}
      `,
      this.db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM jobs
        WHERE project_id = ANY(${projectIds})
          AND phase = 'done'
          AND closed_at >= ${windowStart}
      `,
      this.db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM job_attempts
        WHERE job_id IN (
          SELECT id FROM jobs WHERE project_id = ANY(${projectIds})
        )
          AND status = 'failed'
          AND started_at >= ${windowStart}
      `,
      this.db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM jobs
        WHERE project_id = ANY(${projectIds})
          AND phase IN ('active', 'review')
      `,
    ]);

    return {
      created: parseInt(created[0].count, 10),
      completed: parseInt(completed[0].count, 10),
      failed: parseInt(failed[0].count, 10),
      active: parseInt(active[0].count, 10),
    };
  }

  async getJobStatsForOrg(orgIdOrSlug: string, rawWindow?: string): Promise<AnalyticsJobStats & { as_of: string }> {
    const window = normaliseWindow(rawWindow);
    const windowMs = parseWindow(window);
    const windowStart = new Date(Date.now() - windowMs);

    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getProjectIds(orgId);
    const stats = await this.getJobStats(projectIds, windowStart);

    return { ...stats, as_of: new Date().toISOString() };
  }

  // -----------------------------------------------------------------------
  // Pipeline stats
  // -----------------------------------------------------------------------

  async getPipelineStats(projectIds: string[], windowStart: Date): Promise<AnalyticsPipelineStats> {
    if (projectIds.length === 0) {
      return { runs: 0, success_rate: 0, avg_duration_s: 0 };
    }

    const rows = await this.db<{
      total: string;
      succeeded: string;
      avg_duration_s: string | null;
    }[]>`
      SELECT
        COUNT(*)::text                                          AS total,
        COUNT(*) FILTER (WHERE status = 'succeeded')::text     AS succeeded,
        EXTRACT(EPOCH FROM AVG(
          CASE WHEN completed_at IS NOT NULL
               THEN completed_at - started_at END
        ))::text                                                AS avg_duration_s
      FROM pipeline_runs
      WHERE project_id = ANY(${projectIds})
        AND created_at >= ${windowStart}
    `;

    const row = rows[0];
    const total = parseInt(row.total, 10);
    const succeeded = parseInt(row.succeeded, 10);
    const avgDuration = row.avg_duration_s ? parseFloat(row.avg_duration_s) : 0;

    return {
      runs: total,
      success_rate: total > 0 ? Math.round((succeeded / total) * 10_000) / 100 : 0,
      avg_duration_s: Math.round(avgDuration * 100) / 100,
    };
  }

  async getPipelineStatsForOrg(
    orgIdOrSlug: string,
    rawWindow?: string,
  ): Promise<AnalyticsPipelineStats & { as_of: string }> {
    const window = normaliseWindow(rawWindow);
    const windowMs = parseWindow(window);
    const windowStart = new Date(Date.now() - windowMs);

    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getProjectIds(orgId);
    const stats = await this.getPipelineStats(projectIds, windowStart);

    return { ...stats, as_of: new Date().toISOString() };
  }

  // -----------------------------------------------------------------------
  // Environment health
  // -----------------------------------------------------------------------

  async getEnvStats(projectIds: string[]): Promise<AnalyticsEnvHealth> {
    if (projectIds.length === 0) {
      return { total: 0, healthy: 0, degraded: 0, unknown: 0 };
    }

    const rows = await this.db<{
      total: string;
      healthy: string;
      degraded: string;
      unknown: string;
    }[]>`
      SELECT
        COUNT(*)::text                                          AS total,
        COUNT(*) FILTER (WHERE status = 'active')::text        AS healthy,
        COUNT(*) FILTER (WHERE status = 'suspended')::text     AS degraded,
        COUNT(*) FILTER (WHERE status NOT IN ('active', 'suspended'))::text AS unknown
      FROM environments
      WHERE project_id = ANY(${projectIds})
    `;

    const row = rows[0];
    return {
      total: parseInt(row.total, 10),
      healthy: parseInt(row.healthy, 10),
      degraded: parseInt(row.degraded, 10),
      unknown: parseInt(row.unknown, 10),
    };
  }

  async getEnvHealthForOrg(orgIdOrSlug: string): Promise<AnalyticsEnvHealth & { as_of: string }> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getProjectIds(orgId);
    const stats = await this.getEnvStats(projectIds);

    return { ...stats, as_of: new Date().toISOString() };
  }

  // -----------------------------------------------------------------------
  // Cost by agent
  // -----------------------------------------------------------------------

  async getCostByAgent(
    orgIdOrSlug: string,
    rawWindow?: string,
  ): Promise<{ as_of: string; window: string; agents: AgentCostRow[] }> {
    const window = normaliseWindow(rawWindow);
    const windowMs = parseWindow(window);
    const windowStart = new Date(Date.now() - windowMs);

    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getProjectIds(orgId);

    if (projectIds.length === 0) {
      return { as_of: new Date().toISOString(), window, agents: [] };
    }

    const rows = await this.db<AgentCostRow[]>`
      SELECT
        COALESCE(a.agent_id, j.assignee, 'unassigned') AS agent,
        COUNT(a.id)::int AS attempts,
        COALESCE(SUM(a.receipt_base_total_usd), 0)::numeric(12,4) AS total_cost_usd,
        COALESCE(SUM(a.token_input), 0)::bigint AS total_input_tokens,
        COALESCE(SUM(a.token_output), 0)::bigint AS total_output_tokens
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
      WHERE j.project_id = ANY(${projectIds})
        AND a.ended_at >= ${windowStart}
        AND a.receipt_base_total_usd IS NOT NULL
      GROUP BY COALESCE(a.agent_id, j.assignee, 'unassigned')
      ORDER BY total_cost_usd DESC
    `;

    return {
      as_of: new Date().toISOString(),
      window,
      agents: rows.map(r => ({
        agent: r.agent,
        attempts: Number(r.attempts),
        total_cost_usd: Number(r.total_cost_usd),
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
      })),
    };
  }
}
