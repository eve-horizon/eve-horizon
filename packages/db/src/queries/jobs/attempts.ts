import type { Db } from '../../client.js';
import type { AttemptResultData, CompleteAttemptResult, JobAttempt } from './types.js';

// ============================================================================
// Job Attempts
// ============================================================================

export function jobAttemptQueries(db: Db) {
  return {
    /**
     * Get the current running attempt for a job
     *
     * @param jobId - Job ID
     * @returns Current attempt if found, null otherwise
     */
    async getCurrentAttempt(jobId: string): Promise<JobAttempt | null> {
      const [attempt] = await db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
          AND status = 'running'
        ORDER BY attempt_number DESC
        LIMIT 1
      `;
      return attempt ?? null;
    },

    /**
     * List all attempts for a job
     *
     * @param jobId - Job ID
     * @returns Array of attempts ordered by attempt number descending
     */
    async listAttempts(jobId: string): Promise<JobAttempt[]> {
      return db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
        ORDER BY attempt_number DESC
      `;
    },

    /**
     * Get the latest attempt for a job
     *
     * @param jobId - Job ID
     * @returns Latest attempt or null
     */
    async getLatestAttempt(jobId: string): Promise<JobAttempt | null> {
      const [attempt] = await db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
        ORDER BY attempt_number DESC
        LIMIT 1
      `;
      return attempt ?? null;
    },

    /**
     * Get the most recent rejection reason for a job
     *
     * @param jobId - Job ID
     * @returns Rejection reason or null if none
     */
    async getLatestRejectionReason(jobId: string): Promise<string | null> {
      const [row] = await db<{ reason: string | null }[]>`
        SELECT context->>'reason' as reason
        FROM audit_log
        WHERE entity_type = 'job'
          AND entity_id = ${jobId}
          AND context->>'action' = 'reject_review'
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row?.reason ?? null;
    },

    /**
     * Complete an attempt with result data
     *
     * Updates the attempt with the final status and result fields.
     * Sets ended_at timestamp automatically.
     *
     * @param attemptId - Attempt UUID
     * @param status - Final status ('succeeded' or 'failed')
     * @param result - Optional result fields (exitCode, resultText, etc.)
     * @returns Updated attempt or null if not found
     */
    async completeAttempt(
      attemptId: string,
      status: 'succeeded' | 'failed',
      result?: CompleteAttemptResult,
    ): Promise<JobAttempt | null> {
      const resultJsonValue = result?.resultJson
        ? db.json(result.resultJson as never)
        : null;

      const [attempt] = await db<JobAttempt[]>`
        UPDATE job_attempts
        SET
          status = ${status},
          ended_at = NOW(),
          exit_code = COALESCE(${result?.exitCode ?? null}, exit_code),
          result_text = COALESCE(${result?.resultText ?? null}, result_text),
          result_json = COALESCE(${resultJsonValue}::jsonb, result_json),
          result_summary = COALESCE(${result?.resultSummary ?? null}, result_summary),
          duration_ms = COALESCE(${result?.durationMs ?? null}, duration_ms),
          token_input = COALESCE(${result?.tokenInput ?? null}, token_input),
          token_output = COALESCE(${result?.tokenOutput ?? null}, token_output),
          error_message = COALESCE(${result?.errorMessage ?? null}, error_message)
        WHERE id = ${attemptId}::uuid
          AND status = 'running'
        RETURNING *
      `;
      return attempt ?? null;
    },

    /**
     * Update runtime metadata for an attempt
     *
     * Used to store runtime-specific information like pod name, namespace, etc.
     * This is useful for tools that need to tail logs or inspect runtime resources.
     *
     * @param attemptId - Attempt UUID
     * @param runtimeMeta - Runtime metadata to merge with existing data
     * @returns Updated attempt or null if not found
     */
    async updateRuntimeMeta(
      attemptId: string,
      runtimeMeta: Record<string, unknown>,
    ): Promise<JobAttempt | null> {
      const [attempt] = await db<JobAttempt[]>`
        UPDATE job_attempts
        SET runtime_meta = runtime_meta || ${db.json(runtimeMeta as never)}::jsonb
        WHERE id = ${attemptId}::uuid
        RETURNING *
      `;
      return attempt ?? null;
    },

    /**
     * Mark an attempt as having started execution (idempotent).
     *
     * This is distinct from `started_at` (claim time). It should be set at the
     * first point where the worker begins mutating the workspace / executing hooks.
     */
    async markExecutionStarted(attemptId: string): Promise<void> {
      await db`
        UPDATE job_attempts
        SET execution_started_at = NOW()
        WHERE id = ${attemptId}::uuid AND execution_started_at IS NULL
      `;
    },

    /**
     * Persist an attempt-scoped execution receipt (v2) and materialize totals for aggregation.
     *
     * Receipt JSON is stored as-is (self-contained), while totals are duplicated into
     * dedicated columns for fast spend queries.
     */
    async updateAttemptReceipt(
      attemptId: string,
      receiptJson: Record<string, unknown>,
      materialized: { baseTotalUsd: string; billedTotal: string; billedCurrency: string },
    ): Promise<void> {
      await db`
        UPDATE job_attempts
        SET
          receipt_json = ${db.json(receiptJson as never)}::jsonb,
          receipt_base_total_usd = ${materialized.baseTotalUsd}::numeric,
          receipt_billed_total = ${materialized.billedTotal}::numeric,
          receipt_billed_currency = ${materialized.billedCurrency}
        WHERE id = ${attemptId}::uuid
      `;
    },

    /**
     * Update result_json for an attempt
     *
     * Merges the provided JSON data into the attempt's existing result_json.
     * Useful for adding pipeline outputs or other metadata after attempt completion.
     *
     * @param attemptId - Attempt UUID
     * @param resultJson - JSON data to merge into result_json
     * @returns Updated attempt or null if not found
     */
    async updateAttemptResultJson(
      attemptId: string,
      resultJson: Record<string, unknown>,
    ): Promise<JobAttempt | null> {
      const [attempt] = await db<JobAttempt[]>`
        UPDATE job_attempts
        SET result_json = COALESCE(result_json, '{}'::jsonb) || ${db.json(resultJson as never)}::jsonb
        WHERE id = ${attemptId}::uuid
        RETURNING *
      `;
      return attempt ?? null;
    },

    /**
     * Get just the result fields for an attempt
     *
     * Fetches only the result-related columns for efficiency when
     * you only need to check the outcome of an attempt.
     *
     * @param attemptId - Attempt UUID
     * @returns Result data or null if attempt not found
     */
    async getAttemptResult(attemptId: string): Promise<AttemptResultData | null> {
      const [row] = await db<{
        exit_code: number | null;
        result_text: string | null;
        result_json: Record<string, unknown> | null;
        duration_ms: number | null;
        token_input: number | null;
        token_output: number | null;
        error_message: string | null;
        status: string;
      }[]>`
        SELECT
          exit_code,
          result_text,
          result_json,
          duration_ms,
          token_input,
          token_output,
          error_message,
          status
        FROM job_attempts
        WHERE id = ${attemptId}::uuid
      `;

      if (!row) {
        return null;
      }

      return {
        exitCode: row.exit_code,
        resultText: row.result_text,
        resultJson: row.result_json,
        durationMs: row.duration_ms,
        tokenInput: row.token_input,
        tokenOutput: row.token_output,
        errorMessage: row.error_message,
        status: row.status,
      };
    },
  };
}
