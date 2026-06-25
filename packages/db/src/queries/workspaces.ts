import type { Db } from '../client.js';

// ============================================================================
// Types
// ============================================================================

export interface Workspace {
  id: string;
  project_id: string;
  state: 'idle' | 'acquired' | 'teardown';
  last_job_id: string | null;
  last_used_at: Date | null;
  heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
  pvc_name: string | null;
  namespace: string | null;
}

export interface AcquireWorkspaceResult {
  success: boolean;
  workspace?: Workspace;
  isNew?: boolean;
  error?: string;
}

// ============================================================================
// Factory Function
// ============================================================================

export function workspaceQueries(db: Db) {
  return {
    /**
     * Generate a workspace ID
     */
    generateWorkspaceId(projectSlug: string): string {
      const random = Math.random().toString(36).substring(2, 10);
      return `ws_${projectSlug}_${random}`;
    },

    /**
     * Find a workspace by ID
     */
    async findById(id: string): Promise<Workspace | null> {
      const [row] = await db<Workspace[]>`
        SELECT * FROM workspaces WHERE id = ${id}
      `;
      return row ?? null;
    },

    /**
     * List workspaces for a project
     */
    async listByProject(projectId: string): Promise<Workspace[]> {
      return db<Workspace[]>`
        SELECT * FROM workspaces
        WHERE project_id = ${projectId}
        ORDER BY last_used_at DESC NULLS LAST
      `;
    },

    /**
     * Acquire an available workspace or create a new one
     *
     * Tries to atomically acquire an idle workspace for the given project.
     * If no idle workspaces exist and pool isn't full, creates a new one.
     *
     * @param projectId - Project ID
     * @param jobId - Job ID acquiring the workspace
     * @param poolSize - Maximum pool size (default 1)
     * @param namespace - K8s namespace for new workspaces
     * @returns Result with acquired workspace or error
     */
    async acquireWorkspace(
      projectId: string,
      projectSlug: string,
      jobId: string,
      poolSize: number = 1,
      namespace?: string,
    ): Promise<AcquireWorkspaceResult> {
      // Try to acquire an existing idle workspace atomically
      const [acquired] = await db<Workspace[]>`
        UPDATE workspaces
        SET state = 'acquired',
            last_job_id = ${jobId},
            last_used_at = NOW(),
            heartbeat_at = NOW(),
            updated_at = NOW()
        WHERE id = (
          SELECT id FROM workspaces
          WHERE project_id = ${projectId}
            AND state = 'idle'
          ORDER BY last_used_at DESC NULLS LAST
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `;

      if (acquired) {
        return { success: true, workspace: acquired, isNew: false };
      }

      // No idle workspace available - check if we can create a new one
      const [countResult] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int as count
        FROM workspaces
        WHERE project_id = ${projectId}
          AND state != 'teardown'
      `;

      const currentCount = countResult?.count ?? 0;

      if (currentCount >= poolSize) {
        return {
          success: false,
          error: `Pool full: ${currentCount}/${poolSize} workspaces in use`,
        };
      }

      // Create a new workspace
      const workspaceId = this.generateWorkspaceId(projectSlug);
      const pvcName = `pvc-${workspaceId}`;

      const [created] = await db<Workspace[]>`
        INSERT INTO workspaces (
          id, project_id, state, last_job_id, last_used_at, heartbeat_at,
          pvc_name, namespace
        )
        VALUES (
          ${workspaceId}, ${projectId}, 'acquired', ${jobId}, NOW(), NOW(),
          ${pvcName}, ${namespace ?? null}
        )
        RETURNING *
      `;

      return { success: true, workspace: created, isNew: true };
    },

    /**
     * Release a workspace back to the pool
     *
     * @param workspaceId - Workspace ID to release
     * @param jobId - Job ID releasing (for validation)
     * @returns True if released, false if not found/not owned
     */
    async releaseWorkspace(workspaceId: string, jobId?: string): Promise<boolean> {
      const condition = jobId
        ? db`AND last_job_id = ${jobId}`
        : db``;

      const result = await db<{ id: string }[]>`
        UPDATE workspaces
        SET state = 'idle',
            heartbeat_at = NULL,
            updated_at = NOW()
        WHERE id = ${workspaceId}
          AND state = 'acquired'
          ${condition}
        RETURNING id
      `;

      return result.length > 0;
    },

    /**
     * Update heartbeat for an acquired workspace
     *
     * @param workspaceId - Workspace ID
     * @returns True if updated, false if not found/not acquired
     */
    async heartbeat(workspaceId: string): Promise<boolean> {
      const result = await db<{ id: string }[]>`
        UPDATE workspaces
        SET heartbeat_at = NOW(),
            updated_at = NOW()
        WHERE id = ${workspaceId}
          AND state = 'acquired'
        RETURNING id
      `;

      return result.length > 0;
    },

    /**
     * Mark workspace for teardown
     *
     * @param workspaceId - Workspace ID
     * @returns True if marked, false if not found
     */
    async markForTeardown(workspaceId: string): Promise<boolean> {
      const result = await db<{ id: string }[]>`
        UPDATE workspaces
        SET state = 'teardown',
            updated_at = NOW()
        WHERE id = ${workspaceId}
        RETURNING id
      `;

      return result.length > 0;
    },

    /**
     * Delete a workspace (after teardown)
     *
     * @param workspaceId - Workspace ID
     * @returns True if deleted, false if not found
     */
    async delete(workspaceId: string): Promise<boolean> {
      const result = await db<{ id: string }[]>`
        DELETE FROM workspaces
        WHERE id = ${workspaceId}
        RETURNING id
      `;

      return result.length > 0;
    },

    /**
     * Find stale workspaces (acquired but no heartbeat for too long)
     *
     * @param staleMinutes - Minutes since last heartbeat to consider stale
     * @returns Array of stale workspaces
     */
    async findStaleWorkspaces(staleMinutes: number = 30): Promise<Workspace[]> {
      const staleCutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

      return db<Workspace[]>`
        SELECT * FROM workspaces
        WHERE state = 'acquired'
          AND (heartbeat_at IS NULL OR heartbeat_at < ${staleCutoff})
        ORDER BY heartbeat_at ASC NULLS FIRST
      `;
    },

    /**
     * Reset stale workspaces back to idle
     *
     * @param staleMinutes - Minutes since last heartbeat to consider stale
     * @returns Number of workspaces reset
     */
    async resetStaleWorkspaces(staleMinutes: number = 30): Promise<number> {
      const staleCutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

      const result = await db<{ count: number }[]>`
        WITH updated AS (
          UPDATE workspaces
          SET state = 'idle',
              heartbeat_at = NULL,
              updated_at = NOW()
          WHERE state = 'acquired'
            AND (heartbeat_at IS NULL OR heartbeat_at < ${staleCutoff})
          RETURNING id
        )
        SELECT COUNT(*)::int as count FROM updated
      `;

      return result[0]?.count ?? 0;
    },

    /**
     * Get pool statistics for a project
     *
     * @param projectId - Project ID
     * @returns Pool stats (idle, acquired, teardown counts)
     */
    async getPoolStats(projectId: string): Promise<{
      idle: number;
      acquired: number;
      teardown: number;
      total: number;
    }> {
      const result = await db<{ state: string; count: number }[]>`
        SELECT state, COUNT(*)::int as count
        FROM workspaces
        WHERE project_id = ${projectId}
        GROUP BY state
      `;

      const stats = { idle: 0, acquired: 0, teardown: 0, total: 0 };
      for (const row of result) {
        if (row.state === 'idle') stats.idle = row.count;
        if (row.state === 'acquired') stats.acquired = row.count;
        if (row.state === 'teardown') stats.teardown = row.count;
        stats.total += row.count;
      }

      return stats;
    },
  };
}
