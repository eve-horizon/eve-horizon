import type { Db } from '../client.js';

export interface StorageBucket {
  id: string;
  org_id: string | null;
  project_id: string | null;
  env_name: string | null;
  service_name: string;
  name: string;
  physical_name: string;
  visibility: 'private' | 'public';
  cors_json: Record<string, unknown>;
  isolation_mode: 'irsa' | 'shared' | 'minio-static-key' | null;
  iam_role_arn: string | null;
  iam_role_name: string | null;
  service_account_name: string | null;
  service_account_namespace: string | null;
  created_at: Date;
}

export interface UpsertStorageBucketInput {
  id: string;
  org_id: string;
  project_id: string;
  env_name: string;
  service_name: string;
  name: string;
  physical_name: string;
  visibility: 'private' | 'public';
  cors_json: Record<string, unknown>;
  isolation_mode?: 'irsa' | 'shared' | 'minio-static-key' | null;
  iam_role_arn?: string | null;
  iam_role_name?: string | null;
  service_account_name?: string | null;
  service_account_namespace?: string | null;
}

export interface StorageBucketDesiredKey {
  service_name: string;
  name: string;
}

export function storageBucketQueries(db: Db) {
  return {
    async upsert(input: UpsertStorageBucketInput): Promise<StorageBucket> {
      const corsJson = JSON.stringify(input.cors_json);
      const [row] = await db<StorageBucket[]>`
        INSERT INTO storage_buckets (
          id,
          org_id,
          project_id,
          env_name,
          service_name,
          name,
          physical_name,
          visibility,
          cors_json,
          isolation_mode,
          iam_role_arn,
          iam_role_name,
          service_account_name,
          service_account_namespace
        )
        VALUES (
          ${input.id},
          ${input.org_id},
          ${input.project_id},
          ${input.env_name},
          ${input.service_name},
          ${input.name},
          ${input.physical_name},
          ${input.visibility},
          ${corsJson}::jsonb,
          ${input.isolation_mode ?? null},
          ${input.iam_role_arn ?? null},
          ${input.iam_role_name ?? null},
          ${input.service_account_name ?? null},
          ${input.service_account_namespace ?? null}
        )
        ON CONFLICT (project_id, env_name, service_name, name) DO UPDATE
        SET
          physical_name             = EXCLUDED.physical_name,
          visibility                = EXCLUDED.visibility,
          cors_json                 = EXCLUDED.cors_json,
          isolation_mode            = EXCLUDED.isolation_mode,
          iam_role_arn              = EXCLUDED.iam_role_arn,
          iam_role_name             = EXCLUDED.iam_role_name,
          service_account_name      = EXCLUDED.service_account_name,
          service_account_namespace = EXCLUDED.service_account_namespace
        RETURNING *
      `;
      return row;
    },

    async listByEnv(projectId: string, envName: string): Promise<StorageBucket[]> {
      return db<StorageBucket[]>`
        SELECT * FROM storage_buckets
        WHERE project_id = ${projectId}
          AND env_name   = ${envName}
        ORDER BY service_name ASC, name ASC
      `;
    },

    async findByEnvAndName(
      projectId: string,
      envName: string,
      serviceName: string,
      name: string,
    ): Promise<StorageBucket | null> {
      const [row] = await db<StorageBucket[]>`
        SELECT * FROM storage_buckets
        WHERE project_id  = ${projectId}
          AND env_name    = ${envName}
          AND service_name = ${serviceName}
          AND name        = ${name}
      `;
      return row ?? null;
    },

    async deleteByEnv(projectId: string, envName: string): Promise<number> {
      const result = await db`
        DELETE FROM storage_buckets
        WHERE project_id = ${projectId}
          AND env_name   = ${envName}
      `;
      return result.count;
    },

    async deleteMissingForEnv(
      projectId: string,
      envName: string,
      desired: StorageBucketDesiredKey[],
    ): Promise<number> {
      if (desired.length === 0) {
        return this.deleteByEnv(projectId, envName);
      }

      const serviceNames = desired.map((entry) => entry.service_name);
      const names = desired.map((entry) => entry.name);
      const result = await db`
        DELETE FROM storage_buckets sb
        WHERE sb.project_id = ${projectId}
          AND sb.env_name   = ${envName}
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(${serviceNames}::text[], ${names}::text[]) AS desired(service_name, name)
            WHERE desired.service_name = sb.service_name
              AND desired.name = sb.name
          )
      `;
      return result.count;
    },
  };
}
