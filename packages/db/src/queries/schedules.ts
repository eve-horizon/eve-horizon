import type { Db } from '../client.js';

export interface Schedule {
  id: string;
  project_id: string;
  cron: string;
  event_type: string;
  payload_json: Record<string, unknown> | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ListSchedulesOptions {
  limit?: number;
  offset?: number;
}

export function scheduleQueries(db: Db) {
  return {
    async listAll(options: ListSchedulesOptions = {}): Promise<Schedule[]> {
      const limit = options.limit ?? 500;
      const offset = options.offset ?? 0;
      return db<Schedule[]>`
        SELECT s.*
        FROM schedules s
        JOIN projects p ON p.id = s.project_id
        WHERE p.deleted_at IS NULL
        ORDER BY s.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async listByProject(projectId: string, options: ListSchedulesOptions = {}): Promise<Schedule[]> {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      return db<Schedule[]>`
        SELECT * FROM schedules
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async create(schedule: Omit<Schedule, 'created_at' | 'updated_at'>): Promise<Schedule> {
      const [row] = await db<Schedule[]>`
        INSERT INTO schedules (
          id,
          project_id,
          cron,
          event_type,
          payload_json,
          enabled
        )
        VALUES (
          ${schedule.id},
          ${schedule.project_id},
          ${schedule.cron},
          ${schedule.event_type},
          ${schedule.payload_json ? db.json(schedule.payload_json as never) : null},
          ${schedule.enabled}
        )
        RETURNING *
      `;
      return row;
    },
  };
}
