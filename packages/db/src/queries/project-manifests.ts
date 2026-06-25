import type { Db } from '../client.js';

export interface ProjectManifest {
  id: string;
  project_id: string;
  manifest_yaml: string;
  manifest_hash: string;
  git_sha: string | null;
  branch: string | null;
  parsed_defaults: Record<string, unknown> | null;
  parsed_agents: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListProjectManifestsOptions {
  project_id?: string;
  git_sha?: string;
  branch?: string;
  limit?: number;
  offset?: number;
}

export function projectManifestQueries(db: Db) {
  return {
    /**
     * Find a project manifest by ID
     *
     * @param id - Manifest ID
     * @returns Manifest if found, null otherwise
     */
    async findById(id: string): Promise<ProjectManifest | null> {
      const [row] = await db<ProjectManifest[]>`
        SELECT * FROM project_manifests WHERE id = ${id}
      `;
      return row ?? null;
    },

    /**
     * Find a project manifest by project and hash
     *
     * Useful for checking if a manifest already exists before creating a new one
     *
     * @param projectId - Project TypeID
     * @param manifestHash - SHA256 hash of manifest content
     * @returns Manifest if found, null otherwise
     */
    async findByProjectAndHash(
      projectId: string,
      manifestHash: string,
    ): Promise<ProjectManifest | null> {
      const [row] = await db<ProjectManifest[]>`
        SELECT * FROM project_manifests
        WHERE project_id = ${projectId} AND manifest_hash = ${manifestHash}
      `;
      return row ?? null;
    },

    /**
     * Find the most recent manifest for a project
     *
     * @param projectId - Project TypeID
     * @returns Most recent manifest or null if none exist
     */
    async findLatestByProject(projectId: string): Promise<ProjectManifest | null> {
      const [row] = await db<ProjectManifest[]>`
        SELECT * FROM project_manifests
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    /**
     * Find a manifest by project and git SHA.
     *
     * Multiple manifest rows can share a git_sha if the same SHA was synced at
     * different times or re-parsed; this returns the most recent so downstream
     * consumers see the latest-known YAML for that commit.
     *
     * @param projectId - Project TypeID
     * @param gitSha - Git commit SHA
     * @returns Manifest if found, null otherwise
     */
    async findByProjectAndGitSha(
      projectId: string,
      gitSha: string,
    ): Promise<ProjectManifest | null> {
      const [row] = await db<ProjectManifest[]>`
        SELECT * FROM project_manifests
        WHERE project_id = ${projectId} AND git_sha = ${gitSha}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    /**
     * Create a new project manifest
     *
     * @param manifest - Manifest data (without timestamps)
     * @returns Created manifest
     */
    async create(
      manifest: Omit<ProjectManifest, 'created_at' | 'updated_at'>,
    ): Promise<ProjectManifest> {
      const [row] = await db<ProjectManifest[]>`
        INSERT INTO project_manifests (
          id,
          project_id,
          manifest_yaml,
          manifest_hash,
          git_sha,
          branch,
          parsed_defaults,
          parsed_agents
        )
        VALUES (
          ${manifest.id},
          ${manifest.project_id},
          ${manifest.manifest_yaml},
          ${manifest.manifest_hash},
          ${manifest.git_sha},
          ${manifest.branch},
          ${manifest.parsed_defaults ? db.json(manifest.parsed_defaults as never) : null},
          ${manifest.parsed_agents ? db.json(manifest.parsed_agents as never) : null}
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * Update a project manifest
     *
     * Typically used to update git_sha and branch when syncing
     *
     * @param id - Manifest ID
     * @param updates - Fields to update
     * @returns Updated manifest or null if not found
     */
    async update(
      id: string,
      updates: {
        manifest_yaml?: string;
        manifest_hash?: string;
        git_sha?: string | null;
        branch?: string | null;
        parsed_defaults?: Record<string, unknown> | null;
        parsed_agents?: Record<string, unknown> | null;
      },
    ): Promise<ProjectManifest | null> {
      const manifestYaml = updates.manifest_yaml ?? null;
      const manifestHash = updates.manifest_hash ?? null;
      const gitSha = updates.git_sha !== undefined ? updates.git_sha : undefined;
      const branch = updates.branch !== undefined ? updates.branch : undefined;
      const parsedDefaults = updates.parsed_defaults !== undefined ? updates.parsed_defaults : undefined;
      const parsedAgents = updates.parsed_agents !== undefined ? updates.parsed_agents : undefined;

      // Build update fields dynamically
      const updateFields = [];
      const params: Record<string, unknown> = {};

      if (manifestYaml !== null) {
        updateFields.push(db`manifest_yaml = ${manifestYaml}`);
      }
      if (manifestHash !== null) {
        updateFields.push(db`manifest_hash = ${manifestHash}`);
      }
      if (gitSha !== undefined) {
        updateFields.push(db`git_sha = ${gitSha}`);
      }
      if (branch !== undefined) {
        updateFields.push(db`branch = ${branch}`);
      }
      if (parsedDefaults !== undefined) {
        updateFields.push(
          parsedDefaults === null
            ? db`parsed_defaults = NULL`
            : db`parsed_defaults = ${db.json(parsedDefaults as never)}`
        );
      }
      if (parsedAgents !== undefined) {
        updateFields.push(
          parsedAgents === null
            ? db`parsed_agents = NULL`
            : db`parsed_agents = ${db.json(parsedAgents as never)}`
        );
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

      const [row] = await db<ProjectManifest[]>`
        UPDATE project_manifests
        SET ${setClause}
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    /**
     * Touch a manifest to bump updated_at
     *
     * @param id - Manifest ID
     * @returns Updated manifest or null if not found
     */
    async touch(id: string): Promise<ProjectManifest | null> {
      const [row] = await db<ProjectManifest[]>`
        UPDATE project_manifests
        SET updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    /**
     * List project manifests with optional filters
     *
     * @param options - Filter options
     * @returns Array of manifests
     */
    async list(options: ListProjectManifestsOptions = {}): Promise<ProjectManifest[]> {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      const projectId = options.project_id;
      const gitSha = options.git_sha;
      const branch = options.branch;

      // Build dynamic WHERE conditions
      const conditions: ReturnType<typeof db>[] = [];

      if (projectId) {
        conditions.push(db`project_id = ${projectId}`);
      }

      if (gitSha) {
        conditions.push(db`git_sha = ${gitSha}`);
      }

      if (branch) {
        conditions.push(db`branch = ${branch}`);
      }

      // Build WHERE clause (or TRUE if no conditions)
      const whereClause = conditions.length > 0
        ? conditions.reduce((acc, cond, i) =>
            i === 0 ? cond : db`${acc} AND ${cond}`
          )
        : db`TRUE`;

      return db<ProjectManifest[]>`
        SELECT * FROM project_manifests
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    /**
     * List the latest manifest per project
     *
     * @returns Array of latest manifests (one per project)
     */
    async listLatest(): Promise<ProjectManifest[]> {
      return db<ProjectManifest[]>`
        SELECT DISTINCT ON (pm.project_id) pm.*
        FROM project_manifests pm
        JOIN projects p ON p.id = pm.project_id
        WHERE p.deleted_at IS NULL
        ORDER BY pm.project_id, pm.updated_at DESC, pm.created_at DESC
      `;
    },

    /**
     * Delete a project manifest
     *
     * @param id - Manifest ID
     * @returns True if deleted, false if not found
     */
    async delete(id: string): Promise<boolean> {
      const result = await db<[{ id: string }]>`
        DELETE FROM project_manifests
        WHERE id = ${id}
        RETURNING id
      `;
      return result.length > 0;
    },

    /**
     * Count manifests for a project
     *
     * @param projectId - Project TypeID
     * @returns Count of manifests
     */
    async countByProject(projectId: string): Promise<number> {
      const [result] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int as count
        FROM project_manifests
        WHERE project_id = ${projectId}
      `;
      return result?.count ?? 0;
    },
  };
}
