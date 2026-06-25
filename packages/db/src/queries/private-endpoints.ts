import type { Db } from '../client.js';

export interface PrivateEndpoint {
  id: string;
  name: string;
  org_id: string;
  provider: string;
  hostname: string;
  port: number;
  protocol: string;
  status: string;
  status_msg: string | null;
  k8s_svc_name: string;
  k8s_namespace: string;
  k8s_dns: string | null;
  health_path: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export function privateEndpointQueries(db: Db) {
  return {
    async create(ep: Omit<PrivateEndpoint, 'created_at' | 'updated_at'>): Promise<PrivateEndpoint> {
      const [row] = await db<PrivateEndpoint[]>`
        INSERT INTO private_endpoints (
          id, name, org_id, provider, hostname, port, protocol,
          status, status_msg, k8s_svc_name, k8s_namespace, k8s_dns,
          health_path, metadata
        )
        VALUES (
          ${ep.id}, ${ep.name}, ${ep.org_id}, ${ep.provider},
          ${ep.hostname}, ${ep.port}, ${ep.protocol},
          ${ep.status}, ${ep.status_msg}, ${ep.k8s_svc_name},
          ${ep.k8s_namespace}, ${ep.k8s_dns},
          ${ep.health_path}, ${ep.metadata ? db.json(ep.metadata as never) : null}
        )
        RETURNING *
      `;
      return row;
    },

    async findById(id: string): Promise<PrivateEndpoint | null> {
      const [row] = await db<PrivateEndpoint[]>`
        SELECT * FROM private_endpoints WHERE id = ${id}
      `;
      return row ?? null;
    },

    async findByNameAndOrg(name: string, orgId: string): Promise<PrivateEndpoint | null> {
      const [row] = await db<PrivateEndpoint[]>`
        SELECT * FROM private_endpoints
        WHERE name = ${name} AND org_id = ${orgId}
      `;
      return row ?? null;
    },

    async listByOrg(orgId: string, limit = 100, offset = 0): Promise<PrivateEndpoint[]> {
      return db<PrivateEndpoint[]>`
        SELECT * FROM private_endpoints
        WHERE org_id = ${orgId}
        ORDER BY name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async countByOrg(orgId: string): Promise<number> {
      const [row] = await db<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM private_endpoints
        WHERE org_id = ${orgId}
      `;
      return parseInt(row.count, 10);
    },

    async updateStatus(id: string, status: string, statusMsg: string | null): Promise<PrivateEndpoint | null> {
      const [row] = await db<PrivateEndpoint[]>`
        UPDATE private_endpoints
        SET status = ${status}, status_msg = ${statusMsg}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async delete(id: string): Promise<boolean> {
      const result = await db`
        DELETE FROM private_endpoints WHERE id = ${id}
      `;
      return result.count > 0;
    },

    async deleteByNameAndOrg(name: string, orgId: string): Promise<boolean> {
      const result = await db`
        DELETE FROM private_endpoints
        WHERE name = ${name} AND org_id = ${orgId}
      `;
      return result.count > 0;
    },
  };
}
