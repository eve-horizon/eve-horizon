import type { Db } from '../client.js';

export interface OrgFsObject {
  id: string;
  org_id: string;
  path: string;
  storage_key: string;
  content_hash: string;
  size_bytes: bigint;
  mime_type: string;
  deleted_at: Date | null;
  updated_at: Date;
  created_at: Date;
}

export type CreateOrgFsObjectInput = {
  id: string;
  org_id: string;
  path: string;
  storage_key: string;
  content_hash: string;
  size_bytes: number | bigint;
  mime_type?: string;
};

export function orgFsObjectQueries(db: Db) {
  return {
    // Upsert an object (insert or update by org_id + path)
    async upsert(input: CreateOrgFsObjectInput): Promise<OrgFsObject> {
      const [row] = await db<OrgFsObject[]>`
        INSERT INTO org_fs_objects (
          id,
          org_id,
          path,
          storage_key,
          content_hash,
          size_bytes,
          mime_type
        )
        VALUES (
          ${input.id},
          ${input.org_id},
          ${input.path},
          ${input.storage_key},
          ${input.content_hash},
          ${Number(input.size_bytes)},
          ${input.mime_type ?? 'application/octet-stream'}
        )
        ON CONFLICT (org_id, path) DO UPDATE
        SET
          storage_key  = EXCLUDED.storage_key,
          content_hash = EXCLUDED.content_hash,
          size_bytes   = EXCLUDED.size_bytes,
          mime_type    = EXCLUDED.mime_type,
          deleted_at   = NULL,
          updated_at   = NOW()
        RETURNING *
      `;
      return row;
    },

    // Find by org + path (returns null if not found or soft-deleted)
    async findByPath(orgId: string, path: string): Promise<OrgFsObject | null> {
      const [row] = await db<OrgFsObject[]>`
        SELECT * FROM org_fs_objects
        WHERE org_id = ${orgId}
          AND path = ${path}
          AND deleted_at IS NULL
      `;
      return row ?? null;
    },

    // List objects for an org, optionally filtered by path prefix.
    // Sorted by path ASC, paginated by after (path cursor).
    async list(
      orgId: string,
      opts?: {
        prefix?: string;
        limit?: number;
        after?: string;
      },
    ): Promise<OrgFsObject[]> {
      const limit = opts?.limit ?? 100;
      const prefix = opts?.prefix;
      const after = opts?.after;

      if (prefix !== undefined && after !== undefined) {
        return db<OrgFsObject[]>`
          SELECT * FROM org_fs_objects
          WHERE org_id = ${orgId}
            AND deleted_at IS NULL
            AND path LIKE ${prefix + '%'}
            AND path > ${after}
          ORDER BY path ASC
          LIMIT ${limit}
        `;
      }

      if (prefix !== undefined) {
        return db<OrgFsObject[]>`
          SELECT * FROM org_fs_objects
          WHERE org_id = ${orgId}
            AND deleted_at IS NULL
            AND path LIKE ${prefix + '%'}
          ORDER BY path ASC
          LIMIT ${limit}
        `;
      }

      if (after !== undefined) {
        return db<OrgFsObject[]>`
          SELECT * FROM org_fs_objects
          WHERE org_id = ${orgId}
            AND deleted_at IS NULL
            AND path > ${after}
          ORDER BY path ASC
          LIMIT ${limit}
        `;
      }

      return db<OrgFsObject[]>`
        SELECT * FROM org_fs_objects
        WHERE org_id = ${orgId}
          AND deleted_at IS NULL
        ORDER BY path ASC
        LIMIT ${limit}
      `;
    },

    // Soft-delete an object
    async softDelete(orgId: string, path: string): Promise<OrgFsObject | null> {
      const [row] = await db<OrgFsObject[]>`
        UPDATE org_fs_objects
        SET
          deleted_at = NOW(),
          updated_at = NOW()
        WHERE org_id = ${orgId}
          AND path = ${path}
          AND deleted_at IS NULL
        RETURNING *
      `;
      return row ?? null;
    },
  };
}
