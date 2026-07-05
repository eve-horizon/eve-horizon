import type { Db } from '../../client.js';
import type { Job } from './types.js';

/**
 * Cross-cluster context: `addDependency` resolves `findById` dynamically via
 * `this` on the composed jobQueries object (see ../jobs.ts).
 */
export interface JobLookupContext {
  findById(id: string): Promise<Job | null>;
}

// ============================================================================
// Job Hierarchy + Dependencies
// ============================================================================

export function jobHierarchyQueries(db: Db) {
  return {
    /**
     * Get job hierarchy (parent + children)
     *
     * @param rootId - Root job ID
     * @returns Array of jobs in the hierarchy
     */
    async getHierarchy(rootId: string): Promise<Job[]> {
      return db<Job[]>`
        WITH RECURSIVE job_tree AS (
          -- Start with the root job
          SELECT * FROM jobs WHERE id = ${rootId}

          UNION ALL

          -- Recursively find children
          SELECT j.* FROM jobs j
          INNER JOIN job_tree jt ON j.parent_id = jt.id
        )
        SELECT * FROM job_tree
        ORDER BY depth ASC, created_at ASC
      `;
    },

    /**
     * Get direct children for a job
     *
     * @param jobId - Parent job ID
     * @returns Array of direct child jobs
     */
    async getChildren(jobId: string): Promise<Job[]> {
      return db<Job[]>`
        SELECT * FROM jobs
        WHERE parent_id = ${jobId}
        ORDER BY created_at ASC
      `;
    },

    /**
     * Add a job dependency (relation)
     *
     * Creates a relation where fromId depends on toId (toId blocks fromId)
     * Semantics: "fromId depends on toId" = "toId blocks fromId"
     *
     * @param fromId - Job that has the dependency (the blocked job)
     * @param toId - Job that must complete first (the blocking job)
     * @param relationType - Type of relation (blocks, conditional_blocks, waits_for, related, discovered_from)
     * @returns Created relation ID
     */
    async addDependency(
      this: JobLookupContext,
      fromId: string,
      toId: string,
      relationType: string = 'blocks',
    ): Promise<string> {
      // Validate both jobs exist
      const [fromJob, toJob] = await Promise.all([
        this.findById(fromId),
        this.findById(toId),
      ]);

      if (!fromJob) {
        throw new Error(`Job not found: ${fromId}`);
      }

      if (!toJob) {
        throw new Error(`Job not found: ${toId}`);
      }

      // Insert relation (job_id depends on related_job_id)
      const [result] = await db<[{ id: string }]>`
        INSERT INTO job_relations (job_id, related_job_id, relation_type)
        VALUES (${fromId}, ${toId}, ${relationType})
        ON CONFLICT (job_id, related_job_id, relation_type) DO NOTHING
        RETURNING id
      `;

      return result?.id ?? '';
    },

    /**
     * Remove a job dependency
     *
     * @param fromId - Job that has the dependency
     * @param toId - Job that blocks it
     * @returns True if relation was deleted, false if not found
     */
    async removeDependency(fromId: string, toId: string): Promise<boolean> {
      const result = await db<[{ count: number }]>`
        DELETE FROM job_relations
        WHERE job_id = ${fromId} AND related_job_id = ${toId}
        RETURNING id
      `;

      return result.length > 0;
    },

    /**
     * Get dependencies for a job (jobs this one depends on)
     *
     * Returns jobs that this job depends on (i.e., jobs that block this one)
     *
     * @param jobId - Job ID
     * @returns Array of jobs with relation metadata
     */
    async getDependencies(jobId: string): Promise<Array<Job & { relation_type: string }>> {
      return db<Array<Job & { relation_type: string }>>`
        SELECT j.*, r.relation_type
        FROM job_relations r
        JOIN jobs j ON j.id = r.related_job_id
        WHERE r.job_id = ${jobId}
        ORDER BY j.phase DESC, j.priority ASC
      `;
    },

    /**
     * Get dependents for a job (jobs that depend on this one)
     *
     * Returns jobs that depend on this job (i.e., jobs this one blocks)
     *
     * @param jobId - Job ID
     * @returns Array of jobs with relation metadata
     */
    async getDependents(jobId: string): Promise<Array<Job & { relation_type: string }>> {
      return db<Array<Job & { relation_type: string }>>`
        SELECT j.*, r.relation_type
        FROM job_relations r
        JOIN jobs j ON j.id = r.job_id
        WHERE r.related_job_id = ${jobId}
        ORDER BY j.phase DESC, j.priority ASC
      `;
    },

    /**
     * Get OPEN jobs currently blocking this job
     *
     * Returns only jobs that are NOT done and have a blocking relation type
     *
     * @param jobId - Job ID to check
     * @returns Array of blocking jobs that are still open
     */
    async getBlockingJobs(jobId: string): Promise<Array<Job & { relation_type: string }>> {
      return db<Array<Job & { relation_type: string }>>`
        SELECT j.*, r.relation_type
        FROM job_relations r
        JOIN jobs j ON j.id = r.related_job_id
        WHERE r.job_id = ${jobId}
          AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
          AND j.phase NOT IN ('done', 'cancelled')
        ORDER BY j.priority ASC, j.created_at ASC
      `;
    },
  };
}
