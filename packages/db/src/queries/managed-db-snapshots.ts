import type { Db } from '../client.js';

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

export interface ManagedDbSnapshot {
  id: string;
  tenant_id: string;
  org_id: string;
  project_id: string;
  env_id: string;
  instance_id: string;
  created_by: string | null;
  trigger: string;
  status: string;
  s3_bucket: string | null;
  s3_key: string | null;
  size_bytes: number | null;
  db_size_bytes: number | null;
  pg_version: string | null;
  error_message: string | null;
  retention: string;
  expires_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface CreateSnapshotInput {
  id: string;
  tenant_id: string;
  org_id: string;
  project_id: string;
  env_id: string;
  instance_id: string;
  created_by?: string | null;
  trigger: 'manual' | 'scheduled' | 'pre_delete' | 'pre_reset';
  s3_bucket: string;
  s3_key: string;
  retention?: string;
  expires_at?: Date;
}

// ---------------------------------------------------------------------------
// Query factory
// ---------------------------------------------------------------------------

export function managedDbSnapshotQueries(db: Db) {
  return {
    // -----------------------------------------------------------------------
    // Snapshot CRUD
    // -----------------------------------------------------------------------

    async createSnapshot(input: CreateSnapshotInput): Promise<ManagedDbSnapshot> {
      const [row] = await db<ManagedDbSnapshot[]>`
        INSERT INTO managed_db_snapshots (
          id, tenant_id, org_id, project_id, env_id, instance_id,
          created_by, trigger, s3_bucket, s3_key,
          retention, expires_at
        )
        VALUES (
          ${input.id}, ${input.tenant_id}, ${input.org_id}, ${input.project_id},
          ${input.env_id}, ${input.instance_id},
          ${input.created_by ?? null}, ${input.trigger}, ${input.s3_bucket}, ${input.s3_key},
          ${input.retention ?? '30d'}, ${input.expires_at ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    async findSnapshotById(id: string): Promise<ManagedDbSnapshot | null> {
      const [row] = await db<ManagedDbSnapshot[]>`
        SELECT * FROM managed_db_snapshots WHERE id = ${id}
      `;
      return row ?? null;
    },

    async listSnapshotsByTenant(
      tenantId: string,
      opts?: { status?: string; limit?: number },
    ): Promise<ManagedDbSnapshot[]> {
      const status = opts?.status ?? null;
      const limit = opts?.limit ?? 50;
      return db<ManagedDbSnapshot[]>`
        SELECT * FROM managed_db_snapshots
        WHERE tenant_id = ${tenantId}
          AND (${status}::text IS NULL OR status = ${status})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    },

    async listSnapshotsByEnv(
      envId: string,
      opts?: { status?: string; limit?: number },
    ): Promise<ManagedDbSnapshot[]> {
      const status = opts?.status ?? null;
      const limit = opts?.limit ?? 50;
      return db<ManagedDbSnapshot[]>`
        SELECT * FROM managed_db_snapshots
        WHERE env_id = ${envId}
          AND (${status}::text IS NULL OR status = ${status})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    },

    async listSnapshotsByOrg(
      orgId: string,
      opts?: { limit?: number },
    ): Promise<ManagedDbSnapshot[]> {
      const limit = opts?.limit ?? 50;
      return db<ManagedDbSnapshot[]>`
        SELECT * FROM managed_db_snapshots
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    },

    // -----------------------------------------------------------------------
    // Status transitions
    // -----------------------------------------------------------------------

    async completeSnapshot(
      id: string,
      result: { size_bytes: number; db_size_bytes: number; pg_version: string },
    ): Promise<ManagedDbSnapshot | null> {
      const [row] = await db<ManagedDbSnapshot[]>`
        UPDATE managed_db_snapshots
        SET status = 'completed',
            size_bytes = ${result.size_bytes},
            db_size_bytes = ${result.db_size_bytes},
            pg_version = ${result.pg_version},
            completed_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async failSnapshot(id: string, errorMessage: string): Promise<ManagedDbSnapshot | null> {
      const [row] = await db<ManagedDbSnapshot[]>`
        UPDATE managed_db_snapshots
        SET status = 'failed',
            error_message = ${errorMessage},
            completed_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    // -----------------------------------------------------------------------
    // Deletion
    // -----------------------------------------------------------------------

    async deleteSnapshot(id: string): Promise<boolean> {
      const [row] = await db<{ id: string }[]>`
        DELETE FROM managed_db_snapshots
        WHERE id = ${id}
        RETURNING id
      `;
      return !!row;
    },

    // -----------------------------------------------------------------------
    // Lifecycle helpers
    // -----------------------------------------------------------------------

    async findExpiredSnapshots(limit?: number): Promise<ManagedDbSnapshot[]> {
      const cap = limit ?? 100;
      return db<ManagedDbSnapshot[]>`
        SELECT * FROM managed_db_snapshots
        WHERE expires_at < NOW()
          AND status = 'completed'
        ORDER BY expires_at ASC
        LIMIT ${cap}
      `;
    },

    async findStaleInProgressSnapshots(thresholdMinutes: number): Promise<ManagedDbSnapshot[]> {
      return db<ManagedDbSnapshot[]>`
        SELECT * FROM managed_db_snapshots
        WHERE status = 'in_progress'
          AND created_at < NOW() - make_interval(mins => ${thresholdMinutes})
        ORDER BY created_at ASC
      `;
    },

    async countInProgressByInstance(instanceId: string): Promise<number> {
      const [row] = await db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM managed_db_snapshots
        WHERE instance_id = ${instanceId}
          AND status = 'in_progress'
      `;
      return parseInt(row?.count ?? '0', 10);
    },

    async countInProgressByTenant(tenantId: string): Promise<number> {
      const [row] = await db<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM managed_db_snapshots
        WHERE tenant_id = ${tenantId}
          AND status = 'in_progress'
      `;
      return parseInt(row?.count ?? '0', 10);
    },

    // -----------------------------------------------------------------------
    // Cross-table helper
    // -----------------------------------------------------------------------

    async updateTenantLastSnapshotAt(tenantId: string): Promise<void> {
      await db`
        UPDATE managed_db_tenants
        SET last_snapshot_at = NOW()
        WHERE id = ${tenantId}
      `;
    },
  };
}
