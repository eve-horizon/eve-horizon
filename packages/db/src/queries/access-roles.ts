import type { Db } from '../client.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type AccessBindingPrincipalType = 'user' | 'service_principal' | 'group';
export type AccessBindingScope = Record<string, unknown> | null;

export interface AccessRole {
  id: string;
  org_id: string;
  name: string;
  scope: 'org' | 'project';
  permissions: string[];
  description: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AccessBinding {
  id: string;
  role_id: string;
  principal_type: AccessBindingPrincipalType;
  principal_id: string;
  project_id: string | null;
  scope_json: AccessBindingScope;
  created_by: string | null;
  created_at: Date;
}

export interface AccessBindingWithRole extends AccessBinding {
  role_name: string;
  role_permissions: string[];
  matched_via?: 'direct' | 'group';
  matched_group_id?: string | null;
  matched_group_slug?: string | null;
}

// ── Queries ────────────────────────────────────────────────────────────────

export function accessRoleQueries(db: Db) {
  return {
    // ── Role CRUD ──────────────────────────────────────────────────────

    async createRole(
      id: string,
      orgId: string,
      name: string,
      scope: 'org' | 'project',
      permissions: string[],
      description: string | null,
      createdBy: string | null,
    ): Promise<AccessRole> {
      const [row] = await db<AccessRole[]>`
        INSERT INTO access_roles (id, org_id, name, scope, permissions, description, created_by)
        VALUES (${id}, ${orgId}, ${name}, ${scope}, ${permissions}, ${description}, ${createdBy})
        RETURNING *
      `;
      return row;
    },

    async listRoles(orgId: string): Promise<AccessRole[]> {
      return db<AccessRole[]>`
        SELECT * FROM access_roles
        WHERE org_id = ${orgId}
        ORDER BY name ASC
      `;
    },

    async getRole(orgId: string, roleId: string): Promise<AccessRole | null> {
      const [row] = await db<AccessRole[]>`
        SELECT * FROM access_roles
        WHERE org_id = ${orgId} AND id = ${roleId}
      `;
      return row ?? null;
    },

    async getRoleByName(orgId: string, name: string): Promise<AccessRole | null> {
      const [row] = await db<AccessRole[]>`
        SELECT * FROM access_roles
        WHERE org_id = ${orgId} AND name = ${name}
      `;
      return row ?? null;
    },

    async updateRole(
      orgId: string,
      roleId: string,
      updates: { permissions?: string[]; description?: string | null },
    ): Promise<AccessRole | null> {
      const permissionsVal = updates.permissions ?? null;
      const descriptionVal = updates.description !== undefined ? updates.description : null;
      const hasPermissions = updates.permissions !== undefined;
      const hasDescription = updates.description !== undefined;

      const [row] = await db<AccessRole[]>`
        UPDATE access_roles
        SET
          permissions = CASE WHEN ${hasPermissions} THEN ${permissionsVal}::text[] ELSE permissions END,
          description = CASE WHEN ${hasDescription} THEN ${descriptionVal} ELSE description END,
          updated_at = now()
        WHERE org_id = ${orgId} AND id = ${roleId}
        RETURNING *
      `;
      return row ?? null;
    },

    async deleteRole(orgId: string, roleId: string): Promise<boolean> {
      const rows = await db`
        DELETE FROM access_roles
        WHERE org_id = ${orgId} AND id = ${roleId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    // ── Binding CRUD ───────────────────────────────────────────────────

    async createBinding(
      id: string,
      roleId: string,
      principalType: AccessBindingPrincipalType,
      principalId: string,
      projectId: string | null,
      scopeJson: AccessBindingScope,
      createdBy: string | null,
    ): Promise<AccessBinding> {
      const [row] = await db<AccessBinding[]>`
        INSERT INTO access_bindings (
          id,
          role_id,
          principal_type,
          principal_id,
          project_id,
          scope_json,
          created_by
        )
        VALUES (
          ${id},
          ${roleId},
          ${principalType},
          ${principalId},
          ${projectId},
          ${scopeJson ? db.json(scopeJson as never) : null},
          ${createdBy}
        )
        RETURNING *
      `;
      return row;
    },

    async listBindings(params: {
      orgId?: string;
      projectId?: string;
      principalType?: string;
      principalId?: string;
    }): Promise<AccessBindingWithRole[]> {
      const orgIdParam = params.orgId ?? null;
      const projectIdParam = params.projectId ?? null;
      const principalTypeParam = params.principalType ?? null;
      const principalIdParam = params.principalId ?? null;

      return db<AccessBindingWithRole[]>`
        SELECT
          b.id,
          b.role_id,
          b.principal_type,
          b.principal_id,
          b.project_id,
          b.scope_json,
          b.created_by,
          b.created_at,
          r.name AS role_name,
          r.permissions AS role_permissions
        FROM access_bindings b
        JOIN access_roles r ON r.id = b.role_id
        WHERE
          (${orgIdParam}::text IS NULL OR r.org_id = ${orgIdParam})
          AND (${projectIdParam}::text IS NULL OR b.project_id = ${projectIdParam})
          AND (${principalTypeParam}::text IS NULL OR b.principal_type = ${principalTypeParam})
          AND (${principalIdParam}::text IS NULL OR b.principal_id = ${principalIdParam})
        ORDER BY b.created_at ASC
      `;
    },

    async listApplicableBindings(params: {
      orgId: string;
      principalType: 'user' | 'service_principal' | 'group';
      principalId: string;
      projectId?: string;
    }): Promise<AccessBindingWithRole[]> {
      const projectIdParam = params.projectId ?? null;

      if (params.principalType === 'group') {
        return db<AccessBindingWithRole[]>`
          SELECT
            b.id,
            b.role_id,
            b.principal_type,
            b.principal_id,
            b.project_id,
            b.scope_json,
            b.created_by,
            b.created_at,
            r.name AS role_name,
            r.permissions AS role_permissions,
            'direct' AS matched_via,
            NULL::text AS matched_group_id,
            NULL::text AS matched_group_slug
          FROM access_bindings b
          JOIN access_roles r ON r.id = b.role_id
          WHERE r.org_id = ${params.orgId}
            AND b.principal_type = 'group'
            AND b.principal_id = ${params.principalId}
            AND (
              b.project_id IS NULL
              OR (${projectIdParam}::text IS NOT NULL AND b.project_id = ${projectIdParam})
            )
          ORDER BY b.created_at ASC
        `;
      }

      return db<AccessBindingWithRole[]>`
        WITH direct_bindings AS (
          SELECT
            b.id,
            b.role_id,
            b.principal_type,
            b.principal_id,
            b.project_id,
            b.scope_json,
            b.created_by,
            b.created_at,
            r.name AS role_name,
            r.permissions AS role_permissions,
            'direct'::text AS matched_via,
            NULL::text AS matched_group_id,
            NULL::text AS matched_group_slug
          FROM access_bindings b
          JOIN access_roles r ON r.id = b.role_id
          WHERE r.org_id = ${params.orgId}
            AND b.principal_type = ${params.principalType}
            AND b.principal_id = ${params.principalId}
        ),
        inherited_group_bindings AS (
          SELECT
            b.id,
            b.role_id,
            b.principal_type,
            b.principal_id,
            b.project_id,
            b.scope_json,
            b.created_by,
            b.created_at,
            r.name AS role_name,
            r.permissions AS role_permissions,
            'group'::text AS matched_via,
            g.id AS matched_group_id,
            g.slug AS matched_group_slug
          FROM access_bindings b
          JOIN access_roles r ON r.id = b.role_id
          JOIN access_groups g ON g.id = b.principal_id AND g.org_id = r.org_id
          JOIN access_group_members gm ON gm.group_id = g.id
          WHERE r.org_id = ${params.orgId}
            AND b.principal_type = 'group'
            AND gm.principal_type = ${params.principalType}
            AND gm.principal_id = ${params.principalId}
        )
        SELECT *
        FROM (
          SELECT * FROM direct_bindings
          UNION ALL
          SELECT * FROM inherited_group_bindings
        ) AS resolved
        WHERE (
          resolved.project_id IS NULL
          OR (${projectIdParam}::text IS NOT NULL AND resolved.project_id = ${projectIdParam})
        )
        ORDER BY resolved.created_at ASC
      `;
    },

    async deleteBinding(bindingId: string): Promise<boolean> {
      const rows = await db`
        DELETE FROM access_bindings
        WHERE id = ${bindingId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async deleteBindingsForPrincipal(
      orgId: string,
      principalType: AccessBindingPrincipalType,
      principalId: string,
    ): Promise<number> {
      const rows = await db<{ id: string }[]>`
        DELETE FROM access_bindings b
        USING access_roles r
        WHERE b.role_id = r.id
          AND r.org_id = ${orgId}
          AND b.principal_type = ${principalType}
          AND b.principal_id = ${principalId}
        RETURNING b.id
      `;
      return rows.length;
    },

    async deleteBindingByMatch(
      roleId: string,
      principalType: string,
      principalId: string,
      projectId: string | null,
    ): Promise<boolean> {
      const rows = await db`
        DELETE FROM access_bindings
        WHERE role_id = ${roleId}
          AND principal_type = ${principalType}
          AND principal_id = ${principalId}
          AND COALESCE(project_id, '') = COALESCE(${projectId}::text, '')
        RETURNING id
      `;
      return rows.length > 0;
    },

    // ── Permission resolution ──────────────────────────────────────────

    async getEffectiveCustomPermissions(
      principalType: 'user' | 'service_principal',
      principalId: string,
      orgId: string,
      projectId?: string,
    ): Promise<string[]> {
      const bindings = await this.listApplicableBindings({
        orgId,
        principalType,
        principalId,
        projectId,
      });

      const union = new Set<string>();
      for (const binding of bindings) {
        for (const permission of binding.role_permissions) {
          union.add(permission);
        }
      }

      return [...union];
    },
  };
}
