import type { Db } from '../client.js';
import { formatAttemptId, parseJobId } from '@eve/shared';

export interface Attempt {
  id: string;
  job_id: string;
  number: number;
  status: string;
  workspace_path: string | null;
  agent_session_id: string | null;
  input: Record<string, unknown> | null;
  input_updated_at: Date | null;
  deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

export function attemptQueries(db: Db) {
  return {
    async findById(id: string, options?: { include_deleted?: boolean }): Promise<Attempt | null> {
      const includeDeleted = options?.include_deleted ?? false;
      const [row] = includeDeleted
        ? await db<Attempt[]>`SELECT * FROM attempts WHERE id = ${id}`
        : await db<Attempt[]>`SELECT * FROM attempts WHERE id = ${id} AND deleted = FALSE`;
      return row ?? null;
    },

    async findByJobAndNumber(
      jobId: string,
      number: number,
      options?: { include_deleted?: boolean },
    ): Promise<Attempt | null> {
      const includeDeleted = options?.include_deleted ?? false;
      const [row] = includeDeleted
        ? await db<Attempt[]>`
            SELECT * FROM attempts
            WHERE job_id = ${jobId} AND number = ${number}
          `
        : await db<Attempt[]>`
            SELECT * FROM attempts
            WHERE job_id = ${jobId} AND number = ${number} AND deleted = FALSE
          `;
      return row ?? null;
    },

    async findByJob(
      jobId: string,
      options?: { include_deleted?: boolean; limit?: number; offset?: number },
    ): Promise<Attempt[]> {
      const includeDeleted = options?.include_deleted ?? false;
      const limit = options?.limit ?? 10;
      const offset = options?.offset ?? 0;
      return includeDeleted
        ? db<Attempt[]>`
            SELECT * FROM attempts
            WHERE job_id = ${jobId}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : db<Attempt[]>`
            SELECT * FROM attempts
            WHERE job_id = ${jobId} AND deleted = FALSE
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
    },

    async create(attempt: Pick<Attempt, 'id' | 'job_id' | 'number' | 'status'>): Promise<Attempt> {
      const [row] = await db<Attempt[]>`
        INSERT INTO attempts (id, job_id, number, status)
        VALUES (${attempt.id}, ${attempt.job_id}, ${attempt.number}, ${attempt.status})
        RETURNING *
      `;
      return row;
    },

    async getNextAttemptNumber(jobId: string): Promise<number> {
      const [row] = await db<{ count: string }[]>`
        SELECT COUNT(*) as count FROM attempts WHERE job_id = ${jobId}
      `;
      return parseInt(row?.count ?? '0', 10) + 1;
    },

    async getPendingAttemptForJob(jobId: string): Promise<Attempt | null> {
      const [row] = await db<Attempt[]>`
        SELECT * FROM attempts
        WHERE job_id = ${jobId} AND status = 'pending' AND deleted = FALSE
        ORDER BY number ASC
        LIMIT 1
      `;
      return row ?? null;
    },

    async createAttemptForJob(jobId: string, workspacePath: string): Promise<Attempt> {
      // Parse jobId to get projectId and jobNumber
      const parsed = parseJobId(jobId);
      if (!parsed) {
        throw new Error(`Invalid jobId format: ${jobId}`);
      }
      const { projectId, jobNumber } = parsed;

      // Atomically get next attempt number and insert the attempt in a single query
      // Using a CTE to calculate the next attempt number and format the ID
      const [row] = await db<Attempt[]>`
        WITH next_attempt AS (
          SELECT COALESCE(MAX(number), 0) + 1 AS next_number
          FROM attempts
          WHERE job_id = ${jobId}
        )
        INSERT INTO attempts (id, job_id, number, status, workspace_path)
        SELECT
          ${projectId} || ':' || ${jobNumber} || ':' || next_number,
          ${jobId},
          next_number,
          'pending',
          ${workspacePath}
        FROM next_attempt
        RETURNING *
      `;

      return row;
    },

    async updateInput(id: string, input: Record<string, unknown>): Promise<Attempt | null> {
      const [row] = await db<Attempt[]>`
        UPDATE attempts
        SET input = ${JSON.stringify(input)}::jsonb,
            input_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async setWorkspacePath(id: string, workspacePath: string): Promise<Attempt | null> {
      const [row] = await db<Attempt[]>`
        UPDATE attempts
        SET workspace_path = ${workspacePath}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async markAttemptRunning(id: string): Promise<Attempt | null> {
      const [row] = await db<Attempt[]>`
        UPDATE attempts
        SET status = 'running', updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async markAttemptSucceeded(id: string): Promise<Attempt | null> {
      const [row] = await db<Attempt[]>`
        UPDATE attempts
        SET status = 'succeeded', updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async markAttemptFailed(id: string): Promise<Attempt | null> {
      const [row] = await db<Attempt[]>`
        UPDATE attempts
        SET status = 'failed', updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async update(id: string, updates: { deleted?: boolean }): Promise<Attempt | null> {
      const deleted = updates.deleted ?? null;
      const [row] = await db<Attempt[]>`
        UPDATE attempts
        SET deleted = COALESCE(${deleted}, deleted), updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },
  };
}
