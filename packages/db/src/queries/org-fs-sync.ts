import type { Db } from '../client.js';

export interface OrgFsLinkScope {
  allow_prefixes: string[];
  read_only_prefixes?: string[];
  [key: string]: unknown;
}

export interface OrgSyncDevice {
  id: string;
  org_id: string;
  device_name: string;
  platform: string | null;
  client_version: string | null;
  public_key: string;
  status: 'active' | 'revoked';
  last_seen_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrgSyncEnrollmentToken {
  token: string;
  org_id: string;
  device_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export interface OrgSyncLink {
  id: string;
  org_id: string;
  device_id: string;
  owner_principal_type: 'user' | 'service_principal' | 'system';
  owner_principal_id: string | null;
  mode: 'two_way' | 'push_only' | 'pull_only';
  status: 'active' | 'paused' | 'revoked';
  local_path: string;
  remote_path: string;
  scope_json: OrgFsLinkScope;
  includes_json: string[];
  excludes_json: string[];
  last_cursor: number;
  backlog: number;
  lag_ms: number | null;
  metrics_json: Record<string, unknown>;
  last_synced_at: Date | null;
  last_heartbeat_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrgFsEvent {
  seq: number;
  id: string;
  org_id: string;
  link_id: string | null;
  device_id: string | null;
  event_type: string;
  path: string;
  content_hash: string | null;
  size_bytes: number | null;
  source_side: 'local' | 'remote' | 'system';
  metadata: Record<string, unknown>;
  storage_key: string | null;
  created_at: Date;
}

export interface OrgFsConflict {
  id: string;
  org_id: string;
  link_id: string | null;
  path: string;
  local_hash: string | null;
  remote_hash: string | null;
  status: 'open' | 'resolved';
  resolution: 'pick_local' | 'pick_remote' | 'manual' | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

export interface UpsertOrgSyncDeviceData {
  id: string;
  org_id: string;
  device_name: string;
  platform?: string | null;
  client_version?: string | null;
  public_key: string;
  created_by?: string | null;
}

export interface UpsertOrgSyncLinkData {
  id: string;
  org_id: string;
  device_id: string;
  mode: 'two_way' | 'push_only' | 'pull_only';
  status?: 'active' | 'paused' | 'revoked';
  local_path: string;
  remote_path: string;
  owner_principal_type: OrgSyncLink['owner_principal_type'];
  owner_principal_id?: string | null;
  scope_json: OrgFsLinkScope;
  includes_json?: string[];
  excludes_json?: string[];
  created_by?: string | null;
}

export interface CreateOrgFsEventData {
  seq?: number;
  id: string;
  org_id: string;
  link_id?: string | null;
  device_id?: string | null;
  event_type: string;
  path: string;
  content_hash?: string | null;
  size_bytes?: number | null;
  source_side: 'local' | 'remote' | 'system';
  metadata?: Record<string, unknown>;
  storage_key?: string | null;
}

export interface CreateOrgFsConflictData {
  id: string;
  org_id: string;
  link_id?: string | null;
  path: string;
  local_hash?: string | null;
  remote_hash?: string | null;
}

export function orgFsSyncQueries(db: Db) {
  return {
    async upsertDevice(data: UpsertOrgSyncDeviceData): Promise<OrgSyncDevice> {
      const [row] = await db<OrgSyncDevice[]>`
        INSERT INTO org_sync_devices (
          id,
          org_id,
          device_name,
          platform,
          client_version,
          public_key,
          status,
          created_by
        )
        VALUES (
          ${data.id},
          ${data.org_id},
          ${data.device_name},
          ${data.platform ?? null},
          ${data.client_version ?? null},
          ${data.public_key},
          'active',
          ${data.created_by ?? null}
        )
        ON CONFLICT (org_id, public_key) DO UPDATE
        SET
          device_name = EXCLUDED.device_name,
          platform = EXCLUDED.platform,
          client_version = EXCLUDED.client_version,
          status = 'active',
          updated_at = NOW()
        RETURNING *
      `;
      return row;
    },

    async findDeviceById(orgId: string, deviceId: string): Promise<OrgSyncDevice | null> {
      const [row] = await db<OrgSyncDevice[]>`
        SELECT * FROM org_sync_devices
        WHERE org_id = ${orgId} AND id = ${deviceId}
      `;
      return row ?? null;
    },

    async createEnrollmentToken(
      orgId: string,
      deviceId: string,
      token: string,
      expiresAt: Date,
    ): Promise<OrgSyncEnrollmentToken> {
      const [row] = await db<OrgSyncEnrollmentToken[]>`
        INSERT INTO org_sync_enrollment_tokens (
          token,
          org_id,
          device_id,
          expires_at
        )
        VALUES (
          ${token},
          ${orgId},
          ${deviceId},
          ${expiresAt}
        )
        RETURNING *
      `;
      return row;
    },

    async consumeEnrollmentToken(orgId: string, token: string): Promise<boolean> {
      const result = await db<{ token: string }[]>`
        UPDATE org_sync_enrollment_tokens
        SET consumed_at = NOW()
        WHERE token = ${token}
          AND org_id = ${orgId}
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING token
      `;
      return result.length > 0;
    },

    async deleteExpiredEnrollmentTokens(orgId: string): Promise<number> {
      const rows = await db<{ token: string }[]>`
        DELETE FROM org_sync_enrollment_tokens
        WHERE org_id = ${orgId}
          AND expires_at <= NOW()
        RETURNING token
      `;
      return rows.length;
    },

    async upsertLink(data: UpsertOrgSyncLinkData): Promise<OrgSyncLink> {
      const [row] = await db<OrgSyncLink[]>`
        INSERT INTO org_sync_links (
          id,
          org_id,
          device_id,
          mode,
          status,
          local_path,
          remote_path,
          owner_principal_type,
          owner_principal_id,
          scope_json,
          includes_json,
          excludes_json,
          created_by
        )
        VALUES (
          ${data.id},
          ${data.org_id},
          ${data.device_id},
          ${data.mode},
          ${data.status ?? 'active'},
          ${data.local_path},
          ${data.remote_path},
          ${data.owner_principal_type},
          ${data.owner_principal_id ?? null},
          ${db.json(data.scope_json as never)},
          ${db.json((data.includes_json ?? []) as never)},
          ${db.json((data.excludes_json ?? []) as never)},
          ${data.created_by ?? null}
        )
        ON CONFLICT (org_id, device_id, remote_path) DO UPDATE
        SET
          mode = EXCLUDED.mode,
          status = EXCLUDED.status,
          local_path = EXCLUDED.local_path,
          owner_principal_type = EXCLUDED.owner_principal_type,
          owner_principal_id = EXCLUDED.owner_principal_id,
          scope_json = EXCLUDED.scope_json,
          includes_json = EXCLUDED.includes_json,
          excludes_json = EXCLUDED.excludes_json,
          updated_at = NOW()
        RETURNING *
      `;
      return row;
    },

    async listLinks(orgId: string): Promise<OrgSyncLink[]> {
      return db<OrgSyncLink[]>`
        SELECT * FROM org_sync_links
        WHERE org_id = ${orgId}
        ORDER BY updated_at DESC
      `;
    },

    async findLinkById(orgId: string, linkId: string): Promise<OrgSyncLink | null> {
      const [row] = await db<OrgSyncLink[]>`
        SELECT * FROM org_sync_links
        WHERE org_id = ${orgId}
          AND id = ${linkId}
      `;
      return row ?? null;
    },

    async updateLink(
      orgId: string,
      linkId: string,
      updates: {
        mode?: OrgSyncLink['mode'];
        status?: OrgSyncLink['status'];
        scope_json?: OrgFsLinkScope;
        includes_json?: string[];
        excludes_json?: string[];
      },
    ): Promise<OrgSyncLink | null> {
      const [row] = await db<OrgSyncLink[]>`
        UPDATE org_sync_links
        SET
          mode = COALESCE(${updates.mode ?? null}, mode),
          status = COALESCE(${updates.status ?? null}, status),
          scope_json = COALESCE(${updates.scope_json ? db.json(updates.scope_json as never) : null}, scope_json),
          includes_json = COALESCE(${updates.includes_json ? db.json(updates.includes_json as never) : null}, includes_json),
          excludes_json = COALESCE(${updates.excludes_json ? db.json(updates.excludes_json as never) : null}, excludes_json),
          updated_at = NOW()
        WHERE org_id = ${orgId}
          AND id = ${linkId}
        RETURNING *
      `;
      return row ?? null;
    },

    async deleteLink(orgId: string, linkId: string): Promise<boolean> {
      const rows = await db<{ id: string }[]>`
        DELETE FROM org_sync_links
        WHERE org_id = ${orgId}
          AND id = ${linkId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async updateLinkHeartbeat(
      orgId: string,
      linkId: string,
      updates: { cursor?: number; backlog?: number; lag_ms?: number },
    ): Promise<OrgSyncLink | null> {
      const [row] = await db<OrgSyncLink[]>`
        UPDATE org_sync_links
        SET
          last_heartbeat_at = NOW(),
          last_cursor = COALESCE(${updates.cursor ?? null}, last_cursor),
          backlog = COALESCE(${updates.backlog ?? null}, backlog),
          lag_ms = COALESCE(${updates.lag_ms ?? null}, lag_ms),
          last_synced_at = ${updates.cursor !== undefined ? db`NOW()` : db`last_synced_at`},
          updated_at = NOW()
        WHERE org_id = ${orgId}
          AND id = ${linkId}
        RETURNING *
      `;
      return row ?? null;
    },

    async updateLinkMetrics(
      orgId: string,
      linkId: string,
      metrics: Record<string, unknown>,
    ): Promise<OrgSyncLink | null> {
      const [row] = await db<OrgSyncLink[]>`
        UPDATE org_sync_links
        SET
          metrics_json = metrics_json || ${db.json(metrics as never)},
          updated_at = NOW()
        WHERE org_id = ${orgId}
          AND id = ${linkId}
        RETURNING *
      `;
      return row ?? null;
    },

    async countLinksByStatus(orgId: string): Promise<{ active: number; paused: number; revoked: number }> {
      const rows = await db<Array<{ status: OrgSyncLink['status']; count: string }>>`
        SELECT status, COUNT(*)::text AS count
        FROM org_sync_links
        WHERE org_id = ${orgId}
        GROUP BY status
      `;
      let active = 0;
      let paused = 0;
      let revoked = 0;
      for (const row of rows) {
        const count = Number(row.count);
        if (row.status === 'active') active = count;
        if (row.status === 'paused') paused = count;
        if (row.status === 'revoked') revoked = count;
      }
      return { active, paused, revoked };
    },

    async createEvent(data: CreateOrgFsEventData): Promise<OrgFsEvent> {
      const [row] = await db<OrgFsEvent[]>`
        INSERT INTO org_fs_events (
          id,
          org_id,
          link_id,
          device_id,
          event_type,
          path,
          content_hash,
          size_bytes,
          source_side,
          metadata,
          storage_key
        )
        VALUES (
          ${data.id},
          ${data.org_id},
          ${data.link_id ?? null},
          ${data.device_id ?? null},
          ${data.event_type},
          ${data.path},
          ${data.content_hash ?? null},
          ${data.size_bytes ?? null},
          ${data.source_side},
          ${db.json((data.metadata ?? {}) as never)},
          ${data.storage_key ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    async listEvents(orgId: string, afterSeq = 0, limit = 100): Promise<OrgFsEvent[]> {
      return db<OrgFsEvent[]>`
        SELECT * FROM org_fs_events
        WHERE org_id = ${orgId}
          AND seq > ${afterSeq}
        ORDER BY seq ASC
        LIMIT ${limit}
      `;
    },

    async getLatestSeq(orgId: string): Promise<number> {
      const [row] = await db<Array<{ seq: number | null }>>`
        SELECT MAX(seq) AS seq FROM org_fs_events
        WHERE org_id = ${orgId}
      `;
      return row?.seq ?? 0;
    },

    async createConflict(data: CreateOrgFsConflictData): Promise<OrgFsConflict> {
      const [row] = await db<OrgFsConflict[]>`
        INSERT INTO org_fs_conflicts (
          id,
          org_id,
          link_id,
          path,
          local_hash,
          remote_hash
        )
        VALUES (
          ${data.id},
          ${data.org_id},
          ${data.link_id ?? null},
          ${data.path},
          ${data.local_hash ?? null},
          ${data.remote_hash ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    async listConflicts(orgId: string, status?: OrgFsConflict['status']): Promise<OrgFsConflict[]> {
      if (status) {
        return db<OrgFsConflict[]>`
          SELECT * FROM org_fs_conflicts
          WHERE org_id = ${orgId}
            AND status = ${status}
          ORDER BY created_at DESC
        `;
      }
      return db<OrgFsConflict[]>`
        SELECT * FROM org_fs_conflicts
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
      `;
    },

    async findConflictById(orgId: string, conflictId: string): Promise<OrgFsConflict | null> {
      const [row] = await db<OrgFsConflict[]>`
        SELECT * FROM org_fs_conflicts
        WHERE org_id = ${orgId}
          AND id = ${conflictId}
      `;
      return row ?? null;
    },

    async resolveConflict(
      orgId: string,
      conflictId: string,
      resolution: Exclude<OrgFsConflict['resolution'], null>,
      resolvedBy: string | null,
    ): Promise<OrgFsConflict | null> {
      const [row] = await db<OrgFsConflict[]>`
        UPDATE org_fs_conflicts
        SET
          status = 'resolved',
          resolution = ${resolution},
          resolved_by = ${resolvedBy},
          resolved_at = NOW()
        WHERE org_id = ${orgId}
          AND id = ${conflictId}
        RETURNING *
      `;
      return row ?? null;
    },
  };
}
