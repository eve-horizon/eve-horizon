import type { Db } from '../client.js';

export interface AuthChallenge {
  id: string;
  user_id: string | null;
  provider: string;
  nonce: string;
  expires_at: Date;
  used_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export function authChallengeQueries(db: Db) {
  return {
    async create(userId: string, nonce: string, expiresAt: Date): Promise<AuthChallenge> {
      const [row] = await db<AuthChallenge[]>`
        INSERT INTO auth_challenges (user_id, nonce, expires_at)
        VALUES (${userId}, ${nonce}, ${expiresAt})
        RETURNING *
      `;
      return row;
    },

    async createWithProvider(params: {
      userId: string | null;
      provider: string;
      nonce: string;
      expiresAt: Date;
      metadata?: Record<string, unknown> | null;
    }): Promise<AuthChallenge> {
      const [row] = await db<AuthChallenge[]>`
        INSERT INTO auth_challenges (user_id, provider, nonce, expires_at, metadata)
        VALUES (
          ${params.userId},
          ${params.provider},
          ${params.nonce},
          ${params.expiresAt},
          ${params.metadata ? JSON.stringify(params.metadata) : null}::jsonb
        )
        RETURNING *
      `;
      return row;
    },

    async findById(id: string): Promise<AuthChallenge | null> {
      const [row] = await db<AuthChallenge[]>`
        SELECT * FROM auth_challenges WHERE id = ${id}
      `;
      return row ?? null;
    },

    async markUsed(id: string): Promise<void> {
      await db`
        UPDATE auth_challenges SET used_at = NOW() WHERE id = ${id}
      `;
    },
  };
}
