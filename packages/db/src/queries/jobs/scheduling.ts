import type { Db } from '../../client.js';
import type { ClaimResult, GetReadyJobsOptions, Job, JobAttempt, RequeueReadyOptions } from './types.js';

/**
 * Cross-cluster context: `claimNextJob`/`claimNextAssignedJob` resolve
 * `findById` and `claim` dynamically via `this` on the composed jobQueries
 * object (see ../jobs.ts).
 */
export interface ClaimSchedulingContext {
  findById(id: string): Promise<Job | null>;
  getReadyJobs(projectId: string, options?: GetReadyJobsOptions): Promise<Job[]>;
  getReadyAssignedJobs(projectId: string, options?: { limit?: number }): Promise<Job[]>;
  claim(jobId: string, agentId: string, harness?: string): Promise<ClaimResult>;
}

// ============================================================================
// Scheduling (ready-job queries, requeue, claim-next wrappers)
// ============================================================================

export function jobSchedulingQueries(db: Db) {
  return {
    /**
     * Get ready jobs for a project (scheduler query)
     *
     * Returns jobs that are schedulable (ready or active phase, not blocked, not deferred)
     * Per Part D of jobs-unified-design.md
     *
     * @param projectId - Project TypeID (proj_xxx)
     * @param options - Optional filters (assignee, limit)
     * @returns Array of ready jobs with project_slug
     */
    async getReadyJobs(
      projectId: string,
      options?: GetReadyJobsOptions,
    ): Promise<Job[]> {
      const assignee = options?.assignee ?? null;
      const limit = options?.limit ?? 10;

      // If assignee is explicitly null, only return unassigned jobs
      if (assignee === null) {
        return db<Job[]>`
          SELECT j.*, p.slug as project_slug
          FROM jobs j
          JOIN projects p ON p.id = j.project_id
          WHERE (${projectId} = '' OR j.project_id = ${projectId})
            AND j.phase IN ('ready', 'active')
            AND j.assignee IS NULL
            AND (j.defer_until IS NULL OR j.defer_until <= NOW())
            AND NOT EXISTS (
              SELECT 1 FROM job_relations r
              JOIN jobs blocker ON blocker.id = r.related_job_id
              WHERE r.job_id = j.id
                AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
                AND blocker.phase NOT IN ('done', 'cancelled')
            )
          ORDER BY j.priority ASC, j.created_at ASC
          LIMIT ${limit}
        `;
      }

      // Filter by specific assignee
      return db<Job[]>`
        SELECT j.*, p.slug as project_slug
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        WHERE (${projectId} = '' OR j.project_id = ${projectId})
          AND j.phase IN ('ready', 'active')
          AND j.assignee = ${assignee}
          AND (j.defer_until IS NULL OR j.defer_until <= NOW())
          AND NOT EXISTS (
            SELECT 1 FROM job_relations r
            JOIN jobs blocker ON blocker.id = r.related_job_id
            WHERE r.job_id = j.id
              AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
              AND blocker.phase NOT IN ('done', 'cancelled')
          )
        ORDER BY j.priority ASC, j.created_at ASC
        LIMIT ${limit}
      `;
    },

    /**
     * Get ready jobs that are already assigned (agent-assigned workload).
     *
     * Returns jobs that are schedulable, assigned, and agent execution type.
     * Used by schedulers that should claim agent-assigned chat/agent jobs.
     */
    async getReadyAssignedJobs(
      projectId: string,
      options?: { limit?: number },
    ): Promise<Job[]> {
      const limit = options?.limit ?? 10;

      return db<Job[]>`
        SELECT j.*, p.slug as project_slug
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        WHERE (${projectId} = '' OR j.project_id = ${projectId})
          AND j.phase IN ('ready', 'active')
          AND j.assignee IS NOT NULL
          AND j.execution_type = 'agent'
          AND (j.defer_until IS NULL OR j.defer_until <= NOW())
          AND NOT EXISTS (
            SELECT 1 FROM job_relations r
            JOIN jobs blocker ON blocker.id = r.related_job_id
            WHERE r.job_id = j.id
              AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
              AND blocker.phase NOT IN ('done', 'cancelled')
          )
        ORDER BY j.priority ASC, j.created_at ASC
        LIMIT ${limit}
      `;
    },

    /**
     * Get all blocked jobs for a project
     *
     * Returns jobs that are in ready/active phase but have open blocking dependencies
     * Per Part D of jobs-unified-design.md
     *
     * @param projectId - Project TypeID (proj_xxx)
     * @returns Array of blocked jobs with project_slug
     */
    async getBlockedJobs(projectId: string): Promise<Job[]> {
      return db<Job[]>`
        SELECT DISTINCT j.*, p.slug as project_slug
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        JOIN job_relations r ON r.job_id = j.id
        JOIN jobs blocker ON blocker.id = r.related_job_id
        WHERE j.project_id = ${projectId}
          AND j.phase IN ('ready', 'active')
          AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
          AND blocker.phase NOT IN ('done', 'cancelled')
        ORDER BY j.priority ASC, j.created_at ASC
      `;
    },

    /**
     * Requeue a job back to ready without cancelling the current attempt.
     *
     * Used when a completed attempt needs to wait on dependencies or
     * re-enter the scheduler without changing attempt history.
     *
     * @param jobId - Job ID to requeue
     * @param actor - Actor identifier performing the requeue
     * @param options - Optional defer/backoff and reason
     * @returns Updated job or null if not found
     */
    async requeueReady(
      jobId: string,
      actor: string,
      options?: RequeueReadyOptions,
    ): Promise<Job | null> {
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        return null;
      }

      const hasDeferUntil = Object.prototype.hasOwnProperty.call(options ?? {}, 'deferUntil');
      const deferUntil = options?.deferUntil ?? null;

      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'ready',
          ready_at = NOW(),
          assignee = NULL,
          updated_at = NOW()
          ${hasDeferUntil ? db`, defer_until = ${deferUntil}` : db``}
        WHERE id = ${jobId}
        RETURNING *
      `;

      const changes: Record<string, { old: unknown; new: unknown }> = {
        phase: { old: currentJob.phase, new: 'ready' },
        assignee: { old: currentJob.assignee, new: null },
      };

      if (hasDeferUntil) {
        changes.defer_until = { old: currentJob.defer_until, new: deferUntil };
      }

      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job',
          ${jobId},
          'updated',
          ${actor},
          'agent',
          ${db.json(changes as never)},
          ${db.json({ reason: options?.reason ?? null })}
        )
      `;

      return updatedJob ?? null;
    },

    /**
     * Claim the next available ready job for execution (scheduler pattern)
     *
     * Atomically selects and claims a ready job in a single transaction.
     * This is a convenience method for orchestrators that want to claim any available job.
     *
     * @param projectId - Optional project ID to filter jobs
     * @param agentId - Agent identifier claiming the job (defaults to 'orchestrator')
     * @param harness - Optional harness name
     * @returns Claimed job and attempt, or null if no jobs available
     */
    async claimNextJob(
      this: ClaimSchedulingContext,
      projectId?: string,
      agentId: string = 'orchestrator',
      harness?: string,
    ): Promise<{ job: Job; attempt: JobAttempt } | null> {
      // Find next ready job
      const readyJobs = await this.getReadyJobs(
        projectId ?? '',
        { limit: 1 },
      );

      if (readyJobs.length === 0) {
        return null;
      }

      const job = readyJobs[0];

      // Claim it - use job's harness if no harness specified
      const hintHarness = typeof job.hints?.harness === 'string' ? job.hints.harness : undefined;
      const effectiveHarness = harness ?? job.harness ?? hintHarness ?? undefined;
      const result = await this.claim(job.id, agentId, effectiveHarness);

      if (!result.success || !result.attempt) {
        // Job may have been claimed by another worker
        return null;
      }

      // Refetch job to get updated state
      const updatedJob = await this.findById(job.id);
      if (!updatedJob) {
        return null;
      }

      return { job: updatedJob, attempt: result.attempt };
    },

    /**
     * Claim the next available ready job that is already assigned.
     *
     * Uses the existing assignee as the claiming agent so the assignment remains stable.
     */
    async claimNextAssignedJob(
      this: ClaimSchedulingContext,
      projectId?: string,
    ): Promise<{ job: Job; attempt: JobAttempt } | null> {
      const readyJobs = await this.getReadyAssignedJobs(
        projectId ?? '',
        { limit: 1 },
      );

      if (readyJobs.length === 0) {
        return null;
      }

      const job = readyJobs[0];
      const agentId = job.assignee ?? 'orchestrator';

      const hintHarness = typeof job.hints?.harness === 'string' ? job.hints.harness : undefined;
      const effectiveHarness = job.harness ?? hintHarness ?? undefined;
      const result = await this.claim(job.id, agentId, effectiveHarness);

      if (!result.success || !result.attempt) {
        return null;
      }

      const updatedJob = await this.findById(job.id);
      if (!updatedJob) {
        return null;
      }

      return { job: updatedJob, attempt: result.attempt };
    },
  };
}
