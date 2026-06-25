import type { Db } from '../client.js';

export type ApiSourceType = 'openapi' | 'postgrest' | 'supabase-graphql';

export interface ProjectApiSource {
  project_id: string;
  env_name: string | null;
  name: string;
  type: ApiSourceType;
  base_url: string;
  spec_url: string | null;
  auth_mode: string | null;
  cached_schema_json: Record<string, unknown> | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListProjectApiSourcesOptions {
  project_id: string;
  env_name?: string | null;
  name?: string;
  limit?: number;
  offset?: number;
}

export function projectApiSourceQueries(db: Db) {
  return {
    async list(options: ListProjectApiSourcesOptions): Promise<ProjectApiSource[]> {
      const limit = options.limit ?? 100;
      const offset = options.offset ?? 0;
      const conditions: ReturnType<typeof db>[] = [db`project_id = ${options.project_id}`];

      if (options.env_name !== undefined) {
        conditions.push(db`env_name = ${options.env_name}`);
      }

      if (options.name) {
        conditions.push(db`name = ${options.name}`);
      }

      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`
      );

      return db<ProjectApiSource[]>`
        SELECT * FROM project_api_sources
        WHERE ${whereClause}
        ORDER BY name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async findByProjectEnvAndName(
      projectId: string,
      envName: string | null,
      name: string,
    ): Promise<ProjectApiSource | null> {
      const [row] = await db<ProjectApiSource[]>`
        SELECT * FROM project_api_sources
        WHERE project_id = ${projectId} AND env_name IS NOT DISTINCT FROM ${envName} AND name = ${name}
        LIMIT 1
      `;
      return row ?? null;
    },

    async upsert(
      source: Omit<ProjectApiSource, 'cached_schema_json' | 'last_synced_at' | 'created_at' | 'updated_at'>,
    ): Promise<ProjectApiSource> {
      const [row] = await db<ProjectApiSource[]>`
        INSERT INTO project_api_sources (
          project_id,
          env_name,
          name,
          type,
          base_url,
          spec_url,
          auth_mode
        )
        VALUES (
          ${source.project_id},
          ${source.env_name},
          ${source.name},
          ${source.type},
          ${source.base_url},
          ${source.spec_url},
          ${source.auth_mode}
        )
        ON CONFLICT (project_id, env_name, name)
        DO UPDATE SET
          type = EXCLUDED.type,
          base_url = EXCLUDED.base_url,
          spec_url = EXCLUDED.spec_url,
          auth_mode = EXCLUDED.auth_mode,
          cached_schema_json = CASE
            WHEN project_api_sources.type IS DISTINCT FROM EXCLUDED.type
              OR project_api_sources.base_url IS DISTINCT FROM EXCLUDED.base_url
              OR project_api_sources.spec_url IS DISTINCT FROM EXCLUDED.spec_url
            THEN NULL
            ELSE project_api_sources.cached_schema_json
          END,
          last_synced_at = CASE
            WHEN project_api_sources.type IS DISTINCT FROM EXCLUDED.type
              OR project_api_sources.base_url IS DISTINCT FROM EXCLUDED.base_url
              OR project_api_sources.spec_url IS DISTINCT FROM EXCLUDED.spec_url
            THEN NULL
            ELSE project_api_sources.last_synced_at
          END,
          updated_at = NOW()
        RETURNING *
      `;
      return row;
    },

    async deleteMissing(
      projectId: string,
      names: string[],
      envName: string | null,
    ): Promise<number> {
      if (names.length === 0) {
        const result = await db`
          DELETE FROM project_api_sources
          WHERE project_id = ${projectId} AND env_name IS NOT DISTINCT FROM ${envName}
        `;
        return result.count ?? 0;
      }

      const result = await db`
        DELETE FROM project_api_sources
        WHERE project_id = ${projectId}
          AND env_name IS NOT DISTINCT FROM ${envName}
          AND NOT (name = ANY(${names}))
      `;
      return result.count ?? 0;
    },

    async updateCachedSchema(
      projectId: string,
      envName: string | null,
      name: string,
      cachedSchema: Record<string, unknown>,
    ): Promise<ProjectApiSource | null> {
      const [row] = await db<ProjectApiSource[]>`
        UPDATE project_api_sources
        SET cached_schema_json = ${db.json(cachedSchema as never)},
            last_synced_at = NOW(),
            updated_at = NOW()
        WHERE project_id = ${projectId}
          AND env_name IS NOT DISTINCT FROM ${envName}
          AND name = ${name}
        RETURNING *
      `;
      return row ?? null;
    },
  };
}
