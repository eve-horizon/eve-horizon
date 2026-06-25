import type { Db } from '../client.js';

export interface Project {
  id: string;
  org_id: string;
  name: string;
  slug: string;                 // 4-8 chars, CamelCase, used in job IDs
  repo_url: string;
  branch: string;
  branding: Record<string, unknown> | null;
  auth_config: Record<string, unknown> | null;
  deleted_at: Date | null;      // soft delete timestamp
  created_at: Date;
  updated_at: Date;
}

export interface ListProjectsOptions {
  org_id?: string;
  name?: string;
  limit?: number;
  offset?: number;
  include_deleted?: boolean;
}

export function projectQueries(db: Db) {
  return {
    async findById(id: string, options?: { include_deleted?: boolean }): Promise<Project | null> {
      const includeDeleted = options?.include_deleted ?? false;
      const [row] = includeDeleted
        ? await db<Project[]>`SELECT * FROM projects WHERE id = ${id}`
        : await db<Project[]>`SELECT * FROM projects WHERE id = ${id} AND deleted_at IS NULL`;
      return row ?? null;
    },

    async findByOrgAndName(
      orgId: string,
      name: string,
      options?: { include_deleted?: boolean },
    ): Promise<Project | null> {
      const includeDeleted = options?.include_deleted ?? false;
      const [row] = includeDeleted
        ? await db<Project[]>`
            SELECT * FROM projects
            WHERE org_id = ${orgId} AND name = ${name}
          `
        : await db<Project[]>`
            SELECT * FROM projects
            WHERE org_id = ${orgId} AND name = ${name} AND deleted_at IS NULL
          `;
      return row ?? null;
    },

    async findByOrgAndSlug(
      orgId: string,
      slug: string,
      options?: { include_deleted?: boolean },
    ): Promise<Project | null> {
      const includeDeleted = options?.include_deleted ?? false;
      const [row] = includeDeleted
        ? await db<Project[]>`
            SELECT * FROM projects
            WHERE org_id = ${orgId} AND slug = ${slug}
          `
        : await db<Project[]>`
            SELECT * FROM projects
            WHERE org_id = ${orgId} AND slug = ${slug} AND deleted_at IS NULL
          `;
      return row ?? null;
    },

    async findFirstByOrg(
      orgId: string,
    ): Promise<Project | null> {
      const [row] = await db<Project[]>`
        SELECT * FROM projects
        WHERE org_id = ${orgId} AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `;
      return row ?? null;
    },

    async create(
      project: Omit<Project, 'created_at' | 'updated_at' | 'deleted_at' | 'branding' | 'auth_config'>,
    ): Promise<Project> {
      const [row] = await db<Project[]>`
        INSERT INTO projects (id, org_id, name, slug, repo_url, branch)
        VALUES (
          ${project.id},
          ${project.org_id},
          ${project.name},
          ${project.slug},
          ${project.repo_url},
          ${project.branch}
        )
        RETURNING *
      `;
      return row;
    },

    async list(options: ListProjectsOptions = {}): Promise<Project[]> {
      const limit = options.limit ?? 10;
      const offset = options.offset ?? 0;
      const includeDeleted = options.include_deleted ?? false;
      const orgId = options.org_id;
      const name = options.name;

      if (includeDeleted) {
        if (orgId && name) {
          return db<Project[]>`
            SELECT * FROM projects
            WHERE org_id = ${orgId} AND name = ${name}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
        }

        if (orgId) {
          return db<Project[]>`
            SELECT * FROM projects
            WHERE org_id = ${orgId}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
        }

        if (name) {
          return db<Project[]>`
            SELECT * FROM projects
            WHERE name = ${name}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
        }

        return db<Project[]>`
          SELECT * FROM projects
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (orgId && name) {
        return db<Project[]>`
          SELECT * FROM projects
          WHERE deleted_at IS NULL AND org_id = ${orgId} AND name = ${name}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (orgId) {
        return db<Project[]>`
          SELECT * FROM projects
          WHERE deleted_at IS NULL AND org_id = ${orgId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (name) {
        return db<Project[]>`
          SELECT * FROM projects
          WHERE deleted_at IS NULL AND name = ${name}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return db<Project[]>`
        SELECT * FROM projects
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async update(
      id: string,
      updates: { name?: string; repo_url?: string; branch?: string; deleted?: boolean },
    ): Promise<Project | null> {
      const name = updates.name ?? null;
      const repoUrl = updates.repo_url ?? null;
      const branch = updates.branch ?? null;
      // Convert boolean deleted to timestamp
      const deletedAt = updates.deleted === true ? new Date() : updates.deleted === false ? null : undefined;

      const [row] = deletedAt === undefined
        // No delete change
        ? await db<Project[]>`
            UPDATE projects
            SET
              name = COALESCE(${name}, name),
              repo_url = COALESCE(${repoUrl}, repo_url),
              branch = COALESCE(${branch}, branch),
              updated_at = NOW()
            WHERE id = ${id}
            RETURNING *
          `
        // Include deleted_at change
        : await db<Project[]>`
            UPDATE projects
            SET
              name = COALESCE(${name}, name),
              repo_url = COALESCE(${repoUrl}, repo_url),
              branch = COALESCE(${branch}, branch),
              deleted_at = ${deletedAt},
              updated_at = NOW()
            WHERE id = ${id}
            RETURNING *
          `;
      return row ?? null;
    },

    async updateBranding(
      id: string,
      branding: Record<string, unknown> | null,
    ): Promise<Project | null> {
      const brandingValue = branding === null ? null : db.json(branding as never);
      const [row] = await db<Project[]>`
        UPDATE projects
        SET branding = ${brandingValue}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async updateAuthConfig(
      id: string,
      authConfig: Record<string, unknown> | null,
    ): Promise<Project | null> {
      const authConfigValue = authConfig === null ? null : db.json(authConfig as never);
      const [row] = await db<Project[]>`
        UPDATE projects
        SET auth_config = ${authConfigValue}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async hardDelete(id: string): Promise<boolean> {
      const result = await db`DELETE FROM projects WHERE id = ${id}`;
      return result.count > 0;
    },

  };
}
