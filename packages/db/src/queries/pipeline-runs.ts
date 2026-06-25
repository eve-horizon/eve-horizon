import type { Db } from '../client.js';

export interface PipelineRun {
  id: string;
  project_id: string;
  pipeline_name: string;
  env_name: string | null;
  git_sha: string | null;
  manifest_hash: string | null;
  inputs_json: Record<string, unknown> | null;
  step_outputs_json: Record<string, unknown> | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  requested_by: string | null;
  run_mode: string | null;
  dedupe_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PipelineStepRun {
  id: string;
  pipeline_run_id: string;
  step_index: number;
  step_name: string;
  step_type: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  logs_ref: string | null;
  input_json: Record<string, unknown> | null;
  output_json: Record<string, unknown> | null;
  result_text: string | null;
  result_json: Record<string, unknown> | null;
  exit_code: number | null;
  duration_ms: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListPipelineRunsOptions {
  project_id: string;
  pipeline_name: string;
  limit?: number;
  offset?: number;
}

export function pipelineRunQueries(db: Db) {
  return {
    async createRun(
      run: Omit<PipelineRun, 'created_at' | 'updated_at'>,
    ): Promise<PipelineRun> {
      const inputs = run.inputs_json ? db.json(run.inputs_json as never) : null;
      const stepOutputs = run.step_outputs_json ? db.json(run.step_outputs_json as never) : null;
      const [row] = await db<PipelineRun[]>`
        INSERT INTO pipeline_runs (
          id,
          project_id,
          pipeline_name,
          env_name,
          git_sha,
          manifest_hash,
          inputs_json,
          step_outputs_json,
          status,
          started_at,
          completed_at,
          error_message,
          requested_by,
          run_mode,
          dedupe_key
        )
        VALUES (
          ${run.id},
          ${run.project_id},
          ${run.pipeline_name},
          ${run.env_name},
          ${run.git_sha},
          ${run.manifest_hash},
          ${inputs},
          ${stepOutputs},
          ${run.status},
          ${run.started_at},
          ${run.completed_at},
          ${run.error_message},
          ${run.requested_by},
          ${run.run_mode},
          ${run.dedupe_key}
        )
        RETURNING *
      `;
      return row;
    },

    async findRunById(id: string): Promise<PipelineRun | null> {
      const [row] = await db<PipelineRun[]>`
        SELECT * FROM pipeline_runs WHERE id = ${id}
      `;
      return row ?? null;
    },

    async findActiveRunByDedupeKey(dedupeKey: string): Promise<PipelineRun | null> {
      const [row] = await db<PipelineRun[]>`
        SELECT * FROM pipeline_runs
        WHERE dedupe_key = ${dedupeKey}
          AND status NOT IN ('succeeded', 'failed', 'cancelled')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    async findActiveByEnv(projectId: string, envName: string): Promise<PipelineRun | null> {
      const [row] = await db<PipelineRun[]>`
        SELECT * FROM pipeline_runs
        WHERE project_id = ${projectId}
          AND env_name = ${envName}
          AND status IN ('pending', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    async listRuns(options: ListPipelineRunsOptions): Promise<PipelineRun[]> {
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      return db<PipelineRun[]>`
        SELECT * FROM pipeline_runs
        WHERE project_id = ${options.project_id} AND pipeline_name = ${options.pipeline_name}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async updateRun(
      id: string,
      updates: {
        status?: string;
        started_at?: Date | null;
        completed_at?: Date | null;
        error_message?: string | null;
        inputs_json?: Record<string, unknown> | null;
        step_outputs_json?: Record<string, unknown> | null;
        run_mode?: string | null;
      },
    ): Promise<PipelineRun | null> {
      const updateFields: ReturnType<typeof db>[] = [];

      if (updates.status !== undefined) {
        updateFields.push(db`status = ${updates.status}`);
      }
      if (updates.started_at !== undefined) {
        updateFields.push(db`started_at = ${updates.started_at}`);
      }
      if (updates.completed_at !== undefined) {
        updateFields.push(db`completed_at = ${updates.completed_at}`);
      }
      if (updates.error_message !== undefined) {
        updateFields.push(db`error_message = ${updates.error_message}`);
      }
      if (updates.inputs_json !== undefined) {
        updateFields.push(
          updates.inputs_json === null
            ? db`inputs_json = NULL`
            : db`inputs_json = ${db.json(updates.inputs_json as never)}`
        );
      }
      if (updates.step_outputs_json !== undefined) {
        updateFields.push(
          updates.step_outputs_json === null
            ? db`step_outputs_json = NULL`
            : db`step_outputs_json = ${db.json(updates.step_outputs_json as never)}`
        );
      }
      if (updates.run_mode !== undefined) {
        updateFields.push(db`run_mode = ${updates.run_mode}`);
      }

      updateFields.push(db`updated_at = NOW()`);

      if (updateFields.length === 1) {
        return this.findRunById(id);
      }

      const setClause = updateFields.reduce((acc, field, i) =>
        i === 0 ? field : db`${acc}, ${field}`
      );

      const [row] = await db<PipelineRun[]>`
        UPDATE pipeline_runs
        SET ${setClause}
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    async setStepOutput(
      runId: string,
      stepName: string,
      output: Record<string, unknown>,
    ): Promise<PipelineRun | null> {
      const [row] = await db<PipelineRun[]>`
        UPDATE pipeline_runs
        SET step_outputs_json = COALESCE(step_outputs_json, '{}'::jsonb) || ${db.json({ [stepName]: output } as never)},
            updated_at = NOW()
        WHERE id = ${runId}
        RETURNING *
      `;
      return row ?? null;
    },

    async createStepRun(
      step: Omit<PipelineStepRun, 'created_at' | 'updated_at'>,
    ): Promise<PipelineStepRun> {
      const inputJson = step.input_json ? db.json(step.input_json as never) : null;
      const outputJson = step.output_json ? db.json(step.output_json as never) : null;
      const resultJson = step.result_json ? db.json(step.result_json as never) : null;

      const [row] = await db<PipelineStepRun[]>`
        INSERT INTO pipeline_step_runs (
          id,
          pipeline_run_id,
          step_index,
          step_name,
          step_type,
          status,
          started_at,
          completed_at,
          error_message,
          logs_ref,
          input_json,
          output_json,
          result_text,
          result_json,
          exit_code,
          duration_ms
        )
        VALUES (
          ${step.id},
          ${step.pipeline_run_id},
          ${step.step_index},
          ${step.step_name},
          ${step.step_type},
          ${step.status},
          ${step.started_at},
          ${step.completed_at},
          ${step.error_message},
          ${step.logs_ref},
          ${inputJson},
          ${outputJson},
          ${step.result_text},
          ${resultJson},
          ${step.exit_code},
          ${step.duration_ms}
        )
        RETURNING *
      `;
      return row;
    },

    async listStepRuns(runId: string): Promise<PipelineStepRun[]> {
      return db<PipelineStepRun[]>`
        SELECT * FROM pipeline_step_runs
        WHERE pipeline_run_id = ${runId}
        ORDER BY step_index ASC
      `;
    },

    async findStepRunById(stepRunId: string): Promise<PipelineStepRun | null> {
      const [row] = await db<PipelineStepRun[]>`
        SELECT * FROM pipeline_step_runs WHERE id = ${stepRunId}
      `;
      return row ?? null;
    },

    async hardDeleteByPipelineName(projectId: string, pipelineName: string): Promise<number> {
      const result = await db`
        DELETE FROM pipeline_runs
        WHERE project_id = ${projectId} AND pipeline_name = ${pipelineName}
      `;
      return result.count;
    },

    async updateStepRun(
      stepRunId: string,
      updates: {
        status?: string;
        started_at?: Date | null;
        completed_at?: Date | null;
        error_message?: string | null;
        logs_ref?: string | null;
        input_json?: Record<string, unknown> | null;
        output_json?: Record<string, unknown> | null;
        result_text?: string | null;
        result_json?: Record<string, unknown> | null;
        exit_code?: number | null;
        duration_ms?: number | null;
      },
    ): Promise<PipelineStepRun | null> {
      const updateFields: ReturnType<typeof db>[] = [];

      if (updates.status !== undefined) {
        updateFields.push(db`status = ${updates.status}`);
      }
      if (updates.started_at !== undefined) {
        updateFields.push(db`started_at = ${updates.started_at}`);
      }
      if (updates.completed_at !== undefined) {
        updateFields.push(db`completed_at = ${updates.completed_at}`);
      }
      if (updates.error_message !== undefined) {
        updateFields.push(db`error_message = ${updates.error_message}`);
      }
      if (updates.logs_ref !== undefined) {
        updateFields.push(db`logs_ref = ${updates.logs_ref}`);
      }
      if (updates.input_json !== undefined) {
        updateFields.push(
          updates.input_json === null
            ? db`input_json = NULL`
            : db`input_json = ${db.json(updates.input_json as never)}`
        );
      }
      if (updates.output_json !== undefined) {
        updateFields.push(
          updates.output_json === null
            ? db`output_json = NULL`
            : db`output_json = ${db.json(updates.output_json as never)}`
        );
      }
      if (updates.result_text !== undefined) {
        updateFields.push(db`result_text = ${updates.result_text}`);
      }
      if (updates.result_json !== undefined) {
        updateFields.push(
          updates.result_json === null
            ? db`result_json = NULL`
            : db`result_json = ${db.json(updates.result_json as never)}`
        );
      }
      if (updates.exit_code !== undefined) {
        updateFields.push(db`exit_code = ${updates.exit_code}`);
      }
      if (updates.duration_ms !== undefined) {
        updateFields.push(db`duration_ms = ${updates.duration_ms}`);
      }

      updateFields.push(db`updated_at = NOW()`);

      if (updateFields.length === 1) {
        return this.findStepRunById(stepRunId);
      }

      const setClause = updateFields.reduce((acc, field, i) =>
        i === 0 ? field : db`${acc}, ${field}`
      );

      const [row] = await db<PipelineStepRun[]>`
        UPDATE pipeline_step_runs
        SET ${setClause}
        WHERE id = ${stepRunId}
        RETURNING *
      `;
      return row ?? null;
    },
  };
}
