import type { Db } from '../client.js';

export interface Thread {
  id: string;
  project_id: string | null;
  org_id: string | null;
  scope: 'project' | 'org';
  key: string;
  channel: string | null;
  peer: string | null;
  policy_json: Record<string, unknown> | null;
  summary: string | null;
  workspace_key: string | null;
  metadata_json: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  direction: string;
  kind: 'message' | 'progress';
  actor_type: string | null;
  actor_id: string | null;
  body: string;
  job_id: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export interface ListThreadsOptions {
  limit?: number;
  offset?: number;
}

export function threadQueries(db: Db) {
  return {
    async findByProjectAndKey(projectId: string, key: string): Promise<Thread | null> {
      const [row] = await db<Thread[]>`
        SELECT * FROM threads
        WHERE project_id = ${projectId} AND key = ${key}
      `;
      return row ?? null;
    },

    async findConversationByAppKey(projectId: string, appKey: string): Promise<Thread | null> {
      const [row] = await db<Thread[]>`
        SELECT * FROM threads
        WHERE project_id = ${projectId}
          AND scope = 'project'
          AND metadata_json->>'app_key' = ${appKey}
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    async listByProject(projectId: string, options: ListThreadsOptions = {}): Promise<Thread[]> {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      return db<Thread[]>`
        SELECT * FROM threads
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async findById(threadId: string): Promise<Thread | null> {
      const [row] = await db<Thread[]>`
        SELECT * FROM threads
        WHERE id = ${threadId}
      `;
      return row ?? null;
    },

    async create(thread: Omit<Thread, 'created_at' | 'updated_at'> | Omit<Thread, 'created_at' | 'updated_at' | 'org_id' | 'scope'>): Promise<Thread> {
      const orgId = 'org_id' in thread ? thread.org_id : null;
      const scope = 'scope' in thread ? thread.scope : 'project';
      const metadataJson = 'metadata_json' in thread ? thread.metadata_json : null;
      const [row] = await db<Thread[]>`
        INSERT INTO threads (
          id,
          project_id,
          key,
          channel,
          peer,
          policy_json,
          summary,
          workspace_key,
          org_id,
          scope,
          metadata_json
        )
        VALUES (
          ${thread.id},
          ${thread.project_id},
          ${thread.key},
          ${thread.channel},
          ${thread.peer},
          ${thread.policy_json ? db.json(thread.policy_json as never) : null},
          ${thread.summary},
          ${thread.workspace_key},
          ${orgId},
          ${scope},
          ${metadataJson ? db.json(metadataJson as never) : null}
        )
        RETURNING *
      `;
      return row;
    },

    async touch(threadId: string): Promise<Thread | null> {
      const [row] = await db<Thread[]>`
        UPDATE threads
        SET updated_at = NOW()
        WHERE id = ${threadId}
        RETURNING *
      `;
      return row ?? null;
    },

    async setSummary(threadId: string, summary: string): Promise<Thread | null> {
      const [row] = await db<Thread[]>`
        UPDATE threads
        SET summary = ${summary}, updated_at = NOW()
        WHERE id = ${threadId}
        RETURNING *
      `;
      return row ?? null;
    },

    async updateMetadata(threadId: string, metadata: Record<string, unknown>): Promise<Thread | null> {
      const [row] = await db<Thread[]>`
        UPDATE threads
        SET metadata_json = ${db.json(metadata as never)}, updated_at = NOW()
        WHERE id = ${threadId}
        RETURNING *
      `;
      return row ?? null;
    },

    async findByOrgAndKey(orgId: string, key: string): Promise<Thread | null> {
      const [row] = await db<Thread[]>`
        SELECT * FROM threads
        WHERE org_id = ${orgId} AND key = ${key} AND scope = 'org'
      `;
      return row ?? null;
    },

    async listByOrg(orgId: string, options: ListThreadsOptions & { keyPrefix?: string; scope?: string } = {}): Promise<Thread[]> {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;

      if (options.keyPrefix) {
        const prefix = options.keyPrefix + '%';
        return db<Thread[]>`
          SELECT * FROM threads
          WHERE org_id = ${orgId}
            AND scope = ${options.scope ?? 'org'}
            AND key LIKE ${prefix}
          ORDER BY updated_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return db<Thread[]>`
        SELECT * FROM threads
        WHERE org_id = ${orgId}
          AND scope = ${options.scope ?? 'org'}
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async hardDelete(id: string): Promise<boolean> {
      const result = await db`DELETE FROM threads WHERE id = ${id}`;
      return result.count > 0;
    },

    async createOrgThread(thread: {
      id: string;
      org_id: string;
      key: string;
      scope: 'org';
      channel?: string | null;
      peer?: string | null;
      policy_json?: Record<string, unknown> | null;
      summary?: string | null;
      workspace_key?: string | null;
    }): Promise<Thread> {
      const [row] = await db<Thread[]>`
        INSERT INTO threads (
          id,
          org_id,
          key,
          scope,
          channel,
          peer,
          policy_json,
          summary,
          workspace_key
        )
        VALUES (
          ${thread.id},
          ${thread.org_id},
          ${thread.key},
          ${thread.scope},
          ${thread.channel ?? null},
          ${thread.peer ?? null},
          ${thread.policy_json ? db.json(thread.policy_json as never) : null},
          ${thread.summary ?? null},
          ${thread.workspace_key ?? null}
        )
        RETURNING *
      `;
      return row;
    },
  };
}

export interface ListMessagesOptions {
  /** Return messages created after this timestamp */
  since?: Date;
  limit?: number;
  offset?: number;
}

type CreateThreadMessageInput =
  Omit<ThreadMessage, 'created_at' | 'delivery_status' | 'delivery_error' | 'delivered_at' | 'kind'>
  & { kind?: 'message' | 'progress' };

export function threadMessageQueries(db: Db) {
  return {
    async create(message: CreateThreadMessageInput): Promise<ThreadMessage> {
      const [row] = await db<ThreadMessage[]>`
        INSERT INTO thread_messages (
          id,
          thread_id,
          direction,
          kind,
          actor_type,
          actor_id,
          body,
          job_id
        )
        VALUES (
          ${message.id},
          ${message.thread_id},
          ${message.direction},
          ${message.kind ?? 'message'},
          ${message.actor_type},
          ${message.actor_id},
          ${message.body},
          ${message.job_id}
        )
        RETURNING *
      `;
      return row;
    },

    async listByThread(threadId: string, options: ListMessagesOptions = {}): Promise<ThreadMessage[]> {
      const limit = options.limit ?? 100;
      const offset = options.offset ?? 0;

      if (options.since) {
        return db<ThreadMessage[]>`
          SELECT * FROM thread_messages
          WHERE thread_id = ${threadId}
            AND created_at > ${options.since}
          ORDER BY created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return db<ThreadMessage[]>`
        SELECT * FROM thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async findByThreadAndId(threadId: string, messageId: string): Promise<ThreadMessage | null> {
      const [row] = await db<ThreadMessage[]>`
        SELECT * FROM thread_messages
        WHERE thread_id = ${threadId}
          AND id::text = ${messageId}
      `;
      return row ?? null;
    },

    async listAfterMessageId(threadId: string, messageId: string, options: { limit?: number } = {}): Promise<ThreadMessage[]> {
      const limit = options.limit ?? 100;
      return db<ThreadMessage[]>`
        WITH anchor AS (
          SELECT created_at, id
          FROM thread_messages
          WHERE thread_id = ${threadId}
            AND id::text = ${messageId}
          LIMIT 1
        )
        SELECT tm.*
        FROM thread_messages tm
        CROSS JOIN anchor
        WHERE tm.thread_id = ${threadId}
          AND (
            tm.created_at > anchor.created_at
            OR (tm.created_at = anchor.created_at AND tm.id::text > anchor.id::text)
          )
        ORDER BY tm.created_at ASC, tm.id::text ASC
        LIMIT ${limit}
      `;
    },

    async listRecent(threadId: string, opts: { limit?: number } = {}): Promise<ThreadMessage[]> {
      const limit = opts.limit ?? 20;
      return db<ThreadMessage[]>`
        SELECT id, thread_id, direction, kind, actor_type, actor_id, body, job_id, delivery_status, delivery_error, delivered_at, created_at
        FROM thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `.then(rows => [...rows].reverse());
    },

    async createOutbound(message: {
      id: string;
      thread_id: string;
      actor_type: string | null;
      actor_id: string | null;
      body: string;
      job_id: string;
    }): Promise<ThreadMessage> {
      const [row] = await db<ThreadMessage[]>`
        INSERT INTO thread_messages (
          id, thread_id, direction, kind, actor_type, actor_id, body, job_id, delivery_status
        )
        VALUES (
          ${message.id},
          ${message.thread_id},
          'outbound',
          'message',
          ${message.actor_type},
          ${message.actor_id},
          ${message.body},
          ${message.job_id},
          'pending'
        )
        ON CONFLICT (job_id) WHERE direction = 'outbound' AND kind = 'message' AND job_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `;
      return row;
    },

    async updateDeliveryStatus(
      jobId: string,
      status: 'delivered' | 'failed',
      error?: string,
    ): Promise<ThreadMessage | null> {
      if (status === 'delivered') {
        const [row] = await db<ThreadMessage[]>`
          UPDATE thread_messages
          SET delivery_status = 'delivered', delivered_at = NOW()
          WHERE job_id = ${jobId} AND direction = 'outbound'
          RETURNING *
        `;
        return row ?? null;
      }
      const [row] = await db<ThreadMessage[]>`
        UPDATE thread_messages
        SET delivery_status = 'failed', delivery_error = ${error ?? null}
        WHERE job_id = ${jobId} AND direction = 'outbound'
        RETURNING *
      `;
      return row ?? null;
    },

    async updateDeliveryStatusById(
      messageId: string,
      status: 'delivered' | 'failed',
      error?: string,
    ): Promise<ThreadMessage | null> {
      if (status === 'delivered') {
        const [row] = await db<ThreadMessage[]>`
          UPDATE thread_messages
          SET delivery_status = 'delivered', delivered_at = NOW()
          WHERE id = ${messageId}
          RETURNING *
        `;
        return row ?? null;
      }
      const [row] = await db<ThreadMessage[]>`
        UPDATE thread_messages
        SET delivery_status = 'failed', delivery_error = ${error ?? null}
        WHERE id = ${messageId}
        RETURNING *
      `;
      return row ?? null;
    },

    async countByThread(threadId: string, since?: Date): Promise<number> {
      if (since) {
        const [row] = await db<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM thread_messages
          WHERE thread_id = ${threadId}
            AND created_at > ${since}
        `;
        return parseInt(row?.count ?? '0', 10);
      }

      const [row] = await db<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM thread_messages
        WHERE thread_id = ${threadId}
      `;
      return parseInt(row?.count ?? '0', 10);
    },
  };
}
