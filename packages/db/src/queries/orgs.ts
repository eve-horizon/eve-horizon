import type { Db } from '../client.js';

export interface Org {
  id: string;
  name: string;
  slug: string;
  default_agent_slug: string | null;
  billing_config: Record<string, unknown> | null;
  deleted_at: Date | null;  // soft delete timestamp
  created_at: Date;
  updated_at: Date;
}

export interface ListOrgsOptions {
  limit?: number;
  offset?: number;
  include_deleted?: boolean;
  name?: string;
}

export function orgQueries(db: Db) {
  return {
    async findById(id: string, options?: { include_deleted?: boolean }): Promise<Org | null> {
      const includeDeleted = options?.include_deleted ?? false;
      const [row] = includeDeleted
        ? await db<Org[]>`SELECT * FROM orgs WHERE id = ${id}`
        : await db<Org[]>`SELECT * FROM orgs WHERE id = ${id} AND deleted_at IS NULL`;
      return row ?? null;
    },

    async findByName(name: string, options?: { include_deleted?: boolean }): Promise<Org | null> {
      const includeDeleted = options?.include_deleted ?? false;
      const [row] = includeDeleted
        ? await db<Org[]>`
            SELECT * FROM orgs
            WHERE LOWER(name) = LOWER(${name})
          `
        : await db<Org[]>`
            SELECT * FROM orgs
            WHERE LOWER(name) = LOWER(${name}) AND deleted_at IS NULL
          `;
      return row ?? null;
    },

    async findBySlug(slug: string, options?: { include_deleted?: boolean }): Promise<Org | null> {
      const includeDeleted = options?.include_deleted ?? false;
      const [row] = includeDeleted
        ? await db<Org[]>`SELECT * FROM orgs WHERE slug = ${slug}`
        : await db<Org[]>`SELECT * FROM orgs WHERE slug = ${slug} AND deleted_at IS NULL`;
      return row ?? null;
    },

    async create(org: Pick<Org, 'id' | 'name' | 'slug'>): Promise<Org> {
      const [row] = await db<Org[]>`
        INSERT INTO orgs (id, name, slug)
        VALUES (${org.id}, ${org.name}, ${org.slug})
        RETURNING *
      `;
      return row;
    },

    async ensure(org: Pick<Org, 'id' | 'name' | 'slug'>): Promise<Org> {
      const [row] = await db<Org[]>`
        INSERT INTO orgs (id, name, slug)
        VALUES (${org.id}, ${org.name}, ${org.slug})
        ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
        RETURNING *
      `;
      return row;
    },

    async list(options: ListOrgsOptions = {}): Promise<Org[]> {
      const limit = options.limit ?? 10;
      const offset = options.offset ?? 0;
      const includeDeleted = options.include_deleted ?? false;
      const name = options.name;

      if (includeDeleted) {
        if (name) {
          return db<Org[]>`
            SELECT * FROM orgs
            WHERE name = ${name}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
        }

        return db<Org[]>`
          SELECT * FROM orgs
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (name) {
        return db<Org[]>`
          SELECT * FROM orgs
          WHERE deleted_at IS NULL AND name = ${name}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return db<Org[]>`
        SELECT * FROM orgs
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async hardDelete(id: string): Promise<boolean> {
      const result = await db`DELETE FROM orgs WHERE id = ${id}`;
      return result.count > 0;
    },

    async update(
      id: string,
      updates: { name?: string; deleted?: boolean; default_agent_slug?: string | null; billing_config?: Record<string, unknown> | null },
    ): Promise<Org | null> {
      const name = updates.name ?? null;
      const shouldUpdateDefault = updates.default_agent_slug !== undefined;
      const defaultAgentSlug = updates.default_agent_slug ?? null;
      const shouldUpdateBillingConfig = updates.billing_config !== undefined;
      const billingConfig = updates.billing_config ?? null;
      const billingConfigValue = shouldUpdateBillingConfig
        ? (billingConfig === null ? null : db.json(billingConfig as never))
        : db`billing_config`;
      // Convert boolean deleted to timestamp
      const deletedAt = updates.deleted === true ? new Date() : updates.deleted === false ? null : undefined;

      const [row] = deletedAt === undefined
        // No delete change - just update name
        ? await db<Org[]>`
            UPDATE orgs
            SET
              name = COALESCE(${name}, name),
              default_agent_slug = ${shouldUpdateDefault ? defaultAgentSlug : db`default_agent_slug`},
              billing_config = ${billingConfigValue},
              updated_at = NOW()
            WHERE id = ${id}
            RETURNING *
          `
        // Update with deleted_at change
        : await db<Org[]>`
            UPDATE orgs
            SET
              name = COALESCE(${name}, name),
              default_agent_slug = ${shouldUpdateDefault ? defaultAgentSlug : db`default_agent_slug`},
              billing_config = ${billingConfigValue},
              deleted_at = ${deletedAt},
              updated_at = NOW()
            WHERE id = ${id}
            RETURNING *
          `;
      return row ?? null;
    },
  };
}
