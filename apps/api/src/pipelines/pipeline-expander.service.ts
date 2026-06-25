import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  jobQueries,
  pipelineRunQueries,
  projectManifestQueries,
  projectQueries,
  type Job,
} from '@eve/db';
import {
  AccessBindingScopeSchema,
  EnvOverridesSchema,
  VALID_TOOLCHAINS,
  generatePipelineRunId,
  getScriptConfig,
  isValidPermission,
  mergeEnvOverrides,
  parseStepExecution as parseSharedStepExecution,
  type StepExecution,
  type AccessBindingScope,
  type EnvOverrides,
} from '@eve/shared';
import * as yaml from 'yaml';
import { AccessService } from '../auth/access.service.js';

const VALID_TOOLCHAIN_SET = new Set<string>(VALID_TOOLCHAINS);

// ============================================================================
// Types
// ============================================================================

/**
 * Request to create a pipeline run with job expansion
 */
export interface ExpandPipelineRequest {
  /** References manifest pipelines.<name> */
  pipeline_name: string;
  /** Optional environment targeting */
  env_name?: string;
  /** Git SHA for the run */
  git_sha: string;
  /** Optional inputs to pass to the pipeline */
  inputs?: Record<string, unknown>;
  /** Optional step name to run (includes dependencies) */
  only?: string;
  /** Optional dedupe key for preventing duplicate runs */
  dedupe_key?: string;
  /** Optional dry run mode - returns job graph without persisting */
  dry_run?: boolean;
}

/**
 * Step definition parsed from manifest
 */
interface PipelineStep {
  name?: string;
  depends_on?: string[];
  // Action-based step
  action?: {
    type: string;
    [key: string]: unknown;
  };
  // Script-based step
  script?: {
    run?: string;
    command?: string;
    timeout?: number;
    timeout_seconds?: number;
    [key: string]: unknown;
  };
  // Shorthand script-based step
  run?: string;
  // Agent-based step
  agent?: {
    prompt: string;
    [key: string]: unknown;
  };
  toolchains?: unknown;
  env_overrides?: unknown;
}

/**
 * Pipeline definition from manifest
 */
interface PipelineDefinition {
  steps?: PipelineStep[];
  toolchains?: unknown;
  env_overrides?: unknown;
  [key: string]: unknown;
}

/**
 * Job response format matching JobsService
 */
interface JobResponse {
  id: string;
  project_id: string;
  parent_id: string | null;
  depth: number;
  title: string;
  description: string | null;
  issue_type: string;
  labels: string[];
  phase: string;
  priority: number;
  assignee: string | null;
  review_required: string;
  review_status: string | null;
  reviewer: string | null;
  defer_until: string | null;
  due_at: string | null;
  hints: Record<string, unknown>;
  env_name: string | null;
  execution_mode: string;
  execution_type: string;
  run_id: string | null;
  step_name: string | null;
  action_type: string | null;
  action_input: Record<string, unknown> | null;
  script_command: string | null;
  script_timeout_seconds: number | null;
  env_overrides: Record<string, string> | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
}

/**
 * Job relation for dependency tracking
 */
interface JobRelation {
  from_job_id: string;
  to_job_id: string;
  relation_type: string;
}

/**
 * Pipeline run response
 */
export interface PipelineRunWithJobsResponse {
  run: {
    id: string;
    project_id: string;
    pipeline_name: string;
    env_name: string | null;
    git_sha: string | null;
    manifest_hash: string | null;
    inputs: Record<string, unknown> | null;
    step_outputs: Record<string, unknown> | null;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    error_message: string | null;
    requested_by: string | null;
    run_mode: string | null;
    dedupe_key: string | null;
    created_at: string;
    updated_at: string;
  };
  jobs: JobResponse[];
  relations: JobRelation[];
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class PipelineExpanderService {
  private jobs: ReturnType<typeof jobQueries>;
  private runs: ReturnType<typeof pipelineRunQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    @Optional() private readonly accessService?: AccessService,
  ) {
    this.jobs = jobQueries(db);
    this.runs = pipelineRunQueries(db);
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
  }

  private parseTokenScope(value: unknown, path: string): AccessBindingScope | undefined {
    if (value === undefined || value === null) return undefined;
    const parsed = AccessBindingScopeSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid ${path}: ${parsed.error.issues.map((issue) => {
        const prefix = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${prefix}${issue.message}`;
      }).join('; ')}`);
    }
    return parsed.data;
  }

  private parseTokenPermissions(value: unknown, path: string): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      throw new BadRequestException(`Invalid ${path}: expected array of permission strings`);
    }
    const invalid: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new BadRequestException(`Invalid ${path}: every entry must be a non-empty string`);
      }
      if (!isValidPermission(entry)) invalid.push(entry);
    }
    if (invalid.length > 0) {
      throw new BadRequestException(`Invalid ${path}: unknown permission(s) ${invalid.join(', ')}`);
    }
    return [...new Set(value as string[])].sort();
  }

  private parseToolchains(value: unknown, path: string): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      throw new BadRequestException(`Invalid ${path}: expected array of toolchain names`);
    }

    const toolchains: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new BadRequestException(`Invalid ${path}: every entry must be a non-empty string`);
      }
      if (!VALID_TOOLCHAIN_SET.has(entry)) {
        throw new BadRequestException(`Invalid ${path}: unknown toolchain "${entry}"`);
      }
      toolchains.push(entry);
    }

    return [...new Set(toolchains)];
  }

  private parseEnvOverrides(value: unknown, path: string): EnvOverrides | undefined {
    if (value === undefined || value === null) return undefined;
    const parsed = EnvOverridesSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid ${path}: ${parsed.error.issues.map((issue) => {
        const prefix = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${prefix}${issue.message}`;
      }).join('; ')}`);
    }
    return parsed.data;
  }

  private resolveStepToolchains(
    pipelineToolchains: string[] | undefined,
    stepToolchains: string[] | undefined,
  ): string[] {
    if (stepToolchains && stepToolchains.length > 0) return stepToolchains;
    if (pipelineToolchains && pipelineToolchains.length > 0) return pipelineToolchains;
    return [];
  }

  private resolvePipelineStepToolchains(
    pipelineToolchains: string[] | undefined,
    stepToolchains: string[] | undefined,
    step: PipelineStep,
    execution: StepExecution,
    path: string,
  ): string[] {
    const action = step.action && typeof step.action === 'object' && !Array.isArray(step.action)
      ? step.action
      : null;
    if (action && Object.prototype.hasOwnProperty.call(action, 'toolchains')) {
      throw new BadRequestException(`Invalid ${path}.action.toolchains: use top-level step toolchains instead`);
    }

    if (execution.executionType === 'action' && execution.actionType !== 'run') {
      if (stepToolchains && stepToolchains.length > 0) {
        throw new BadRequestException(`Invalid ${path}.toolchains: pipeline action steps support toolchains only for action.type=run`);
      }
      return [];
    }

    return this.resolveStepToolchains(pipelineToolchains, stepToolchains);
  }

  private resolvePipelineActionRunEnvOverrides(
    pipelineName: string,
    pipelineEnvOverrides: EnvOverrides | undefined,
    steps: PipelineStep[],
  ): Map<string, EnvOverrides | null> {
    const byStep = new Map<string, EnvOverrides | null>();
    for (const [index, step] of steps.entries()) {
      const stepName = step.name || `step-${index + 1}`;
      const stepEnvOverrides = this.parseEnvOverrides(
        step.env_overrides,
        `Pipeline "${pipelineName}" step "${stepName}".env_overrides`,
      );
      const stepExecution = this.parseSharedStepExecution(step, stepName);
      const value =
        stepExecution.executionType === 'action' && stepExecution.actionType === 'run'
          ? mergeEnvOverrides(pipelineEnvOverrides, stepEnvOverrides, undefined)
          : null;
      byStep.set(stepName, value);
    }
    return byStep;
  }

  /**
   * Step-level scope wins; otherwise pipeline-level. Pipelines have no
   * "invocation" override surface (they're triggered by builds, events, or
   * manual run requests with no per-call scope override today).
   */
  private mergeStepTokenScope(
    pipelineScope: AccessBindingScope | undefined,
    stepScope: AccessBindingScope | undefined,
  ): AccessBindingScope | null {
    return stepScope ?? pipelineScope ?? null;
  }

  private mergeStepTokenPermissions(
    pipelinePermissions: string[] | undefined,
    stepPermissions: string[] | undefined,
  ): string[] | null {
    const winner = stepPermissions ?? pipelinePermissions;
    if (!winner) return null;
    return [...new Set(winner)].sort();
  }

  private async assertActorCanGrantPermissions(
    orgId: string,
    projectId: string,
    userId: string | undefined,
    permissions: string[] | null,
    context: string,
  ): Promise<void> {
    if (!userId || !permissions || permissions.length === 0 || !this.accessService) return;
    for (const permission of permissions) {
      const result = await this.accessService.can({
        org_id: orgId,
        principal_type: 'user',
        principal_id: userId,
        project_id: projectId,
        permission,
      });
      if (!result.allowed) {
        throw new BadRequestException(`${context} requests permission "${permission}" that the invoking actor does not hold`);
      }
    }
  }

  /**
   * Resolve the manifest to use for a pipeline run. When a git_sha is
   * provided and a manifest row already exists for that SHA (typically
   * from a prior `eve project sync`), use it so the run's manifest_hash
   * binds to the ref the user is deploying. Otherwise fall back to the
   * project's latest manifest.
   *
   * The worker's autoSyncManifestFromWorkspace is still the safety net —
   * it re-reads the manifest from the cloned workspace and (with Phase 6
   * changes) will fail the step with manifest_invalid if its hash differs
   * from the job's inherited input.manifest_hash. That catches the case
   * where the ref was never synced.
   */
  private async resolveManifestForRun(projectId: string, gitSha?: string) {
    if (gitSha) {
      const byRef = await this.manifests.findByProjectAndGitSha(projectId, gitSha);
      if (byRef) return byRef;
    }
    return this.manifests.findLatestByProject(projectId);
  }

  /**
   * Expand a pipeline definition into a job graph
   *
   * This creates:
   * 1. A pipeline_run record to track the overall run
   * 2. A job for each step in the pipeline
   * 3. Job relations for step dependencies
   *
   * @param projectId - Project ID (TypeID or slug)
   * @param request - Pipeline run request
   * @param userId - Optional user ID of the actor who initiated this pipeline
   * @returns The created pipeline run with its job graph
   */
  async expandPipeline(
    projectId: string,
    request: ExpandPipelineRequest,
    userId?: string,
  ): Promise<PipelineRunWithJobsResponse> {
    // 1. Resolve project
    const project = await this.projects.findById(projectId);
    if (!project) {
      // Try by slug
      const bySlug = await this.db<{ id: string; slug: string }[]>`
        SELECT id, slug FROM projects WHERE slug = ${projectId}
      `;
      if (!bySlug[0]) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }
      projectId = bySlug[0].id;
    }

    // 2. Resolve the manifest. When the caller supplied a git_sha, prefer the
    //    manifest synced for that SHA — that keeps a pipeline's manifest_hash
    //    bound to the ref the user is deploying rather than "whatever was last
    //    synced for this project". Fall back to latest when no ref-scoped row
    //    exists yet (the worker's autoSyncManifestFromWorkspace will catch any
    //    drift between the job's inherited hash and the workspace's real hash).
    const manifest = await this.resolveManifestForRun(projectId, request.git_sha);
    if (!manifest) {
      throw new NotFoundException(`No manifest synced for project ${projectId}`);
    }

    const pipeline = this.getPipelineFromManifest(
      manifest.manifest_yaml,
      request.pipeline_name,
    );
    const pipelineToolchains = this.parseToolchains(
      pipeline.toolchains,
      `Pipeline "${request.pipeline_name}".toolchains`,
    );
    const pipelineEnvOverrides = this.parseEnvOverrides(
      pipeline.env_overrides,
      `Pipeline "${request.pipeline_name}".env_overrides`,
    );

    // Resolve effective env_name: request > pipeline definition > null
    const pipelineEnv = typeof pipeline.env === 'string' ? pipeline.env : null;
    const effectiveEnvName = request.env_name ?? pipelineEnv ?? null;

    if (request.dedupe_key) {
      await this.cancelExistingRunForDedupeKey(request.dedupe_key);
    }

    // 3. Validate pipeline has steps
    let steps = pipeline.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new BadRequestException(
        `Pipeline "${request.pipeline_name}" has no steps`,
      );
    }

    if (request.only) {
      steps = this.filterStepsForOnly(steps, request.only);
    }

    this.ensureRemediationPipelinePolicy(request.pipeline_name, pipeline, steps);
    const actionRunEnvOverridesByStep = this.resolvePipelineActionRunEnvOverrides(
      request.pipeline_name,
      pipelineEnvOverrides,
      steps,
    );

    // 3.1. If dry_run mode, return computed job graph without persisting
    if (request.dry_run) {
      return this.buildDryRunResponse(
        projectId,
        request,
        manifest.manifest_hash,
        steps,
        effectiveEnvName,
        pipelineToolchains,
        actionRunEnvOverridesByStep,
      );
    }

    // 4. Create the pipeline run record
    const runId = generatePipelineRunId();
    const run = await this.runs.createRun({
      id: runId,
      project_id: projectId,
      pipeline_name: request.pipeline_name,
      env_name: effectiveEnvName,
      git_sha: request.git_sha,
      manifest_hash: manifest.manifest_hash,
      inputs_json: request.inputs ?? null,
      step_outputs_json: null,
      status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: null,
      run_mode: 'jobs',  // Indicates this run uses jobs (not step_runs)
      dedupe_key: request.dedupe_key ?? null,
    });

    // 4a. Parse pipeline-level scope/permissions once for the whole expand pass
    const pipelineTokenScope = this.parseTokenScope(
      pipeline.scope,
      `Pipeline "${request.pipeline_name}".scope`,
    );
    const pipelineTokenPermissions = this.parseTokenPermissions(
      pipeline.permissions,
      `Pipeline "${request.pipeline_name}".permissions`,
    );

    // 5. Create jobs for each step
    const createdJobs: Job[] = [];
    const stepNameToJobId = new Map<string, string>();

    // Get project slug for job ID generation
    const projectForSlug = await this.projects.findById(projectId);
    if (!projectForSlug) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    for (const [index, step] of steps.entries()) {
      // Determine step name
      const stepName = step.name || `step-${index + 1}`;
      const stepJobEnvOverrides = actionRunEnvOverridesByStep.get(stepName) ?? null;

      // Determine execution type and build job metadata
      const stepExecution = this.parseSharedStepExecution(step, stepName);
      const { executionType, title, description, metadata } = this.describePipelineStepExecution(step, stepExecution, stepName);
      const scriptCommand = stepExecution.scriptCommand;
      const scriptTimeoutSeconds = stepExecution.scriptTimeoutSeconds;
      const stepToolchains = this.parseToolchains(
        step.toolchains,
        `Pipeline "${request.pipeline_name}" step "${stepName}".toolchains`,
      );
      const resolvedToolchains = this.resolvePipelineStepToolchains(
        pipelineToolchains,
        stepToolchains,
        step,
        stepExecution,
        `Pipeline "${request.pipeline_name}" step "${stepName}"`,
      );

      // Dependencies are enforced by the scheduler query; keep jobs in ready
      // so they become schedulable as soon as blockers complete.
      const initialPhase = 'ready';

      // Generate job ID
      const { id: jobId } = await this.jobs.generateJobId(projectId);

      // Resolve per-step token scope and permissions, narrowing pipeline-level
      // declarations with anything the step itself declares.
      const stepTokenScope = this.parseTokenScope(
        (step as { scope?: unknown }).scope,
        `Pipeline "${request.pipeline_name}" step "${stepName}".scope`,
      );
      const stepJobTokenScope = this.mergeStepTokenScope(pipelineTokenScope, stepTokenScope);
      const stepTokenPermissions = this.parseTokenPermissions(
        (step as { permissions?: unknown }).permissions,
        `Pipeline "${request.pipeline_name}" step "${stepName}".permissions`,
      );
      const stepJobTokenPermissions = this.mergeStepTokenPermissions(
        pipelineTokenPermissions,
        stepTokenPermissions,
      );
      await this.assertActorCanGrantPermissions(
        projectForSlug.org_id,
        projectId,
        userId,
        stepJobTokenPermissions,
        `Pipeline "${request.pipeline_name}" step "${stepName}" permissions`,
      );

      // Create the job
      const reviewRequired =
        step.action && typeof (step.action as Record<string, unknown>).review_required === 'string'
          ? String((step.action as Record<string, unknown>).review_required)
          : step.action?.type === 'create-pr'
            ? 'human'
            : 'none';

      const job = await this.jobs.create({
        id: jobId,
        project_id: projectId,
        parent_id: null,  // Pipeline jobs are top-level
        depth: 0,
        title,
        description,
        issue_type: 'task',
        labels: [
          `pipeline:${request.pipeline_name}`,
          `run:${runId}`,
          `step:${stepName}`,
          `execution:${executionType}`,
        ],
        phase: initialPhase,
        priority: Math.min(index, 4),  // Clamp to valid range (0-4); step ordering uses depends_on
        assignee: null,
        review_required: reviewRequired as 'none' | 'human' | 'agent',
        review_status: null,
        reviewer: null,
        defer_until: null,
        due_at: null,
        hints: {
          pipeline_run_id: runId,
          step_name: stepName,
          step_index: index,
          execution_type: executionType,
          git_sha: request.git_sha,
          ...metadata,
          ...(resolvedToolchains.length > 0 ? { toolchains: resolvedToolchains } : {}),
        },
        harness: null,
        harness_profile: null,
        harness_options: null,
        harness_profile_override: null,
        env_overrides: stepJobEnvOverrides,
        token_scope: stepJobTokenScope,
        token_permissions: stepJobTokenPermissions,
        harness_profile_source: null,
        harness_profile_hash: null,
        git_json: null,
        resolved_git_json: null,
        workspace_json: null,
        blocked_on_gates: [],
        env_name: effectiveEnvName,
        execution_mode: 'ephemeral',
        execution_type: executionType as 'agent' | 'script' | 'action',
        run_id: runId,
        step_name: stepName,
        action_type: step.action?.type ?? null,
        action_input: step.action ? (step.action as unknown as Record<string, unknown>) : null,
        script_command: scriptCommand,
        script_timeout_seconds: scriptTimeoutSeconds,
        target: null,
        resource_refs: [],
        content_hash: null,
        actor_user_id: userId ?? null,
        failure_disposition: null,
        closed_at: null,
        close_reason: null,
      });

      createdJobs.push(job);
      stepNameToJobId.set(stepName, jobId);
    }

    // 6. Create job relations for dependencies
    const relations: JobRelation[] = [];

    for (const [index, step] of steps.entries()) {
      const stepName = step.name || `step-${index + 1}`;
      const jobId = stepNameToJobId.get(stepName);
      if (!jobId) continue;

      if (step.depends_on && Array.isArray(step.depends_on)) {
        for (const depName of step.depends_on) {
          const depJobId = stepNameToJobId.get(depName);
          if (!depJobId) {
            throw new BadRequestException(
              `Step "${stepName}" depends on unknown step "${depName}"`,
            );
          }

          // Add dependency: jobId depends on depJobId
          await this.jobs.addDependency(jobId, depJobId, 'blocks');

          relations.push({
            from_job_id: jobId,
            to_job_id: depJobId,
            relation_type: 'blocks',
          });
        }
      }
    }

    // 7. Return the complete response
    return {
      run: {
        id: run.id,
        project_id: run.project_id,
        pipeline_name: run.pipeline_name,
        env_name: run.env_name,
        git_sha: run.git_sha,
        manifest_hash: run.manifest_hash,
        inputs: run.inputs_json,
        step_outputs: run.step_outputs_json ?? null,
        status: run.status,
        started_at: run.started_at?.toISOString() ?? null,
        completed_at: run.completed_at?.toISOString() ?? null,
        error_message: run.error_message,
        requested_by: run.requested_by,
        run_mode: run.run_mode,
        dedupe_key: run.dedupe_key,
        created_at: run.created_at.toISOString(),
        updated_at: run.updated_at.toISOString(),
      },
      jobs: createdJobs.map(job => this.toJobResponse(job)),
      relations,
    };
  }

  /**
   * Get a pipeline run with its associated jobs
   */
  async getRunWithJobs(
    projectId: string,
    runId: string,
  ): Promise<PipelineRunWithJobsResponse> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get the run
    const run = await this.runs.findRunById(runId);
    if (!run || run.project_id !== projectId) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }

    // Get jobs for this run by label
    const jobs = await this.db<Job[]>`
      SELECT * FROM jobs
      WHERE project_id = ${projectId}
        AND labels @> ARRAY[${`run:${runId}`}]::varchar[]
      ORDER BY priority ASC
    `;

    // Get relations between these jobs
    const jobIds = jobs.map(j => j.id);
    const relations = jobIds.length > 0
      ? await this.db<{ job_id: string; related_job_id: string; relation_type: string }[]>`
          SELECT job_id, related_job_id, relation_type
          FROM job_relations
          WHERE job_id = ANY(${jobIds}) AND related_job_id = ANY(${jobIds})
        `
      : [];

    return {
      run: {
        id: run.id,
        project_id: run.project_id,
        pipeline_name: run.pipeline_name,
        env_name: run.env_name,
        git_sha: run.git_sha,
        manifest_hash: run.manifest_hash,
        inputs: run.inputs_json,
        step_outputs: run.step_outputs_json ?? null,
        status: run.status,
        started_at: run.started_at?.toISOString() ?? null,
        completed_at: run.completed_at?.toISOString() ?? null,
        error_message: run.error_message,
        requested_by: run.requested_by,
        run_mode: run.run_mode,
        dedupe_key: run.dedupe_key,
        created_at: run.created_at.toISOString(),
        updated_at: run.updated_at.toISOString(),
      },
      jobs: jobs.map(job => this.toJobResponse(job)),
      relations: relations.map(r => ({
        from_job_id: r.job_id,
        to_job_id: r.related_job_id,
        relation_type: r.relation_type,
      })),
    };
  }

  /**
   * List jobs for a pipeline run
   */
  async listJobsForRun(
    projectId: string,
    runId: string,
  ): Promise<{ jobs: JobResponse[] }> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Verify run exists
    const run = await this.runs.findRunById(runId);
    if (!run || run.project_id !== projectId) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }

    // Get jobs for this run by label
    const jobs = await this.db<Job[]>`
      SELECT * FROM jobs
      WHERE project_id = ${projectId}
        AND labels @> ARRAY[${`run:${runId}`}]::varchar[]
      ORDER BY priority ASC
    `;

    return {
      jobs: jobs.map(job => this.toJobResponse(job)),
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private getPipelineFromManifest(
    manifestYaml: string,
    pipelineName: string,
  ): PipelineDefinition {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = yaml.parse(manifestYaml) as Record<string, unknown> | null;
    } catch (error) {
      throw new BadRequestException(
        `Invalid manifest YAML: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const pipelines = parsed?.pipelines;
    if (!pipelines || typeof pipelines !== 'object') {
      throw new NotFoundException(`No pipelines defined in manifest`);
    }

    const pipeline = (pipelines as Record<string, PipelineDefinition>)[pipelineName];
    if (!pipeline) {
      throw new NotFoundException(`Pipeline "${pipelineName}" not found in manifest`);
    }

    return pipeline;
  }

  private async cancelExistingRunForDedupeKey(dedupeKey: string): Promise<void> {
    const existingRun = await this.runs.findActiveRunByDedupeKey(dedupeKey);
    if (!existingRun) {
      return;
    }

    const completedAt = new Date();
    await this.runs.updateRun(existingRun.id, {
      status: 'cancelled',
      completed_at: completedAt,
      error_message: 'Superseded by new run with same dedupe key',
    });

    const steps = await this.runs.listStepRuns(existingRun.id);
    for (const step of steps) {
      if (!this.isStepTerminal(step.status)) {
        await this.runs.updateStepRun(step.id, {
          status: 'cancelled',
          completed_at: completedAt,
        });
      }
    }
  }

  private isStepTerminal(status: string): boolean {
    return ['succeeded', 'failed', 'cancelled'].includes(status);
  }

  private parseSharedStepExecution(
    step: PipelineStep,
    stepName: string,
  ): StepExecution {
    try {
      return parseSharedStepExecution(step as unknown as Record<string, unknown>, stepName);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  private describePipelineStepExecution(
    step: PipelineStep,
    execution: StepExecution,
    stepName: string,
  ): {
    executionType: 'action' | 'script' | 'agent';
    title: string;
    description: string;
    metadata: Record<string, unknown>;
  } {
    if (execution.executionType === 'action') {
      // Action-based step
      return {
        executionType: 'action',
        title: `[Action] ${stepName}`,
        description: `Execute action: ${execution.actionType}`,
        metadata: {
          action_type: execution.actionType,
          action_input: execution.actionInput ?? {},
        },
      };
    }

    if (execution.executionType === 'script') {
      // Script-based step
      const scriptCommand = execution.scriptCommand ?? '';
      const scriptConfig = getScriptConfig(step as unknown as Record<string, unknown>);
      return {
        executionType: 'script',
        title: `[Script] ${stepName}`,
        description: scriptCommand,
        metadata: {
          script_command: scriptCommand,
          script_config: scriptConfig?.config ?? {},
        },
      };
    }

    if (execution.executionType === 'agent') {
      // Agent-based step
      const prompt = execution.agentConfig?.prompt;
      return {
        executionType: 'agent',
        title: `[Agent] ${stepName}`,
        description: typeof prompt === 'string' ? prompt : '',
        metadata: {
          agent_prompt: prompt,
          agent_config: execution.agentConfig,
        },
      };
    }

    // Unknown step type - treat as generic task
    throw new BadRequestException(
      `Step "${stepName}" has no recognized execution type (action, script, or agent)`,
    );
  }

  private ensureRemediationPipelinePolicy(
    pipelineName: string,
    pipeline: PipelineDefinition,
    steps: PipelineStep[],
  ): void {
    if (!this.isRemediationPipeline(pipeline)) {
      return;
    }

    const actionSteps = steps.filter((step) => step.action && typeof step.action === 'object');
    const createPrSteps = actionSteps.filter((step) => step.action?.type === 'create-pr');
    if (createPrSteps.length === 0) {
      throw new BadRequestException(
        `Remediation pipeline "${pipelineName}" must include a create-pr action step`,
      );
    }

    const invalidAction = actionSteps.find((step) => step.action?.type !== 'create-pr');
    if (invalidAction?.action?.type) {
      throw new BadRequestException(
        `Remediation pipeline "${pipelineName}" action "${invalidAction.action.type}" is not allowed; use create-pr`,
      );
    }
  }

  private isRemediationPipeline(pipeline: PipelineDefinition): boolean {
    const trigger = pipeline.trigger;
    if (!trigger || typeof trigger !== 'object') {
      return false;
    }

    const systemTrigger = (trigger as Record<string, unknown>).system;
    if (!systemTrigger || typeof systemTrigger !== 'object') {
      return false;
    }

    const event = (systemTrigger as Record<string, unknown>).event;
    return event === 'pipeline.failed' || event === 'system.pipeline.failed';
  }

  private filterStepsForOnly(steps: PipelineStep[], only: string): PipelineStep[] {
    const namedSteps = steps.map((step, index) => {
      if (step.name) return step;
      return { ...step, name: `step-${index + 1}` };
    });
    const stepNames = namedSteps.map((step) => step.name ?? '');
    const stepMap = new Map<string, PipelineStep>();
    stepNames.forEach((name, index) => stepMap.set(name, namedSteps[index]));

    const included = new Set<string>();
    const visit = (name: string) => {
      const step = stepMap.get(name);
      if (!step) {
        throw new BadRequestException(`Pipeline step "${name}" not found`);
      }
      if (included.has(name)) return;
      included.add(name);
      if (Array.isArray(step.depends_on)) {
        for (const dep of step.depends_on) {
          visit(dep);
        }
      }
    };

    visit(only);

    return namedSteps.filter((_, index) => included.has(stepNames[index]));
  }

  private toJobResponse(job: Job): JobResponse {
    return {
      id: job.id,
      project_id: job.project_id,
      parent_id: job.parent_id,
      depth: job.depth,
      title: job.title,
      description: job.description,
      issue_type: job.issue_type,
      labels: job.labels,
      phase: job.phase,
      priority: job.priority,
      assignee: job.assignee,
      review_required: job.review_required,
      review_status: job.review_status,
      reviewer: job.reviewer,
      defer_until: job.defer_until?.toISOString() ?? null,
      due_at: job.due_at?.toISOString() ?? null,
      hints: job.hints,
      env_name: job.env_name,
      execution_mode: job.execution_mode,
      execution_type: job.execution_type,
      run_id: job.run_id,
      step_name: job.step_name,
      action_type: job.action_type,
      action_input: job.action_input,
      script_command: job.script_command,
      script_timeout_seconds: job.script_timeout_seconds,
      env_overrides: job.env_overrides ?? null,
      created_at: job.created_at.toISOString(),
      updated_at: job.updated_at.toISOString(),
      closed_at: job.closed_at?.toISOString() ?? null,
      close_reason: job.close_reason,
    };
  }

  /**
   * Build a dry run response without persisting anything to the database.
   * Computes the job graph that would be created, including jobs and relations.
   */
  private async buildDryRunResponse(
    projectId: string,
    request: ExpandPipelineRequest,
    manifestHash: string,
    steps: PipelineStep[],
    effectiveEnvName: string | null = null,
    pipelineToolchains?: string[],
    actionRunEnvOverridesByStep: Map<string, EnvOverrides | null> = new Map(),
  ): Promise<PipelineRunWithJobsResponse> {
    const now = new Date();
    const runId = `dry-run-${Date.now()}`;

    const jobs: JobResponse[] = [];
    const relations: JobRelation[] = [];
    const stepNameToIndex = new Map<string, number>();

    for (const [index, step] of steps.entries()) {
      const stepName = step.name || `step-${index + 1}`;
      stepNameToIndex.set(stepName, index);
      const stepJobEnvOverrides = actionRunEnvOverridesByStep.get(stepName) ?? null;

      const stepExecution = this.parseSharedStepExecution(step, stepName);
      const { executionType, title, description, metadata } = this.describePipelineStepExecution(step, stepExecution, stepName);
      const scriptCommand = stepExecution.scriptCommand;
      const scriptTimeoutSeconds = stepExecution.scriptTimeoutSeconds;
      const stepToolchains = this.parseToolchains(
        step.toolchains,
        `Pipeline "${request.pipeline_name}" step "${stepName}".toolchains`,
      );
      const resolvedToolchains = this.resolvePipelineStepToolchains(
        pipelineToolchains,
        stepToolchains,
        step,
        stepExecution,
        `Pipeline "${request.pipeline_name}" step "${stepName}"`,
      );

      const reviewRequired =
        step.action && typeof (step.action as Record<string, unknown>).review_required === 'string'
          ? String((step.action as Record<string, unknown>).review_required)
          : step.action?.type === 'create-pr'
            ? 'human'
            : 'none';

      jobs.push({
        id: `dry-${stepName}-${index}`,
        project_id: projectId,
        parent_id: null,
        depth: 0,
        title,
        description,
        issue_type: 'task',
        labels: [
          `pipeline:${request.pipeline_name}`,
          `run:${runId}`,
          `step:${stepName}`,
          `execution:${executionType}`,
        ],
        phase: (step.depends_on && Array.isArray(step.depends_on) && step.depends_on.length > 0) ? 'backlog' : 'ready',
        priority: Math.min(index, 4),  // Clamp to valid range (0-4)
        assignee: null,
        review_required: reviewRequired,
        review_status: null,
        reviewer: null,
        defer_until: null,
        due_at: null,
        hints: {
          pipeline_run_id: runId,
          step_name: stepName,
          step_index: index,
          execution_type: executionType,
          git_sha: request.git_sha,
          ...metadata,
          ...(resolvedToolchains.length > 0 ? { toolchains: resolvedToolchains } : {}),
        },
        env_name: effectiveEnvName,
        execution_mode: 'ephemeral',
        execution_type: executionType,
        run_id: runId,
        step_name: stepName,
        action_type: step.action?.type ?? null,
        action_input: step.action ? (step.action as unknown as Record<string, unknown>) : null,
        script_command: scriptCommand,
        script_timeout_seconds: scriptTimeoutSeconds,
        env_overrides: stepJobEnvOverrides,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        closed_at: null,
        close_reason: null,
      });
    }

    // Build relations from dependencies
    for (const [index, step] of steps.entries()) {
      const stepName = step.name || `step-${index + 1}`;
      if (step.depends_on && Array.isArray(step.depends_on)) {
        for (const depName of step.depends_on) {
          const depIndex = stepNameToIndex.get(depName);
          if (depIndex === undefined) {
            throw new BadRequestException(
              `Step "${stepName}" depends on unknown step "${depName}"`,
            );
          }
          relations.push({
            from_job_id: `dry-${stepName}-${index}`,
            to_job_id: `dry-${depName}-${depIndex}`,
            relation_type: 'blocks',
          });
        }
      }
    }

    return {
      run: {
        id: runId,
        project_id: projectId,
        pipeline_name: request.pipeline_name,
        env_name: effectiveEnvName,
        git_sha: request.git_sha,
        manifest_hash: manifestHash,
        inputs: request.inputs ?? null,
        step_outputs: null,
        status: 'dry_run',
        started_at: null,
        completed_at: null,
        error_message: null,
        requested_by: null,
        run_mode: 'dry_run',
        dedupe_key: request.dedupe_key ?? null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      jobs,
      relations,
    };
  }
}
