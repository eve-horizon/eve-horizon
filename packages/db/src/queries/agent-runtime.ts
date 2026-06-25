import type { Db } from '../client.js';

export interface AgentRuntimePod {
  org_id: string;
  pod_name: string;
  status: string;
  capacity: number;
  last_heartbeat_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface AgentPlacement {
  org_id: string;
  agent_id: string;
  pod_name: string;
  shard_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export function agentRuntimePodQueries(db: Db) {
  return {
    async listByOrg(orgId: string): Promise<AgentRuntimePod[]> {
      return db<AgentRuntimePod[]>`
        SELECT * FROM agent_runtime_pods
        WHERE org_id = ${orgId}
        ORDER BY pod_name ASC
      `;
    },

    async upsert(payload: {
      org_id: string;
      pod_name: string;
      status: string;
      capacity: number;
      last_heartbeat_at: Date;
    }): Promise<AgentRuntimePod> {
      const [row] = await db<AgentRuntimePod[]>`
        INSERT INTO agent_runtime_pods (
          org_id,
          pod_name,
          status,
          capacity,
          last_heartbeat_at
        )
        VALUES (
          ${payload.org_id},
          ${payload.pod_name},
          ${payload.status},
          ${payload.capacity},
          ${payload.last_heartbeat_at}
        )
        ON CONFLICT (org_id, pod_name) DO UPDATE SET
          status = EXCLUDED.status,
          capacity = EXCLUDED.capacity,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at,
          updated_at = NOW()
        RETURNING *
      `;
      return row;
    },
  };
}

export function agentPlacementQueries(db: Db) {
  return {
    async findByOrgAndAgent(orgId: string, agentId: string): Promise<AgentPlacement | null> {
      const [row] = await db<AgentPlacement[]>`
        SELECT * FROM agent_placements
        WHERE org_id = ${orgId} AND agent_id = ${agentId}
        LIMIT 1
      `;
      return row ?? null;
    },
    async listByOrg(orgId: string): Promise<AgentPlacement[]> {
      return db<AgentPlacement[]>`
        SELECT * FROM agent_placements
        WHERE org_id = ${orgId}
        ORDER BY agent_id ASC
      `;
    },

    async upsert(payload: {
      org_id: string;
      agent_id: string;
      pod_name: string;
      shard_key: string | null;
    }): Promise<AgentPlacement> {
      const [row] = await db<AgentPlacement[]>`
        INSERT INTO agent_placements (
          org_id,
          agent_id,
          pod_name,
          shard_key
        )
        VALUES (
          ${payload.org_id},
          ${payload.agent_id},
          ${payload.pod_name},
          ${payload.shard_key}
        )
        ON CONFLICT (org_id, agent_id) DO UPDATE SET
          pod_name = EXCLUDED.pod_name,
          shard_key = EXCLUDED.shard_key,
          updated_at = NOW()
        RETURNING *
      `;
      return row;
    },
  };
}
