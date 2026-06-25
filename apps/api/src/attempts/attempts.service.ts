import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Db, Job, JobAttempt } from '@eve/db';
import { jobQueries, attemptQueries, executionLogQueries } from '@eve/db';
import {
  type ContinueAttemptRequest,
  type AttemptResponse,
  type AttemptListResponse,
  type LogsResponse,
} from '@eve/shared';

/**
 * Attempts Service - Adapted for the new Jobs schema
 *
 * NOTE: This service has been adapted to work with the new Jobs system.
 * The new system uses job_attempts table (via jobQueries.listAttempts) instead of
 * a separate attempts table.
 *
 * Some changes:
 * - Attempt IDs are now TypeID format (att_xxx)
 * - Attempt numbers are stored as attempt_number instead of number
 * - Attempts are created via job.claim() not directly
 */
@Injectable()
export class AttemptsService {
  private jobs: ReturnType<typeof jobQueries>;
  private attempts: ReturnType<typeof attemptQueries>;
  private logs: ReturnType<typeof executionLogQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.jobs = jobQueries(db);
    this.attempts = attemptQueries(db);
    this.logs = executionLogQueries(db);
  }

  async create(projectId: string, jobId: string): Promise<AttemptResponse> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.project_id !== projectId) {
      throw new NotFoundException(`Job ${jobId} not found in project ${projectId}`);
    }

    // In the new system, attempts are created by claiming a job
    const result = await this.jobs.claim(jobId, 'api');
    if (!result.success || !result.attempt) {
      throw new BadRequestException(result.error || 'Failed to create attempt');
    }

    return this.toResponse(result.attempt, job);
  }

  async continue(
    projectId: string,
    jobId: string,
    attemptNumber: number,
    data: ContinueAttemptRequest
  ): Promise<AttemptResponse> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.project_id !== projectId) {
      throw new NotFoundException(`Job ${jobId} not found in project ${projectId}`);
    }

    // Get the attempt
    const attempts = await this.jobs.listAttempts(jobId);
    const attempt = attempts.find(a => a.attempt_number === attemptNumber);
    if (!attempt) {
      throw new NotFoundException(`Attempt ${attemptNumber} not found for job ${jobId}`);
    }

    // Update attempt (new system doesn't have updateInput, use direct SQL or skip for now)
    // For now, we'll just return the existing attempt
    // TODO: Implement continue functionality for new Jobs system if needed
    return this.toResponse(attempt, job);
  }

  async list(
    projectId: string,
    jobId: string,
    options: { limit: number; offset: number; include_deleted: boolean },
  ): Promise<AttemptListResponse> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.project_id !== projectId) {
      throw new NotFoundException(`Job ${jobId} not found in project ${projectId}`);
    }

    const attempts = await this.jobs.listAttempts(jobId);

    // Apply pagination manually (new system doesn't have pagination on listAttempts)
    const paginatedAttempts = attempts.slice(options.offset, options.offset + options.limit);

    return {
      data: paginatedAttempts.map((attempt) => this.toResponse(attempt, job)),
      pagination: {
        limit: options.limit,
        offset: options.offset,
        count: paginatedAttempts.length,
      },
    };
  }

  async findByNumber(
    projectId: string,
    jobId: string,
    attemptNumber: number,
    includeDeleted = false,
  ): Promise<AttemptResponse | null> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.project_id !== projectId) {
      throw new NotFoundException(`Job ${jobId} not found in project ${projectId}`);
    }

    const attempts = await this.jobs.listAttempts(jobId);
    const attempt = attempts.find(a => a.attempt_number === attemptNumber);
    if (!attempt) return null;

    return this.toResponse(attempt, job);
  }

  async getLogs(projectId: string, jobId: string, attemptNumber: number, afterSequence?: number): Promise<LogsResponse> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.project_id !== projectId) {
      throw new NotFoundException(`Job ${jobId} not found in project ${projectId}`);
    }

    const attempts = await this.jobs.listAttempts(jobId);
    const attempt = attempts.find(a => a.attempt_number === attemptNumber);
    if (!attempt) {
      throw new NotFoundException(`Attempt ${attemptNumber} not found for job ${jobId}`);
    }

    const executionLogs = await this.logs.listLogs(attempt.id, afterSequence);

    const logs = executionLogs.map((log) => {
      const content = log.content as Record<string, unknown>;
      return {
        sequence: log.seq,
        timestamp: (content.timestamp as string) || log.created_at.toISOString(),
        line: content,
      };
    });

    return { logs };
  }

  // ============== Internal API methods for worker operations ==============

  /**
   * Append a log entry to an attempt (internal API for workers)
   */
  async appendLog(attemptId: string, logType: string, content: Record<string, unknown>): Promise<void> {
    // Verify attempt exists in job_attempts table
    const [attempt] = await this.db<{ id: string }[]>`
      SELECT id FROM job_attempts WHERE id = ${attemptId}::uuid
    `;
    if (!attempt) {
      throw new NotFoundException(`Attempt ${attemptId} not found`);
    }
    await this.logs.appendLog(attemptId, logType, content);
  }

  /**
   * Update attempt status and result (internal API for workers)
   * Works with job_attempts table (new system)
   */
  async updateAttemptInternal(
    attemptId: string,
    data: { status?: string; result_json?: Record<string, unknown>; result_summary?: string }
  ): Promise<void> {
    const status = data.status ?? null;
    // Use db.json() to properly serialize JSONB, not JSON.stringify
    const resultJson = data.result_json ?? null;
    const resultSummary = data.result_summary ?? null;

    // Determine if we should set ended_at
    const isTerminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';

    const [result] = await this.db<{ id: string }[]>`
      UPDATE job_attempts
      SET
        status = COALESCE(${status}, status),
        result_json = COALESCE(${this.db.json(resultJson as never)}::jsonb, result_json),
        result_summary = COALESCE(${resultSummary}, result_summary),
        ended_at = CASE WHEN ${isTerminal} THEN NOW() ELSE ended_at END
      WHERE id = ${attemptId}::uuid
      RETURNING id
    `;

    if (!result) {
      throw new NotFoundException(`Attempt ${attemptId} not found`);
    }
  }

  /**
   * Requeue a job to ready phase (internal API for workers)
   */
  async requeueJob(jobId: string, agentId: string, reason?: string): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    await this.jobs.requeueReady(jobId, agentId, { reason });
  }

  /**
   * Extract a numeric job number from the job ID for backwards compatibility
   */
  private extractJobNumber(jobId: string): number {
    // Job IDs are like: slug-hash or slug-hash.1.2
    const idParts = jobId.split('-');
    const hashPart = idParts[idParts.length - 1];
    const sequencePart = hashPart.split('.')[0];
    return parseInt(sequencePart, 36) || 0;
  }

  private toResponse(attempt: JobAttempt, job: Job): AttemptResponse {
    const jobNumber = this.extractJobNumber(job.id);
    return {
      attempt_id: attempt.id,
      attempt_number: attempt.attempt_number,
      job_id: job.id,
      job_number: jobNumber,
      status: attempt.status,
      session_id: attempt.agent_id ?? undefined,
      deleted: false, // New system doesn't have deleted flag on attempts
      created_at: attempt.started_at.toISOString(),
      updated_at: attempt.ended_at?.toISOString() ?? attempt.started_at.toISOString(),
      runtime_meta: attempt.runtime_meta,
    };
  }
}
