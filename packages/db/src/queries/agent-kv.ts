import type { Db } from '../client.js';

export interface AgentKvEntry {
  id: string;
  org_id: string;
  agent_slug: string;
  namespace: string;
  key: string;
  value: Record<string, unknown> | unknown[] | string | number | boolean | null;
  ttl_seconds: number | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function agentKvQueries(db: Db) {
  return {
    async put(input: {
      org_id: string;
      agent_slug: string;
      namespace: string;
      key: string;
      value: unknown;
      ttl_seconds?: number | null;
    }): Promise<AgentKvEntry> {
      const ttl = typeof input.ttl_seconds === 'number' && Number.isFinite(input.ttl_seconds) && input.ttl_seconds > 0
        ? Math.floor(input.ttl_seconds)
        : null;

      const [row] = await db<AgentKvEntry[]>`
        INSERT INTO agent_kv (
          org_id,
          agent_slug,
          namespace,
          key,
          value,
          ttl_seconds,
          expires_at
        )
        VALUES (
          ${input.org_id},
          ${input.agent_slug},
          ${input.namespace},
          ${input.key},
          ${db.json((input.value ?? null) as never)},
          ${ttl},
          CASE
            WHEN ${ttl}::int IS NULL THEN NULL
            ELSE NOW() + make_interval(secs => ${ttl}::int)
          END
        )
        ON CONFLICT (org_id, agent_slug, namespace, key)
        DO UPDATE SET
          value = EXCLUDED.value,
          ttl_seconds = EXCLUDED.ttl_seconds,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
        RETURNING *
      `;
      return row;
    },

    async get(orgId: string, agentSlug: string, namespace: string, key: string): Promise<AgentKvEntry | null> {
      const [row] = await db<AgentKvEntry[]>`
        SELECT *
        FROM agent_kv
        WHERE org_id = ${orgId}
          AND agent_slug = ${agentSlug}
          AND namespace = ${namespace}
          AND key = ${key}
          AND (expires_at IS NULL OR expires_at > NOW())
      `;
      return row ?? null;
    },

    async list(orgId: string, agentSlug: string, namespace: string, limit = 100): Promise<AgentKvEntry[]> {
      return db<AgentKvEntry[]>`
        SELECT *
        FROM agent_kv
        WHERE org_id = ${orgId}
          AND agent_slug = ${agentSlug}
          AND namespace = ${namespace}
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    },

    async mget(orgId: string, agentSlug: string, namespace: string, keys: string[]): Promise<AgentKvEntry[]> {
      if (keys.length === 0) return [];

      return db<AgentKvEntry[]>`
        SELECT *
        FROM agent_kv
        WHERE org_id = ${orgId}
          AND agent_slug = ${agentSlug}
          AND namespace = ${namespace}
          AND key = ANY(${keys})
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY updated_at DESC
      `;
    },

    async delete(orgId: string, agentSlug: string, namespace: string, key: string): Promise<boolean> {
      const result = await db<{ id: string }[]>`
        DELETE FROM agent_kv
        WHERE org_id = ${orgId}
          AND agent_slug = ${agentSlug}
          AND namespace = ${namespace}
          AND key = ${key}
        RETURNING id
      `;
      return result.length > 0;
    },

    async purgeExpired(limit = 1000): Promise<number> {
      const rows = await db<{ id: string }[]>`
        DELETE FROM agent_kv
        WHERE id IN (
          SELECT id
          FROM agent_kv
          WHERE expires_at IS NOT NULL
            AND expires_at <= NOW()
          ORDER BY expires_at ASC
          LIMIT ${limit}
        )
        RETURNING id
      `;
      return rows.length;
    },
  };
}
