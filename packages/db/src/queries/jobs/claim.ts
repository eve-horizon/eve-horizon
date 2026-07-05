import type { Db } from '../../client.js';
import type { ClaimResult, Job, JobAttempt, ReleaseResult } from './types.js';

// ============================================================================
// Claim / Release
// ============================================================================

export function jobClaimQueries(db: Db) {
  return {
    /**
     * Claim a job by creating an attempt and transitioning to active phase
     *
     * Process:
     * 1. Check job exists and is in 'ready' phase
     * 2. Get next attempt number
     * 3. Insert attempt with status='running'
     * 4. Update job phase to 'active' and set assignee
     * 5. Audit log both operations
     * 6. Return the attempt
     *
     * @param jobId - Job ID to claim
     * @param agentId - Agent identifier claiming the job
     * @param harness - Optional harness name (e.g., 'mclaude')
     * @returns Result with attempt or error
     */
    async claim(
      jobId: string,
      agentId: string,
      harness?: string,
    ): Promise<ClaimResult> {
      // 1. Check job exists
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        return {
          success: false,
          error: `Job not found: ${jobId}`,
        };
      }

      // Claim normally requires a job to be in 'ready', but review rejection creates a
      // pending auto_retry attempt while leaving the job in 'active'. In that case we
      // "claim" by starting the pending attempt rather than inserting a new one.
      if (currentJob.phase !== 'ready' && currentJob.phase !== 'active') {
        return {
          success: false,
          error: `Job must be in 'ready' or 'active' phase to claim (current: ${currentJob.phase})`,
        };
      }

      const [pendingAttempt] = await db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
          AND status = 'pending'
        ORDER BY attempt_number DESC
        LIMIT 1
      `;

      if (pendingAttempt) {
        // Start the pending attempt (idempotent-ish: guarded by status='pending').
        const [attempt] = await db<JobAttempt[]>`
          UPDATE job_attempts
          SET
            status = 'running',
            harness = COALESCE(${harness ?? null}, harness),
            agent_id = ${agentId},
            started_at = NOW(),
            harness_profile_source = COALESCE(harness_profile_source, ${currentJob.harness_profile_source}),
            harness_profile_hash = COALESCE(harness_profile_hash, ${currentJob.harness_profile_hash}),
            runtime_meta = COALESCE(runtime_meta, '{}'::jsonb)
          WHERE id = ${pendingAttempt.id}::uuid
            AND status = 'pending'
          RETURNING *
        `;

        if (!attempt) {
          return {
            success: false,
            error: `Pending attempt was already claimed for job: ${jobId}`,
          };
        }

        // Ensure the job is marked active and assigned.
        await db`
          UPDATE jobs
          SET
            phase = 'active',
            assignee = ${agentId},
            updated_at = NOW()
          WHERE id = ${jobId}
        `;

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
              phase: { old: currentJob.phase, new: 'active' },
              assignee: { old: currentJob.assignee, new: agentId },
            })},
            ${db.json({ claim_attempt: attempt.id, claim_mode: 'pending_attempt' })}
          )
        `;

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
            'job_attempt',
            ${attempt.id},
            'updated',
            ${agentId},
            'agent',
            ${db.json({
              status: { old: 'pending', new: 'running' },
              agent_id: { old: pendingAttempt.agent_id, new: agentId },
              harness: { old: pendingAttempt.harness, new: harness ?? pendingAttempt.harness },
            })},
            ${db.json({ job_id: jobId })}
          )
        `;

        return {
          success: true,
          attempt,
        };
      }

      if (currentJob.phase !== 'ready') {
        return {
          success: false,
          error: `Job must be in 'ready' phase to claim (current: ${currentJob.phase})`,
        };
      }

      // 2. Get next attempt number
      const [countResult] = await db<[{ count: number }]>`
        SELECT COUNT(*)::int as count
        FROM job_attempts
        WHERE job_id = ${jobId}
      `;
      const nextAttemptNumber = (countResult?.count ?? 0) + 1;

      // 3. Insert attempt with status='running'
      const [attempt] = await db<JobAttempt[]>`
        INSERT INTO job_attempts (
          job_id,
          attempt_number,
          status,
          trigger_type,
          harness,
          agent_id,
          started_at,
          harness_profile_source,
          harness_profile_hash,
          runtime_meta
        )
        VALUES (
          ${jobId},
          ${nextAttemptNumber},
          'running',
          'manual',
          ${harness ?? null},
          ${agentId},
          NOW(),
          ${currentJob.harness_profile_source},
          ${currentJob.harness_profile_hash},
          ${db.json({})}
        )
        RETURNING *
      `;

      // 4. Update job phase to 'active' and set assignee
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'active',
          assignee = ${agentId},
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 5. Audit log both operations
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
            phase: { old: currentJob.phase, new: 'active' },
            assignee: { old: currentJob.assignee, new: agentId },
          })},
          ${db.json({ claim_attempt: attempt.id })}
        )
      `;

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
          'job_attempt',
          ${attempt.id},
          'created',
          ${agentId},
          'agent',
          ${db.json({
            attempt_number: { old: null, new: nextAttemptNumber },
            status: { old: null, new: 'running' },
          })},
          ${db.json({ job_id: jobId })}
        )
      `;

      return {
        success: true,
        attempt,
      };
    },

    /**
     * Release a job by ending the current attempt and setting back to ready
     *
     * Process:
     * 1. Check job exists and is in 'active' phase
     * 2. Get current running attempt
     * 3. End the attempt (set ended_at, status='cancelled')
     * 4. Update job phase to 'ready' and clear assignee
     * 5. Audit log both operations
     * 6. Return the updated job
     *
     * @param jobId - Job ID to release
     * @param agentId - Agent identifier releasing the job
     * @param reason - Optional reason for release
     * @returns Result with job or error
     */
    async release(
      jobId: string,
      agentId: string,
      reason?: string,
    ): Promise<ReleaseResult> {
      // 1. Check job exists and is in 'active' phase
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        return {
          success: false,
          error: `Job not found: ${jobId}`,
        };
      }

      if (currentJob.phase !== 'active') {
        return {
          success: false,
          error: `Job must be in 'active' phase to release (current: ${currentJob.phase})`,
        };
      }

      // 2. Get current running attempt
      const [currentAttempt] = await db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
          AND status = 'running'
        ORDER BY attempt_number DESC
        LIMIT 1
      `;

      if (!currentAttempt) {
        // Idempotent fallback: if the active attempt was already finalized by
        // another path, still requeue the job to ready.
        const [requeuedJob] = await db<Job[]>`
          UPDATE jobs
          SET
            phase = 'ready',
            ready_at = NOW(),
            assignee = NULL,
            updated_at = NOW()
          WHERE id = ${jobId}
            AND phase = 'active'
          RETURNING *
        `;

        if (requeuedJob) {
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
                phase: { old: 'active', new: 'ready' },
                assignee: { old: currentJob.assignee, new: null },
              })},
              ${db.json({ reason: reason ?? 'Job released by agent', release_mode: 'no_running_attempt' })}
            )
          `;

          return {
            success: true,
            job: requeuedJob,
          };
        }

        return {
          success: false,
          error: `No running attempt found for job: ${jobId}`,
        };
      }

      // 3. End the attempt
      const [endedAttempt] = await db<JobAttempt[]>`
        UPDATE job_attempts
        SET
          status = 'cancelled',
          ended_at = NOW(),
          result_summary = ${reason ?? 'Job released by agent'}
        WHERE id = ${currentAttempt.id}
        RETURNING *
      `;

      // 4. Update job phase to 'ready' and clear assignee
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'ready',
          ready_at = NOW(),
          assignee = NULL,
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 5. Audit log both operations
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
          'job_attempt',
          ${endedAttempt.id},
          'updated',
          ${agentId},
          'agent',
          ${db.json({
            status: { old: 'running', new: 'cancelled' },
            ended_at: { old: null, new: endedAttempt.ended_at },
          })},
          ${db.json({ job_id: jobId, reason })}
        )
      `;

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
            phase: { old: 'active', new: 'ready' },
            assignee: { old: currentJob.assignee, new: null },
          })},
          ${db.json({ release_attempt: endedAttempt.id })}
        )
      `;

      return {
        success: true,
        job: updatedJob,
      };
    },
  };
}
