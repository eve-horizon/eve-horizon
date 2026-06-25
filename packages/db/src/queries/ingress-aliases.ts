import type { Db } from '../client.js';

export interface IngressAlias {
  id: string;
  alias: string;
  project_id: string;
  environment_id: string | null;
  service_name: string;
  created_at: Date;
  updated_at: Date;
}

export interface ClaimOrUpdateIngressAliasInput {
  id: string;
  alias: string;
  project_id: string;
  service_name: string;
}

export interface ListIngressAliasesOptions {
  alias?: string;
  project_id?: string;
  environment_id?: string | null;
  limit?: number;
  offset?: number;
}

export function ingressAliasQueries(db: Db) {
  return {
    async findByAlias(alias: string): Promise<IngressAlias | null> {
      const normalized = alias.trim().toLowerCase();
      const [row] = await db<IngressAlias[]>`
        SELECT * FROM ingress_aliases WHERE alias = ${normalized}
      `;
      return row ?? null;
    },

    async findByProject(projectId: string): Promise<IngressAlias[]> {
      return db<IngressAlias[]>`
        SELECT * FROM ingress_aliases
        WHERE project_id = ${projectId}
        ORDER BY alias ASC
      `;
    },

    async findByEnvironment(environmentId: string): Promise<IngressAlias[]> {
      return db<IngressAlias[]>`
        SELECT * FROM ingress_aliases
        WHERE environment_id = ${environmentId}
        ORDER BY alias ASC
      `;
    },

    async findByEnvironmentIds(environmentIds: string[]): Promise<IngressAlias[]> {
      if (environmentIds.length === 0) {
        return [];
      }

      return db<IngressAlias[]>`
        SELECT * FROM ingress_aliases
        WHERE environment_id = ANY(${environmentIds})
        ORDER BY alias ASC
      `;
    },

    async findByProjectAndEnvironment(projectId: string, environmentId: string): Promise<IngressAlias[]> {
      return db<IngressAlias[]>`
        SELECT * FROM ingress_aliases
        WHERE project_id = ${projectId} AND environment_id = ${environmentId}
        ORDER BY alias ASC
      `;
    },

    /**
     * Claim a new alias or update service_name for a same-project claim.
     * Returns null if alias exists and belongs to a different project.
     */
    async claimOrUpdate(input: ClaimOrUpdateIngressAliasInput): Promise<IngressAlias | null> {
      const normalized = input.alias.trim().toLowerCase();
      const [row] = await db<IngressAlias[]>`
        INSERT INTO ingress_aliases (id, alias, project_id, environment_id, service_name)
        VALUES (${input.id}, ${normalized}, ${input.project_id}, NULL, ${input.service_name})
        ON CONFLICT (alias) DO UPDATE
        SET
          service_name = EXCLUDED.service_name,
          updated_at = NOW()
        WHERE ingress_aliases.project_id = EXCLUDED.project_id
        RETURNING *
      `;

      if (row) {
        return row;
      }

      const [existing] = await db<IngressAlias[]>`
        SELECT * FROM ingress_aliases
        WHERE alias = ${normalized}
      `;
      return existing ?? null;
    },

    /**
     * Bind alias to an environment only if the alias is currently unbound
     * or already bound to that same environment.
     */
    async bindToEnvironment(
      alias: string,
      projectId: string,
      environmentId: string,
      serviceName: string,
    ): Promise<IngressAlias | null> {
      const normalized = alias.trim().toLowerCase();
      const [row] = await db<IngressAlias[]>`
        UPDATE ingress_aliases
        SET
          environment_id = ${environmentId},
          service_name = ${serviceName},
          updated_at = NOW()
        WHERE alias = ${normalized}
          AND project_id = ${projectId}
          AND (environment_id IS NULL OR environment_id = ${environmentId})
        RETURNING *
      `;
      return row ?? null;
    },

    async unbindEnvironment(environmentId: string): Promise<number> {
      const result = await db`
        UPDATE ingress_aliases
        SET
          environment_id = NULL,
          updated_at = NOW()
        WHERE environment_id = ${environmentId}
      `;
      return result.count;
    },

    async unbindAliasesForEnvironment(environmentId: string, aliases: string[]): Promise<number> {
      if (aliases.length === 0) {
        return 0;
      }

      const normalizedAliases = aliases.map((alias) => alias.trim().toLowerCase());
      const result = await db`
        UPDATE ingress_aliases
        SET
          environment_id = NULL,
          updated_at = NOW()
        WHERE environment_id = ${environmentId}
          AND alias = ANY(${normalizedAliases})
      `;
      return result.count;
    },

    async release(alias: string, projectId: string): Promise<boolean> {
      const normalized = alias.trim().toLowerCase();
      const result = await db`
        DELETE FROM ingress_aliases
        WHERE alias = ${normalized} AND project_id = ${projectId}
      `;
      return result.count > 0;
    },

    async releaseByProject(projectId: string): Promise<number> {
      const result = await db`
        DELETE FROM ingress_aliases
        WHERE project_id = ${projectId}
      `;
      return result.count;
    },

    async list(options: ListIngressAliasesOptions = {}): Promise<IngressAlias[]> {
      const alias = options.alias?.trim().toLowerCase();
      const projectId = options.project_id;
      const environmentId = options.environment_id;
      const limit = options.limit ?? 100;
      const offset = options.offset ?? 0;

      if (alias && projectId && environmentId === null) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE alias = ${alias} AND project_id = ${projectId} AND environment_id IS NULL
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (alias && projectId && environmentId) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE alias = ${alias} AND project_id = ${projectId} AND environment_id = ${environmentId}
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (alias && projectId) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE alias = ${alias} AND project_id = ${projectId}
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (alias) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE alias = ${alias}
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (projectId && environmentId === null) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE project_id = ${projectId} AND environment_id IS NULL
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (projectId && environmentId) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE project_id = ${projectId} AND environment_id = ${environmentId}
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (projectId) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE project_id = ${projectId}
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (environmentId === null) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE environment_id IS NULL
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (environmentId) {
        return db<IngressAlias[]>`
          SELECT * FROM ingress_aliases
          WHERE environment_id = ${environmentId}
          ORDER BY alias ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return db<IngressAlias[]>`
        SELECT * FROM ingress_aliases
        ORDER BY alias ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },
  };
}
