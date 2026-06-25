import type { Db } from '../client.js';

export interface ConversationEvent {
  seq: number | string;
  id: string;
  thread_id: string;
  project_id: string | null;
  org_id: string | null;
  kind: string;
  source: string;
  actor_type: string | null;
  actor_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  agent_id: string | null;
  workflow_step: string | null;
  run_id: string | null;
  message_id: string | null;
  event_id: string | null;
  log_id: string | null;
  attachment_id: string | null;
  text: string | null;
  delivery_status: string | null;
  payload_json: Record<string, unknown>;
  created_at: Date;
}

export interface ListConversationEventsOptions {
  afterSeq?: number;
  kinds?: string[];
  jobId?: string;
  attemptId?: string;
  workflowStep?: string;
  source?: string;
  limit?: number;
}

export interface CreateConversationEventInput {
  thread_id: string;
  project_id?: string | null;
  org_id?: string | null;
  kind: string;
  source?: string;
  actor_type?: string | null;
  actor_id?: string | null;
  job_id?: string | null;
  attempt_id?: string | null;
  agent_id?: string | null;
  workflow_step?: string | null;
  run_id?: string | null;
  message_id?: string | null;
  event_id?: string | null;
  log_id?: string | null;
  attachment_id?: string | null;
  text?: string | null;
  delivery_status?: string | null;
  payload_json?: Record<string, unknown>;
}

export function conversationEventQueries(db: Db) {
  return {
    async create(input: CreateConversationEventInput): Promise<ConversationEvent> {
      const [row] = await db<ConversationEvent[]>`
        INSERT INTO conversation_events (
          thread_id,
          project_id,
          org_id,
          kind,
          source,
          actor_type,
          actor_id,
          job_id,
          attempt_id,
          agent_id,
          workflow_step,
          run_id,
          message_id,
          event_id,
          log_id,
          attachment_id,
          text,
          delivery_status,
          payload_json
        )
        VALUES (
          ${input.thread_id},
          ${input.project_id ?? null},
          ${input.org_id ?? null},
          ${input.kind},
          ${input.source ?? 'app'},
          ${input.actor_type ?? null},
          ${input.actor_id ?? null},
          ${input.job_id ?? null},
          ${input.attempt_id ?? null},
          ${input.agent_id ?? null},
          ${input.workflow_step ?? null},
          ${input.run_id ?? null},
          ${input.message_id ?? null},
          ${input.event_id ?? null},
          ${input.log_id ?? null},
          ${input.attachment_id ?? null},
          ${input.text ?? null},
          ${input.delivery_status ?? null},
          ${db.json((input.payload_json ?? {}) as never)}
        )
        RETURNING *
      `;
      return row;
    },

    async listByThread(threadId: string, options: ListConversationEventsOptions = {}): Promise<ConversationEvent[]> {
      const limit = options.limit ?? 100;
      const conditions = [db`thread_id = ${threadId}`];

      if (options.afterSeq !== undefined) {
        conditions.push(db`seq > ${options.afterSeq}`);
      }
      if (options.kinds?.length) {
        conditions.push(db`kind = ANY(${options.kinds})`);
      }
      if (options.jobId) {
        conditions.push(db`job_id = ${options.jobId}`);
      }
      if (options.attemptId) {
        conditions.push(db`attempt_id = ${options.attemptId}`);
      }
      if (options.workflowStep) {
        conditions.push(db`workflow_step = ${options.workflowStep}`);
      }
      if (options.source) {
        conditions.push(db`source = ${options.source}`);
      }

      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`
      );

      return db<ConversationEvent[]>`
        SELECT *
        FROM conversation_events
        WHERE ${whereClause}
        ORDER BY seq ASC
        LIMIT ${limit}
      `;
    },

    async findByThreadAndCursor(threadId: string, cursor: string): Promise<ConversationEvent | null> {
      const [row] = await db<ConversationEvent[]>`
        SELECT *
        FROM conversation_events
        WHERE thread_id = ${threadId}
          AND (id = ${cursor} OR seq::text = ${cursor})
        LIMIT 1
      `;
      return row ?? null;
    },

    async countByThread(threadId: string, options: Omit<ListConversationEventsOptions, 'afterSeq' | 'limit'> = {}): Promise<number> {
      const conditions = [db`thread_id = ${threadId}`];

      if (options.kinds?.length) {
        conditions.push(db`kind = ANY(${options.kinds})`);
      }
      if (options.jobId) {
        conditions.push(db`job_id = ${options.jobId}`);
      }
      if (options.attemptId) {
        conditions.push(db`attempt_id = ${options.attemptId}`);
      }
      if (options.workflowStep) {
        conditions.push(db`workflow_step = ${options.workflowStep}`);
      }
      if (options.source) {
        conditions.push(db`source = ${options.source}`);
      }

      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`
      );

      const [row] = await db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM conversation_events
        WHERE ${whereClause}
      `;
      return parseInt(row?.count ?? '0', 10);
    },
  };
}
