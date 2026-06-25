import type { Db } from '../client.js';

export interface BatchJob {
  id: string;
  project_id: string;
  idempotency_key: string | null;
  node_count: number;
  created_by: string | null;
  created_at: Date;
}

export function batchJobQueries(db: Db) {
  return {
    async create(batch: Omit<BatchJob, 'created_at'>): Promise<BatchJob> {
      const [row] = await db<BatchJob[]>`
        INSERT INTO batch_jobs (
          id,
          project_id,
          idempotency_key,
          node_count,
          created_by
        )
        VALUES (
          ${batch.id},
          ${batch.project_id},
          ${batch.idempotency_key},
          ${batch.node_count},
          ${batch.created_by}
        )
        RETURNING *
      `;
      return row;
    },

    async findByIdempotencyKey(projectId: string, key: string): Promise<BatchJob | null> {
      const [row] = await db<BatchJob[]>`
        SELECT * FROM batch_jobs
        WHERE project_id = ${projectId} AND idempotency_key = ${key}
      `;
      return row ?? null;
    },

    async findById(id: string): Promise<BatchJob | null> {
      const [row] = await db<BatchJob[]>`
        SELECT * FROM batch_jobs
        WHERE id = ${id}
      `;
      return row ?? null;
    },
  };
}
