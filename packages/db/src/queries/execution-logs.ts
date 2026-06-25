import type { Db } from '../client.js';

export interface ExecutionLog {
  id: string;
  attempt_id: string | null;
  step_run_id?: string | null;
  seq: number;
  type: string;
  content: Record<string, unknown>;
  created_at: Date;
}

export function executionLogQueries(db: Db) {
  return {
    async appendLog(attemptId: string, type: string, content: Record<string, unknown>): Promise<ExecutionLog> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jsonContent = db.json(content as any);
      const [row] = await db<ExecutionLog[]>`
        INSERT INTO execution_logs (attempt_id, step_run_id, seq, type, content)
        SELECT ${attemptId}, NULL, COALESCE(MAX(seq), 0) + 1, ${type}, ${jsonContent}
        FROM execution_logs WHERE attempt_id = ${attemptId}
        RETURNING *
      `;
      return row;
    },

    async appendStepLog(stepRunId: string, type: string, content: Record<string, unknown>): Promise<ExecutionLog> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jsonContent = db.json(content as any);
      const [row] = await db<ExecutionLog[]>`
        INSERT INTO execution_logs (attempt_id, step_run_id, seq, type, content)
        SELECT NULL, ${stepRunId}, COALESCE(MAX(seq), 0) + 1, ${type}, ${jsonContent}
        FROM execution_logs WHERE step_run_id = ${stepRunId}
        RETURNING *
      `;
      return row;
    },

    async appendLogsBatch(attemptId: string, entries: Array<{ type: string; content: Record<string, unknown> }>): Promise<ExecutionLog[]> {
      if (entries.length === 0) {
        return [];
      }
      const rows: ExecutionLog[] = [];
      for (const entry of entries) {
        rows.push(await this.appendLog(attemptId, entry.type, entry.content));
      }
      return rows;
    },

    async listLogs(attemptId: string, afterSeq?: number): Promise<ExecutionLog[]> {
      if (afterSeq !== undefined) {
        return db<ExecutionLog[]>`
          SELECT * FROM execution_logs
          WHERE attempt_id = ${attemptId} AND seq > ${afterSeq}
          ORDER BY seq
        `;
      }

      return db<ExecutionLog[]>`
        SELECT * FROM execution_logs
        WHERE attempt_id = ${attemptId}
        ORDER BY seq
      `;
    },

    async listStepLogs(stepRunId: string, afterSeq?: number): Promise<ExecutionLog[]> {
      if (afterSeq !== undefined) {
        return db<ExecutionLog[]>`
          SELECT * FROM execution_logs
          WHERE step_run_id = ${stepRunId} AND seq > ${afterSeq}
          ORDER BY seq
        `;
      }

      return db<ExecutionLog[]>`
        SELECT * FROM execution_logs
        WHERE step_run_id = ${stepRunId}
        ORDER BY seq
      `;
    },
  };
}
