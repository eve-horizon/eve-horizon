import type { Db } from '../client.js';

export interface BuildSpec {
  id: string;
  project_id: string;
  git_sha: string;
  manifest_hash: string;
  services_json: string[] | null;
  inputs_json: Record<string, unknown> | null;
  registry_json: Record<string, unknown> | null;
  cache_json: Record<string, unknown> | null;
  created_by: string | null;
  created_at: Date;
}

export interface BuildRun {
  id: string;
  build_id: string;
  status: string;
  backend: string;
  runner_ref: string | null;
  logs_ref: string | null;
  error_message: string | null;
  error_code: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface BuildArtifact {
  id: string;
  build_id: string;
  service_name: string;
  image_ref: string;
  digest: string;
  platforms_json: string[] | null;
  size_bytes: number | null;
  sbom_ref: string | null;
  provenance_ref: string | null;
  created_at: Date;
}

export interface BuildLog {
  id: number;
  build_run_id: string;
  seq: number;
  type: string;
  content: Record<string, unknown>;
  created_at: Date;
}

export interface ListBuildSpecsOptions {
  project_id: string;
  limit?: number;
  offset?: number;
}

export interface ListBuildRunsOptions {
  build_id: string;
  limit?: number;
  offset?: number;
}

export interface ListBuildArtifactsOptions {
  build_id: string;
  limit?: number;
  offset?: number;
}

export function buildQueries(db: Db) {
  return {
    async createSpec(spec: Omit<BuildSpec, 'created_at'>): Promise<BuildSpec> {
      const servicesJson = spec.services_json ? db.json(spec.services_json as never) : null;
      const inputsJson = spec.inputs_json ? db.json(spec.inputs_json as never) : null;
      const registryJson = spec.registry_json ? db.json(spec.registry_json as never) : null;
      const cacheJson = spec.cache_json ? db.json(spec.cache_json as never) : null;

      const [row] = await db<BuildSpec[]>`
        INSERT INTO build_specs (
          id,
          project_id,
          git_sha,
          manifest_hash,
          services_json,
          inputs_json,
          registry_json,
          cache_json,
          created_by
        )
        VALUES (
          ${spec.id},
          ${spec.project_id},
          ${spec.git_sha},
          ${spec.manifest_hash},
          ${servicesJson},
          ${inputsJson},
          ${registryJson},
          ${cacheJson},
          ${spec.created_by}
        )
        RETURNING *
      `;
      return row;
    },

    async findSpecById(id: string): Promise<BuildSpec | null> {
      const [row] = await db<BuildSpec[]>`SELECT * FROM build_specs WHERE id = ${id}`;
      return row ?? null;
    },

    async listSpecs(options: ListBuildSpecsOptions): Promise<BuildSpec[]> {
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      return db<BuildSpec[]>`
        SELECT * FROM build_specs
        WHERE project_id = ${options.project_id}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async createRun(run: Omit<BuildRun, 'created_at' | 'updated_at'>): Promise<BuildRun> {
      const [row] = await db<BuildRun[]>`
        INSERT INTO build_runs (
          id,
          build_id,
          status,
          backend,
          runner_ref,
          logs_ref,
          error_message,
          error_code,
          started_at,
          completed_at
        )
        VALUES (
          ${run.id},
          ${run.build_id},
          ${run.status},
          ${run.backend},
          ${run.runner_ref},
          ${run.logs_ref},
          ${run.error_message},
          ${run.error_code},
          ${run.started_at},
          ${run.completed_at}
        )
        RETURNING *
      `;
      return row;
    },

    async findRunById(id: string): Promise<BuildRun | null> {
      const [row] = await db<BuildRun[]>`SELECT * FROM build_runs WHERE id = ${id}`;
      return row ?? null;
    },

    async findLatestRunByBuildId(buildId: string): Promise<BuildRun | null> {
      const [row] = await db<BuildRun[]>`
        SELECT * FROM build_runs
        WHERE build_id = ${buildId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    async listRuns(options: ListBuildRunsOptions): Promise<BuildRun[]> {
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      return db<BuildRun[]>`
        SELECT * FROM build_runs
        WHERE build_id = ${options.build_id}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async updateRun(
      id: string,
      updates: {
        status?: string;
        runner_ref?: string | null;
        logs_ref?: string | null;
        error_message?: string | null;
        error_code?: string | null;
        started_at?: Date | null;
        completed_at?: Date | null;
      },
    ): Promise<BuildRun | null> {
      const updateFields: ReturnType<typeof db>[] = [];

      if (updates.status !== undefined) {
        updateFields.push(db`status = ${updates.status}`);
      }
      if (updates.runner_ref !== undefined) {
        updateFields.push(db`runner_ref = ${updates.runner_ref}`);
      }
      if (updates.logs_ref !== undefined) {
        updateFields.push(db`logs_ref = ${updates.logs_ref}`);
      }
      if (updates.error_message !== undefined) {
        updateFields.push(db`error_message = ${updates.error_message}`);
      }
      if (updates.error_code !== undefined) {
        updateFields.push(db`error_code = ${updates.error_code}`);
      }
      if (updates.started_at !== undefined) {
        updateFields.push(db`started_at = ${updates.started_at}`);
      }
      if (updates.completed_at !== undefined) {
        updateFields.push(db`completed_at = ${updates.completed_at}`);
      }

      updateFields.push(db`updated_at = NOW()`);

      if (updateFields.length === 1) {
        return this.findRunById(id);
      }

      const setClause = updateFields.reduce((acc, field, i) =>
        i === 0 ? field : db`${acc}, ${field}`
      );

      const [row] = await db<BuildRun[]>`
        UPDATE build_runs
        SET ${setClause}
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async createArtifact(artifact: Omit<BuildArtifact, 'created_at'>): Promise<BuildArtifact> {
      const platformsJson = artifact.platforms_json ? db.json(artifact.platforms_json as never) : null;
      const [row] = await db<BuildArtifact[]>`
        INSERT INTO build_artifacts (
          id,
          build_id,
          service_name,
          image_ref,
          digest,
          platforms_json,
          size_bytes,
          sbom_ref,
          provenance_ref
        )
        VALUES (
          ${artifact.id},
          ${artifact.build_id},
          ${artifact.service_name},
          ${artifact.image_ref},
          ${artifact.digest},
          ${platformsJson},
          ${artifact.size_bytes},
          ${artifact.sbom_ref},
          ${artifact.provenance_ref}
        )
        RETURNING *
      `;
      return row;
    },

    async listArtifacts(options: ListBuildArtifactsOptions): Promise<BuildArtifact[]> {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      return db<BuildArtifact[]>`
        SELECT * FROM build_artifacts
        WHERE build_id = ${options.build_id}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async appendLog(buildRunId: string, type: string, content: Record<string, unknown>): Promise<BuildLog> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jsonContent = db.json(content as any);
      const [row] = await db<BuildLog[]>`
        INSERT INTO build_logs (build_run_id, seq, type, content)
        SELECT ${buildRunId}, COALESCE(MAX(seq), 0) + 1, ${type}, ${jsonContent}
        FROM build_logs WHERE build_run_id = ${buildRunId}
        RETURNING *
      `;
      return row;
    },

    async listLogs(buildRunId: string, afterSeq?: number): Promise<BuildLog[]> {
      if (afterSeq !== undefined) {
        return db<BuildLog[]>`
          SELECT * FROM build_logs
          WHERE build_run_id = ${buildRunId} AND seq > ${afterSeq}
          ORDER BY seq
        `;
      }

      return db<BuildLog[]>`
        SELECT * FROM build_logs
        WHERE build_run_id = ${buildRunId}
        ORDER BY seq
      `;
    },

    async hardDelete(id: string): Promise<boolean> {
      // Cascade: logs -> runs -> artifacts -> release FK -> spec
      // build_logs references build_runs, so delete logs first
      await db`DELETE FROM build_logs WHERE build_run_id IN (SELECT id FROM build_runs WHERE build_id = ${id})`;
      await db`DELETE FROM build_runs WHERE build_id = ${id}`;
      await db`DELETE FROM build_artifacts WHERE build_id = ${id}`;
      // Clear the release FK reference before deleting the spec
      await db`UPDATE releases SET build_id = NULL WHERE build_id = ${id}`;
      const result = await db`DELETE FROM build_specs WHERE id = ${id}`;
      return result.count > 0;
    },
  };
}
