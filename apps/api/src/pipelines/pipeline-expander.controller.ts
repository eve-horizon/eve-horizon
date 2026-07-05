import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { z } from 'zod';
import { GitShaSchema } from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import {
  PipelineExpanderService,
  type ExpandPipelineRequest,
  type PipelineRunWithJobsResponse,
} from './pipeline-expander.service.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';

// ============================================================================
// Schemas
// ============================================================================

export const ExpandPipelineRequestSchema = z.object({
  git_sha: GitShaSchema,
  env_name: z.string().optional(),
  inputs: z.record(z.unknown()).optional(),
  only: z.string().min(1).optional(),
  dedupe_key: z.string().optional(),
  dry_run: z.boolean().optional(),
});

export const JobResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: z.string().nullable(),
  depth: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  issue_type: z.string(),
  labels: z.array(z.string()),
  phase: z.string(),
  priority: z.number().int(),
  assignee: z.string().nullable(),
  review_required: z.string(),
  review_status: z.string().nullable(),
  reviewer: z.string().nullable(),
  defer_until: z.string().nullable(),
  due_at: z.string().nullable(),
  hints: z.record(z.unknown()),
  env_name: z.string().nullable(),
  execution_mode: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  close_reason: z.string().nullable(),
});

export const JobRelationSchema = z.object({
  from_job_id: z.string(),
  to_job_id: z.string(),
  relation_type: z.string(),
});

export const PipelineRunWithJobsResponseSchema = z.object({
  run: z.object({
    id: z.string(),
    project_id: z.string(),
    pipeline_name: z.string(),
    env_name: z.string().nullable(),
    git_sha: z.string().nullable(),
    manifest_hash: z.string().nullable(),
    inputs: z.record(z.unknown()).nullable(),
    step_outputs: z.record(z.unknown()).nullable(),
    status: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    error_message: z.string().nullable(),
    requested_by: z.string().nullable(),
    run_mode: z.string().nullable(),
    dedupe_key: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  jobs: z.array(JobResponseSchema),
  relations: z.array(JobRelationSchema),
});

export const JobListResponseSchema = z.object({
  jobs: z.array(JobResponseSchema),
});

// ============================================================================
// Controller
// ============================================================================

@ApiTags('pipeline-expander')
@ApiBearerAuth()
@Controller()
export class PipelineExpanderController {
  constructor(
    private readonly pipelineExpanderService: PipelineExpanderService,
  ) {}

  @RequirePermission('pipelines:write')
  @Post('projects/:id/pipelines/:name/runs')
  @ApiOperation({
    summary: 'Create a pipeline run (expands into job graph)',
    description:
      'Creates a pipeline run and expands the pipeline definition into a job graph. ' +
      'Each step becomes a job with appropriate phase (ready or backlog based on dependencies). ' +
      'Job relations are created for step dependencies.',
  })
  @ApiBody({
    schema: zodSchemaToOpenApi(ExpandPipelineRequestSchema, 'ExpandPipelineRequest'),
  })
  @ApiOkResponse({
    description: 'Pipeline run created with expanded job graph',
    schema: zodSchemaToOpenApi(
      PipelineRunWithJobsResponseSchema,
      'PipelineRunWithJobsResponse',
    ),
  })
  async createRun(
    @Param('id') projectId: string,
    @Param('name') pipelineName: string,
    @Body(new ZodValidationPipe(ExpandPipelineRequestSchema))
    body: { git_sha: string; env_name?: string; inputs?: Record<string, unknown>; only?: string; dedupe_key?: string; dry_run?: boolean },
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<PipelineRunWithJobsResponse> {
    const request: ExpandPipelineRequest = {
      pipeline_name: pipelineName,
      git_sha: body.git_sha,
      env_name: body.env_name,
      inputs: body.inputs,
      only: body.only,
      dedupe_key: body.dedupe_key,
      dry_run: body.dry_run,
    };
    return this.pipelineExpanderService.expandPipeline(projectId, request, caller?.user_id);
  }

  @RequirePermission('pipelines:read')
  @Get('projects/:id/runs/:runId')
  @ApiOperation({
    summary: 'Get pipeline run with its job graph',
    description:
      'Retrieves a pipeline run along with all associated jobs and their relations.',
  })
  @ApiOkResponse({
    description: 'Pipeline run with job graph',
    schema: zodSchemaToOpenApi(
      PipelineRunWithJobsResponseSchema,
      'PipelineRunWithJobsResponse',
    ),
  })
  async getRunWithJobs(
    @Param('id') projectId: string,
    @Param('runId') runId: string,
  ): Promise<PipelineRunWithJobsResponse> {
    return this.pipelineExpanderService.getRunWithJobs(projectId, runId);
  }

  @RequirePermission('pipelines:read')
  @Get('projects/:id/runs/:runId/jobs')
  @ApiOperation({
    summary: 'List jobs for a pipeline run',
    description:
      'Lists all jobs associated with a pipeline run, ordered by priority.',
  })
  @ApiOkResponse({
    description: 'List of jobs for the pipeline run',
    schema: zodSchemaToOpenApi(JobListResponseSchema, 'PipelineJobListResponse'),
  })
  async listJobsForRun(
    @Param('id') projectId: string,
    @Param('runId') runId: string,
  ): Promise<{ jobs: PipelineRunWithJobsResponse['jobs'] }> {
    return this.pipelineExpanderService.listJobsForRun(projectId, runId);
  }
}
