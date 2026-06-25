import type { Db } from '../client.js';

export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export interface EnvironmentHealthCheck {
  environment_id: string;
  project_id: string;
  org_id: string;
  environment_slug: string;
  status: HealthStatus;
  issue_signature: string;
  issues_json: HealthIssue[] | null;
  pod_count: number;
  healthy_pod_count: number;
  degraded_since: Date | null;
  consecutive_degraded_ticks: number;
  actions_taken_json: HealthAction[] | null;
  notified_at: Date | null;
  checked_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface HealthIssue {
  type: 'image_pull_backoff' | 'crash_loop_backoff' | 'high_restarts' | 'pending_too_long';
  pod: string;
  container?: string;
  restarts?: number;
  reason?: string;
  since?: string;
  image?: string;
}

export interface HealthAction {
  type: 'scale_to_zero';
  deployment: string;
  at: string;
}

export function environmentHealthQueries(db: Db) {
  return {
    async upsert(check: {
      environment_id: string;
      project_id: string;
      org_id: string;
      environment_slug: string;
      status: HealthStatus;
      issue_signature: string;
      issues_json: HealthIssue[] | null;
      pod_count: number;
      healthy_pod_count: number;
      degraded_since: Date | null;
      consecutive_degraded_ticks: number;
      actions_taken_json: HealthAction[] | null;
      notified_at?: Date | null;
    }): Promise<EnvironmentHealthCheck> {
      const [row] = await db<EnvironmentHealthCheck[]>`
        INSERT INTO environment_health_checks (
          environment_id, project_id, org_id, environment_slug,
          status, issue_signature, issues_json,
          pod_count, healthy_pod_count,
          degraded_since, consecutive_degraded_ticks,
          actions_taken_json, notified_at, checked_at, updated_at
        ) VALUES (
          ${check.environment_id}, ${check.project_id}, ${check.org_id}, ${check.environment_slug},
          ${check.status}, ${check.issue_signature}, ${JSON.stringify(check.issues_json)}::jsonb,
          ${check.pod_count}, ${check.healthy_pod_count},
          ${check.degraded_since}, ${check.consecutive_degraded_ticks},
          ${JSON.stringify(check.actions_taken_json)}::jsonb, ${check.notified_at ?? null}, NOW(), NOW()
        )
        ON CONFLICT (environment_id) DO UPDATE SET
          status = EXCLUDED.status,
          issue_signature = EXCLUDED.issue_signature,
          issues_json = EXCLUDED.issues_json,
          pod_count = EXCLUDED.pod_count,
          healthy_pod_count = EXCLUDED.healthy_pod_count,
          degraded_since = EXCLUDED.degraded_since,
          consecutive_degraded_ticks = EXCLUDED.consecutive_degraded_ticks,
          actions_taken_json = EXCLUDED.actions_taken_json,
          notified_at = COALESCE(EXCLUDED.notified_at, environment_health_checks.notified_at),
          checked_at = NOW(),
          updated_at = NOW()
        RETURNING *
      `;
      return row!;
    },

    async markNotified(environmentId: string): Promise<void> {
      await db`
        UPDATE environment_health_checks
        SET notified_at = NOW(), updated_at = NOW()
        WHERE environment_id = ${environmentId}
      `;
    },

    async findByEnvironmentId(environmentId: string): Promise<EnvironmentHealthCheck | null> {
      const [row] = await db<EnvironmentHealthCheck[]>`
        SELECT * FROM environment_health_checks WHERE environment_id = ${environmentId}
      `;
      return row ?? null;
    },

    async listAll(opts?: { status?: HealthStatus; limit?: number; offset?: number }): Promise<EnvironmentHealthCheck[]> {
      const limit = opts?.limit ?? 100;
      const offset = opts?.offset ?? 0;
      if (opts?.status) {
        return db<EnvironmentHealthCheck[]>`
          SELECT * FROM environment_health_checks
          WHERE status = ${opts.status}
          ORDER BY checked_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }
      return db<EnvironmentHealthCheck[]>`
        SELECT * FROM environment_health_checks
        ORDER BY
          CASE status WHEN 'critical' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END,
          checked_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async summary(): Promise<{ total: number; healthy: number; degraded: number; critical: number }> {
      const [row] = await db<Array<{ total: string; healthy: string; degraded: string; critical: string }>>`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'healthy') as healthy,
          COUNT(*) FILTER (WHERE status = 'degraded') as degraded,
          COUNT(*) FILTER (WHERE status = 'critical') as critical
        FROM environment_health_checks
      `;
      return {
        total: parseInt(row?.total ?? '0', 10),
        healthy: parseInt(row?.healthy ?? '0', 10),
        degraded: parseInt(row?.degraded ?? '0', 10),
        critical: parseInt(row?.critical ?? '0', 10),
      };
    },

    async deleteByEnvironmentId(environmentId: string): Promise<void> {
      await db`DELETE FROM environment_health_checks WHERE environment_id = ${environmentId}`;
    },
  };
}
