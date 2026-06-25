import type { Db } from '../client.js';

export type AppLinkEventDeliveryStatus = 'pending' | 'retrying' | 'success' | 'failed' | 'skipped';

export interface AppLinkEventDelivery {
  id: string;
  subscription_id: string;
  source_event_id: string;
  consumer_event_id: string | null;
  status: AppLinkEventDeliveryStatus;
  attempts: number;
  last_attempt_at: Date | null;
  next_retry_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function appLinkEventDeliveryQueries(db: Db) {
  return {
    async findById(id: string): Promise<AppLinkEventDelivery | null> {
      const [row] = await db<AppLinkEventDelivery[]>`
        SELECT * FROM app_link_event_deliveries WHERE id = ${id}
      `;
      return row ?? null;
    },

    async queue(input: {
      id: string;
      subscription_id: string;
      source_event_id: string;
      next_retry_at?: Date | null;
    }): Promise<AppLinkEventDelivery | null> {
      const rows = await db<AppLinkEventDelivery[]>`
        INSERT INTO app_link_event_deliveries (
          id,
          subscription_id,
          source_event_id,
          status,
          next_retry_at
        )
        VALUES (
          ${input.id},
          ${input.subscription_id},
          ${input.source_event_id},
          'pending',
          ${input.next_retry_at ?? null}
        )
        ON CONFLICT (subscription_id, source_event_id) DO NOTHING
        RETURNING *
      `;
      return rows[0] ?? null;
    },

    async claimDue(limit: number): Promise<AppLinkEventDelivery[]> {
      return db<AppLinkEventDelivery[]>`
        UPDATE app_link_event_deliveries
        SET status = CASE WHEN attempts = 0 THEN 'pending' ELSE 'retrying' END,
            updated_at = NOW()
        WHERE id IN (
          SELECT id
          FROM app_link_event_deliveries
          WHERE status IN ('pending', 'retrying')
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          ORDER BY created_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `;
    },

    async markSuccess(id: string, consumerEventId: string): Promise<AppLinkEventDelivery | null> {
      const [row] = await db<AppLinkEventDelivery[]>`
        UPDATE app_link_event_deliveries
        SET status = 'success',
            consumer_event_id = ${consumerEventId},
            attempts = attempts + 1,
            last_attempt_at = NOW(),
            next_retry_at = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async markRetry(id: string, error: string, nextRetryAt: Date): Promise<AppLinkEventDelivery | null> {
      const [row] = await db<AppLinkEventDelivery[]>`
        UPDATE app_link_event_deliveries
        SET status = 'retrying',
            attempts = attempts + 1,
            last_attempt_at = NOW(),
            next_retry_at = ${nextRetryAt},
            last_error = ${error},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async markFailed(id: string, error: string): Promise<AppLinkEventDelivery | null> {
      const [row] = await db<AppLinkEventDelivery[]>`
        UPDATE app_link_event_deliveries
        SET status = 'failed',
            attempts = attempts + 1,
            last_attempt_at = NOW(),
            next_retry_at = NULL,
            last_error = ${error},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async listBySubscription(subscriptionId: string, limit = 50): Promise<AppLinkEventDelivery[]> {
      return db<AppLinkEventDelivery[]>`
        SELECT *
        FROM app_link_event_deliveries
        WHERE subscription_id = ${subscriptionId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    },
  };
}
