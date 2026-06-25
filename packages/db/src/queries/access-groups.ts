import type { Db } from '../client.js';

export type AccessGroupMemberPrincipalType = 'user' | 'service_principal';

export interface AccessGroup {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AccessGroupMember {
  group_id: string;
  principal_type: AccessGroupMemberPrincipalType;
  principal_id: string;
  added_by: string | null;
  created_at: Date;
}

export interface AccessGroupMemberWithGroup extends AccessGroupMember {
  group_name: string;
  group_slug: string;
  org_id: string;
}

export function accessGroupQueries(db: Db) {
  return {
    async createGroup(
      id: string,
      orgId: string,
      name: string,
      slug: string,
      description: string | null,
      createdBy: string | null,
    ): Promise<AccessGroup> {
      const [row] = await db<AccessGroup[]>`
        INSERT INTO access_groups (id, org_id, name, slug, description, created_by)
        VALUES (${id}, ${orgId}, ${name}, ${slug}, ${description}, ${createdBy})
        RETURNING *
      `;
      return row;
    },

    async listGroups(orgId: string): Promise<AccessGroup[]> {
      return db<AccessGroup[]>`
        SELECT *
        FROM access_groups
        WHERE org_id = ${orgId}
        ORDER BY slug ASC, created_at ASC
      `;
    },

    async findGroupById(orgId: string, groupId: string): Promise<AccessGroup | null> {
      const [row] = await db<AccessGroup[]>`
        SELECT *
        FROM access_groups
        WHERE org_id = ${orgId} AND id = ${groupId}
        LIMIT 1
      `;
      return row ?? null;
    },

    async findGroupBySlug(orgId: string, slug: string): Promise<AccessGroup | null> {
      const [row] = await db<AccessGroup[]>`
        SELECT *
        FROM access_groups
        WHERE org_id = ${orgId} AND slug = ${slug}
        LIMIT 1
      `;
      return row ?? null;
    },

    async updateGroup(
      orgId: string,
      groupId: string,
      updates: {
        name?: string;
        slug?: string;
        description?: string | null;
      },
    ): Promise<AccessGroup | null> {
      const [row] = await db<AccessGroup[]>`
        UPDATE access_groups
        SET
          name = COALESCE(${updates.name ?? null}, name),
          slug = COALESCE(${updates.slug ?? null}, slug),
          description = CASE
            WHEN ${updates.description !== undefined}
              THEN ${updates.description ?? null}
            ELSE description
          END,
          updated_at = NOW()
        WHERE org_id = ${orgId} AND id = ${groupId}
        RETURNING *
      `;
      return row ?? null;
    },

    async deleteGroup(orgId: string, groupId: string): Promise<boolean> {
      const rows = await db<{ id: string }[]>`
        DELETE FROM access_groups
        WHERE org_id = ${orgId} AND id = ${groupId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async addMember(
      groupId: string,
      principalType: AccessGroupMemberPrincipalType,
      principalId: string,
      addedBy: string | null,
    ): Promise<AccessGroupMember> {
      const [row] = await db<AccessGroupMember[]>`
        INSERT INTO access_group_members (group_id, principal_type, principal_id, added_by)
        VALUES (${groupId}, ${principalType}, ${principalId}, ${addedBy})
        ON CONFLICT (group_id, principal_type, principal_id)
        DO UPDATE SET added_by = COALESCE(EXCLUDED.added_by, access_group_members.added_by)
        RETURNING *
      `;
      return row;
    },

    async listMembers(groupId: string): Promise<AccessGroupMember[]> {
      return db<AccessGroupMember[]>`
        SELECT *
        FROM access_group_members
        WHERE group_id = ${groupId}
        ORDER BY principal_type ASC, principal_id ASC
      `;
    },

    async removeMember(
      groupId: string,
      principalType: AccessGroupMemberPrincipalType,
      principalId: string,
    ): Promise<boolean> {
      const rows = await db<{ group_id: string }[]>`
        DELETE FROM access_group_members
        WHERE group_id = ${groupId}
          AND principal_type = ${principalType}
          AND principal_id = ${principalId}
        RETURNING group_id
      `;
      return rows.length > 0;
    },

    async listGroupsForPrincipal(
      orgId: string,
      principalType: AccessGroupMemberPrincipalType,
      principalId: string,
    ): Promise<AccessGroupMemberWithGroup[]> {
      return db<AccessGroupMemberWithGroup[]>`
        SELECT
          gm.group_id,
          gm.principal_type,
          gm.principal_id,
          gm.added_by,
          gm.created_at,
          g.name AS group_name,
          g.slug AS group_slug,
          g.org_id
        FROM access_group_members gm
        JOIN access_groups g ON g.id = gm.group_id
        WHERE g.org_id = ${orgId}
          AND gm.principal_type = ${principalType}
          AND gm.principal_id = ${principalId}
        ORDER BY g.slug ASC
      `;
    },

    async listGroupIdsForPrincipal(
      orgId: string,
      principalType: AccessGroupMemberPrincipalType,
      principalId: string,
    ): Promise<string[]> {
      const rows = await db<{ group_id: string }[]>`
        SELECT gm.group_id
        FROM access_group_members gm
        JOIN access_groups g ON g.id = gm.group_id
        WHERE g.org_id = ${orgId}
          AND gm.principal_type = ${principalType}
          AND gm.principal_id = ${principalId}
      `;
      return rows.map((row) => row.group_id);
    },
  };
}

