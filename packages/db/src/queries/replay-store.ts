import type { Db } from '../client.js';

export interface AuthRequestReplay {
  id: string;
  provider: string;
  replay_id: string;
  expires_at: Date;
  created_at: Date;
}

export function replayStoreQueries(db: Db) {
  return {
    /**
     * Assert that this (provider, replayId) has not been seen before.
     * Inserts a row with TTL. Throws if duplicate.
     * Uses ON CONFLICT to make this safe under concurrent requests.
     */
    async assertNotReplayed(provider: string, replayId: string, ttlSeconds: number): Promise<void> {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      const result = await db`
        INSERT INTO auth_request_replays (provider, replay_id, expires_at)
        VALUES (${provider}, ${replayId}, ${expiresAt})
        ON CONFLICT (provider, replay_id) DO NOTHING
        RETURNING id
      `;
      if (result.length === 0) {
        throw new Error('Replay detected');
      }
    },

    /** Purge expired replay entries. Returns number of rows deleted. */
    async purgeExpired(): Promise<number> {
      const result = await db`
        DELETE FROM auth_request_replays
        WHERE expires_at < NOW()
      `;
      return result.count;
    },
  };
}
