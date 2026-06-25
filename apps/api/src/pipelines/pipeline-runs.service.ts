import {
  BadRequestException,
  Injectable,
  Inject,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import type { Db } from '@eve/db';
import { executionLogQueries, jobQueries, pipelineRunQueries, projectManifestQueries, projectQueries } from '@eve/db';
import {
  generatePipelineRunId,
  generatePipelineStepRunId,
  type PipelineRunDetailResponse,
  type PipelineRunListResponse,
  type PipelineRunRequest,
  type PipelineRunResponse,
  type PipelineStepRunResponse,
} from '@eve/shared';
import * as yaml from 'yaml';
import { interval, from, concatMap, switchMap, takeWhile, share } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { PipelineExpanderService, type PipelineRunWithJobsResponse } from './pipeline-expander.service.js';

const DEFAULT_WAIT_SECONDS = 60;
const MIN_WAIT_SECONDS = 5;

interface PipelineDefinition {
  steps?: Array<Record<string, unknown>>;
  wait_timeout?: number;
  [key: string]: unknown;
}

@Injectable()
export class PipelineRunsService {
  private runs: ReturnType<typeof pipelineRunQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private logs: ReturnType<typeof executionLogQueries>;
  private jobs: ReturnType<typeof jobQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    @Inject(forwardRef(() => PipelineExpanderService))
    private readonly expander: PipelineExpanderService,
  ) {
    this.runs = pipelineRunQueries(db);
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
    this.logs = executionLogQueries(db);
    this.jobs = jobQueries(db);
  }

  async createRun(
    projectId: string,
    pipelineName: string,
    request: PipelineRunRequest,
    runMode: string | null,
    dedupeKey?: string,
  ): Promise<{ detail: PipelineRunDetailResponse; pipeline: PipelineDefinition }>
  {
    await this.ensureProjectExists(projectId);
    const { manifest, pipeline } = await this.getPipeline(projectId, pipelineName, request.ref);

    const pipelineSteps = pipeline.steps;
    if (!Array.isArray(pipelineSteps) || pipelineSteps.length === 0) {
      throw new BadRequestException(`Pipeline "${pipelineName}" has no steps`);
    }

    // Route all pipelines to job-based execution (build actions require job-based path)
    // Legacy step_run path is retained below but no longer reached
    return this.createRunAsJobs(projectId, pipelineName, request, pipeline, dedupeKey);

    /* ===== LEGACY STEP_RUN CODE - RETAINED FOR REFERENCE, NO LONGER EXECUTED =====
    // Handle deduplication: cancel existing active run if dedupe_key provided
    if (dedupeKey) {
      await this.cancelExistingRunForDedupeKey(dedupeKey);
    }

    const runId = generatePipelineRunId();
    const run = await this.runs.createRun({
      id: runId,
      project_id: projectId,
      pipeline_name: pipelineName,
      env_name: request.env ?? null,
      git_sha: request.ref ?? null,
      manifest_hash: manifest.manifest_hash,
      inputs_json: request.inputs ?? null,
      step_outputs_json: null,
      status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: null,
      run_mode: runMode,
      dedupe_key: dedupeKey ?? null,
    });

    const stepRuns = [] as PipelineStepRunResponse[];
    for (const [index, step] of pipelineSteps.entries()) {
      const stepType = this.getStepType(step);
      if (!stepType) {
        throw new BadRequestException(`Pipeline "${pipelineName}" step missing type at index ${index}`);
      }

      const stepName =
        typeof step.name === 'string' && step.name.trim().length > 0
          ? step.name
          : `${stepType}-${index + 1}`;

      const stepRun = await this.runs.createStepRun({
        id: generatePipelineStepRunId(),
        pipeline_run_id: runId,
        step_index: index,
        step_name: stepName,
        step_type: stepType,
        status: 'pending',
        started_at: null,
        completed_at: null,
        error_message: null,
        logs_ref: null,
        input_json: step,
        output_json: null,
        result_text: null,
        result_json: null,
        exit_code: null,
        duration_ms: null,
      });

      stepRuns.push(this.toStepResponse(stepRun));
    }

    return {
      detail: {
        run: this.toRunResponse(run),
        steps: stepRuns,
      },
      pipeline,
    };
    */
  }

  async listRuns(
    projectId: string,
    pipelineName: string,
    options: { limit?: number; offset?: number },
  ): Promise<PipelineRunListResponse> {
    await this.ensureProjectExists(projectId);
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const runs = await this.runs.listRuns({ project_id: projectId, pipeline_name: pipelineName, limit, offset });
    return {
      data: runs.map(run => this.toRunResponse(run)),
      pagination: {
        limit,
        offset,
        count: runs.length,
      },
    };
  }

  async getRunDetail(projectId: string, pipelineName: string, runId: string): Promise<PipelineRunDetailResponse> {
    await this.ensureProjectExists(projectId);
    const run = await this.runs.findRunById(runId);
    if (!run || run.project_id !== projectId || run.pipeline_name !== pipelineName) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }

    // Handle job-based pipeline runs
    if (run.run_mode === 'jobs') {
      const { jobs } = await this.expander.listJobsForRun(projectId, runId);
      return {
        run: this.toRunResponse(run),
        steps: jobs.map((job, index) => this.jobToStepResponse(job, runId, index)),
      };
    }

    // Handle legacy step-based pipeline runs
    const steps = await this.runs.listStepRuns(runId);
    return {
      run: this.toRunResponse(run),
      steps: steps.map(step => this.toStepResponse(step)),
    };
  }

  async waitForRun(
    runId: string,
    timeoutSeconds: number,
  ): Promise<{ completed: boolean; detail: PipelineRunDetailResponse; elapsed: number }>
  {
    const startTime = Date.now();
    const pollIntervalMs = 2000;

    while (true) {
      const run = await this.runs.findRunById(runId);
      if (!run) {
        throw new NotFoundException(`Pipeline run ${runId} not found`);
      }

      // Handle both run modes
      let detail: PipelineRunDetailResponse;
      if (run.run_mode === 'jobs') {
        const { jobs } = await this.expander.listJobsForRun(run.project_id, runId);
        detail = {
          run: this.toRunResponse(run),
          steps: jobs.map((job, index) => this.jobToStepResponse(job, runId, index)),
        };
      } else {
        const steps = await this.runs.listStepRuns(runId);
        detail = {
          run: this.toRunResponse(run),
          steps: steps.map(step => this.toStepResponse(step)),
        };
      }

      if (this.isRunTerminal(run.status)) {
        return { completed: true, detail, elapsed: Math.floor((Date.now() - startTime) / 1000) };
      }

      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= timeoutSeconds * 1000) {
        return { completed: false, detail, elapsed: Math.floor(elapsedMs / 1000) };
      }

      const remainingMs = timeoutSeconds * 1000 - elapsedMs;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    }
  }

  async approveRun(runId: string): Promise<PipelineRunDetailResponse> {
    const run = await this.runs.findRunById(runId);
    if (!run) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }

    if (run.status !== 'awaiting_approval') {
      throw new BadRequestException(`Run ${runId} is not awaiting approval`);
    }

    if (run.run_mode === 'jobs') {
      throw new BadRequestException(`Run ${runId} approval is not supported for job-based pipelines`);
    }

    const approvedEnv = run.env_name ? [run.env_name] : [];
    const inputs = run.inputs_json ?? {};
    const existing = Array.isArray((inputs as Record<string, unknown>).approved_envs)
      ? ((inputs as Record<string, unknown>).approved_envs as string[])
      : [];
    const approved_envs = Array.from(new Set([...existing, ...approvedEnv]));

    await this.runs.updateRun(runId, {
      status: 'pending',
      inputs_json: { ...inputs, approved_envs },
    });
    const steps = await this.runs.listStepRuns(runId);

    for (const step of steps) {
      if (step.status === 'blocked') {
        await this.runs.updateStepRun(step.id, { status: 'pending' });
      }
    }

    return this.getRunDetail(run.project_id, run.pipeline_name, runId);
  }

  async cancelRun(runId: string, reason?: string): Promise<PipelineRunDetailResponse> {
    const run = await this.runs.findRunById(runId);
    if (!run) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }

    const completedAt = new Date();
    await this.runs.updateRun(runId, {
      status: 'cancelled',
      completed_at: completedAt,
      error_message: reason ?? run.error_message ?? null,
    });

    const steps = await this.runs.listStepRuns(runId);
    for (const step of steps) {
      if (!this.isStepTerminal(step.status)) {
        await this.runs.updateStepRun(step.id, {
          status: 'cancelled',
          completed_at: completedAt,
        });
      }
    }

    if (run.run_mode === 'jobs') {
      const jobs = await this.jobs.listByRunId(runId);
      for (const job of jobs) {
        if (job.phase === 'done' || job.phase === 'cancelled') {
          continue;
        }
        await this.jobs.cancelJob(job.id, reason ?? 'Pipeline run cancelled');
      }
    }

    return this.getRunDetail(run.project_id, run.pipeline_name, runId);
  }

  async updateRunInternal(
    runId: string,
    updates: { status?: string; started_at?: string; completed_at?: string; error_message?: string },
  ): Promise<void> {
    const updatePayload: {
      status?: string;
      started_at?: Date | null;
      completed_at?: Date | null;
      error_message?: string | null;
    } = {};

    if (updates.status !== undefined) updatePayload.status = updates.status;
    if (updates.started_at !== undefined) updatePayload.started_at = updates.started_at ? new Date(updates.started_at) : null;
    if (updates.completed_at !== undefined) updatePayload.completed_at = updates.completed_at ? new Date(updates.completed_at) : null;
    if (updates.error_message !== undefined) updatePayload.error_message = updates.error_message;

    const updated = await this.runs.updateRun(runId, updatePayload);
    if (!updated) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }
  }

  async updateStepInternal(
    runId: string,
    stepRunId: string,
    updates: {
      status?: string;
      started_at?: string;
      completed_at?: string;
      error_message?: string;
      result_text?: string;
      result_json?: Record<string, unknown>;
      exit_code?: number;
      duration_ms?: number;
      output_json?: Record<string, unknown>;
    },
  ): Promise<void> {
    const step = await this.runs.findStepRunById(stepRunId);
    if (!step || step.pipeline_run_id !== runId) {
      throw new NotFoundException(`Pipeline step ${stepRunId} not found`);
    }

    const updatePayload: {
      status?: string;
      started_at?: Date | null;
      completed_at?: Date | null;
      error_message?: string | null;
      result_text?: string | null;
      result_json?: Record<string, unknown> | null;
      exit_code?: number | null;
      duration_ms?: number | null;
      output_json?: Record<string, unknown> | null;
    } = {};

    if (updates.status !== undefined) updatePayload.status = updates.status;
    if (updates.started_at !== undefined) updatePayload.started_at = updates.started_at ? new Date(updates.started_at) : null;
    if (updates.completed_at !== undefined) updatePayload.completed_at = updates.completed_at ? new Date(updates.completed_at) : null;
    if (updates.error_message !== undefined) updatePayload.error_message = updates.error_message;
    if (updates.result_text !== undefined) updatePayload.result_text = updates.result_text;
    if (updates.result_json !== undefined) updatePayload.result_json = updates.result_json ?? null;
    if (updates.exit_code !== undefined) updatePayload.exit_code = updates.exit_code;
    if (updates.duration_ms !== undefined) updatePayload.duration_ms = updates.duration_ms;
    if (updates.output_json !== undefined) updatePayload.output_json = updates.output_json ?? null;

    await this.runs.updateStepRun(stepRunId, updatePayload);
  }

  async appendStepLog(runId: string, stepRunId: string, logType: string, content: Record<string, unknown>): Promise<void> {
    const step = await this.runs.findStepRunById(stepRunId);
    if (!step || step.pipeline_run_id !== runId) {
      throw new NotFoundException(`Pipeline step ${stepRunId} not found`);
    }
    await this.logs.appendStepLog(stepRunId, logType, content);
  }

  streamRunLogs(runId: string): MessageEvent[] | import('rxjs').Observable<MessageEvent> {
    let isComplete = false;
    const lastSequences = new Map<string, number>();
    const lastJobUpdates = new Map<string, string>();
    const lastJobSeq = new Map<string, number>();

    return interval(1000).pipe(
      switchMap(() =>
        from(
          (async () => {
            const run = await this.runs.findRunById(runId);
            if (!run) {
              throw new NotFoundException(`Pipeline run ${runId} not found`);
            }

            if (run.run_mode === 'jobs') {
              const { jobs } = await this.expander.listJobsForRun(run.project_id, runId);
              return { run, jobs, steps: null } as const;
            }

            const steps = await this.runs.listStepRuns(runId);
            return { run, jobs: null, steps } as const;
          })()
        )
      ),
      concatMap(({ run, steps, jobs }) =>
        from(
          (async () => {
            const events: MessageEvent[] = [];

            if (steps) {
              for (const step of steps) {
                const lastSeq = lastSequences.get(step.id) ?? 0;
                const logs = await this.logs.listStepLogs(step.id, lastSeq);
                for (const log of logs) {
                  const content = log.content as Record<string, unknown>;
                  lastSequences.set(step.id, log.seq);
                  events.push({
                    type: 'log',
                    data: {
                      step_id: step.id,
                      step_name: step.step_name,
                      sequence: log.seq,
                      timestamp: (content.timestamp as string) || log.created_at.toISOString(),
                      type: log.type,
                      line: content,
                    },
                  });
                }
              }
            }

            if (jobs) {
              for (const job of jobs) {
                const lastUpdate = lastJobUpdates.get(job.id);
                if (lastUpdate && lastUpdate === job.updated_at) {
                  continue;
                }
                lastJobUpdates.set(job.id, job.updated_at);
                const nextSeq = (lastJobSeq.get(job.id) ?? 0) + 1;
                lastJobSeq.set(job.id, nextSeq);
                events.push({
                  type: 'log',
                  data: {
                    step_id: job.id,
                    step_name: job.step_name ?? job.title,
                    sequence: nextSeq,
                    timestamp: job.updated_at,
                    type: 'status',
                    line: {
                      phase: job.phase,
                      close_reason: job.close_reason ?? null,
                    },
                  },
                });
              }
            }

            if (this.isRunTerminal(run.status)) {
              isComplete = true;
              const eventType = run.status === 'succeeded' ? 'complete' : 'error';
              events.push({
                type: eventType,
                data: {
                  status: run.status,
                  errorMessage: run.error_message ?? null,
                },
              });
            }

            return events;
          })()
        )
      ),
      concatMap((events) => from(events)),
      takeWhile(() => !isComplete, true),
      share(),
    );
  }

  streamStepLogs(runId: string, stepName: string): import('rxjs').Observable<MessageEvent> {
    let lastSequence = 0;
    let isComplete = false;

    return interval(1000).pipe(
      switchMap(() =>
        from(
          (async () => {
            const run = await this.runs.findRunById(runId);
            if (!run) {
              throw new NotFoundException(`Pipeline run ${runId} not found`);
            }

            const steps = await this.runs.listStepRuns(runId);
            const step = steps.find(s => s.step_name === stepName);
            if (!step) {
              throw new NotFoundException(`Pipeline step "${stepName}" not found for run ${runId}`);
            }

            const logs = await this.logs.listStepLogs(step.id, lastSequence);
            return { step, logs };
          })()
        )
      ),
      concatMap(({ step, logs }) => {
        const events: MessageEvent[] = [];
        for (const log of logs) {
          const content = log.content as Record<string, unknown>;
          lastSequence = log.seq;
          events.push({
            type: 'log',
            data: {
              sequence: log.seq,
              timestamp: (content.timestamp as string) || log.created_at.toISOString(),
              type: log.type,
              line: content,
            },
          });
        }

        if (this.isStepTerminal(step.status)) {
          isComplete = true;
          const eventType = step.status === 'succeeded' ? 'complete' : 'error';
          events.push({
            type: eventType,
            data: {
              status: step.status,
              errorMessage: step.error_message ?? null,
            },
          });
        }

        return from(events);
      }),
      takeWhile(() => !isComplete, true),
      share(),
    );
  }

  async getRunLogs(
    runId: string,
    options: { step?: string; afterSeq?: number; limit?: number },
  ): Promise<{ logs: Array<{ step_name: string; seq: number; type: string; content: Record<string, unknown>; timestamp: string }> }> {
    const run = await this.runs.findRunById(runId);
    if (!run) {
      throw new NotFoundException(`Pipeline run ${runId} not found`);
    }

    if (run.run_mode === 'jobs') {
      const { jobs } = await this.expander.listJobsForRun(run.project_id, runId);
      const filteredJobs = options.step
        ? jobs.filter(j => (j.step_name ?? j.title) === options.step)
        : jobs;

      const collectedLogs: Array<{
        step_name: string;
        type: string;
        content: Record<string, unknown>;
        timestamp: string;
      }> = [];

      for (const job of filteredJobs) {
        const stepName = job.step_name ?? job.title;
        const attempts = await this.jobs.listAttempts(job.id);
        let sawAttemptLog = false;

        for (const attempt of [...attempts].reverse()) {
          const attemptLogs = await this.logs.listLogs(attempt.id);
          for (const log of attemptLogs) {
            const content = this.parseLogContent(log.content);
            sawAttemptLog = true;
            collectedLogs.push({
              step_name: stepName,
              type: log.type,
              content,
              timestamp: (content.timestamp as string) ?? log.created_at?.toISOString() ?? new Date().toISOString(),
            });
          }
        }

        if (!sawAttemptLog) {
          collectedLogs.push({
            step_name: stepName,
            type: 'status',
            content: {
              phase: job.phase,
              close_reason: job.close_reason ?? null,
            },
            timestamp: job.updated_at,
          });
        }
      }

      collectedLogs.sort((a, b) => {
        const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        return timeDiff;
      });

      const logs = collectedLogs.map((log, index) => ({ ...log, seq: index + 1 }));
      const afterSeq = options.afterSeq;
      const filteredLogs = afterSeq !== undefined
        ? logs.filter((log) => log.seq > afterSeq)
        : logs;
      const limited = options.limit ? filteredLogs.slice(0, options.limit) : filteredLogs;
      return { logs: limited };
    }

    const steps = await this.runs.listStepRuns(runId);
    const filteredSteps = options.step
      ? steps.filter(s => s.step_name === options.step)
      : steps;

    const allLogs: Array<{ step_name: string; seq: number; type: string; content: Record<string, unknown>; timestamp: string }> = [];

    for (const step of filteredSteps) {
      const logs = await this.logs.listStepLogs(step.id, options.afterSeq);
      for (const log of logs) {
        const content = this.parseLogContent(log.content);
        allLogs.push({
          step_name: step.step_name,
          seq: log.seq,
          type: log.type,
          content,
          timestamp: (content.timestamp as string) ?? log.created_at?.toISOString() ?? new Date().toISOString(),
        });
      }
    }

    // Sort by timestamp, then seq
    allLogs.sort((a, b) => {
      const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      return timeDiff !== 0 ? timeDiff : a.seq - b.seq;
    });

    const limited = options.limit ? allLogs.slice(0, options.limit) : allLogs;

    return { logs: limited };
  }

  private parseLogContent(content: unknown): Record<string, unknown> {
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
      } catch {
        return { message: content };
      }
    }
    return content && typeof content === 'object' ? content as Record<string, unknown> : {};
  }

  async findActiveRunByEnv(projectId: string, envName: string) {
    return this.runs.findActiveByEnv(projectId, envName);
  }

  resolveWaitTimeout(pipeline: PipelineDefinition, explicitTimeout?: number): number {
    const maxWait = this.getMaxWaitSeconds();
    if (explicitTimeout !== undefined) {
      return this.clampWait(explicitTimeout, maxWait);
    }

    if (typeof pipeline.wait_timeout === 'number' && Number.isFinite(pipeline.wait_timeout)) {
      return this.clampWait(pipeline.wait_timeout, maxWait);
    }

    return this.clampWait(DEFAULT_WAIT_SECONDS, maxWait);
  }

  /**
   * Create a pipeline run using job-based execution.
   * Used when pipeline contains agent or script steps that require job scheduling.
   */
  private async createRunAsJobs(
    projectId: string,
    pipelineName: string,
    request: PipelineRunRequest,
    pipeline: PipelineDefinition,
    dedupeKey?: string,
  ): Promise<{ detail: PipelineRunDetailResponse; pipeline: PipelineDefinition }> {
    // Handle deduplication: cancel existing active run if dedupe_key provided
    if (dedupeKey) {
      await this.cancelExistingRunForDedupeKey(dedupeKey);
    }

    const expanderResponse = await this.expander.expandPipeline(projectId, {
      pipeline_name: pipelineName,
      env_name: request.env,
      git_sha: request.ref,
      inputs: request.inputs,
      dedupe_key: dedupeKey,
    });

    // Map expander response to the expected format
    // Jobs are used instead of step runs, so steps array is empty
    // Clients can query jobs via the run:${runId} label
    const detail: PipelineRunDetailResponse = {
      run: {
        id: expanderResponse.run.id,
        project_id: expanderResponse.run.project_id,
        pipeline_name: expanderResponse.run.pipeline_name,
        env_name: expanderResponse.run.env_name,
        git_sha: expanderResponse.run.git_sha,
        manifest_hash: expanderResponse.run.manifest_hash,
        inputs: expanderResponse.run.inputs,
        step_outputs: expanderResponse.run.step_outputs,
        status: expanderResponse.run.status as PipelineRunResponse['status'],
        started_at: expanderResponse.run.started_at,
        completed_at: expanderResponse.run.completed_at,
        error_message: expanderResponse.run.error_message,
        requested_by: expanderResponse.run.requested_by,
        run_mode: expanderResponse.run.run_mode,
        created_at: expanderResponse.run.created_at,
        updated_at: expanderResponse.run.updated_at,
      },
      steps: [], // Jobs are used instead; query via run:${runId} label
    };

    return { detail, pipeline };
  }

  /**
   * Determine step type from step definition.
   * Steps can be: action, script, agent, or run (shorthand for script)
   */
  private getStepType(step: Record<string, unknown>): string {
    if (step.action && typeof step.action === 'object') {
      const action = step.action as Record<string, unknown>;
      return typeof action.type === 'string' ? action.type : 'action';
    }
    if (step.script) return 'script';
    if (step.agent) return 'agent';
    if (step.run) return 'script';
    return '';
  }

  private clampWait(timeout: number, maxWait: number): number {
    const floored = Math.floor(timeout);
    if (!Number.isFinite(floored)) {
      return this.clampWait(DEFAULT_WAIT_SECONDS, maxWait);
    }
    return Math.max(MIN_WAIT_SECONDS, Math.min(floored, maxWait));
  }

  private getMaxWaitSeconds(): number {
    const configured = process.env.EVE_PIPELINE_WAIT_MAX;
    if (!configured) {
      return 300;
    }
    const parsed = Number(configured);
    return Number.isFinite(parsed) ? Math.max(MIN_WAIT_SECONDS, parsed) : 300;
  }

  private async ensureProjectExists(projectId: string): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }

  private async getPipeline(
    projectId: string,
    pipelineName: string,
    ref?: string,
  ): Promise<{ manifest: any; pipeline: PipelineDefinition }> {
    // When a ref is supplied, prefer the manifest synced for that git SHA so
    // the pipeline resolution matches what the deployer will actually render.
    // Falls back to latest when no ref-scoped row exists (e.g. legacy calls).
    const manifest = ref
      ? ((await this.manifests.findByProjectAndGitSha(projectId, ref)) ??
         (await this.manifests.findLatestByProject(projectId)))
      : await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      throw new NotFoundException(`No manifest synced for project ${projectId}`);
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = yaml.parse(manifest.manifest_yaml) as Record<string, unknown> | null;
    } catch (error) {
      throw new BadRequestException(
        `Invalid manifest YAML: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    const pipelines = parsed?.pipelines;
    if (!pipelines || typeof pipelines !== 'object') {
      throw new NotFoundException(`No pipelines defined for project ${projectId}`);
    }

    const pipeline = (pipelines as Record<string, PipelineDefinition>)[pipelineName];
    if (!pipeline) {
      throw new NotFoundException(`Pipeline "${pipelineName}" not found for project ${projectId}`);
    }

    return { manifest, pipeline };
  }

  private toRunResponse(run: Awaited<ReturnType<typeof this.runs.findRunById>> & object): PipelineRunResponse {
    return {
      id: run.id,
      project_id: run.project_id,
      pipeline_name: run.pipeline_name,
      env_name: run.env_name,
      git_sha: run.git_sha,
      manifest_hash: run.manifest_hash,
      inputs: run.inputs_json,
      step_outputs: run.step_outputs_json,
      status: run.status as PipelineRunResponse['status'],
      started_at: run.started_at ? run.started_at.toISOString() : null,
      completed_at: run.completed_at ? run.completed_at.toISOString() : null,
      error_message: run.error_message,
      requested_by: run.requested_by,
      run_mode: run.run_mode,
      created_at: run.created_at.toISOString(),
      updated_at: run.updated_at.toISOString(),
    };
  }

  private toStepResponse(step: Awaited<ReturnType<typeof this.runs.findStepRunById>> & object): PipelineStepRunResponse {
    return {
      id: step.id,
      pipeline_run_id: step.pipeline_run_id,
      step_index: step.step_index,
      step_name: step.step_name,
      step_type: step.step_type as PipelineStepRunResponse['step_type'],
      status: step.status as PipelineStepRunResponse['status'],
      started_at: step.started_at ? step.started_at.toISOString() : null,
      completed_at: step.completed_at ? step.completed_at.toISOString() : null,
      error_message: step.error_message,
      logs_ref: step.logs_ref,
      input_json: step.input_json,
      output_json: step.output_json,
      result_text: step.result_text,
      result_json: step.result_json,
      exit_code: step.exit_code,
      duration_ms: step.duration_ms,
      created_at: step.created_at.toISOString(),
      updated_at: step.updated_at.toISOString(),
    };
  }

  private isRunTerminal(status: string): boolean {
    return ['succeeded', 'failed', 'cancelled'].includes(status);
  }

  private isStepTerminal(status: string): boolean {
    return ['succeeded', 'failed', 'cancelled'].includes(status);
  }

  /**
   * Map job phase to pipeline step status.
   * Jobs use phases (ready, in_progress, done, etc.) while steps use statuses (pending, running, succeeded, etc.)
   */
  private mapJobPhaseToStepStatus(phase: string): PipelineStepRunResponse['status'] {
    switch (phase) {
      case 'idea':
      case 'backlog':
      case 'ready':
        return 'pending';
      case 'active':
        return 'running';
      case 'review':
        return 'blocked';
      case 'done':
        return 'succeeded';
      case 'cancelled':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  /**
   * Infer pipeline step type from job action/execution type.
   */
  private mapActionToStepType(actionType: string | null, executionType: string): PipelineStepRunResponse['step_type'] {
    if (actionType && ['build', 'release', 'deploy', 'create-pr'].includes(actionType)) {
      return actionType as PipelineStepRunResponse['step_type'];
    }
    return 'run';
  }

  /**
   * Convert a job to a PipelineStepRunResponse for job-based pipeline runs.
   */
  private jobToStepResponse(
    job: PipelineRunWithJobsResponse['jobs'][number],
    runId: string,
    index: number,
  ): PipelineStepRunResponse {
    const closeReason = job.close_reason ?? null;
    const cancelledIsFailure = job.phase === 'cancelled'
      && !!closeReason
      && !['cancelled', 'Job cancelled'].includes(closeReason);
    const status = cancelledIsFailure
      ? 'failed'
      : this.mapJobPhaseToStepStatus(job.phase);
    const startedAtStatuses: PipelineStepRunResponse['status'][] = [
      'running',
      'succeeded',
      'failed',
      'cancelled',
    ];

    return {
      id: job.id,
      pipeline_run_id: runId,
      step_index: index,
      step_name: job.step_name ?? job.title,
      step_type: this.mapActionToStepType(job.action_type, job.execution_type),
      status,
      started_at: startedAtStatuses.includes(status) ? job.updated_at : null,
      completed_at: job.closed_at,
      error_message: (status === 'failed' || status === 'cancelled') ? closeReason : null,
      logs_ref: null,
      input_json: null,
      output_json: null,
      result_text: null,
      result_json: null,
      exit_code: null,
      duration_ms: null,
      created_at: job.created_at,
      updated_at: job.updated_at,
    };
  }

  /**
   * Cancel any existing active pipeline run with the given dedupe_key.
   * This allows the new run to proceed without conflicts.
   */
  private async cancelExistingRunForDedupeKey(dedupeKey: string): Promise<void> {
    const existingRun = await this.runs.findActiveRunByDedupeKey(dedupeKey);
    if (existingRun) {
      console.log(`Cancelling existing pipeline run ${existingRun.id} (dedupe_key: ${dedupeKey}) to allow new run`);
      await this.cancelRun(existingRun.id, 'Superseded by new run with same dedupe key');
    }
  }
}
