import type { Db } from '../client.js';

export interface ThreadSubscription {
  id: string;
  thread_id: string;
  subscriber_type: string;
  subscriber_id: string;
  created_at: Date;
}

export interface AgentThreadSubscription {
  thread_key: string;
  project_id: string;
  project_slug: string;
  project_name: string;
  agent_id: string;
  agent_slug: string | null;
  agent_name: string | null;
  agent_description: string | null;
  harness_profile: string | null;
}

export function threadSubscriptionQueries(db: Db) {
  return {
    async insert(subscription: Omit<ThreadSubscription, 'id' | 'created_at'>): Promise<ThreadSubscription | null> {
      const [row] = await db<ThreadSubscription[]>`
        INSERT INTO thread_subscriptions (
          thread_id,
          subscriber_type,
          subscriber_id
        )
        VALUES (
          ${subscription.thread_id},
          ${subscription.subscriber_type},
          ${subscription.subscriber_id}
        )
        ON CONFLICT (thread_id, subscriber_type, subscriber_id)
        DO NOTHING
        RETURNING *
      `;
      return row ?? null;
    },

    async deleteByThread(
      threadId: string,
      subscriberType: string,
      subscriberId: string,
    ): Promise<number> {
      const rows = await db<{ id: string }[]>`
        DELETE FROM thread_subscriptions
        WHERE thread_id = ${threadId}
          AND subscriber_type = ${subscriberType}
          AND subscriber_id = ${subscriberId}
        RETURNING id
      `;
      return rows.length;
    },

    async listAgentSubscriptionsByOrgAndThreadKeys(
      orgId: string,
      threadKeys: string[],
    ): Promise<AgentThreadSubscription[]> {
      if (threadKeys.length === 0) {
        return [];
      }
      return db<AgentThreadSubscription[]>`
        SELECT
          t.key as thread_key,
          t.project_id,
          p.slug as project_slug,
          p.name as project_name,
          a.id as agent_id,
          a.slug as agent_slug,
          a.name as agent_name,
          a.description as agent_description,
          a.harness_profile as harness_profile
        FROM thread_subscriptions s
        JOIN threads t ON t.id = s.thread_id
        JOIN projects p ON p.id = t.project_id
        JOIN agents a ON a.project_id = t.project_id AND a.id = s.subscriber_id
        WHERE p.org_id = ${orgId}
          AND s.subscriber_type = 'agent'
          AND t.key = ANY(${threadKeys})
        ORDER BY p.slug ASC, a.slug NULLS LAST, a.id ASC
      `;
    },
  };
}
