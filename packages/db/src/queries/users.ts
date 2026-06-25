import type { Db } from '../client.js';

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserWithMemberships extends User {
  memberships: Array<{
    org_id: string;
    org_name: string;
    org_slug: string;
    role: string;
  }>;
  project_memberships: Array<{
    project_id: string;
    project_name: string;
    project_slug: string;
    org_slug: string;
    role: string;
  }>;
}

export function userQueries(db: Db) {
  return {
    async findById(id: string): Promise<User | null> {
      const [row] = await db<User[]>`SELECT * FROM users WHERE id = ${id}`;
      return row ?? null;
    },

    async findByEmail(email: string): Promise<User | null> {
      const [row] = await db<User[]>`SELECT * FROM users WHERE LOWER(email) = LOWER(${email})`;
      return row ?? null;
    },

    async create(user: Pick<User, 'id' | 'email' | 'display_name' | 'is_admin'>): Promise<User> {
      const [row] = await db<User[]>`
        INSERT INTO users (id, email, display_name, is_admin)
        VALUES (${user.id}, ${user.email}, ${user.display_name}, ${user.is_admin})
        RETURNING *
      `;
      return row;
    },

    async update(
      id: string,
      updates: { email?: string; display_name?: string | null; is_admin?: boolean },
    ): Promise<User | null> {
      const [row] = await db<User[]>`
        UPDATE users
        SET
          email = COALESCE(${updates.email ?? null}, email),
          display_name = COALESCE(${updates.display_name ?? null}, display_name),
          is_admin = COALESCE(${updates.is_admin ?? null}, is_admin),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async findFirstAdmin(): Promise<User | null> {
      const [row] = await db<User[]>`
        SELECT * FROM users WHERE is_admin = TRUE ORDER BY created_at ASC LIMIT 1
      `;
      return row ?? null;
    },

    async listAllWithMemberships(): Promise<UserWithMemberships[]> {
      // Two separate aggregations to avoid cross-product explosion
      const rows = await db`
        SELECT
          u.id,
          u.email,
          u.display_name,
          u.is_admin,
          u.created_at,
          u.updated_at,
          COALESCE(org_agg.memberships, '[]'::json) AS memberships,
          COALESCE(proj_agg.project_memberships, '[]'::json) AS project_memberships
        FROM users u
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'org_id', om.org_id,
              'org_name', o.name,
              'org_slug', o.slug,
              'role', om.role
            )
          ) AS memberships
          FROM org_memberships om
          JOIN orgs o ON o.id = om.org_id
          WHERE om.user_id = u.id
        ) org_agg ON true
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'project_id', pm.project_id,
              'project_name', p.name,
              'project_slug', p.slug,
              'org_slug', o.slug,
              'role', pm.role
            )
          ) AS project_memberships
          FROM project_memberships pm
          JOIN projects p ON p.id = pm.project_id
          JOIN orgs o ON o.id = p.org_id
          WHERE pm.user_id = u.id
        ) proj_agg ON true
        ORDER BY u.created_at ASC
      `;
      return rows as unknown as UserWithMemberships[];
    },

    async findByIdWithMemberships(userId: string): Promise<UserWithMemberships | null> {
      const rows = await db`
        SELECT
          u.id,
          u.email,
          u.display_name,
          u.is_admin,
          u.created_at,
          u.updated_at,
          COALESCE(org_agg.memberships, '[]'::json) AS memberships,
          COALESCE(proj_agg.project_memberships, '[]'::json) AS project_memberships
        FROM users u
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'org_id', om.org_id,
              'org_name', o.name,
              'org_slug', o.slug,
              'role', om.role
            )
          ) AS memberships
          FROM org_memberships om
          JOIN orgs o ON o.id = om.org_id
          WHERE om.user_id = u.id
        ) org_agg ON true
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'project_id', pm.project_id,
              'project_name', p.name,
              'project_slug', p.slug,
              'org_slug', o.slug,
              'role', pm.role
            )
          ) AS project_memberships
          FROM project_memberships pm
          JOIN projects p ON p.id = pm.project_id
          JOIN orgs o ON o.id = p.org_id
          WHERE pm.user_id = u.id
        ) proj_agg ON true
        WHERE u.id = ${userId}
      `;
      return (rows[0] as unknown as UserWithMemberships) ?? null;
    },
  };
}
