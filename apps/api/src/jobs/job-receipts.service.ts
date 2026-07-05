import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { jobQueries, spendQueries } from '@eve/db';
import type { JobCompareResponse } from '@eve/shared';
import type { JobResultResponse } from './jobs.service.js';

/**
 * Job results, receipts, and attempt cost comparison.
 *
 * Extracted verbatim from JobsService (R-C5). JobsService delegates here so
 * the controller-facing surface is unchanged.
 */
@Injectable()
export class JobReceiptsService {
  private jobs: ReturnType<typeof jobQueries>;
  private spend: ReturnType<typeof spendQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.jobs = jobQueries(db);
    this.spend = spendQueries(db);
  }

  /**
   * Get job result (from latest or specific attempt)
   */
  async getJobResult(
    jobId: string,
    attemptNumber?: number,
    format?: 'full' | 'text',
  ): Promise<JobResultResponse> {
    // 1. Find the job
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    // 2. Get the attempt (latest or specified)
    const attempts = await this.jobs.listAttempts(jobId);
    if (attempts.length === 0) {
      throw new NotFoundException('No attempts found for this job');
    }

    const attempt = attemptNumber
      ? attempts.find(a => a.attempt_number === attemptNumber)
      : attempts[0]; // listAttempts returns descending by attempt_number, so [0] is latest

    if (!attempt) {
      throw new NotFoundException(`Attempt ${attemptNumber} not found for job ${jobId}`);
    }

    // 3. Check if still running
    if (attempt.status === 'running' || attempt.status === 'pending') {
      throw new ConflictException({
        message: 'Job is still running',
        phase: job.phase,
        status: attempt.status,
      });
    }

    // 4. Get result data
    const result = await this.jobs.getAttemptResult(attempt.id);

    // 5. Return based on format
    if (format === 'text') {
      return { resultText: result?.resultText ?? null };
    }

    return {
      jobId,
      attemptId: attempt.id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      exitCode: result?.exitCode ?? null,
      resultText: result?.resultText ?? null,
      resultJson: result?.resultJson ?? null,
      durationMs: result?.durationMs ?? null,
      tokenUsage: result ? {
        input: result.tokenInput,
        output: result.tokenOutput,
      } : null,
      errorMessage: result?.errorMessage ?? null,
      git: attempt.git_json ?? undefined,
    };
  }

  async getJobReceipt(jobId: string, attemptNumber?: number): Promise<Record<string, unknown>> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    const [row] = attemptNumber
      ? await this.db<{ receipt_json: Record<string, unknown> | null }[]>`
          SELECT receipt_json
          FROM job_attempts
          WHERE job_id = ${jobId} AND attempt_number = ${attemptNumber}
          LIMIT 1
        `
      : await this.db<{ receipt_json: Record<string, unknown> | null }[]>`
          SELECT receipt_json
          FROM job_attempts
          WHERE job_id = ${jobId}
          ORDER BY attempt_number DESC
          LIMIT 1
        `;

    if (!row) {
      throw new NotFoundException(`Attempt not found for job ${jobId}`);
    }
    if (!row.receipt_json) {
      throw new NotFoundException(`Receipt not found for job ${jobId}`);
    }

    return row.receipt_json;
  }

  async getAttemptReceipt(jobId: string, attemptId: string): Promise<Record<string, unknown>> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    const [row] = await this.db<{ receipt_json: Record<string, unknown> | null }[]>`
      SELECT receipt_json
      FROM job_attempts
      WHERE job_id = ${jobId} AND id = ${attemptId}::uuid
      LIMIT 1
    `;

    if (!row) {
      throw new NotFoundException(`Attempt not found: ${attemptId}`);
    }
    if (!row.receipt_json) {
      throw new NotFoundException(`Receipt not found for attempt ${attemptId}`);
    }

    return row.receipt_json;
  }

  async compareAttempts(
    jobId: string,
    attemptA: number,
    attemptB: number,
    options?: { include_receipt?: boolean },
  ): Promise<JobCompareResponse> {
    if (!Number.isFinite(attemptA) || !Number.isFinite(attemptB)) {
      throw new BadRequestException('Attempt numbers must be integers');
    }
    const a = Math.max(1, Math.floor(attemptA));
    const b = Math.max(1, Math.floor(attemptB));
    if (a === b) {
      throw new BadRequestException('Attempt numbers must be different');
    }

    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    const result = await this.spend.compareAttempts(jobId, a, b);
    const includeReceipt = options?.include_receipt ?? false;

    return {
      job_id: jobId,
      attempts: result.attempts.map((entry) => ({
        attempt_number: entry.attempt_number,
        status: entry.status,
        started_at: entry.started_at,
        ended_at: entry.ended_at,
        base_total_usd: entry.base_total_usd,
        billed_total: entry.billed_total,
        billed_currency: entry.billed_currency,
        ...(includeReceipt ? { receipt: entry.receipt_json } : {}),
      })),
    };
  }
}
