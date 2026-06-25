import type { Db } from '../client.js';

// ============================================================================
// Cursor encoding / decoding
// ============================================================================

/**
 * Encode a (created_at, id) pair into a base64 cursor string.
 * The cursor is opaque to the client.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

/**
 * Decode a base64url cursor back into (created_at, id).
 * Returns null if the cursor is malformed.
 */
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [isoDate, id] = decoded.split('|');
    if (!isoDate || !id) return null;
    const createdAt = new Date(isoDate);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface OrgJobRow {
  id: string;
  project_id: string;
  project_slug: string;
  project_name: string;
  title: string;
  phase: string;
  priority: number;
  assignee: string | null;
  labels: string[];
  created_at: Date;
  updated_at: Date;
}

export interface OrgJobStatsRow {
  phase: string;
  count: number;
}

export interface OrgJobStatsProjectRow {
  project_id: string;
  project_name: string;
  count: number;
}

export interface OrgEventRow {
  id: string;
  project_id: string;
  project_slug: string;
  type: string;
  source: string;
  status: string;
  created_at: Date;
}

export interface OrgAgentRow {
  project_id: string;
  project_slug: string;
  project_name: string;
  agent_id: string;
  agent_slug: string | null;
  agent_name: string | null;
  agent_description: string | null;
  role: string | null;
  workflow: string | null;
  gateway_policy: string;
}

// ============================================================================
// Query factory
// ============================================================================

export function orgQueryQueries(db: Db) {
  return {
    /**
     * Find jobs across multiple projects within an org.
     *
     * Permission filtering is done via the `projectIds` parameter —
     * only projects the caller has access to should be passed in.
     *
     * Supports cursor-based pagination (newest first) and optional
     * filters for phase (status) and agent slug (glob via `*`).
     */
    async findJobsAcrossProjects(
      projectIds: string[],
      params: {
        status?: string;
        agent_slug?: string;
        project_id?: string;
        limit?: number;
        cursor?: string;
      },
    ): Promise<{ items: OrgJobRow[]; next_cursor: string | null }> {
      if (projectIds.length === 0) {
        return { items: [], next_cursor: null };
      }

      const limit = Math.min(params.limit ?? 50, 100);

      // Build conditions
      const conditions: ReturnType<typeof db>[] = [
        db`j.project_id = ANY(${projectIds})`,
      ];

      if (params.status) {
        conditions.push(db`j.phase = ${params.status}`);
      }

      if (params.agent_slug) {
        const pattern = params.agent_slug.replace(/\*/g, '%');
        conditions.push(db`j.assignee LIKE ${pattern}`);
      }

      if (params.project_id) {
        conditions.push(db`j.project_id = ${params.project_id}`);
      }

      // Cursor: decode and add keyset pagination condition
      if (params.cursor) {
        const decoded = decodeCursor(params.cursor);
        if (decoded) {
          conditions.push(
            db`(j.created_at, j.id) < (${decoded.createdAt}, ${decoded.id})`,
          );
        }
      }

      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`,
      );

      // Fetch limit+1 to detect whether there's a next page
      const rows = await db<OrgJobRow[]>`
        SELECT
          j.id,
          j.project_id,
          p.slug AS project_slug,
          p.name AS project_name,
          j.title,
          j.phase,
          j.priority,
          j.assignee,
          j.labels,
          j.created_at,
          j.updated_at
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        WHERE ${whereClause}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ${limit + 1}
      `;

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && items.length > 0
          ? encodeCursor(items[items.length - 1].created_at, items[items.length - 1].id)
          : null;

      return { items, next_cursor: nextCursor };
    },

    /**
     * Aggregate job counts by phase and project.
     */
    async jobStats(
      projectIds: string[],
    ): Promise<{
      total: number;
      byPhase: OrgJobStatsRow[];
      byProject: OrgJobStatsProjectRow[];
    }> {
      if (projectIds.length === 0) {
        return { total: 0, byPhase: [], byProject: [] };
      }

      const [totalResult, byPhase, byProject] = await Promise.all([
        db<[{ count: number }]>`
          SELECT COUNT(*)::int AS count
          FROM jobs
          WHERE project_id = ANY(${projectIds})
        `,
        db<OrgJobStatsRow[]>`
          SELECT phase, COUNT(*)::int AS count
          FROM jobs
          WHERE project_id = ANY(${projectIds})
          GROUP BY phase
          ORDER BY count DESC
        `,
        db<OrgJobStatsProjectRow[]>`
          SELECT j.project_id, p.name AS project_name, COUNT(*)::int AS count
          FROM jobs j
          JOIN projects p ON p.id = j.project_id
          WHERE j.project_id = ANY(${projectIds})
          GROUP BY j.project_id, p.name
          ORDER BY count DESC
        `,
      ]);

      return {
        total: totalResult[0]?.count ?? 0,
        byPhase,
        byProject,
      };
    },

    /**
     * Find events across multiple projects within an org.
     *
     * Supports cursor-based pagination and optional type glob filter.
     */
    async findEventsAcrossProjects(
      projectIds: string[],
      params: {
        type?: string;
        since?: string;
        limit?: number;
        cursor?: string;
      },
    ): Promise<{ items: OrgEventRow[]; next_cursor: string | null }> {
      if (projectIds.length === 0) {
        return { items: [], next_cursor: null };
      }

      const limit = Math.min(params.limit ?? 50, 100);

      const conditions: ReturnType<typeof db>[] = [
        db`e.project_id = ANY(${projectIds})`,
      ];

      if (params.type) {
        const pattern = params.type.replace(/\*/g, '%');
        conditions.push(db`e.type LIKE ${pattern}`);
      }

      if (params.since) {
        conditions.push(db`e.created_at >= ${params.since}`);
      }

      if (params.cursor) {
        const decoded = decodeCursor(params.cursor);
        if (decoded) {
          conditions.push(
            db`(e.created_at, e.id) < (${decoded.createdAt}, ${decoded.id})`,
          );
        }
      }

      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`,
      );

      const rows = await db<OrgEventRow[]>`
        SELECT
          e.id,
          e.project_id,
          p.slug AS project_slug,
          e.type,
          e.source,
          e.status,
          e.created_at
        FROM events e
        JOIN projects p ON p.id = e.project_id
        WHERE ${whereClause}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ${limit + 1}
      `;

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && items.length > 0
          ? encodeCursor(items[items.length - 1].created_at, items[items.length - 1].id)
          : null;

      return { items, next_cursor: nextCursor };
    },

    /**
     * Find all agents across projects within an org.
     *
     * Returns agents from all accessible projects, joined with project metadata.
     * No pagination needed — agent counts are typically small (tens, not thousands).
     */
    async findAgentsAcrossProjects(
      projectIds: string[],
    ): Promise<OrgAgentRow[]> {
      if (projectIds.length === 0) {
        return [];
      }

      return db<OrgAgentRow[]>`
        SELECT
          a.project_id,
          p.slug AS project_slug,
          p.name AS project_name,
          a.id AS agent_id,
          a.slug AS agent_slug,
          a.name AS agent_name,
          a.description AS agent_description,
          a.role,
          a.workflow,
          a.gateway_policy
        FROM agents a
        JOIN projects p ON p.id = a.project_id
        WHERE a.project_id = ANY(${projectIds})
        ORDER BY p.slug ASC, a.slug NULLS LAST, a.id ASC
      `;
    },

    /**
     * Get all project IDs in an org that a user has access to.
     *
     * A user has access to a project if:
     *   1. They have a direct project_memberships row, OR
     *   2. They are a member of the org (org_memberships) — which grants
     *      implicit access to all projects in that org.
     */
    async getAccessibleProjectIds(
      orgId: string,
      userId: string,
    ): Promise<string[]> {
      const rows = await db<{ id: string }[]>`
        SELECT DISTINCT p.id
        FROM projects p
        LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ${userId}
        LEFT JOIN org_memberships om ON om.org_id = p.org_id AND om.user_id = ${userId}
        WHERE p.org_id = ${orgId}
          AND p.deleted_at IS NULL
          AND (pm.user_id IS NOT NULL OR om.user_id IS NOT NULL)
      `;
      return rows.map((r) => r.id);
    },
  };
}
