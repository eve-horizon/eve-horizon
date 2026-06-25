import type { Db } from '../client.js';

export interface SystemSetting {
  key: string;
  value: string;
  description: string | null;
  updated_at: Date;
  updated_by: string | null;
}

export function systemSettingsQueries(db: Db) {
  return {
    async get(key: string): Promise<SystemSetting | null> {
      const [row] = await db<SystemSetting[]>`
        SELECT * FROM system_settings WHERE key = ${key}
      `;
      return row ?? null;
    },

    async set(
      key: string,
      value: string,
      updatedBy: string,
      description?: string,
    ): Promise<SystemSetting> {
      const desc = description ?? null;
      const [row] = await db<SystemSetting[]>`
        INSERT INTO system_settings (key, value, description, updated_by)
        VALUES (${key}, ${value}, ${desc}, ${updatedBy})
        ON CONFLICT (key)
        DO UPDATE SET
          value = EXCLUDED.value,
          description = COALESCE(EXCLUDED.description, system_settings.description),
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
        RETURNING *
      `;
      return row;
    },

    async list(): Promise<SystemSetting[]> {
      return db<SystemSetting[]>`
        SELECT * FROM system_settings ORDER BY key
      `;
    },

    async delete(key: string): Promise<boolean> {
      const result = await db`
        DELETE FROM system_settings WHERE key = ${key}
      `;
      return result.count > 0;
    },
  };
}
