import type { Db } from '../client.js';

export interface OrgFsShareRow {
  id: string;
  org_id: string;
  path: string;
  label: string | null;
  created_by: string;
  expires_at: Date | null;
  accessed_at: Date | null;
  access_count: number;
  revoked_at: Date | null;
  created_at: Date;
}

export interface OrgFsPublicPathRow {
  id: string;
  org_id: string;
  path_prefix: string;
  label: string | null;
  created_by: string;
  created_at: Date;
}

export function orgFsShareQueries(db: Db) {
  return {
    async insert(row: Omit<OrgFsShareRow, 'accessed_at' | 'access_count' | 'revoked_at' | 'created_at'>): Promise<OrgFsShareRow> {
      const [result] = await db<OrgFsShareRow[]>`
        INSERT INTO org_fs_shares (id, org_id, path, label, created_by, expires_at)
        VALUES (${row.id}, ${row.org_id}, ${row.path}, ${row.label}, ${row.created_by}, ${row.expires_at})
        RETURNING *
      `;
      return result;
    },

    async findById(id: string): Promise<OrgFsShareRow | null> {
      const [result] = await db<OrgFsShareRow[]>`
        SELECT * FROM org_fs_shares WHERE id = ${id}
      `;
      return result ?? null;
    },

    async listActive(orgId: string): Promise<OrgFsShareRow[]> {
      return db<OrgFsShareRow[]>`
        SELECT * FROM org_fs_shares
        WHERE org_id = ${orgId}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
      `;
    },

    async revoke(id: string, orgId: string): Promise<OrgFsShareRow | null> {
      const [result] = await db<OrgFsShareRow[]>`
        UPDATE org_fs_shares
        SET revoked_at = NOW()
        WHERE id = ${id} AND org_id = ${orgId} AND revoked_at IS NULL
        RETURNING *
      `;
      return result ?? null;
    },

    async recordAccess(id: string): Promise<void> {
      await db`
        UPDATE org_fs_shares
        SET accessed_at = NOW(), access_count = access_count + 1
        WHERE id = ${id}
      `;
    },
  };
}

export function orgFsPublicPathQueries(db: Db) {
  return {
    async insert(row: Omit<OrgFsPublicPathRow, 'created_at'>): Promise<OrgFsPublicPathRow> {
      const [result] = await db<OrgFsPublicPathRow[]>`
        INSERT INTO org_fs_public_paths (id, org_id, path_prefix, label, created_by)
        VALUES (${row.id}, ${row.org_id}, ${row.path_prefix}, ${row.label}, ${row.created_by})
        ON CONFLICT (org_id, path_prefix) DO UPDATE SET label = EXCLUDED.label
        RETURNING *
      `;
      return result;
    },

    async listByOrg(orgId: string): Promise<OrgFsPublicPathRow[]> {
      return db<OrgFsPublicPathRow[]>`
        SELECT * FROM org_fs_public_paths WHERE org_id = ${orgId} ORDER BY path_prefix
      `;
    },

    async findById(id: string, orgId: string): Promise<OrgFsPublicPathRow | null> {
      const [result] = await db<OrgFsPublicPathRow[]>`
        SELECT * FROM org_fs_public_paths WHERE id = ${id} AND org_id = ${orgId}
      `;
      return result ?? null;
    },

    async deleteById(id: string, orgId: string): Promise<boolean> {
      const result = await db`
        DELETE FROM org_fs_public_paths WHERE id = ${id} AND org_id = ${orgId}
      `;
      return result.count > 0;
    },

    /** Returns the matching public path entry if `path` starts with any registered prefix */
    async resolveForPath(orgId: string, path: string): Promise<OrgFsPublicPathRow | null> {
      const [result] = await db<OrgFsPublicPathRow[]>`
        SELECT * FROM org_fs_public_paths
        WHERE org_id = ${orgId} AND ${path} LIKE path_prefix || '%'
        ORDER BY length(path_prefix) DESC
        LIMIT 1
      `;
      return result ?? null;
    },
  };
}
