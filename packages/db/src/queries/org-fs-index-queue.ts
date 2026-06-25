import type { Db } from '../client.js';

export interface OrgFsIndexQueueItem {
  id: string;
  org_id: string;
  path: string;
  storage_key: string;
  content_hash: string;
  mime_type: string;
  attempts: number;
  locked_until: Date | null;
  created_at: Date;
}

export type EnqueueOrgFsIndexInput = {
  id: string;
  org_id: string;
  path: string;
  storage_key: string;
  content_hash: string;
  mime_type: string;
};

export function orgFsIndexQueueQueries(db: Db) {
  return {
    // Insert or refresh a queue item. On conflict (org_id, path), update
    // storage_key/content_hash/mime_type and clear locked_until so a new
    // upload is immediately eligible for re-indexing.
    async enqueue(input: EnqueueOrgFsIndexInput): Promise<OrgFsIndexQueueItem> {
      const [row] = await db<OrgFsIndexQueueItem[]>`
        INSERT INTO org_fs_index_queue (
          id,
          org_id,
          path,
          storage_key,
          content_hash,
          mime_type
        )
        VALUES (
          ${input.id},
          ${input.org_id},
          ${input.path},
          ${input.storage_key},
          ${input.content_hash},
          ${input.mime_type}
        )
        ON CONFLICT (org_id, path) DO UPDATE
        SET
          storage_key  = EXCLUDED.storage_key,
          content_hash = EXCLUDED.content_hash,
          mime_type    = EXCLUDED.mime_type,
          locked_until = NULL,
          created_at   = NOW()
        RETURNING *
      `;
      return row;
    },

    // Claim a batch of items for processing using a CTE with FOR UPDATE SKIP LOCKED.
    // Returns the claimed rows after setting locked_until to prevent concurrent claims.
    async claimBatch(
      limit: number,
      lockUntil: Date,
    ): Promise<OrgFsIndexQueueItem[]> {
      return db<OrgFsIndexQueueItem[]>`
        WITH claimed AS (
          SELECT id
          FROM org_fs_index_queue
          WHERE locked_until IS NULL OR locked_until < NOW()
          ORDER BY created_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE org_fs_index_queue q
        SET locked_until = ${lockUntil}
        FROM claimed
        WHERE q.id = claimed.id
        RETURNING q.*
      `;
    },

    // Remove a successfully processed item from the queue.
    async remove(id: string): Promise<void> {
      await db`
        DELETE FROM org_fs_index_queue
        WHERE id = ${id}
      `;
    },

    // Increment attempts and clear the lock so the item is eligible for retry.
    async incrementAttempts(id: string): Promise<void> {
      await db`
        UPDATE org_fs_index_queue
        SET
          attempts     = attempts + 1,
          locked_until = NULL
        WHERE id = ${id}
      `;
    },
  };
}
