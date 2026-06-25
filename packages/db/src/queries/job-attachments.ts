import type { Db } from '../client.js';

// ============================================================================
// Types
// ============================================================================

export interface JobAttachment {
  id: string;
  job_id: string;
  name: string;
  mime_type: string;
  content: string;
  content_hash: string;
  created_by: string | null;
  created_at: Date;
}

export interface CreateJobAttachmentData {
  job_id: string;
  name: string;
  mime_type?: string;
  content: string;
  created_by?: string | null;
}

// ============================================================================
// Factory Function
// ============================================================================

export function jobAttachmentQueries(db: Db) {
  return {
    /**
     * Create a new job attachment.
     *
     * @param data - Attachment data
     * @returns Created attachment
     */
    async create(data: CreateJobAttachmentData): Promise<JobAttachment> {
      const [row] = await db<JobAttachment[]>`
        INSERT INTO job_attachments (
          job_id,
          name,
          mime_type,
          content,
          created_by
        )
        VALUES (
          ${data.job_id},
          ${data.name},
          ${data.mime_type ?? 'text/plain'},
          ${data.content},
          ${data.created_by ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * Find an attachment by ID.
     *
     * @param id - Attachment UUID
     * @returns Attachment if found, null otherwise
     */
    async findById(id: string): Promise<JobAttachment | null> {
      const [row] = await db<JobAttachment[]>`
        SELECT * FROM job_attachments WHERE id = ${id}::uuid
      `;
      return row ?? null;
    },

    /**
     * List all attachments for a job (metadata only, excludes content).
     *
     * @param jobId - Job ID
     * @returns Array of attachments without content
     */
    async findByJobId(jobId: string): Promise<JobAttachment[]> {
      return db<JobAttachment[]>`
        SELECT id, job_id, name, mime_type, content_hash, created_by, created_at
        FROM job_attachments
        WHERE job_id = ${jobId}
        ORDER BY created_at ASC
      `;
    },

    /**
     * Find an attachment by job ID and name.
     *
     * @param jobId - Job ID
     * @param name - Attachment name
     * @returns Attachment if found, null otherwise
     */
    async findByJobIdAndName(jobId: string, name: string): Promise<JobAttachment | null> {
      const [row] = await db<JobAttachment[]>`
        SELECT * FROM job_attachments
        WHERE job_id = ${jobId} AND name = ${name}
      `;
      return row ?? null;
    },

    /**
     * Delete an attachment by ID.
     *
     * @param id - Attachment UUID
     * @returns True if deleted, false if not found
     */
    async delete(id: string): Promise<boolean> {
      const result = await db<{ id: string }[]>`
        DELETE FROM job_attachments WHERE id = ${id}::uuid
        RETURNING id
      `;
      return result.length > 0;
    },

    /**
     * Get total size of all attachments for a job.
     *
     * @param jobId - Job ID
     * @returns Total size in bytes
     */
    async totalSizeForJob(jobId: string): Promise<number> {
      const [row] = await db<{ total: number }[]>`
        SELECT COALESCE(SUM(LENGTH(content)), 0)::int AS total
        FROM job_attachments
        WHERE job_id = ${jobId}
      `;
      return row?.total ?? 0;
    },
  };
}
