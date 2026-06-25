import type { Db } from '../client.js';

export type EntityType = 'job' | 'job_relation' | 'job_attempt' | 'external_map' | 'ingress_alias';
export type AuditAction = 'created' | 'updated' | 'deleted';
export type ActorType = 'user' | 'agent' | 'system' | 'sync';

export interface AuditEntry {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  action: AuditAction;
  actor: string | null;
  actor_type: ActorType;
  changes: Record<string, { old: unknown; new: unknown }>;
  context: Record<string, unknown>;
  created_at: Date;
}

export interface AuditHistoryOptions {
  limit?: number;
  offset?: number;
}

/**
 * Helper to compute changes between old and new objects.
 *
 * @param oldObj - Previous state (null for creates)
 * @param newObj - New state
 * @param fields - Optional subset of fields to check
 * @returns Object with changed fields and their old/new values
 */
export function diffChanges<T extends Record<string, unknown>>(
  oldObj: T | null,
  newObj: T,
  fields?: (keyof T)[],
): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  const keysToCheck = fields ?? Object.keys(newObj);

  for (const key of keysToCheck) {
    const oldVal = oldObj?.[key];
    const newVal = newObj[key];
    if (oldVal !== newVal) {
      changes[key as string] = { old: oldVal, new: newVal };
    }
  }
  return changes;
}

export function auditQueries(db: Db) {
  return {
    /**
     * Log an audit entry for a mutation.
     */
    async log(
      entry: Omit<AuditEntry, 'id' | 'created_at'>,
    ): Promise<AuditEntry> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jsonChanges = db.json(entry.changes as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jsonContext = db.json(entry.context as any);

      const [row] = await db<AuditEntry[]>`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          ${entry.entity_type},
          ${entry.entity_id},
          ${entry.action},
          ${entry.actor},
          ${entry.actor_type},
          ${jsonChanges},
          ${jsonContext}
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * Get audit history for a specific entity.
     */
    async getHistory(
      entityType: EntityType,
      entityId: string,
      options?: AuditHistoryOptions,
    ): Promise<AuditEntry[]> {
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;

      return db<AuditEntry[]>`
        SELECT * FROM audit_log
        WHERE entity_type = ${entityType} AND entity_id = ${entityId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    /**
     * Get audit history filtered by actor.
     */
    async getHistoryByActor(
      actor: string,
      options?: AuditHistoryOptions,
    ): Promise<AuditEntry[]> {
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;

      return db<AuditEntry[]>`
        SELECT * FROM audit_log
        WHERE actor = ${actor}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    /**
     * Helper to compute changes between old and new objects.
     * Re-exported from module level for convenience.
     */
    diffChanges,
  };
}
