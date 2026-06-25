import type { Db } from '../client.js';

export interface Team {
  project_id: string;
  id: string;
  lead_agent_id: string | null;
  dispatch_json: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface TeamMember {
  project_id: string;
  team_id: string;
  agent_id: string;
  created_at: Date;
}

export function teamQueries(db: Db) {
  return {
    async listByProject(projectId: string): Promise<Team[]> {
      return db<Team[]>`
        SELECT * FROM teams
        WHERE project_id = ${projectId}
        ORDER BY id ASC
      `;
    },

    async deleteByProject(projectId: string): Promise<void> {
      await db`
        DELETE FROM teams
        WHERE project_id = ${projectId}
      `;
    },

    async findByOrgAndId(orgId: string, teamId: string): Promise<(Team & { project_id: string }) | null> {
      const [row] = await db<Team[]>`
        SELECT t.*
        FROM teams t
        JOIN projects p ON p.id = t.project_id
        WHERE p.org_id = ${orgId} AND t.id = ${teamId}
        LIMIT 1
      `;
      return row ?? null;
    },

    async insert(team: Omit<Team, 'created_at' | 'updated_at'>): Promise<Team> {
      const [row] = await db<Team[]>`
        INSERT INTO teams (
          project_id,
          id,
          lead_agent_id,
          dispatch_json
        )
        VALUES (
          ${team.project_id},
          ${team.id},
          ${team.lead_agent_id},
          ${team.dispatch_json ? db.json(team.dispatch_json as never) : null}
        )
        RETURNING *
      `;
      return row;
    },

    async hardDelete(projectId: string, id: string): Promise<boolean> {
      const result = await db`DELETE FROM teams WHERE project_id = ${projectId} AND id = ${id}`;
      return result.count > 0;
    },
  };
}

export function teamMemberQueries(db: Db) {
  return {
    async listByProject(projectId: string): Promise<TeamMember[]> {
      return db<TeamMember[]>`
        SELECT * FROM team_members
        WHERE project_id = ${projectId}
        ORDER BY team_id ASC
      `;
    },

    async deleteByProject(projectId: string): Promise<void> {
      await db`
        DELETE FROM team_members
        WHERE project_id = ${projectId}
      `;
    },

    async insert(member: Omit<TeamMember, 'created_at'>): Promise<TeamMember> {
      const [row] = await db<TeamMember[]>`
        INSERT INTO team_members (
          project_id,
          team_id,
          agent_id
        )
        VALUES (
          ${member.project_id},
          ${member.team_id},
          ${member.agent_id}
        )
        RETURNING *
      `;
      return row;
    },
  };
}
