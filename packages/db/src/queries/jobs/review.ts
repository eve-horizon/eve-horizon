import type { Db } from '../../client.js';
import type { Job, JobAttempt, UpdatePhaseResult } from './types.js';

/**
 * Cross-cluster context: `markJobDone`/`cancelJob`/`markJobFailed` resolve
 * `findById`, `updatePhase`, `getCurrentAttempt`, and `submitForReview`
 * dynamically via `this` on the composed jobQueries object (see ../jobs.ts).
 */
export interface JobLifecycleContext {
  findById(id: string): Promise<Job | null>;
  updatePhase(jobId: string, newPhase: Job['phase'], actor?: string): Promise<UpdatePhaseResult>;
  getCurrentAttempt(jobId: string): Promise<JobAttempt | null>;
  submitForReview(jobId: string, agentId: string, summary: string): Promise<Job>;
}

// ============================================================================
// Review Workflow + Terminal Lifecycle
// ============================================================================

export function jobReviewQueries(db: Db) {
  return {
    /**
     * Submit a job for review
     *
     * Validates job is in 'active' phase, ends current attempt as completed,
     * and transitions job to 'review' phase.
     *
     * @param jobId - Job ID
     * @param agentId - Agent identifier submitting the review
     * @param summary - Summary of work completed
     * @returns Updated job
     */
    async submitForReview(
      jobId: string,
      agentId: string,
      summary: string,
    ): Promise<Job> {
      // 1. Validate job is in 'active' phase
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (currentJob.phase !== 'active') {
        throw new Error(
          `Cannot submit for review. Job must be in 'active' phase, currently: ${currentJob.phase}`,
        );
      }

      // 2. Find current active attempt (may already be 'succeeded' if completion event fired first)
      const [activeAttempt] = await db<{ id: string; attempt_number: number; status: string }[]>`
        SELECT id, attempt_number, status FROM job_attempts
        WHERE job_id = ${jobId} AND status IN ('running', 'succeeded')
        ORDER BY attempt_number DESC
        LIMIT 1
      `;

      if (!activeAttempt) {
        throw new Error(`No active attempt found for job: ${jobId}`);
      }

      // End the attempt
      await db`
        UPDATE job_attempts
        SET
          status = 'succeeded',
          ended_at = NOW(),
          result_summary = ${summary}
        WHERE id = ${activeAttempt.id}
      `;

      // 3. Update job phase to 'review'
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'review',
          review_status = 'pending',
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 4. Audit log the submission
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
          ${agentId},
          'agent',
          ${db.json({
            phase: { old: 'active', new: 'review' },
            review_status: { old: currentJob.review_status, new: 'pending' },
          })},
          ${db.json({
            action: 'submit_for_review',
            attempt_id: activeAttempt.id,
            summary,
          })}
        )
      `;

      return updatedJob;
    },

    /**
     * Approve a job in review
     *
     * Validates job is in 'review' phase and transitions to 'done' phase.
     *
     * @param jobId - Job ID
     * @param reviewerId - Reviewer identifier
     * @param comment - Optional approval comment
     * @returns Updated job
     */
    async approveReview(
      jobId: string,
      reviewerId: string,
      comment?: string,
    ): Promise<Job> {
      // 1. Validate job is in 'review' phase
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (currentJob.phase !== 'review') {
        throw new Error(
          `Cannot approve. Job must be in 'review' phase, currently: ${currentJob.phase}`,
        );
      }

      // 2. Update job to done with review metadata
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'done',
          review_status = 'approved',
          reviewer = ${reviewerId},
          closed_at = NOW(),
          close_reason = ${comment ?? 'Review approved'},
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 3. Audit log the approval
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
          ${reviewerId},
          'user',
          ${db.json({
            phase: { old: 'review', new: 'done' },
            review_status: { old: 'pending', new: 'approved' },
            reviewer: { old: currentJob.reviewer, new: reviewerId },
          })},
          ${db.json({
            action: 'approve_review',
            comment: comment ?? '',
          })}
        )
      `;

      return updatedJob;
    },

    /**
     * Reject a job in review
     *
     * Validates job is in 'review' phase, transitions back to 'active' phase,
     * and creates a new attempt automatically.
     *
     * @param jobId - Job ID
     * @param reviewerId - Reviewer identifier
     * @param reason - Rejection reason
     * @returns Updated job
     */
    async rejectReview(
      jobId: string,
      reviewerId: string,
      reason: string,
    ): Promise<Job> {
      // 1. Validate job is in 'review' phase
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (currentJob.phase !== 'review') {
        throw new Error(
          `Cannot reject. Job must be in 'review' phase, currently: ${currentJob.phase}`,
        );
      }

      // 2. Update job back to active with rejection metadata
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'active',
          review_status = 'rejected',
          reviewer = ${reviewerId},
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 3. Create new attempt for retry
      const [nextAttemptNum] = await db<{ next_num: number }[]>`
        SELECT COALESCE(MAX(attempt_number), 0) + 1 as next_num
        FROM job_attempts
        WHERE job_id = ${jobId}
      `;

      await db`
        INSERT INTO job_attempts (
          job_id,
          attempt_number,
          status,
          trigger_type,
          harness_profile_source,
          harness_profile_hash,
          result_summary
        )
        VALUES (
          ${jobId},
          ${nextAttemptNum.next_num},
          'pending',
          'auto_retry',
          ${currentJob.harness_profile_source},
          ${currentJob.harness_profile_hash},
          ${`Retry after rejection: ${reason}`}
        )
      `;

      // 4. Audit log the rejection
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
          ${reviewerId},
          'user',
          ${db.json({
            phase: { old: 'review', new: 'active' },
            review_status: { old: 'pending', new: 'rejected' },
            reviewer: { old: currentJob.reviewer, new: reviewerId },
          })},
          ${db.json({
            action: 'reject_review',
            reason,
            new_attempt_number: nextAttemptNum.next_num,
          })}
        )
      `;

      return updatedJob;
    },

    /**
     * Mark a job as done (convenience method for orchestrator)
     *
     * For jobs without review_required, this transitions directly to 'done'.
     * For jobs with review_required, use submitForReview instead.
     *
     * @param jobId - Job ID
     * @param summary - Optional summary of work completed
     * @returns Updated job or null if transition not allowed
     */
    async markJobDone(this: JobLifecycleContext, jobId: string, summary?: string): Promise<Job | null> {
      const job = await this.findById(jobId);
      if (!job) return null;
      if (job.phase === 'done' || job.phase === 'cancelled') return job;

      // If job requires review, use the review flow
      if (job.review_required !== 'none') {
        if (job.phase === 'active') {
          await this.submitForReview(jobId, job.assignee ?? 'orchestrator', summary ?? 'Completed');
        }
        return this.findById(jobId);
      }

      // Direct transition to done
      const result = await this.updatePhase(jobId, 'done', job.assignee ?? 'orchestrator');
      return result.job ?? null;
    },

    /**
     * Cancel a job and end any running attempt.
     *
     * @param jobId - Job ID
     * @param reason - Optional cancellation reason
     * @returns Updated job or null if not found
     */
    async cancelJob(this: JobLifecycleContext, jobId: string, reason?: string): Promise<Job | null> {
      const job = await this.findById(jobId);
      if (!job) return null;
      if (job.phase === 'cancelled' || job.phase === 'done') return job;

      const currentAttempt = await this.getCurrentAttempt(jobId);
      if (currentAttempt) {
        await db<JobAttempt[]>`
          UPDATE job_attempts
          SET
            status = 'cancelled',
            ended_at = NOW(),
            result_summary = ${reason ?? 'Job cancelled'}
          WHERE id = ${currentAttempt.id}
          RETURNING *
        `;
      }

      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'cancelled',
          closed_at = NOW(),
          close_reason = ${reason ?? 'Job cancelled'},
          failure_disposition = 'cancelled',
          updated_at = NOW()
        WHERE id = ${jobId}
          AND phase NOT IN ('done', 'cancelled')
        RETURNING *
      `;

      // Ensure cancellations never leave stale gate locks behind.
      await db`DELETE FROM job_gates WHERE job_id = ${jobId}`;
      await db`
        UPDATE jobs
        SET blocked_on_gates = '{}', updated_at = NOW()
        WHERE id = ${jobId}
      `;

      // Cancel backlog children (staged dispatch members that were never promoted)
      if (updatedJob) {
        const backlogCancelled = await db<{ id: string }[]>`
          UPDATE jobs
          SET
            phase = 'cancelled',
            closed_at = NOW(),
            close_reason = ${'Parent job ' + jobId + ' cancelled'},
            failure_disposition = 'cancelled',
            updated_at = NOW()
          WHERE parent_id = ${jobId}
            AND phase = 'backlog'
          RETURNING id
        `;
        if (backlogCancelled.length > 0) {
          console.log(
            `Cancelled ${backlogCancelled.length} backlog child(ren) for ${jobId}: ${backlogCancelled.map(j => j.id).join(', ')}`,
          );
        }
      }

      return updatedJob ?? null;
    },

    /**
     * Mark a job as failed (convenience method for orchestrator)
     *
     * Transitions job to 'cancelled' phase with an error reason.
     * Also ends any running attempt.
     *
     * @param jobId - Job ID
     * @param reason - Failure reason
     * @returns Updated job or null if not found
     */
    async markJobFailed(this: JobLifecycleContext, jobId: string, reason?: string): Promise<Job | null> {
      const job = await this.findById(jobId);
      if (!job) return null;
      if (job.phase === 'done' || job.phase === 'cancelled') return job;

      // End any running attempt
      const currentAttempt = await this.getCurrentAttempt(jobId);
      if (currentAttempt) {
        await db<JobAttempt[]>`
          UPDATE job_attempts
          SET
            status = 'failed',
            ended_at = NOW(),
            result_summary = ${reason ?? 'Job failed'}
          WHERE id = ${currentAttempt.id}
          RETURNING *
        `;
      }

      // Transition to cancelled
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'cancelled',
          closed_at = NOW(),
          close_reason = ${reason ?? 'Job failed'},
          failure_disposition = 'failed',
          updated_at = NOW()
        WHERE id = ${jobId}
          AND phase NOT IN ('done', 'cancelled')
        RETURNING *
      `;

      await db`DELETE FROM job_gates WHERE job_id = ${jobId}`;
      await db`
        UPDATE jobs
        SET blocked_on_gates = '{}', updated_at = NOW()
        WHERE id = ${jobId}
      `;

      // Cascade-cancel downstream jobs that transitively depend on this one.
      // Uses a recursive CTE to walk the dependency graph in a single query,
      // preventing orphaned jobs from accumulating in 'ready' phase.
      if (updatedJob) {
        const cascadeReason = `Upstream job ${jobId} failed`;
        const cancelled = await db<{ id: string }[]>`
          WITH RECURSIVE downstream AS (
            SELECT r.job_id AS id
            FROM job_relations r
            WHERE r.related_job_id = ${jobId}
              AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
            UNION
            SELECT r.job_id AS id
            FROM job_relations r
            JOIN downstream d ON r.related_job_id = d.id
            WHERE r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
          )
          UPDATE jobs
          SET
            phase = 'cancelled',
            closed_at = NOW(),
            close_reason = ${cascadeReason},
            failure_disposition = 'upstream_failed',
            updated_at = NOW()
          WHERE id IN (SELECT id FROM downstream)
            AND phase NOT IN ('done', 'cancelled')
          RETURNING id
        `;

        if (cancelled.length > 0) {
          const cancelledIds = cancelled.map((row) => row.id);
          await db`DELETE FROM job_gates WHERE job_id = ANY(${cancelledIds})`;
          await db`
            UPDATE jobs
            SET blocked_on_gates = '{}', updated_at = NOW()
            WHERE id = ANY(${cancelledIds})
          `;
        }

        if (cancelled.length > 0) {
          console.log(
            `Cascade-cancelled ${cancelled.length} downstream job(s) for ${jobId}: ${cancelled.map(j => j.id).join(', ')}`,
          );
        }
      }

      // Cancel backlog children (staged dispatch members that were never promoted)
      if (updatedJob) {
        const backlogCancelled = await db<{ id: string }[]>`
          UPDATE jobs
          SET
            phase = 'cancelled',
            closed_at = NOW(),
            close_reason = ${'Parent job ' + jobId + ' failed'},
            failure_disposition = 'upstream_failed',
            updated_at = NOW()
          WHERE parent_id = ${jobId}
            AND phase = 'backlog'
          RETURNING id
        `;
        if (backlogCancelled.length > 0) {
          console.log(
            `Cancelled ${backlogCancelled.length} backlog child(ren) for ${jobId}: ${backlogCancelled.map(j => j.id).join(', ')}`,
          );
        }
      }

      return updatedJob ?? null;
    },

    /**
     * Get review history for a job
     *
     * Returns all review submissions and decisions for the job.
     *
     * @param jobId - Job ID
     * @returns Array of review-related audit entries
     */
    async getReviewHistory(jobId: string): Promise<
      Array<{
        action: string;
        actor: string | null;
        actor_type: string;
        changes: Record<string, { old: unknown; new: unknown }>;
        context: Record<string, unknown>;
        created_at: Date;
      }>
    > {
      return db<
        Array<{
          action: string;
          actor: string | null;
          actor_type: string;
          changes: Record<string, { old: unknown; new: unknown }>;
          context: Record<string, unknown>;
          created_at: Date;
        }>
      >`
        SELECT
          action,
          actor,
          actor_type,
          changes,
          context,
          created_at
        FROM audit_log
        WHERE entity_type = 'job'
          AND entity_id = ${jobId}
          AND (
            changes ? 'phase'
            AND (
              changes->'phase'->>'new' IN ('review', 'done', 'active')
              OR changes->'phase'->>'old' IN ('review')
            )
          )
        ORDER BY created_at ASC
      `;
    },
  };
}
