import type { Db } from '../client.js';

export interface PackRef {
  id: string;
  source: string;
  ref: string;
}

export interface ProjectAgentConfig {
  id: string;
  project_id: string;
  agents_yaml: string;
  teams_yaml: string;
  chat_yaml: string;
  x_eve_yaml: string | null;
  parsed_agents: Record<string, unknown> | null;
  parsed_teams: Record<string, unknown> | null;
  parsed_routes: unknown[] | null;
  pack_refs: PackRef[] | null;
  git_sha: string | null;
  branch: string | null;
  git_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export function agentConfigQueries(db: Db) {
  return {
    async findLatestByProject(projectId: string): Promise<ProjectAgentConfig | null> {
      const [row] = await db<ProjectAgentConfig[]>`
        SELECT * FROM project_agent_configs
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    async create(
      config: Omit<ProjectAgentConfig, 'created_at' | 'updated_at'>,
    ): Promise<ProjectAgentConfig> {
      const [row] = await db<ProjectAgentConfig[]>`
        INSERT INTO project_agent_configs (
          id,
          project_id,
          agents_yaml,
          teams_yaml,
          chat_yaml,
          x_eve_yaml,
          parsed_agents,
          parsed_teams,
          parsed_routes,
          pack_refs,
          git_sha,
          branch,
          git_ref
        )
        VALUES (
          ${config.id},
          ${config.project_id},
          ${config.agents_yaml},
          ${config.teams_yaml},
          ${config.chat_yaml},
          ${config.x_eve_yaml},
          ${config.parsed_agents ? db.json(config.parsed_agents as never) : null},
          ${config.parsed_teams ? db.json(config.parsed_teams as never) : null},
          ${config.parsed_routes ? db.json(config.parsed_routes as never) : null},
          ${config.pack_refs ? db.json(config.pack_refs as never) : null},
          ${config.git_sha},
          ${config.branch},
          ${config.git_ref}
        )
        RETURNING *
      `;
      return row;
    },
  };
}
