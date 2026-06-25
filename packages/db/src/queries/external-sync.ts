import type { Db } from '../client.js';

// ============================================================================
// Types
// ============================================================================

export interface ExternalMapping {
  id: string;
  job_id: string;
  provider: string;
  external_id: string;
  external_key: string | null;
  external_url: string | null;
  remote_updated_at: Date | null;
  last_synced_at: Date | null;
  sync_direction: 'inbound' | 'outbound' | 'bidirectional';
  content_hash: string | null;
  sync_error: string | null;
}

export interface CreateMappingParams {
  job_id: string;
  provider: string;
  external_id: string;
  external_key?: string | null;
  external_url?: string | null;
  sync_direction?: 'inbound' | 'outbound' | 'bidirectional';
  content_hash?: string | null;
  sync_meta?: Record<string, unknown>;
}

export interface UpdateMappingParams {
  external_key?: string | null;
  external_url?: string | null;
  remote_updated_at?: Date | null;
  last_synced_at?: Date | null;
  content_hash?: string | null;
  sync_error?: string | null;
}

// ============================================================================
// Factory Function
// ============================================================================

export function externalSyncQueries(db: Db) {
  return {
    /**
     * Create or update an external mapping
     *
     * Uses upsert semantics: if mapping exists for (provider, external_id),
     * updates the existing record. Otherwise creates a new one.
     *
     * @param params - Mapping parameters
     * @returns Created or updated mapping
     */
    async upsertMapping(params: CreateMappingParams): Promise<ExternalMapping> {
      const syncDirection = params.sync_direction ?? 'bidirectional';

      const [row] = await db<ExternalMapping[]>`
        INSERT INTO external_item_map (
          job_id,
          provider,
          external_id,
          external_key,
          external_url,
          sync_direction,
          content_hash,
          last_synced_at
        )
        VALUES (
          ${params.job_id},
          ${params.provider},
          ${params.external_id},
          ${params.external_key ?? null},
          ${params.external_url ?? null},
          ${syncDirection},
          ${params.content_hash ?? null},
          NOW()
        )
        ON CONFLICT (provider, external_id) DO UPDATE SET
          job_id = EXCLUDED.job_id,
          external_key = COALESCE(EXCLUDED.external_key, external_item_map.external_key),
          external_url = COALESCE(EXCLUDED.external_url, external_item_map.external_url),
          sync_direction = EXCLUDED.sync_direction,
          content_hash = EXCLUDED.content_hash,
          last_synced_at = NOW(),
          sync_error = NULL
        RETURNING *
      `;

      return row;
    },

    /**
     * Find job ID by external ID
     *
     * @param provider - Provider name (e.g., 'beads', 'jira')
     * @param externalId - External system's unique ID
     * @returns Job ID if found, null otherwise
     */
    async findJobByExternalId(provider: string, externalId: string): Promise<string | null> {
      const [row] = await db<{ job_id: string }[]>`
        SELECT job_id FROM external_item_map
        WHERE provider = ${provider}
          AND external_id = ${externalId}
      `;

      return row?.job_id ?? null;
    },

    /**
     * Find external ID by job
     *
     * @param jobId - Job ID
     * @param provider - Provider name
     * @returns External ID if found, null otherwise
     */
    async findExternalIdByJob(jobId: string, provider: string): Promise<string | null> {
      const [row] = await db<{ external_id: string }[]>`
        SELECT external_id FROM external_item_map
        WHERE job_id = ${jobId}
          AND provider = ${provider}
      `;

      return row?.external_id ?? null;
    },

    /**
     * Get full mapping for a job and provider
     *
     * @param jobId - Job ID
     * @param provider - Provider name
     * @returns Full mapping if found, null otherwise
     */
    async getMapping(jobId: string, provider: string): Promise<ExternalMapping | null> {
      const [row] = await db<ExternalMapping[]>`
        SELECT * FROM external_item_map
        WHERE job_id = ${jobId}
          AND provider = ${provider}
      `;

      return row ?? null;
    },

    /**
     * List all mappings for a job
     *
     * @param jobId - Job ID
     * @returns Array of all external mappings for the job
     */
    async listMappingsForJob(jobId: string): Promise<ExternalMapping[]> {
      return db<ExternalMapping[]>`
        SELECT * FROM external_item_map
        WHERE job_id = ${jobId}
        ORDER BY provider ASC
      `;
    },

    /**
     * List all mappings for a provider
     *
     * @param provider - Provider name
     * @param options - Optional pagination
     * @returns Array of all external mappings for the provider
     */
    async listMappingsForProvider(
      provider: string,
      options?: { limit?: number; offset?: number },
    ): Promise<ExternalMapping[]> {
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;

      return db<ExternalMapping[]>`
        SELECT * FROM external_item_map
        WHERE provider = ${provider}
        ORDER BY last_synced_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    /**
     * List jobs without external mapping for a provider
     *
     * Useful for finding jobs that need to be pushed to external system.
     *
     * @param projectId - Project TypeID
     * @param provider - Provider name
     * @param options - Optional limit
     * @returns Array of job IDs without mapping
     */
    async listUnmappedJobs(
      projectId: string,
      provider: string,
      options?: { limit?: number },
    ): Promise<string[]> {
      const limit = options?.limit ?? 100;

      const rows = await db<{ id: string }[]>`
        SELECT j.id
        FROM jobs j
        LEFT JOIN external_item_map m ON m.job_id = j.id AND m.provider = ${provider}
        WHERE j.project_id = ${projectId}
          AND m.id IS NULL
        ORDER BY j.created_at ASC
        LIMIT ${limit}
      `;

      return rows.map((r) => r.id);
    },

    /**
     * Update mapping metadata
     *
     * @param jobId - Job ID
     * @param provider - Provider name
     * @param updates - Fields to update
     * @returns Updated mapping or null if not found
     */
    async updateMapping(
      jobId: string,
      provider: string,
      updates: UpdateMappingParams,
    ): Promise<ExternalMapping | null> {
      const [row] = await db<ExternalMapping[]>`
        UPDATE external_item_map
        SET
          external_key = COALESCE(${updates.external_key ?? null}, external_key),
          external_url = COALESCE(${updates.external_url ?? null}, external_url),
          remote_updated_at = COALESCE(${updates.remote_updated_at ?? null}, remote_updated_at),
          last_synced_at = COALESCE(${updates.last_synced_at ?? null}, last_synced_at),
          content_hash = COALESCE(${updates.content_hash ?? null}, content_hash),
          sync_error = ${updates.sync_error ?? null}
        WHERE job_id = ${jobId}
          AND provider = ${provider}
        RETURNING *
      `;

      return row ?? null;
    },

    /**
     * Mark mapping as synced
     *
     * Updates last_synced_at and optionally content_hash.
     *
     * @param jobId - Job ID
     * @param provider - Provider name
     * @param contentHash - Optional new content hash
     */
    async markSynced(jobId: string, provider: string, contentHash?: string): Promise<void> {
      await db`
        UPDATE external_item_map
        SET
          last_synced_at = NOW(),
          content_hash = ${contentHash ?? db`content_hash`},
          sync_error = NULL
        WHERE job_id = ${jobId}
          AND provider = ${provider}
      `;
    },

    /**
     * Record sync error
     *
     * @param jobId - Job ID
     * @param provider - Provider name
     * @param error - Error message
     */
    async recordSyncError(jobId: string, provider: string, error: string): Promise<void> {
      await db`
        UPDATE external_item_map
        SET sync_error = ${error}
        WHERE job_id = ${jobId}
          AND provider = ${provider}
      `;
    },

    /**
     * Delete mapping
     *
     * @param jobId - Job ID
     * @param provider - Provider name
     */
    async deleteMapping(jobId: string, provider: string): Promise<void> {
      await db`
        DELETE FROM external_item_map
        WHERE job_id = ${jobId}
          AND provider = ${provider}
      `;
    },

    /**
     * Delete all mappings for a job
     *
     * @param jobId - Job ID
     */
    async deleteAllMappingsForJob(jobId: string): Promise<void> {
      await db`
        DELETE FROM external_item_map
        WHERE job_id = ${jobId}
      `;
    },

    /**
     * Get stale mappings (not synced recently)
     *
     * @param provider - Provider name
     * @param staleDays - Number of days to consider stale
     * @param limit - Max results
     * @returns Array of stale mappings
     */
    async getStaleMappings(
      provider: string,
      staleDays: number = 7,
      limit: number = 100,
    ): Promise<ExternalMapping[]> {
      return db<ExternalMapping[]>`
        SELECT * FROM external_item_map
        WHERE provider = ${provider}
          AND (
            last_synced_at IS NULL
            OR last_synced_at < NOW() - INTERVAL '${db.unsafe(String(staleDays))} days'
          )
        ORDER BY last_synced_at ASC NULLS FIRST
        LIMIT ${limit}
      `;
    },

    /**
     * Get mappings with errors
     *
     * @param provider - Optional provider filter
     * @param limit - Max results
     * @returns Array of mappings with sync errors
     */
    async getMappingsWithErrors(provider?: string, limit: number = 100): Promise<ExternalMapping[]> {
      if (provider) {
        return db<ExternalMapping[]>`
          SELECT * FROM external_item_map
          WHERE provider = ${provider}
            AND sync_error IS NOT NULL
          ORDER BY last_synced_at DESC NULLS LAST
          LIMIT ${limit}
        `;
      }

      return db<ExternalMapping[]>`
        SELECT * FROM external_item_map
        WHERE sync_error IS NOT NULL
        ORDER BY provider, last_synced_at DESC NULLS LAST
        LIMIT ${limit}
      `;
    },
  };
}
