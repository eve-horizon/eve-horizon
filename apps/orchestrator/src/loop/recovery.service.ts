import { Logger } from '@nestjs/common';
import {
  gateQueries,
  jobQueries,
  type Db,
} from '@eve/db';
import type { ConcurrencyLimiter } from './concurrency-limiter';

export function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type RunningAttemptHealth = {
  stale: boolean;
  reason?: string;
  errorCode?: WatchdogAttemptErrorCode;
};

type WatchdogAttemptErrorCode =
  | 'attempt_timeout'
  | 'attempt_stale'
  | 'attempt_init_timeout'
  | 'attempt_startup_timeout';

type RunningAttemptWatchdogCandidate = {
  attempt_id: string;
  job_id: string;
  started_at: Date;
  execution_started_at?: Date | null;
  project_id: string;
  run_id: string | null;
  step_name: string | null;
  execution_type: string | null;
  action_type: string | null;
  hints: Record<string, unknown> | null;
  parent_id: string | null;
};

export function evaluateRunningAttemptHealth(params: {
  startedAt: Date;
  lastLogAt: Date;
  timeoutSeconds: number;
  timeoutGraceSeconds: number;
  staleRunningSeconds: number;
  staleIdleSeconds: number;
  now?: Date;
}): RunningAttemptHealth {
  const now = params.now ?? new Date();
  const elapsedSeconds = Math.floor((now.getTime() - params.startedAt.getTime()) / 1000);
  const idleSeconds = Math.floor((now.getTime() - params.lastLogAt.getTime()) / 1000);
  const timeoutLimit = Math.max(1, params.timeoutSeconds) + Math.max(0, params.timeoutGraceSeconds);

  if (elapsedSeconds >= timeoutLimit) {
    return {
      stale: true,
      reason: `Attempt timed out (${elapsedSeconds}s >= ${timeoutLimit}s)`,
      errorCode: 'attempt_timeout',
    };
  }

  if (
    params.staleRunningSeconds > 0
    && elapsedSeconds >= params.staleRunningSeconds
    && idleSeconds >= Math.max(1, params.staleIdleSeconds)
  ) {
    return {
      stale: true,
      reason: `Attempt made no progress for ${idleSeconds}s after ${elapsedSeconds}s runtime`,
      errorCode: 'attempt_stale',
    };
  }

  return { stale: false };
}

export function evaluateAttemptInitHealth(params: {
  startedAt: Date;
  initTimeoutSeconds: number;
  now?: Date;
}): RunningAttemptHealth {
  const now = params.now ?? new Date();
  const elapsedSeconds = Math.floor((now.getTime() - params.startedAt.getTime()) / 1000);
  const timeoutLimit = Math.max(1, params.initTimeoutSeconds);

  if (elapsedSeconds >= timeoutLimit) {
    return {
      stale: true,
      reason: `Attempt did not reach runtime acceptance within ${timeoutLimit}s of claim (${elapsedSeconds}s elapsed)`,
      errorCode: 'attempt_init_timeout',
    };
  }

  return { stale: false };
}

export function evaluateAttemptStartupHealth(params: {
  executionStartedAt: Date;
  startupTimeoutSeconds: number;
  now?: Date;
}): RunningAttemptHealth {
  const now = params.now ?? new Date();
  const elapsedSeconds = Math.floor((now.getTime() - params.executionStartedAt.getTime()) / 1000);
  const timeoutLimit = Math.max(1, params.startupTimeoutSeconds);

  if (elapsedSeconds >= timeoutLimit) {
    return {
      stale: true,
      reason: `Attempt did not start the harness within ${timeoutLimit}s of runtime acceptance (${elapsedSeconds}s elapsed)`,
      errorCode: 'attempt_startup_timeout',
    };
  }

  return { stale: false };
}

/**
 * Watchdog/recovery sweeps extracted from LoopService (refactor batch R-C2a).
 *
 * Plain class (not a Nest provider) constructed by LoopService. Constructor
 * parameters mirror the LoopService member names the method bodies reference
 * (`db`, `inFlightJobs`, `limiter`, ...) so the bodies moved verbatim.
 */
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  constructor(
    private readonly db: Db,
    private readonly inFlightJobs: Map<string, number>,
    private readonly limiter: ConcurrencyLimiter,
    private readonly emitJobFailureEvent: (
      job: {
        id: string;
        project_id: string;
        run_id: string | null;
        step_name: string | null;
        execution_type: string | null;
        action_type: string | null;
        hints?: Record<string, unknown> | null;
      },
      attempt: { id: string },
      details: { errorMessage: string; errorCode: string; exitCode?: number | null },
    ) => Promise<void>,
    private readonly tryCloseWorkflowRoot: (parentId: string) => Promise<void>,
    private readonly syncIngestRecordStatus: (
      job: { id: string; hints?: Record<string, unknown> | null },
      succeeded: boolean,
      errorMessage?: string | null,
    ) => Promise<void>,
  ) {}

  /**
   * Recover jobs that were being processed when the orchestrator last restarted.
   *
   * When the orchestrator restarts (crash, deploy, manual), any jobs it was
   * processing become orphaned - they're assigned to 'orchestrator' with running
   * attempts, but no one is actually processing them.
   *
   * This method finds those orphaned jobs and resets them so they can be
   * reclaimed and retried.
   */
  async recoverOrphanedJobs() {
    const jobs = jobQueries(this.db);
    const gates = gateQueries(this.db);
    const staleMinutes = parseInt(process.env.EVE_ORCH_ATTEMPT_STALE_MINUTES ?? '5', 10);
    const staleCutoff = new Date(Date.now() - Math.max(1, staleMinutes) * 60 * 1000);

    // Find any active jobs with running attempts that may be orphaned
    // (regardless of assignee — agent-assigned jobs can also become zombies)
    const orphanedJobs = await this.db<{ id: string; phase: string }[]>`
      SELECT id, phase FROM jobs
      WHERE phase = 'active'
        AND (hints->>'supervising')::boolean IS NOT TRUE
    `;

    if (orphanedJobs.length === 0) {
      return;
    }

    this.logger.log(`Found ${orphanedJobs.length} potentially orphaned job(s), recovering...`);

    for (const job of orphanedJobs) {
      try {
        // Check if there's a running attempt for this job
        const runningAttempts = await this.db<{ id: string }[]>`
          SELECT id FROM job_attempts
          WHERE job_id = ${job.id}
            AND status = 'running'
        `;

        let runningCount = 0;
        let staleAttempts: Array<{ id: string }> = [];

        if (runningAttempts.length > 0) {
          const runningRows = await this.db<{ id: string; started_at: Date }[]>`
            SELECT id, started_at FROM job_attempts
            WHERE job_id = ${job.id}
              AND status = 'running'
          `;
          runningCount = runningRows.length;
          staleAttempts = runningRows.filter((attempt) => attempt.started_at < staleCutoff);

          if (runningCount > staleAttempts.length) {
            // Before skipping, check if the running attempt already has a completion log.
            // This catches the case where the dispatch finished but never finalized the job
            // (e.g. the dispatch crashed after the worker reported completion).
            const nonStaleIds = runningRows
              .filter((a) => a.started_at >= staleCutoff)
              .map((a) => a.id);

            const completionLogs = nonStaleIds.length > 0
              ? await this.db<{ attempt_id: string }[]>`
                  SELECT DISTINCT attempt_id
                  FROM execution_logs
                  WHERE attempt_id = ANY(${nonStaleIds})
                    AND type = 'system'
                    AND content->>'event' = 'completed'
                `
              : [];

            if (completionLogs.length === 0) {
              this.logger.log(
                `Skipping recovery for job ${job.id}; ${runningCount - staleAttempts.length} running attempt(s) within ${staleMinutes}m`,
              );
              continue;
            }

            // Completion log exists but dispatch never finalized — treat as completed
            this.logger.log(
              `Job ${job.id} has ${completionLogs.length} completed-but-not-finalized attempt(s), recovering inline`,
            );
          }
        }

        if (staleAttempts.length > 0) {
          // Mark stale running attempts as failed (orchestrator restarted)
          for (const attempt of staleAttempts) {
            await jobs.completeAttempt(attempt.id, 'failed', {
              exitCode: 1,
              errorMessage: 'Orchestrator restarted while attempt was running',
            });
            this.logger.log(`Marked orphaned attempt ${attempt.id} as failed`);
          }
        }

        if (runningCount === staleAttempts.length) {
          // Reset the job so it can be reclaimed
          // Set assignee to null and phase back to ready
          await this.db`
            UPDATE jobs
            SET assignee = NULL, phase = 'ready', ready_at = NOW(), updated_at = NOW()
            WHERE id = ${job.id}
          `;
          this.logger.log(`Reset orphaned job ${job.id} for retry`);
        }

        const released = await gates.releaseGates(job.id);
        if (released > 0) {
          this.logger.log(`Released ${released} gate(s) for orphaned job ${job.id}`);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to recover orphaned job ${job.id}: ${errMsg}`);
      }
    }

    this.logger.log('Orphaned job recovery complete');
  }

  private releaseInFlightDispatchForWatchdog(jobId: string, label: string): void {
    const dispatchStart = this.inFlightJobs.get(jobId);
    if (dispatchStart === undefined) return;

    this.inFlightJobs.delete(jobId);
    try {
      this.limiter.release();
    } catch (releaseError) {
      const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
      this.logger.warn(`Failed to release limiter for ${label} job ${jobId}: ${message}`);
    }
    const dispatchElapsed = Math.round((Date.now() - dispatchStart) / 1000);
    this.logger.warn(
      `Force-recovered ${label} job ${jobId} while dispatch was in-flight (${dispatchElapsed}s elapsed)`,
    );
  }

  private async failRunningAttemptFromWatchdog(
    candidate: RunningAttemptWatchdogCandidate,
    health: Required<Pick<RunningAttemptHealth, 'reason' | 'errorCode'>>,
    label: string,
  ): Promise<void> {
    const jobs = jobQueries(this.db);
    const gates = gateQueries(this.db);

    this.releaseInFlightDispatchForWatchdog(candidate.job_id, label);

    const errorMessage = `Watchdog: ${health.reason}`;
    const completedAttempt = await jobs.completeAttempt(candidate.attempt_id, 'failed', {
      exitCode: 1,
      errorMessage,
      resultJson: {
        error_code: health.errorCode,
      },
    });

    if (!completedAttempt) {
      this.logger.log(`Attempt ${candidate.attempt_id} already finalized; skipping ${label} recovery`);
      return;
    }

    const failedJob = await jobs.markJobFailed(candidate.job_id, errorMessage);
    if (failedJob) {
      await this.emitJobFailureEvent(
        {
          id: failedJob.id,
          project_id: failedJob.project_id,
          run_id: failedJob.run_id,
          step_name: failedJob.step_name,
          execution_type: failedJob.execution_type,
          action_type: failedJob.action_type,
          hints: failedJob.hints,
        },
        { id: candidate.attempt_id },
        {
          errorMessage,
          errorCode: health.errorCode,
          exitCode: 1,
        },
      );
    }

    const released = await gates.releaseGates(candidate.job_id);
    if (released > 0) {
      this.logger.log(`Released ${released} gate(s) for ${label} job ${candidate.job_id}`);
    }

    this.logger.warn(`Recovered ${label} running attempt ${candidate.attempt_id} for job ${candidate.job_id}`);

    if (candidate.parent_id) {
      await this.tryCloseWorkflowRoot(candidate.parent_id);
    }
  }

  async recoverAttemptInitTimeouts(): Promise<void> {
    const initTimeoutSeconds = readPositiveInt(process.env.EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS, 300);

    const candidates = await this.db<RunningAttemptWatchdogCandidate[]>`
      SELECT
        a.id as attempt_id,
        a.job_id,
        a.started_at,
        a.execution_started_at,
        j.project_id,
        j.run_id,
        j.step_name,
        j.execution_type,
        j.action_type,
        j.hints,
        j.parent_id
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'running'
        AND j.phase = 'active'
        AND a.execution_started_at IS NULL
        AND a.started_at < NOW() - INTERVAL '1 second' * ${initTimeoutSeconds}
    `;

    for (const candidate of candidates) {
      try {
        const health = evaluateAttemptInitHealth({
          startedAt: candidate.started_at,
          initTimeoutSeconds,
        });
        if (!health.stale || !health.reason || !health.errorCode) continue;
        await this.failRunningAttemptFromWatchdog(
          candidate,
          { reason: health.reason, errorCode: health.errorCode },
          'init-timeout',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed init-timeout recovery for ${candidate.attempt_id}: ${message}`);
      }
    }
  }

  async recoverAttemptStartupTimeouts(): Promise<void> {
    const startupTimeoutSeconds = readPositiveInt(process.env.EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS, 600);

    const candidates = await this.db<RunningAttemptWatchdogCandidate[]>`
      SELECT
        a.id as attempt_id,
        a.job_id,
        a.started_at,
        a.execution_started_at,
        j.project_id,
        j.run_id,
        j.step_name,
        j.execution_type,
        j.action_type,
        j.hints,
        j.parent_id
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'running'
        AND j.phase = 'active'
        AND COALESCE(j.execution_type, 'agent') = 'agent'
        AND a.execution_started_at IS NOT NULL
        AND a.execution_started_at < NOW() - INTERVAL '1 second' * ${startupTimeoutSeconds}
        AND NOT EXISTS (
          SELECT 1
          FROM execution_logs el
          WHERE el.attempt_id = a.id
            AND el.type = 'lifecycle_harness_start'
        )
    `;

    for (const candidate of candidates) {
      try {
        if (!candidate.execution_started_at) continue;
        const health = evaluateAttemptStartupHealth({
          executionStartedAt: candidate.execution_started_at,
          startupTimeoutSeconds,
        });
        if (!health.stale || !health.reason || !health.errorCode) continue;
        await this.failRunningAttemptFromWatchdog(
          candidate,
          { reason: health.reason, errorCode: health.errorCode },
          'startup-timeout',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed startup-timeout recovery for ${candidate.attempt_id}: ${message}`);
      }
    }
  }

  async recoverStaleRunningAttempts(): Promise<void> {
    const staleRunningSeconds = readPositiveInt(process.env.EVE_ORCH_STALE_RUNNING_SECONDS, 900);
    const staleIdleSeconds = readPositiveInt(process.env.EVE_ORCH_STALE_IDLE_SECONDS, staleRunningSeconds);
    const timeoutGraceSeconds = readPositiveInt(process.env.EVE_ORCH_TIMEOUT_GRACE_SECONDS, 30);

    const candidates = await this.db<{
      attempt_id: string;
      job_id: string;
      started_at: Date;
      last_log_at: Date;
      timeout_seconds: number;
      project_id: string;
      run_id: string | null;
      step_name: string | null;
      execution_type: string | null;
      action_type: string | null;
      hints: Record<string, unknown> | null;
      parent_id: string | null;
    }[]>`
      SELECT
        a.id as attempt_id,
        a.job_id,
        a.started_at,
        COALESCE(MAX(el.created_at), a.started_at) as last_log_at,
        CASE
          WHEN (j.hints->>'timeout_seconds') ~ '^[0-9]+$'
            THEN (j.hints->>'timeout_seconds')::int
          ELSE 1800
        END as timeout_seconds,
        j.project_id,
        j.run_id,
        j.step_name,
        j.execution_type,
        j.action_type,
        j.hints,
        j.parent_id
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
      LEFT JOIN execution_logs el ON el.attempt_id = a.id
      WHERE a.status = 'running'
        AND j.phase = 'active'
      GROUP BY
        a.id,
        a.job_id,
        a.started_at,
        j.project_id,
        j.run_id,
        j.step_name,
        j.execution_type,
        j.action_type,
        j.hints,
        j.parent_id
    `;

    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      try {
        const health = evaluateRunningAttemptHealth({
          startedAt: candidate.started_at,
          lastLogAt: candidate.last_log_at,
          timeoutSeconds: candidate.timeout_seconds,
          timeoutGraceSeconds,
          staleRunningSeconds,
          staleIdleSeconds,
        });

        if (!health.stale || !health.reason) {
          continue;
        }

        await this.failRunningAttemptFromWatchdog(
          candidate,
          { reason: health.reason, errorCode: health.errorCode ?? 'attempt_stale' },
          'stale',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed stale-attempt recovery for ${candidate.attempt_id}: ${message}`);
      }
    }
  }

  /**
   * Safety-net sweep: find active jobs where all attempts are terminal
   * (no running attempts remain). This catches the case where agent-runtime's
   * drainRunningAttempts() marked the attempt as failed but the orchestrator's
   * processJob poll was still waiting and never transitioned the job phase.
   *
   * Also handles the case where processJob was force-recovered by another
   * sweep but the limiter/inFlightJobs weren't cleaned up properly.
   */
  async recoverActiveJobsWithTerminatedAttempts(): Promise<void> {
    const jobs = jobQueries(this.db);
    const gates = gateQueries(this.db);
    const graceSeconds = readPositiveInt(process.env.EVE_ORCH_TERMINATED_GRACE_SECONDS, 30);

    const stuckJobs = await this.db<{
      id: string;
      project_id: string;
      run_id: string | null;
      step_name: string | null;
      execution_type: string | null;
      action_type: string | null;
      hints: Record<string, unknown> | null;
      parent_id: string | null;
      latest_attempt_id: string | null;
      latest_attempt_status: string | null;
      latest_attempt_error: string | null;
      latest_attempt_exit_code: number | null;
    }[]>`
      SELECT
        j.id, j.project_id, j.run_id, j.step_name,
        j.execution_type, j.action_type, j.hints, j.parent_id,
        la.id as latest_attempt_id,
        la.status as latest_attempt_status,
        la.error_message as latest_attempt_error,
        la.exit_code as latest_attempt_exit_code
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT id, status, error_message, exit_code, ended_at
        FROM job_attempts
        WHERE job_id = j.id
        ORDER BY attempt_number DESC
        LIMIT 1
      ) la ON true
      WHERE j.phase = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM job_attempts a
          WHERE a.job_id = j.id AND a.status = 'running'
        )
        AND EXISTS (
          SELECT 1 FROM job_attempts a WHERE a.job_id = j.id
        )
        AND la.ended_at IS NOT NULL
        AND la.ended_at < NOW() - INTERVAL '1 second' * ${graceSeconds}
    `;

    if (stuckJobs.length === 0) return;

    this.logger.warn(
      `Found ${stuckJobs.length} active job(s) with no running attempts; recovering`,
    );

    for (const stuckJob of stuckJobs) {
      try {
        // Release limiter if dispatch is in-flight
        const dispatchStart = this.inFlightJobs.get(stuckJob.id);
        if (dispatchStart !== undefined) {
          this.inFlightJobs.delete(stuckJob.id);
          try {
            this.limiter.release();
          } catch (releaseError) {
            const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
            this.logger.warn(`Failed to release limiter for stuck job ${stuckJob.id}: ${message}`);
          }
          const elapsed = Math.round((Date.now() - dispatchStart) / 1000);
          this.logger.warn(
            `Released in-flight dispatch for stuck job ${stuckJob.id} (dispatch running ${elapsed}s)`,
          );
        }

        const errorMessage = stuckJob.latest_attempt_error
          ?? 'Active job with no running attempts (pod terminated or attempt externally failed)';

        const failedJob = await jobs.markJobFailed(stuckJob.id, errorMessage);
        if (failedJob) {
          await this.emitJobFailureEvent(
            {
              id: failedJob.id,
              project_id: failedJob.project_id,
              run_id: failedJob.run_id,
              step_name: failedJob.step_name,
              execution_type: failedJob.execution_type,
              action_type: failedJob.action_type,
              hints: failedJob.hints,
            },
            { id: stuckJob.latest_attempt_id ?? 'unknown' },
            {
              errorMessage,
              errorCode: 'orphaned_active_job',
              exitCode: stuckJob.latest_attempt_exit_code ?? 1,
            },
          );
        }

        const released = await gates.releaseGates(stuckJob.id);
        if (released > 0) {
          this.logger.log(`Released ${released} gate(s) for stuck job ${stuckJob.id}`);
        }

        // Sync ingest record status so sources don't stay in parse_status=processing
        await this.syncIngestRecordStatus(
          { id: stuckJob.id, hints: stuckJob.hints },
          false,
          errorMessage,
        );

        // Close workflow root if applicable
        if (stuckJob.parent_id) {
          await this.tryCloseWorkflowRoot(stuckJob.parent_id);
        }

        this.logger.warn(`Recovered stuck active job ${stuckJob.id}: ${errorMessage}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to recover stuck job ${stuckJob.id}: ${msg}`);
      }
    }
  }
}
