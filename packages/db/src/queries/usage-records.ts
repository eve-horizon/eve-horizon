import type { Db } from '../client.js';

export interface UsageRecord {
  id: string;
  org_id: string;
  project_id: string | null;
  env_id: string | null;
  resource_type: string;
  resource_class: string | null;
  quantity: string;
  unit: string;
  started_at: Date;
  ended_at: Date | null;
  source_type: string;
  source_id: string;
  created_at: Date;
}

export interface CreateUsageRecordInput {
  id: string;
  org_id: string;
  project_id?: string | null;
  env_id?: string | null;
  resource_type: string;
  resource_class?: string | null;
  quantity: string;
  unit: string;
  started_at: Date;
  ended_at?: Date | null;
  source_type: string;
  source_id: string;
}

export interface ListUsageRecordsOptions {
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface UsageAggregate {
  resource_type: string;
  unit: string;
  total_quantity: string;
}

export function usageRecordQueries(db: Db) {
  return {
    /**
     * Insert a usage record. Returns the created row.
     * The UNIQUE(source_type, source_id, resource_type) constraint provides idempotency.
     */
    async create(input: CreateUsageRecordInput): Promise<UsageRecord> {
      const projectId = input.project_id ?? null;
      const envId = input.env_id ?? null;
      const resourceClass = input.resource_class ?? null;
      const endedAt = input.ended_at ?? null;

      const [row] = await db<UsageRecord[]>`
        INSERT INTO usage_records (
          id, org_id, project_id, env_id,
          resource_type, resource_class,
          quantity, unit,
          started_at, ended_at,
          source_type, source_id
        )
        VALUES (
          ${input.id}, ${input.org_id}, ${projectId}, ${envId},
          ${input.resource_type}, ${resourceClass},
          ${input.quantity}, ${input.unit},
          ${input.started_at}, ${endedAt},
          ${input.source_type}, ${input.source_id}
        )
        ON CONFLICT (source_type, source_id, resource_type) DO NOTHING
        RETURNING *
      `;

      // ON CONFLICT DO NOTHING returns nothing on duplicate; re-read.
      if (!row) {
        const [existing] = await db<UsageRecord[]>`
          SELECT * FROM usage_records
          WHERE source_type = ${input.source_type}
            AND source_id = ${input.source_id}
            AND resource_type = ${input.resource_type}
        `;
        return existing;
      }

      return row;
    },

    /**
     * Idempotency lookup: find a record by its source composite key.
     */
    async findBySource(
      sourceType: string,
      sourceId: string,
      resourceType: string,
    ): Promise<UsageRecord | null> {
      const [row] = await db<UsageRecord[]>`
        SELECT * FROM usage_records
        WHERE source_type = ${sourceType}
          AND source_id = ${sourceId}
          AND resource_type = ${resourceType}
      `;
      return row ?? null;
    },

    /**
     * List usage records for an org with pagination and date filters.
     */
    async listByOrg(
      orgId: string,
      opts?: ListUsageRecordsOptions,
    ): Promise<UsageRecord[]> {
      const limit = opts?.limit && Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50;
      const offset = opts?.offset && Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
      const since = opts?.since ?? null;
      const until = opts?.until ?? null;

      return db<UsageRecord[]>`
        SELECT * FROM usage_records
        WHERE org_id = ${orgId}
          AND (${since}::timestamptz IS NULL OR started_at >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR started_at <= ${until}::timestamptz)
        ORDER BY started_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    },

    /**
     * List usage records for a specific environment with pagination.
     */
    async listByEnv(
      envId: string,
      opts?: ListUsageRecordsOptions,
    ): Promise<UsageRecord[]> {
      const limit = opts?.limit && Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50;
      const offset = opts?.offset && Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
      const since = opts?.since ?? null;
      const until = opts?.until ?? null;

      return db<UsageRecord[]>`
        SELECT * FROM usage_records
        WHERE env_id = ${envId}
          AND (${since}::timestamptz IS NULL OR started_at >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR started_at <= ${until}::timestamptz)
        ORDER BY started_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    },

    /**
     * Aggregate usage by resource_type + unit for an org, with optional date filters.
     */
    async aggregateByOrg(
      orgId: string,
      opts?: { since?: Date; until?: Date },
    ): Promise<UsageAggregate[]> {
      const since = opts?.since ?? null;
      const until = opts?.until ?? null;

      return db<UsageAggregate[]>`
        SELECT
          resource_type,
          unit,
          SUM(quantity)::text AS total_quantity
        FROM usage_records
        WHERE org_id = ${orgId}
          AND (${since}::timestamptz IS NULL OR started_at >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR started_at <= ${until}::timestamptz)
        GROUP BY resource_type, unit
        ORDER BY resource_type
      `;
    },
  };
}
