import type { Db } from '../client.js';

export interface Agent {
  project_id: string;
  id: string;
  slug: string | null;
  alias: string | null;
  name: string | null;
  description: string | null;
  role: string | null;
  workflow: string | null;
  harness_profile: string | null;
  policies_json: Record<string, unknown> | null;
  access_json: Record<string, unknown> | null;
  gateway_policy: string;
  gateway_clients: string[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrgAgentDirectoryItem {
  project_id: string;
  project_slug: string;
  project_name: string;
  agent_id: string;
  agent_slug: string | null;
  agent_alias: string | null;
  agent_name: string | null;
  agent_description: string | null;
  role: string | null;
  workflow: string | null;
  gateway_policy: string;
  gateway_clients: string[] | null;
}

export function agentQueries(db: Db) {
  return {
    async listByProject(projectId: string): Promise<Agent[]> {
      return db<Agent[]>`
        SELECT * FROM agents
        WHERE project_id = ${projectId}
        ORDER BY id ASC
      `;
    },

    async listDirectoryByOrg(orgId: string): Promise<OrgAgentDirectoryItem[]> {
      return db<OrgAgentDirectoryItem[]>`
        SELECT
          a.project_id,
          p.slug as project_slug,
          p.name as project_name,
          a.id as agent_id,
          a.slug as agent_slug,
          a.alias as agent_alias,
          a.name as agent_name,
          a.description as agent_description,
          a.role,
          a.workflow,
          a.gateway_policy,
          a.gateway_clients
        FROM agents a
        JOIN projects p ON p.id = a.project_id
        WHERE p.org_id = ${orgId}
        ORDER BY p.slug ASC, a.slug NULLS LAST, a.id ASC
      `;
    },

    async deleteByProject(projectId: string): Promise<void> {
      await db`
        DELETE FROM agents
        WHERE project_id = ${projectId}
      `;
    },

    async insert(agent: Omit<Agent, 'created_at' | 'updated_at'>): Promise<Agent> {
      const [row] = await db<Agent[]>`
        INSERT INTO agents (
          project_id,
          id,
          slug,
          alias,
          name,
          description,
          role,
          workflow,
          harness_profile,
          policies_json,
          access_json,
          gateway_policy,
          gateway_clients
        )
        VALUES (
          ${agent.project_id},
          ${agent.id},
          ${agent.slug},
          ${agent.alias},
          ${agent.name},
          ${agent.description},
          ${agent.role},
          ${agent.workflow},
          ${agent.harness_profile},
          ${agent.policies_json ? db.json(agent.policies_json as never) : null},
          ${agent.access_json ? db.json(agent.access_json as never) : null},
          ${agent.gateway_policy},
          ${agent.gateway_clients}
        )
        RETURNING *
      `;
      return row;
    },

    async findByOrgAndSlug(orgId: string, slug: string): Promise<Agent | null> {
      const [row] = await db<Agent[]>`
        SELECT a.*
        FROM agents a
        JOIN projects p ON p.id = a.project_id
        WHERE p.org_id = ${orgId} AND a.slug = ${slug}
        LIMIT 1
      `;
      return row ?? null;
    },

    async listByOrgAndSlugs(orgId: string, slugs: string[]): Promise<Agent[]> {
      if (slugs.length === 0) {
        return [];
      }
      return db<Agent[]>`
        SELECT a.*
        FROM agents a
        JOIN projects p ON p.id = a.project_id
        WHERE p.org_id = ${orgId}
          AND a.slug = ANY(${slugs})
      `;
    },

    async findByOrgAndAlias(orgId: string, alias: string): Promise<Agent | null> {
      const normalizedAlias = alias.trim().toLowerCase();
      const [row] = await db<Agent[]>`
        SELECT a.*
        FROM agents a
        JOIN projects p ON p.id = a.project_id
        WHERE p.org_id = ${orgId} AND lower(a.alias) = ${normalizedAlias}
        LIMIT 1
      `;
      return row ?? null;
    },

    async listByOrgAndAliases(orgId: string, aliases: string[]): Promise<Agent[]> {
      const normalizedAliases = aliases.map((a) => a.trim().toLowerCase());
      if (normalizedAliases.length === 0) return [];
      return db<Agent[]>`
        SELECT a.*
        FROM agents a
        JOIN projects p ON p.id = a.project_id
        WHERE p.org_id = ${orgId} AND lower(a.alias) = ANY(${normalizedAliases})
      `;
    },

    async hardDelete(projectId: string, id: string): Promise<boolean> {
      const result = await db`DELETE FROM agents WHERE project_id = ${projectId} AND id = ${id}`;
      return result.count > 0;
    },

    async findByProjectAndId(projectId: string, agentId: string): Promise<Agent | null> {
      const [row] = await db<Agent[]>`
        SELECT * FROM agents
        WHERE project_id = ${projectId} AND id = ${agentId}
        LIMIT 1
      `;
      return row ?? null;
    },

    async findByProjectAndSlug(projectId: string, slug: string): Promise<Agent | null> {
      const [row] = await db<Agent[]>`
        SELECT * FROM agents
        WHERE project_id = ${projectId} AND slug = ${slug}
        LIMIT 1
      `;
      return row ?? null;
    },
  };
}
