import type { Db } from '../client.js';

export interface Identity {
  id: string;
  user_id: string;
  provider: string;
  public_key: string;
  fingerprint: string;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}

export function identityQueries(db: Db) {
  return {
    async listByUser(userId: string): Promise<Identity[]> {
      return db<Identity[]>`
        SELECT * FROM identities WHERE user_id = ${userId}
        ORDER BY created_at ASC
      `;
    },

    async listByUserAndProvider(userId: string, provider: string): Promise<Identity[]> {
      return db<Identity[]>`
        SELECT * FROM identities
        WHERE user_id = ${userId} AND provider = ${provider}
        ORDER BY created_at ASC
      `;
    },

    async findByFingerprint(provider: string, fingerprint: string): Promise<Identity | null> {
      const [row] = await db<Identity[]>`
        SELECT * FROM identities
        WHERE provider = ${provider} AND fingerprint = ${fingerprint}
      `;
      return row ?? null;
    },

    /** Find all identities with a given fingerprint, across all providers. */
    async findAllByFingerprint(fingerprint: string): Promise<Identity[]> {
      return db<Identity[]>`
        SELECT * FROM identities WHERE fingerprint = ${fingerprint}
      `;
    },

    async create(identity: Omit<Identity, 'created_at' | 'updated_at'>): Promise<Identity> {
      const [row] = await db<Identity[]>`
        INSERT INTO identities (id, user_id, provider, public_key, fingerprint, label)
        VALUES (
          ${identity.id},
          ${identity.user_id},
          ${identity.provider},
          ${identity.public_key},
          ${identity.fingerprint},
          ${identity.label}
        )
        RETURNING *
      `;
      return row;
    },
  };
}
