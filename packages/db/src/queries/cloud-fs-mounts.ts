import type { Db } from '../client.js';

export interface CloudFsMount {
  id: string;
  org_id: string;
  project_id: string | null;
  integration_id: string;
  provider: string;
  root_folder_id: string;
  root_folder_path: string | null;
  mode: 'read_only' | 'write_only' | 'read_write';
  auto_index: boolean;
  changes_cursor: string | null;
  watch_channel_id: string | null;
  watch_expiry: Date | null;
  label: string | null;
  metadata_json: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export function cloudFsMountQueries(db: Db) {
  return {
    async listByOrg(orgId: string): Promise<CloudFsMount[]> {
      return db<CloudFsMount[]>`
        SELECT * FROM cloud_fs_mounts
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
      `;
    },

    async listByProject(orgId: string, projectId: string): Promise<CloudFsMount[]> {
      return db<CloudFsMount[]>`
        SELECT * FROM cloud_fs_mounts
        WHERE org_id = ${orgId}
          AND (project_id = ${projectId} OR project_id IS NULL)
        ORDER BY created_at DESC
      `;
    },

    async findById(id: string): Promise<CloudFsMount | undefined> {
      const [row] = await db<CloudFsMount[]>`
        SELECT * FROM cloud_fs_mounts
        WHERE id = ${id}
        LIMIT 1
      `;
      return row;
    },

    async findByOrgAndProvider(orgId: string, provider: string): Promise<CloudFsMount[]> {
      return db<CloudFsMount[]>`
        SELECT * FROM cloud_fs_mounts
        WHERE org_id = ${orgId}
          AND provider = ${provider}
        ORDER BY created_at DESC
      `;
    },

    async insert(
      mount: Omit<CloudFsMount, 'created_at' | 'updated_at'>,
    ): Promise<CloudFsMount> {
      const [row] = await db<CloudFsMount[]>`
        INSERT INTO cloud_fs_mounts (
          id,
          org_id,
          project_id,
          integration_id,
          provider,
          root_folder_id,
          root_folder_path,
          mode,
          auto_index,
          changes_cursor,
          watch_channel_id,
          watch_expiry,
          label,
          metadata_json,
          created_by
        )
        VALUES (
          ${mount.id},
          ${mount.org_id},
          ${mount.project_id},
          ${mount.integration_id},
          ${mount.provider},
          ${mount.root_folder_id},
          ${mount.root_folder_path},
          ${mount.mode},
          ${mount.auto_index},
          ${mount.changes_cursor},
          ${mount.watch_channel_id},
          ${mount.watch_expiry},
          ${mount.label},
          ${db.json(mount.metadata_json as never)},
          ${mount.created_by}
        )
        RETURNING *
      `;
      return row;
    },

    async update(
      id: string,
      updates: Partial<Pick<CloudFsMount, 'mode' | 'auto_index' | 'label' | 'metadata_json'>>,
    ): Promise<CloudFsMount | undefined> {
      const [row] = await db<CloudFsMount[]>`
        UPDATE cloud_fs_mounts
        SET mode          = COALESCE(${updates.mode ?? null}, mode),
            auto_index    = COALESCE(${updates.auto_index ?? null}, auto_index),
            label         = COALESCE(${updates.label ?? null}, label),
            metadata_json = CASE
                              WHEN ${updates.metadata_json !== undefined} THEN metadata_json || ${updates.metadata_json ? db.json(updates.metadata_json as never) : db.json({} as never)}
                              ELSE metadata_json
                            END,
            updated_at    = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row;
    },

    async updateCursor(id: string, cursor: string | null): Promise<CloudFsMount | undefined> {
      const [row] = await db<CloudFsMount[]>`
        UPDATE cloud_fs_mounts
        SET changes_cursor = ${cursor},
            updated_at     = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row;
    },

    async updateWatch(
      id: string,
      channelId: string | null,
      expiry: Date | null,
    ): Promise<CloudFsMount | undefined> {
      const [row] = await db<CloudFsMount[]>`
        UPDATE cloud_fs_mounts
        SET watch_channel_id = ${channelId},
            watch_expiry     = ${expiry},
            updated_at       = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row;
    },

    async remove(id: string): Promise<void> {
      await db`
        DELETE FROM cloud_fs_mounts
        WHERE id = ${id}
      `;
    },
  };
}
