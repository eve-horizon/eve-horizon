import type { Db } from '../client.js';

// ============================================================================
// Types
// ============================================================================

export interface JobGate {
  gate_key: string;
  job_id: string;
  acquired_at: Date;
  ttl_expires_at: Date;
  context: Record<string, unknown>;
}

export interface AcquireGatesResult {
  success: boolean;
  acquired: string[];
  blocked_by: string[];
  error?: string;
}

// ============================================================================
// Factory Function
// ============================================================================

export function gateQueries(db: Db) {
  return {
    /**
     * Try to acquire gates for a job
     *
     * Uses INSERT ... ON CONFLICT DO NOTHING for atomic acquisition.
     * Returns which gates were acquired and which are blocking.
     *
     * @param jobId - Job ID trying to acquire gates
     * @param gateKeys - Array of gate keys to acquire (e.g., ['env:staging', 'project:myproj'])
     * @param ttlSeconds - TTL for the gates (default 30 minutes)
     * @param context - Optional context metadata
     * @returns Result with acquired gates and blocked_by info
     */
    async acquireGates(
      jobId: string,
      gateKeys: string[],
      ttlSeconds: number = 1800,
      context: Record<string, unknown> = {},
    ): Promise<AcquireGatesResult> {
      if (gateKeys.length === 0) {
        return { success: true, acquired: [], blocked_by: [] };
      }

      // First, clean up expired gates
      await this.cleanupExpiredGates();

      // Check which gates are already held (by other jobs)
      const heldGates = await db<{ gate_key: string; job_id: string }[]>`
        SELECT gate_key, job_id
        FROM job_gates
        WHERE gate_key = ANY(${gateKeys})
          AND job_id != ${jobId}
          AND ttl_expires_at > NOW()
      `;

      if (heldGates.length > 0) {
        // Some gates are blocked
        return {
          success: false,
          acquired: [],
          blocked_by: heldGates.map(g => g.gate_key),
        };
      }

      // Try to acquire all gates atomically
      const ttlExpiresAt = new Date(Date.now() + ttlSeconds * 1000);
      const acquired: string[] = [];

      for (const gateKey of gateKeys) {
        // Use INSERT ... ON CONFLICT DO NOTHING
        // If we already hold this gate, update the TTL
        const contextJson = JSON.stringify(context);
        const result = await db<{ gate_key: string }[]>`
          INSERT INTO job_gates (gate_key, job_id, acquired_at, ttl_expires_at, context)
          VALUES (${gateKey}, ${jobId}, NOW(), ${ttlExpiresAt}, ${contextJson}::jsonb)
          ON CONFLICT (gate_key) DO UPDATE
            SET ttl_expires_at = ${ttlExpiresAt},
                context = ${contextJson}::jsonb
            WHERE job_gates.job_id = ${jobId}
          RETURNING gate_key
        `;

        if (result.length > 0) {
          acquired.push(gateKey);
        }
      }

      // Check if we acquired all gates
      if (acquired.length === gateKeys.length) {
        return { success: true, acquired, blocked_by: [] };
      }

      // We didn't get all gates - release what we acquired and return blocked
      if (acquired.length > 0) {
        await this.releaseGates(jobId, acquired);
      }

      // Find what's blocking us now
      const blocking = await db<{ gate_key: string }[]>`
        SELECT gate_key
        FROM job_gates
        WHERE gate_key = ANY(${gateKeys})
          AND job_id != ${jobId}
          AND ttl_expires_at > NOW()
      `;

      return {
        success: false,
        acquired: [],
        blocked_by: blocking.map(g => g.gate_key),
      };
    },

    /**
     * Release gates held by a job
     *
     * @param jobId - Job ID releasing gates
     * @param gateKeys - Optional specific gates to release (all if not specified)
     * @returns Number of gates released
     */
    async releaseGates(jobId: string, gateKeys?: string[]): Promise<number> {
      if (gateKeys && gateKeys.length === 0) {
        return 0;
      }

      let result: { count: number }[];

      if (gateKeys) {
        result = await db<{ count: number }[]>`
          WITH deleted AS (
            DELETE FROM job_gates
            WHERE job_id = ${jobId}
              AND gate_key = ANY(${gateKeys})
            RETURNING gate_key
          )
          SELECT COUNT(*)::int as count FROM deleted
        `;
      } else {
        result = await db<{ count: number }[]>`
          WITH deleted AS (
            DELETE FROM job_gates
            WHERE job_id = ${jobId}
            RETURNING gate_key
          )
          SELECT COUNT(*)::int as count FROM deleted
        `;
      }

      return result[0]?.count ?? 0;
    },

    /**
     * Get all gates held by a job
     *
     * @param jobId - Job ID
     * @returns Array of gate records
     */
    async getGatesForJob(jobId: string): Promise<JobGate[]> {
      return db<JobGate[]>`
        SELECT * FROM job_gates
        WHERE job_id = ${jobId}
        ORDER BY acquired_at ASC
      `;
    },

    /**
     * Check if specific gates are available
     *
     * @param gateKeys - Gate keys to check
     * @param excludeJobId - Optional job ID to exclude (for checking own gates)
     * @returns Map of gate_key -> holder job_id (empty if available)
     */
    async checkGatesAvailable(
      gateKeys: string[],
      excludeJobId?: string,
    ): Promise<Map<string, string>> {
      if (gateKeys.length === 0) {
        return new Map();
      }

      const query = excludeJobId
        ? db<{ gate_key: string; job_id: string }[]>`
            SELECT gate_key, job_id
            FROM job_gates
            WHERE gate_key = ANY(${gateKeys})
              AND job_id != ${excludeJobId}
              AND ttl_expires_at > NOW()
          `
        : db<{ gate_key: string; job_id: string }[]>`
            SELECT gate_key, job_id
            FROM job_gates
            WHERE gate_key = ANY(${gateKeys})
              AND ttl_expires_at > NOW()
          `;

      const held = await query;
      return new Map(held.map(g => [g.gate_key, g.job_id]));
    },

    /**
     * Clean up expired gates
     *
     * @returns Number of gates cleaned up
     */
    async cleanupExpiredGates(): Promise<number> {
      const result = await db<{ count: number }[]>`
        WITH deleted AS (
          DELETE FROM job_gates
          WHERE ttl_expires_at <= NOW()
          RETURNING gate_key
        )
        SELECT COUNT(*)::int as count FROM deleted
      `;

      return result[0]?.count ?? 0;
    },

    /**
     * Refresh TTL on gates held by a job (heartbeat)
     *
     * @param jobId - Job ID
     * @param ttlSeconds - New TTL in seconds
     * @returns Number of gates refreshed
     */
    async refreshGatesTTL(jobId: string, ttlSeconds: number = 1800): Promise<number> {
      const ttlExpiresAt = new Date(Date.now() + ttlSeconds * 1000);

      const result = await db<{ count: number }[]>`
        WITH updated AS (
          UPDATE job_gates
          SET ttl_expires_at = ${ttlExpiresAt}
          WHERE job_id = ${jobId}
          RETURNING gate_key
        )
        SELECT COUNT(*)::int as count FROM updated
      `;

      return result[0]?.count ?? 0;
    },

    /**
     * Update blocked_on_gates for a job
     *
     * @param jobId - Job ID
     * @param blockedOnGates - Array of gate keys blocking the job
     */
    async updateBlockedOnGates(jobId: string, blockedOnGates: string[]): Promise<void> {
      await db`
        UPDATE jobs
        SET blocked_on_gates = ${blockedOnGates},
            updated_at = NOW()
        WHERE id = ${jobId}
      `;
    },

    /**
     * Clear blocked_on_gates for a job
     *
     * @param jobId - Job ID
     */
    async clearBlockedOnGates(jobId: string): Promise<void> {
      await db`
        UPDATE jobs
        SET blocked_on_gates = '{}',
            updated_at = NOW()
        WHERE id = ${jobId}
      `;
    },

    /**
     * Get all jobs blocked on gates
     *
     * @returns Array of jobs with their blocked_on_gates
     */
    async getJobsBlockedOnGates(): Promise<Array<{ id: string; blocked_on_gates: string[] }>> {
      return db<Array<{ id: string; blocked_on_gates: string[] }>>`
        SELECT id, blocked_on_gates
        FROM jobs
        WHERE array_length(blocked_on_gates, 1) > 0
          AND phase IN ('ready', 'active')
      `;
    },
  };
}
