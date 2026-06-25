import type { Db } from '../client.js';

// ============================================================================
// Types
// ============================================================================

export interface IngestRecord {
  id: string;
  org_id: string;
  project_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  actor_type: string;
  actor_id: string | null;
  source_channel: string;
  title: string | null;
  description: string | null;
  instructions: string | null;
  tags: string[] | null;
  callback_url: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed';
  error_message: string | null;
  event_id: string | null;
  job_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface CreateIngestRecordData {
  id: string;
  org_id: string;
  project_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  actor_type: string;
  actor_id?: string | null;
  source_channel?: string;
  title?: string | null;
  description?: string | null;
  instructions?: string | null;
  tags?: string[] | null;
  callback_url?: string | null;
}

// ============================================================================
// Factory Function
// ============================================================================

export function ingestRecordQueries(db: Db) {
  return {
    async create(data: CreateIngestRecordData): Promise<IngestRecord> {
      const [row] = await db<IngestRecord[]>`
        INSERT INTO ingest_records (
          id, org_id, project_id,
          file_name, mime_type, size_bytes, storage_key,
          actor_type, actor_id, source_channel,
          title, description, instructions, tags, callback_url
        )
        VALUES (
          ${data.id}, ${data.org_id}, ${data.project_id},
          ${data.file_name}, ${data.mime_type}, ${data.size_bytes}, ${data.storage_key},
          ${data.actor_type}, ${data.actor_id ?? null}, ${data.source_channel ?? 'upload'},
          ${data.title ?? null}, ${data.description ?? null}, ${data.instructions ?? null},
          ${data.tags ?? null}, ${data.callback_url ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    async findById(id: string): Promise<IngestRecord | null> {
      const [row] = await db<IngestRecord[]>`
        SELECT * FROM ingest_records WHERE id = ${id}
      `;
      return row ?? null;
    },

    async findByProjectId(
      projectId: string,
      options?: { status?: string; limit?: number; offset?: number },
    ): Promise<IngestRecord[]> {
      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;

      if (options?.status) {
        return db<IngestRecord[]>`
          SELECT * FROM ingest_records
          WHERE project_id = ${projectId} AND status = ${options.status}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return db<IngestRecord[]>`
        SELECT * FROM ingest_records
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async updateStatus(
      id: string,
      status: 'pending' | 'processing' | 'done' | 'failed',
      fields?: {
        event_id?: string;
        job_id?: string;
        error_message?: string;
        completed_at?: Date;
      },
    ): Promise<IngestRecord | null> {
      const [row] = await db<IngestRecord[]>`
        UPDATE ingest_records
        SET
          status = ${status},
          event_id = COALESCE(${fields?.event_id ?? null}, event_id),
          job_id = COALESCE(${fields?.job_id ?? null}, job_id),
          error_message = COALESCE(${fields?.error_message ?? null}, error_message),
          completed_at = COALESCE(${fields?.completed_at ?? null}, completed_at),
          updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async countByProjectId(projectId: string, status?: string): Promise<number> {
      if (status) {
        const [row] = await db<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM ingest_records
          WHERE project_id = ${projectId} AND status = ${status}
        `;
        return row?.count ?? 0;
      }
      const [row] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM ingest_records
        WHERE project_id = ${projectId}
      `;
      return row?.count ?? 0;
    },
  };
}
