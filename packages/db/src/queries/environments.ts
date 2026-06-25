import type { Db } from '../client.js';

export type EnvironmentKind = 'standard' | 'preview';
export type EnvironmentStatus = 'active' | 'suspended' | 'terminated';

export interface Environment {
  id: string;
  project_id: string;
  name: string;                // e.g., 'staging', 'production', 'test', 'pr-123'
  type: 'persistent' | 'temporary';
  kind: EnvironmentKind;       // 'standard' = regular, 'preview' = PR preview
  namespace: string | null;    // K8s namespace like 'myapp-staging'
  db_ref: string | null;       // Reference to database definition in manifest
  overrides_json: Record<string, unknown> | null;  // Environment-specific config overrides
  labels_json: Record<string, string> | null;      // Arbitrary key-value metadata (PR info, etc.)
  current_release_id: string | null;  // FK to releases (when that table exists) — last known-ready / rollback base
  last_failed_release_id: string | null;
  last_applied_release_id: string | null;  // Release currently applied to cluster (success or fail)
  last_deploy_failure_json: Record<string, unknown> | null;  // Structured context of last deploy failure
  deploy_status: string;        // 'unknown' | 'deployed' | 'undeployed' | 'deploying' | 'undeploying' | 'failed'
  status: EnvironmentStatus;   // 'active' | 'suspended' | 'terminated'
  suspended_at: Date | null;
  suspension_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListEnvironmentsOptions {
  project_id?: string;
  name?: string;
  type?: 'persistent' | 'temporary';
  kind?: EnvironmentKind;
  limit?: number;
  offset?: number;
}

export function environmentQueries(db: Db) {
  return {
    async findById(id: string): Promise<Environment | null> {
      const [row] = await db<Environment[]>`SELECT * FROM environments WHERE id = ${id}`;
      return row ?? null;
    },

    async findByProjectAndName(
      projectId: string,
      name: string,
    ): Promise<Environment | null> {
      const [row] = await db<Environment[]>`
        SELECT * FROM environments
        WHERE project_id = ${projectId} AND name = ${name}
      `;
      return row ?? null;
    },

    async create(
      environment: Omit<Environment, 'created_at' | 'updated_at' | 'status' | 'suspended_at' | 'suspension_reason' | 'deploy_status'> & { deploy_status?: string },
    ): Promise<Environment> {
      const overridesJson = environment.overrides_json
        ? db.json(environment.overrides_json as never)
        : null;
      const labelsJson = environment.labels_json
        ? db.json(environment.labels_json as never)
        : null;

      const [row] = await db<Environment[]>`
        INSERT INTO environments (
          id,
          project_id,
          name,
          type,
          kind,
          namespace,
          db_ref,
          overrides_json,
          labels_json,
          current_release_id,
          last_failed_release_id
        )
        VALUES (
          ${environment.id},
          ${environment.project_id},
          ${environment.name},
          ${environment.type},
          ${environment.kind ?? 'standard'},
          ${environment.namespace},
          ${environment.db_ref},
          ${overridesJson},
          ${labelsJson},
          ${environment.current_release_id},
          ${environment.last_failed_release_id ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    async list(options: ListEnvironmentsOptions = {}): Promise<Environment[]> {
      const limit = options.limit ?? 100;
      const offset = options.offset ?? 0;
      const projectId = options.project_id;
      const name = options.name;
      const type = options.type;

      if (projectId && name && type) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId} AND name = ${name} AND type = ${type}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (projectId && name) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId} AND name = ${name}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (projectId && type) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId} AND type = ${type}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (projectId) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (name) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE name = ${name}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (type) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE type = ${type}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return db<Environment[]>`
        SELECT * FROM environments
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async update(
      id: string,
      updates: {
        name?: string;
        type?: 'persistent' | 'temporary';
        kind?: EnvironmentKind;
        namespace?: string | null;
        db_ref?: string | null;
        overrides_json?: Record<string, unknown> | null;
        labels_json?: Record<string, string> | null;
        current_release_id?: string | null;
        last_failed_release_id?: string | null;
        last_applied_release_id?: string | null;
        last_deploy_failure_json?: Record<string, unknown> | null;
        deploy_status?: string;
      },
    ): Promise<Environment | null> {
      // Build update fields dynamically
      const updateFields: ReturnType<typeof db>[] = [];

      if (updates.name !== undefined) {
        updateFields.push(db`name = ${updates.name}`);
      }
      if (updates.type !== undefined) {
        updateFields.push(db`type = ${updates.type}`);
      }
      if (updates.kind !== undefined) {
        updateFields.push(db`kind = ${updates.kind}`);
      }
      if (updates.namespace !== undefined) {
        updateFields.push(db`namespace = ${updates.namespace}`);
      }
      if (updates.db_ref !== undefined) {
        updateFields.push(db`db_ref = ${updates.db_ref}`);
      }
      if (updates.overrides_json !== undefined) {
        updateFields.push(
          updates.overrides_json === null
            ? db`overrides_json = NULL`
            : db`overrides_json = ${db.json(updates.overrides_json as never)}`
        );
      }
      if (updates.labels_json !== undefined) {
        updateFields.push(
          updates.labels_json === null
            ? db`labels_json = NULL`
            : db`labels_json = ${db.json(updates.labels_json as never)}`
        );
      }
      if (updates.current_release_id !== undefined) {
        updateFields.push(db`current_release_id = ${updates.current_release_id}`);
      }
      if (updates.last_failed_release_id !== undefined) {
        updateFields.push(db`last_failed_release_id = ${updates.last_failed_release_id}`);
      }
      if (updates.last_applied_release_id !== undefined) {
        updateFields.push(db`last_applied_release_id = ${updates.last_applied_release_id}`);
      }
      if (updates.last_deploy_failure_json !== undefined) {
        updateFields.push(
          updates.last_deploy_failure_json === null
            ? db`last_deploy_failure_json = NULL`
            : db`last_deploy_failure_json = ${db.json(updates.last_deploy_failure_json as never)}`,
        );
      }
      if (updates.deploy_status !== undefined) {
        updateFields.push(db`deploy_status = ${updates.deploy_status}`);
      }

      // Always update updated_at
      updateFields.push(db`updated_at = NOW()`);

      if (updateFields.length === 1) {
        // Only updated_at would be updated, so no real changes
        return this.findById(id);
      }

      const setClause = updateFields.reduce((acc, field, i) =>
        i === 0 ? field : db`${acc}, ${field}`
      );

      const [row] = await db<Environment[]>`
        UPDATE environments
        SET ${setClause}
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async delete(id: string): Promise<boolean> {
      const result = await db`DELETE FROM environments WHERE id = ${id}`;
      return result.count > 0;
    },

    async listByProject(projectId: string): Promise<Environment[]> {
      return db<Environment[]>`
        SELECT * FROM environments
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC
      `;
    },

    async listPersistent(projectId?: string): Promise<Environment[]> {
      if (projectId) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId} AND type = 'persistent'
          ORDER BY created_at DESC
        `;
      }
      return db<Environment[]>`
        SELECT * FROM environments
        WHERE type = 'persistent'
        ORDER BY created_at DESC
      `;
    },

    async listTemporary(projectId?: string): Promise<Environment[]> {
      if (projectId) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId} AND type = 'temporary'
          ORDER BY created_at DESC
        `;
      }
      return db<Environment[]>`
        SELECT * FROM environments
        WHERE type = 'temporary'
        ORDER BY created_at DESC
      `;
    },

    async listByKind(kind: EnvironmentKind, projectId?: string): Promise<Environment[]> {
      if (projectId) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId} AND kind = ${kind}
          ORDER BY created_at DESC
        `;
      }
      return db<Environment[]>`
        SELECT * FROM environments
        WHERE kind = ${kind}
        ORDER BY created_at DESC
      `;
    },

    async listPreviewEnvironments(projectId?: string): Promise<Environment[]> {
      return this.listByKind('preview', projectId);
    },

    async suspend(id: string, reason: string): Promise<Environment | null> {
      const [row] = await db<Environment[]>`
        UPDATE environments
        SET status = 'suspended',
            suspended_at = NOW(),
            suspension_reason = ${reason},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async resume(id: string): Promise<Environment | null> {
      const [row] = await db<Environment[]>`
        UPDATE environments
        SET status = 'active',
            suspended_at = NULL,
            suspension_reason = NULL,
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async listActive(projectId?: string): Promise<Environment[]> {
      if (projectId) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId} AND status = 'active'
          ORDER BY created_at DESC
        `;
      }
      return db<Environment[]>`
        SELECT * FROM environments
        WHERE status = 'active'
        ORDER BY created_at DESC
      `;
    },

    async findActiveByProjectAndName(
      projectId: string,
      name: string,
    ): Promise<Environment | null> {
      const [row] = await db<Environment[]>`
        SELECT * FROM environments
        WHERE project_id = ${projectId} AND name = ${name} AND status = 'active'
      `;
      return row ?? null;
    },

    async findByLabel(
      labelKey: string,
      labelValue: string,
      projectId?: string,
    ): Promise<Environment[]> {
      if (projectId) {
        return db<Environment[]>`
          SELECT * FROM environments
          WHERE project_id = ${projectId}
            AND labels_json ->> ${labelKey} = ${labelValue}
          ORDER BY created_at DESC
        `;
      }
      return db<Environment[]>`
        SELECT * FROM environments
        WHERE labels_json ->> ${labelKey} = ${labelValue}
        ORDER BY created_at DESC
      `;
    },
  };
}
