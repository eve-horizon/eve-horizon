import type { Db } from '../client.js';

// ============================================================================
// Types
// ============================================================================

export interface WebhookSubscription {
  id: string;
  org_id: string;
  project_id: string | null;
  url: string;
  events: string[];
  filter: Record<string, unknown>;
  secret: string;
  active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateWebhookSubscriptionData {
  org_id: string;
  project_id?: string | null;
  url: string;
  events: string[];
  filter?: Record<string, unknown>;
  secret: string;
  created_by?: string | null;
}

export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  event_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  last_attempt_at: Date | null;
  next_retry_at: Date | null;
  response_status: number | null;
  response_body: string | null;
  created_at: Date;
}

export interface CreateWebhookDeliveryData {
  subscription_id: string;
  event_id?: string | null;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface UpdateWebhookDeliveryData {
  status?: string;
  attempts?: number;
  last_attempt_at?: Date | null;
  next_retry_at?: Date | null;
  response_status?: number | null;
  response_body?: string | null;
}

export interface WebhookReplay {
  id: string;
  subscription_id: string;
  org_id: string;
  project_id: string | null;
  status: string;
  requested: number;
  processed: number;
  replayed: number;
  deduplicated: number;
  failed: number;
  from_event_id: string | null;
  from_time: Date | null;
  to_time: Date | null;
  max_events: number;
  dry_run: boolean;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  updated_at: Date;
  completed_at: Date | null;
}

export interface CreateWebhookReplayData {
  subscription_id: string;
  org_id: string;
  project_id?: string | null;
  status?: string;
  requested?: number;
  processed?: number;
  replayed?: number;
  deduplicated?: number;
  failed?: number;
  from_event_id?: string | null;
  from_time?: Date | null;
  to_time?: Date | null;
  max_events?: number;
  dry_run?: boolean;
  created_by?: string | null;
  started_at?: Date | null;
  completed_at?: Date | null;
}

export interface UpdateWebhookReplayData {
  status?: string;
  requested?: number;
  processed?: number;
  replayed?: number;
  deduplicated?: number;
  failed?: number;
  started_at?: Date | null;
  completed_at?: Date | null;
}

// ============================================================================
// Factory Function
// ============================================================================

export function webhookQueries(db: Db) {
  return {
    // ── Subscriptions ──────────────────────────────────────────────────

    /**
     * Create a new webhook subscription.
     */
    async createSubscription(data: CreateWebhookSubscriptionData): Promise<WebhookSubscription> {
      const [row] = await db<WebhookSubscription[]>`
        INSERT INTO webhook_subscriptions (
          org_id,
          project_id,
          url,
          events,
          filter,
          secret,
          created_by
        )
        VALUES (
          ${data.org_id},
          ${data.project_id ?? null},
          ${data.url},
          ${data.events},
          ${JSON.stringify(data.filter ?? {})},
          ${data.secret},
          ${data.created_by ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * Find a subscription by ID.
     */
    async findSubscriptionById(id: string): Promise<WebhookSubscription | null> {
      const [row] = await db<WebhookSubscription[]>`
        SELECT * FROM webhook_subscriptions WHERE id = ${id}::uuid
      `;
      return row ?? null;
    },

    /**
     * List subscriptions for an org, optionally filtered by project.
     */
    async listSubscriptions(orgId: string, projectId?: string): Promise<WebhookSubscription[]> {
      if (projectId) {
        return db<WebhookSubscription[]>`
          SELECT * FROM webhook_subscriptions
          WHERE org_id = ${orgId}
            AND (project_id IS NULL OR project_id = ${projectId})
          ORDER BY created_at DESC
        `;
      }
      return db<WebhookSubscription[]>`
        SELECT * FROM webhook_subscriptions
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
      `;
    },

    /**
     * Delete a subscription by ID.
     */
    async deleteSubscription(id: string): Promise<boolean> {
      const result = await db<{ id: string }[]>`
        DELETE FROM webhook_subscriptions WHERE id = ${id}::uuid
        RETURNING id
      `;
      return result.length > 0;
    },

    /**
     * Find active subscriptions matching an org, project, and event type.
     * Supports wildcard patterns in event subscriptions (e.g. "system.job.*").
     */
    async findMatchingSubscriptions(
      orgId: string,
      projectId: string,
      eventType: string,
    ): Promise<WebhookSubscription[]> {
      return db<WebhookSubscription[]>`
        SELECT * FROM webhook_subscriptions
        WHERE org_id = ${orgId}
          AND active = true
          AND (project_id IS NULL OR project_id = ${projectId})
          AND EXISTS (
            SELECT 1 FROM unnest(events) AS evt
            WHERE ${eventType} LIKE replace(evt, '*', '%')
          )
      `;
    },

    /**
     * Disable a subscription (sets active = false).
     */
    async disableSubscription(id: string): Promise<void> {
      await db`
        UPDATE webhook_subscriptions
        SET active = false, updated_at = now()
        WHERE id = ${id}::uuid
      `;
    },

    /**
     * Enable a subscription (sets active = true).
     */
    async enableSubscription(id: string): Promise<void> {
      await db`
        UPDATE webhook_subscriptions
        SET active = true, updated_at = now()
        WHERE id = ${id}::uuid
      `;
    },

    // ── Deliveries ─────────────────────────────────────────────────────

    /**
     * Create a new delivery record.
     */
    async createDelivery(data: CreateWebhookDeliveryData): Promise<WebhookDelivery> {
      const [row] = await db<WebhookDelivery[]>`
        INSERT INTO webhook_deliveries (
          subscription_id,
          event_id,
          event_type,
          payload
        )
        VALUES (
          ${data.subscription_id}::uuid,
          ${data.event_id ?? null},
          ${data.event_type},
          ${JSON.stringify(data.payload)}
        )
        ON CONFLICT (subscription_id, event_id) DO NOTHING
        RETURNING *
      `;
      if (!row) {
        throw new Error('delivery_conflict');
      }
      return row;
    },

    /**
     * Find deliveries that are pending or retrying and due for processing.
     */
    async findPendingDeliveries(limit = 50): Promise<WebhookDelivery[]> {
      return db<WebhookDelivery[]>`
        SELECT * FROM webhook_deliveries
        WHERE status IN ('pending', 'retrying')
          AND (next_retry_at IS NULL OR next_retry_at <= now())
        ORDER BY created_at ASC
        LIMIT ${limit}
      `;
    },

    /**
     * Update a delivery record (status, attempt count, response, etc.).
     */
    async updateDelivery(id: string, data: UpdateWebhookDeliveryData): Promise<void> {
      await db`
        UPDATE webhook_deliveries
        SET
          status = COALESCE(${data.status ?? null}, status),
          attempts = COALESCE(${data.attempts ?? null}, attempts),
          last_attempt_at = COALESCE(${data.last_attempt_at ?? null}, last_attempt_at),
          next_retry_at = ${data.next_retry_at === undefined ? db`next_retry_at` : data.next_retry_at},
          response_status = ${data.response_status === undefined ? db`response_status` : data.response_status},
          response_body = ${data.response_body === undefined ? db`response_body` : data.response_body}
        WHERE id = ${id}::uuid
      `;
    },

    /**
     * List deliveries for a subscription, most recent first.
     */
    async listDeliveries(subscriptionId: string, limit = 50): Promise<WebhookDelivery[]> {
      return db<WebhookDelivery[]>`
        SELECT * FROM webhook_deliveries
        WHERE subscription_id = ${subscriptionId}::uuid
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    },

    async listDeliveryEventIds(subscriptionId: string, eventIds: string[]): Promise<string[]> {
      if (eventIds.length === 0) return [];
      const rows = await db<{ event_id: string | null }[]>`
        SELECT event_id
        FROM webhook_deliveries
        WHERE subscription_id = ${subscriptionId}::uuid
          AND event_id = ANY(${eventIds})
      `;
      return rows.map((r) => r.event_id).filter((id): id is string => Boolean(id));
    },

    /**
     * Count consecutive failures for a subscription (from most recent delivery backwards).
     * Used to auto-disable subscriptions after sustained failures.
     */
    async countConsecutiveFailures(subscriptionId: string): Promise<number> {
      const rows = await db<{ status: string }[]>`
        SELECT status FROM webhook_deliveries
        WHERE subscription_id = ${subscriptionId}::uuid
        ORDER BY created_at DESC
        LIMIT 20
      `;
      let count = 0;
      for (const r of rows) {
        if (r.status === 'failed') {
          count++;
        } else {
          break;
        }
      }
      return count;
    },

    // ── Replays ───────────────────────────────────────────────────────

    async createReplay(data: CreateWebhookReplayData): Promise<WebhookReplay> {
      const [row] = await db<WebhookReplay[]>`
        INSERT INTO webhook_replays (
          subscription_id,
          org_id,
          project_id,
          status,
          requested,
          processed,
          replayed,
          deduplicated,
          failed,
          from_event_id,
          from_time,
          to_time,
          max_events,
          dry_run,
          created_by,
          started_at,
          completed_at
        )
        VALUES (
          ${data.subscription_id}::uuid,
          ${data.org_id},
          ${data.project_id ?? null},
          ${data.status ?? 'queued'},
          ${data.requested ?? 0},
          ${data.processed ?? 0},
          ${data.replayed ?? 0},
          ${data.deduplicated ?? 0},
          ${data.failed ?? 0},
          ${data.from_event_id ?? null},
          ${data.from_time ?? null},
          ${data.to_time ?? null},
          ${data.max_events ?? 5000},
          ${data.dry_run ?? false},
          ${data.created_by ?? null},
          ${data.started_at ?? null},
          ${data.completed_at ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    async findReplayById(id: string): Promise<WebhookReplay | null> {
      const [row] = await db<WebhookReplay[]>`
        SELECT * FROM webhook_replays WHERE id = ${id}::uuid
      `;
      return row ?? null;
    },

    async updateReplay(id: string, data: UpdateWebhookReplayData): Promise<WebhookReplay | null> {
      const [row] = await db<WebhookReplay[]>`
        UPDATE webhook_replays
        SET
          status = COALESCE(${data.status ?? null}, status),
          requested = COALESCE(${data.requested ?? null}, requested),
          processed = COALESCE(${data.processed ?? null}, processed),
          replayed = COALESCE(${data.replayed ?? null}, replayed),
          deduplicated = COALESCE(${data.deduplicated ?? null}, deduplicated),
          failed = COALESCE(${data.failed ?? null}, failed),
          started_at = ${data.started_at === undefined ? db`started_at` : data.started_at},
          completed_at = ${data.completed_at === undefined ? db`completed_at` : data.completed_at},
          updated_at = NOW()
        WHERE id = ${id}::uuid
        RETURNING *
      `;
      return row ?? null;
    },

    async countActiveReplays(subscriptionId: string): Promise<number> {
      const [row] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int as count
        FROM webhook_replays
        WHERE subscription_id = ${subscriptionId}::uuid
          AND status IN ('queued', 'running')
      `;
      return row?.count ?? 0;
    },
  };
}
