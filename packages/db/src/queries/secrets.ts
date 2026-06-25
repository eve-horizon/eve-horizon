import type { Db } from '../client.js';

export type SecretScopeType = 'user' | 'org' | 'project' | 'system';
export type SecretType = 'env_var' | 'file' | 'github_token' | 'ssh_key';

export interface Secret {
  id: string;
  scope_type: SecretScopeType;
  scope_id: string;
  key: string;
  type: SecretType;
  value_encrypted: string;
  created_at: Date;
  updated_at: Date;
}

export interface ListSecretsOptions {
  limit?: number;
  offset?: number;
}

export function secretQueries(db: Db) {
  return {
    async create(secret: Omit<Secret, 'created_at' | 'updated_at'>): Promise<Secret> {
      const [row] = await db<Secret[]>`
        INSERT INTO secrets (id, scope_type, scope_id, key, type, value_encrypted)
        VALUES (
          ${secret.id},
          ${secret.scope_type},
          ${secret.scope_id},
          ${secret.key},
          ${secret.type},
          ${secret.value_encrypted}
        )
        RETURNING *
      `;
      return row;
    },

    async listByScope(
      scopeType: SecretScopeType,
      scopeId: string,
      options: ListSecretsOptions = {},
    ): Promise<Secret[]> {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      return db<Secret[]>`
        SELECT * FROM secrets
        WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async findByScopeAndKey(
      scopeType: SecretScopeType,
      scopeId: string,
      key: string,
    ): Promise<Secret | null> {
      const [row] = await db<Secret[]>`
        SELECT * FROM secrets
        WHERE scope_type = ${scopeType} AND scope_id = ${scopeId} AND key = ${key}
      `;
      return row ?? null;
    },

    async updateByKey(
      scopeType: SecretScopeType,
      scopeId: string,
      key: string,
      updates: { value_encrypted?: string; type?: SecretType },
    ): Promise<Secret | null> {
      const valueEncrypted = updates.value_encrypted ?? null;
      const type = updates.type ?? null;

      const [row] = await db<Secret[]>`
        UPDATE secrets
        SET
          value_encrypted = COALESCE(${valueEncrypted}, value_encrypted),
          type = COALESCE(${type}, type),
          updated_at = NOW()
        WHERE scope_type = ${scopeType} AND scope_id = ${scopeId} AND key = ${key}
        RETURNING *
      `;
      return row ?? null;
    },

    async deleteByKey(scopeType: SecretScopeType, scopeId: string, key: string): Promise<boolean> {
      const result = await db`
        DELETE FROM secrets
        WHERE scope_type = ${scopeType} AND scope_id = ${scopeId} AND key = ${key}
      `;
      return result.count > 0;
    },
  };
}
