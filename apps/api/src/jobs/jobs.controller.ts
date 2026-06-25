import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  DefaultValuePipe,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Observable } from 'rxjs';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { RbacService } from '../auth/rbac.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import type { Permission } from '../auth/permissions.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import {
  AddDependencyRequestSchema,
  ApproveRequestSchema,
  ClaimRequestSchema,
  ClaimResponseSchema,
  CreateBatchRequestSchema,
  CreateBatchResponseSchema,
  BatchValidateResponseSchema,
  CreateJobRequestSchema,
  CreateJobResponseSchema,
  DependenciesResponseSchema,
  JobAttemptListResponseSchema,
  JobContextResponseSchema,
  JobLogsResponseSchema,
  JobResponseSchema,
  JobResultResponseSchema,
  JobTreeNodeSchema,
  JobListResponseSchema,
  ReleaseRequestSchema,
  JobReleaseResponseSchema,
  JobCompareResponseSchema,
  RejectRequestSchema,
  SubmitRequestSchema,
  SuccessMessageSchema,
  UpdateJobRequestSchema,
  WaitTimeoutResponseSchema,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type BatchValidateResponse,
  type JobCompareResponse,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import {
  JobsService,
  type CreateJobRequest,
  type UpdateJobRequest,
  type JobResponse,
  type JobListResponse,
  type JobTreeNode,
  type ClaimRequest,
  type ReleaseRequest,
  type SubmitRequest,
  type ApproveRequest,
  type RejectRequest,
  type AddDependencyRequest,
  type DependenciesResponse,
  type JobAttemptResponse,
  type JobResultResponse,
  type JobContextResponse,
} from './jobs.service.js';

/**
 * Jobs Controller - New Jobs V2 API
 *
 * This controller provides the full API for the new Jobs system, including:
 * - Project-scoped job CRUD operations
 * - Job hierarchy (tree) operations
 * - Dependency management
 * - Claim/release workflow
 * - Review workflow (submit, approve, reject)
 */
@ApiTags('jobs')
@ApiBearerAuth()
@Controller()
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly rbac: RbacService,
  ) {}

  // ==========================================================================
  // Project-scoped routes: /projects/:project_id/jobs
  // ==========================================================================

  @RequirePermission('jobs:write')
  @Post('projects/:project_id/jobs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a job in a project' })
  @ApiParam({ name: 'project_id', description: 'Project ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateJobRequestSchema, 'CreateJobRequest') })
  @ApiCreatedResponse({
    description: 'Job created',
    schema: zodSchemaToOpenApi(CreateJobResponseSchema, 'CreateJobResponse'),
  })
  async create(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateJobRequestSchema)) body: CreateJobRequest,
    @Req() request: { user?: AuthUser; correlationId?: string }
  ): Promise<JobResponse> {
    // Per-job harness overrides and env_overrides are privileged input: gate
    // them on jobs:harness_override and, when ${secret.KEY} placeholders are
    // present, also on secrets:read. docs/plans/per-job-harness-override-plan.md §3.7
    if (request.user) {
      const needs: Permission[] = [];
      if (body.harness_profile_override || body.env_overrides) {
        needs.push('jobs:harness_override');
      }
      if (body.env_overrides) {
        const refsAnySecret = Object.values(body.env_overrides).some((v) =>
          /\$\{secret\.[A-Z_][A-Z0-9_]*\}/.test(v),
        );
        if (refsAnySecret) needs.push('secrets:read');
      }
      if (needs.length > 0) {
        await this.rbac.requirePermissions(request.user, projectId, needs);
      }
    }
    return this.jobsService.create(projectId, body, request.user?.user_id, request.correlationId);
  }

  @RequirePermission('jobs:read')
  @Get('projects/:project_id/jobs')
  @ApiOperation({ summary: 'List jobs for a project' })
  @ApiParam({ name: 'project_id', description: 'Project ID or slug', type: String })
  @ApiQuery({ name: 'phase', required: false })
  @ApiQuery({ name: 'assignee', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'since', required: false, description: 'Filter jobs created after this ISO timestamp' })
  @ApiQuery({ name: 'stuck', required: false, description: 'Filter to jobs stuck in active phase' })
  @ApiQuery({ name: 'stuck_minutes', required: false, description: 'Minutes threshold for stuck detection (default: 5)' })
  @ApiQuery({ name: 'label', required: false, description: 'Filter by label (e.g. workflow:ingestion-pipeline)' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by execution type (agent, script, action)' })
  @ApiQuery({ name: 'parent', required: false, description: 'Filter by parent_id (use "null" for root jobs only)' })
  @ApiQuery({ name: 'failure_disposition', required: false, description: 'Filter by failure disposition (cancelled, failed, upstream_failed)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Job list',
    schema: zodSchemaToOpenApi(JobListResponseSchema, 'JobListResponse'),
  })
  async list(
    @Param('project_id') projectId: string,
    @Query('phase') phase?: string,
    @Query('assignee') assignee?: string,
    @Query('priority') priority?: string,
    @Query('since') since?: string,
    @Query('stuck') stuck?: string,
    @Query('stuck_minutes') stuckMinutes?: string,
    @Query('label') label?: string,
    @Query('type') type?: string,
    @Query('parent') parent?: string,
    @Query('failure_disposition') failureDisposition?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ): Promise<JobListResponse> {
    return this.jobsService.list(projectId, {
      phase: phase as any,
      assignee,
      priority: priority ? parseInt(priority, 10) : undefined,
      createdAfter: since ? new Date(since) : undefined,
      stuck: stuck === 'true' || stuck === '1',
      stuckMinutes: stuckMinutes ? parseInt(stuckMinutes, 10) : undefined,
      label,
      executionType: type,
      parentId: parent === 'null' ? null : parent,
      failureDisposition,
      limit,
      offset,
    });
  }

  @RequirePermission('jobs:read')
  @Get('projects/:project_id/jobs/ready')
  @ApiOperation({ summary: 'Get ready/schedulable jobs for a project' })
  @ApiParam({ name: 'project_id', description: 'Project ID or slug', type: String })
  @ApiQuery({ name: 'assignee', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({
    description: 'Ready job list',
    schema: zodSchemaToOpenApi(JobListResponseSchema, 'JobListResponse'),
  })
  async getReadyJobs(
    @Param('project_id') projectId: string,
    @Query('assignee') assignee?: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit?: number,
  ): Promise<JobListResponse> {
    return this.jobsService.getReadyJobs(projectId, { assignee, limit });
  }

  @RequirePermission('jobs:read')
  @Get('projects/:project_id/jobs/blocked')
  @ApiOperation({ summary: 'Get blocked jobs for a project' })
  @ApiParam({ name: 'project_id', description: 'Project ID or slug', type: String })
  @ApiOkResponse({
    description: 'Blocked job list',
    schema: zodSchemaToOpenApi(JobListResponseSchema, 'JobListResponse'),
  })
  async getBlockedJobs(
    @Param('project_id') projectId: string,
  ): Promise<JobListResponse> {
    return this.jobsService.getBlockedJobs(projectId);
  }

  // ==========================================================================
  // Batch routes: /projects/:project_id/jobs/batch
  // ==========================================================================

  @RequirePermission('jobs:read')
  @Post('projects/:project_id/jobs/batch/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a batch job graph without creating jobs' })
  @ApiParam({ name: 'project_id', description: 'Project ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateBatchRequestSchema, 'CreateBatchRequest') })
  @ApiOkResponse({
    description: 'Validation result',
    schema: zodSchemaToOpenApi(BatchValidateResponseSchema, 'BatchValidateResponse'),
  })
  async validateBatch(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateBatchRequestSchema)) body: CreateBatchRequest,
  ): Promise<BatchValidateResponse> {
    return this.jobsService.validateBatch(projectId, body);
  }

  @RequirePermission('jobs:write')
  @Post('projects/:project_id/jobs/batch')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a batch of jobs with dependencies atomically' })
  @ApiParam({ name: 'project_id', description: 'Project ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateBatchRequestSchema, 'CreateBatchRequest') })
  @ApiCreatedResponse({
    description: 'Batch created',
    schema: zodSchemaToOpenApi(CreateBatchResponseSchema, 'CreateBatchResponse'),
  })
  async createBatch(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateBatchRequestSchema)) body: CreateBatchRequest,
    @Req() request: { user?: { user_id?: string }; correlationId?: string },
  ): Promise<CreateBatchResponse> {
    return this.jobsService.createBatch(projectId, body, request.correlationId, request.user?.user_id);
  }

  // ==========================================================================
  // Admin routes: /jobs (cross-project)
  // ==========================================================================

  @RequirePermission('jobs:admin')
  @Get('jobs')
  @ApiOperation({ summary: 'List all jobs (admin)' })
  @ApiQuery({ name: 'org_id', required: false, description: 'Filter by organization ID' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Filter by project ID' })
  @ApiQuery({ name: 'phase', required: false, description: 'Filter by job phase' })
  @ApiQuery({ name: 'label', required: false, description: 'Filter by label (e.g. workflow:ingestion-pipeline)' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by execution type (agent, script, action)' })
  @ApiQuery({ name: 'parent', required: false, description: 'Filter by parent_id (use "null" for root jobs only)' })
  @ApiQuery({ name: 'failure_disposition', required: false, description: 'Filter by failure disposition (cancelled, failed, upstream_failed)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiOkResponse({
    description: 'Job list',
    schema: zodSchemaToOpenApi(JobListResponseSchema, 'JobListResponse'),
  })
  async listAll(
    @Query('org_id') orgId?: string,
    @Query('project_id') projectId?: string,
    @Query('phase') phase?: string,
    @Query('label') label?: string,
    @Query('type') type?: string,
    @Query('parent') parent?: string,
    @Query('failure_disposition') failureDisposition?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ): Promise<JobListResponse> {
    return this.jobsService.listAll({
      orgId,
      projectId,
      phase: phase as any,
      label,
      executionType: type,
      parentId: parent === 'null' ? null : parent,
      failureDisposition,
      limit,
      offset,
    });
  }

  // ==========================================================================
  // Job-scoped routes: /jobs/:job_id
  // ==========================================================================

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id')
  @ApiOperation({ summary: 'Get a job by ID' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiOkResponse({
    description: 'Job details',
    schema: zodSchemaToOpenApi(JobResponseSchema, 'JobResponse'),
  })
  @ApiNotFoundResponse({ description: 'Job not found' })
  async findById(
    @Param('job_id') jobId: string,
  ): Promise<JobResponse> {
    return this.jobsService.findById(jobId);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/compare')
  @ApiOperation({ summary: 'Compare two job attempts (cost + receipt summaries)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiQuery({ name: 'a', required: true, description: 'Attempt number A (1,2,3...)' })
  @ApiQuery({ name: 'b', required: true, description: 'Attempt number B (1,2,3...)' })
  @ApiQuery({ name: 'include_receipt', required: false, description: 'Include full receipt JSON (default: false)' })
  @ApiOkResponse({
    description: 'Attempt comparison',
    schema: zodSchemaToOpenApi(JobCompareResponseSchema, 'JobCompareResponse'),
  })
  async compareAttempts(
    @Param('job_id') jobId: string,
    @Query('a', ParseIntPipe) attemptA: number,
    @Query('b', ParseIntPipe) attemptB: number,
    @Query('include_receipt') includeReceipt?: string,
  ): Promise<JobCompareResponse> {
    const include = typeof includeReceipt === 'string'
      ? ['true', '1', 'yes', 'y', 'on'].includes(includeReceipt.toLowerCase())
      : false;
    return this.jobsService.compareAttempts(jobId, attemptA, attemptB, { include_receipt: include });
  }

  @RequirePermission('jobs:write')
  @Patch('jobs/:job_id')
  @ApiOperation({ summary: 'Update a job' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(UpdateJobRequestSchema, 'UpdateJobRequest') })
  @ApiOkResponse({
    description: 'Job updated',
    schema: zodSchemaToOpenApi(JobResponseSchema, 'JobResponse'),
  })
  async update(
    @Param('job_id') jobId: string,
    @Body() body: UpdateJobRequest
  ): Promise<JobResponse> {
    return this.jobsService.update(jobId, body);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/tree')
  @ApiOperation({ summary: 'Get job hierarchy (tree)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiOkResponse({
    description: 'Job tree',
    schema: zodSchemaToOpenApi(JobTreeNodeSchema, 'JobTreeNode'),
  })
  async getTree(
    @Param('job_id') jobId: string,
  ): Promise<JobTreeNode> {
    return this.jobsService.getTree(jobId);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/context')
  @ApiOperation({ summary: 'Get job context (job, relations, derived status)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiOkResponse({
    description: 'Job context',
    schema: zodSchemaToOpenApi(JobContextResponseSchema, 'JobContextResponse'),
  })
  @ApiNotFoundResponse({ description: 'Job not found' })
  async getContext(
    @Param('job_id') jobId: string,
  ): Promise<JobContextResponse> {
    return this.jobsService.getContext(jobId);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/supervise')
  @ApiOperation({ summary: 'Long-poll for child events and coordination messages' })
  @ApiParam({ name: 'job_id', description: 'Parent job ID', type: String })
  @ApiQuery({ name: 'since', required: false, description: 'ISO cursor for incremental polling' })
  @ApiQuery({ name: 'timeout', required: false, description: 'Max wait in seconds (default: 30, max: 120)' })
  @ApiOkResponse({ description: 'Supervision events' })
  @ApiNotFoundResponse({ description: 'Job not found' })
  async supervise(
    @Param('job_id') jobId: string,
    @Query('since') since?: string,
    @Query('timeout') timeout?: string,
  ) {
    const timeoutSec = Math.min(Math.max(parseInt(timeout ?? '30', 10) || 30, 1), 120);
    return this.jobsService.supervise(jobId, since, timeoutSec);
  }

  // ==========================================================================
  // Dependency routes: /jobs/:job_id/dependencies
  // ==========================================================================

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/dependencies')
  @ApiOperation({ summary: 'Get job dependencies' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiOkResponse({
    description: 'Dependencies',
    schema: zodSchemaToOpenApi(DependenciesResponseSchema, 'DependenciesResponse'),
  })
  async getDependencies(
    @Param('job_id') jobId: string,
  ): Promise<DependenciesResponse> {
    return this.jobsService.getDependencies(jobId);
  }

  @RequirePermission('jobs:write')
  @Post('jobs/:job_id/dependencies')
  @ApiOperation({ summary: 'Add a dependency to a job' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(AddDependencyRequestSchema, 'AddDependencyRequest') })
  @ApiCreatedResponse({
    description: 'Dependency added',
    schema: zodSchemaToOpenApi(SuccessMessageSchema, 'SuccessMessage'),
  })
  async addDependency(
    @Param('job_id') jobId: string,
    @Body() body: AddDependencyRequest
  ): Promise<{ success: boolean; message: string }> {
    return this.jobsService.addDependency(jobId, body);
  }

  @RequirePermission('jobs:write')
  @Delete('jobs/:job_id/dependencies/:related_job_id')
  @ApiOperation({ summary: 'Remove a dependency from a job' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'related_job_id', description: 'Related job ID', type: String })
  @ApiOkResponse({
    description: 'Dependency removed',
    schema: zodSchemaToOpenApi(SuccessMessageSchema, 'SuccessMessage'),
  })
  async removeDependency(
    @Param('job_id') jobId: string,
    @Param('related_job_id') relatedJobId: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.jobsService.removeDependency(jobId, relatedJobId);
  }

  // ==========================================================================
  // Claim/Release routes
  // ==========================================================================

  @RequirePermission('jobs:write')
  @Post('jobs/:job_id/claim')
  @ApiOperation({ summary: 'Claim a job (creates attempt, transitions to active)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(ClaimRequestSchema, 'ClaimRequest') })
  @ApiOkResponse({
    description: 'Job claimed',
    schema: zodSchemaToOpenApi(ClaimResponseSchema, 'ClaimResponse'),
  })
  async claim(
    @Param('job_id') jobId: string,
    @Body() body: ClaimRequest
  ): Promise<{ attempt: JobAttemptResponse }> {
    return this.jobsService.claim(jobId, body);
  }

  @RequirePermission('jobs:write')
  @Post('jobs/:job_id/release')
  @ApiOperation({ summary: 'Release a job (ends attempt, transitions back to ready)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(ReleaseRequestSchema, 'ReleaseRequest') })
  @ApiOkResponse({
    description: 'Job released',
    schema: zodSchemaToOpenApi(JobReleaseResponseSchema, 'JobReleaseResponse'),
  })
  async release(
    @Param('job_id') jobId: string,
    @Body() body: ReleaseRequest
  ): Promise<{ job: JobResponse }> {
    return this.jobsService.release(jobId, body);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/attempts')
  @ApiOperation({ summary: 'List attempts for a job' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiOkResponse({
    description: 'Attempt list',
    schema: zodSchemaToOpenApi(JobAttemptListResponseSchema, 'JobAttemptListResponse'),
  })
  async listAttempts(
    @Param('job_id') jobId: string,
  ): Promise<{ attempts: JobAttemptResponse[] }> {
    return this.jobsService.listAttempts(jobId);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/result')
  @ApiOperation({ summary: 'Get job result from latest or specified attempt' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiQuery({ name: 'attempt', required: false, description: 'Attempt number (defaults to latest)' })
  @ApiQuery({ name: 'format', required: false, description: 'Response format: full (default) or text' })
  @ApiOkResponse({
    description: 'Job result data',
    schema: zodSchemaToOpenApi(JobResultResponseSchema, 'JobResultResponse'),
  })
  @ApiNotFoundResponse({ description: 'Job or attempt not found' })
  @ApiConflictResponse({ description: 'Job is still running' })
  async getJobResult(
    @Param('job_id') jobId: string,
    @Query('attempt') attemptNumber?: string,
    @Query('format') format?: 'full' | 'text',
  ): Promise<JobResultResponse> {
    return this.jobsService.getJobResult(
      jobId,
      attemptNumber ? parseInt(attemptNumber, 10) : undefined,
      format,
    );
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/receipt')
  @ApiOperation({ summary: 'Get job receipt from latest or specified attempt' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiQuery({ name: 'attempt', required: false, description: 'Attempt number (defaults to latest)' })
  @ApiOkResponse({ description: 'Attempt receipt (ExecutionReceiptV2 JSON)' })
  @ApiNotFoundResponse({ description: 'Job, attempt, or receipt not found' })
  async getJobReceipt(
    @Param('job_id') jobId: string,
    @Query('attempt') attemptNumber?: string,
  ): Promise<Record<string, unknown>> {
    return this.jobsService.getJobReceipt(jobId, attemptNumber ? parseInt(attemptNumber, 10) : undefined);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/attempts/:attempt_id/receipt')
  @ApiOperation({ summary: 'Get receipt for an attempt (by attempt id)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'attempt_id', description: 'Attempt UUID', type: String })
  @ApiOkResponse({ description: 'Attempt receipt (ExecutionReceiptV2 JSON)' })
  @ApiNotFoundResponse({ description: 'Job, attempt, or receipt not found' })
  async getAttemptReceipt(
    @Param('job_id') jobId: string,
    @Param('attempt_id') attemptId: string,
  ): Promise<Record<string, unknown>> {
    return this.jobsService.getAttemptReceipt(jobId, attemptId);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/wait')
  @ApiOperation({ summary: 'Long-poll until job completes or timeout' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiQuery({ name: 'timeout', required: false, description: 'Max wait in seconds (default: 30, max: 300)' })
  @ApiOkResponse({
    description: 'Job completed - returns result',
    schema: zodSchemaToOpenApi(JobResultResponseSchema, 'JobResultResponse'),
  })
  @ApiAcceptedResponse({
    description: 'Timeout - job still running',
    schema: zodSchemaToOpenApi(WaitTimeoutResponseSchema, 'WaitTimeoutResponse'),
  })
  @ApiNotFoundResponse({ description: 'Job not found' })
  async waitForJob(
    @Param('job_id') jobId: string,
    @Query('timeout', new DefaultValuePipe(30), ParseIntPipe) timeout: number,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<JobResultResponse | { jobId: string; status: string; phase: string; elapsed: number; message: string }> {
    const result = await this.jobsService.waitForJob(jobId, timeout);

    if (result.completed) {
      // 200 OK - job completed, return result
      return result.result;
    } else {
      // 202 Accepted - timeout, job still running
      res.status(HttpStatus.ACCEPTED);
      return {
        jobId: result.jobId,
        status: result.status,
        phase: result.phase,
        elapsed: result.elapsed,
        message: result.message,
      };
    }
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/attempts/:attempt_num/logs')
  @ApiOperation({ summary: 'Get execution logs for an attempt' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'attempt_num', description: 'Attempt number', type: Number })
  @ApiQuery({ name: 'after', required: false, description: 'Return logs after this sequence number' })
  @ApiOkResponse({
    description: 'Logs response',
    schema: zodSchemaToOpenApi(JobLogsResponseSchema, 'JobLogsResponse'),
  })
  async getAttemptLogs(
    @Param('job_id') jobId: string,
    @Param('attempt_num', ParseIntPipe) attemptNum: number,
    @Query('after') after?: string,
  ): Promise<{ logs: Array<{ sequence: number; timestamp: string; type: string; line: Record<string, unknown> }> }> {
    const afterSequence = after ? parseInt(after, 10) : undefined;
    return this.jobsService.getAttemptLogs(jobId, attemptNum, afterSequence);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/attempts/:attempt_num/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream execution logs for an attempt (SSE)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'attempt_num', description: 'Attempt number', type: Number })
  @ApiOkResponse({ description: 'Server-Sent Events stream of logs' })
  streamAttemptLogs(
    @Param('job_id') jobId: string,
    @Param('attempt_num', ParseIntPipe) attemptNum: number,
  ): Observable<MessageEvent> {
    return this.jobsService.streamAttemptLogs(jobId, attemptNum);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream execution logs for current attempt (SSE)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiOkResponse({ description: 'Server-Sent Events stream of logs for current attempt' })
  streamJobLogs(
    @Param('job_id') jobId: string,
  ): Observable<MessageEvent> {
    return this.jobsService.streamJobLogs(jobId);
  }

  // ==========================================================================
  // Review routes
  // ==========================================================================

  @RequirePermission('jobs:write')
  @Post('jobs/:job_id/submit')
  @ApiOperation({ summary: 'Submit a job for review' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(SubmitRequestSchema, 'SubmitRequest') })
  @ApiOkResponse({
    description: 'Job submitted for review',
    schema: zodSchemaToOpenApi(JobResponseSchema, 'JobResponse'),
  })
  async submit(
    @Param('job_id') jobId: string,
    @Body() body: SubmitRequest
  ): Promise<JobResponse> {
    return this.jobsService.submit(jobId, body);
  }

  @RequirePermission('jobs:write')
  @Post('jobs/:job_id/approve')
  @ApiOperation({ summary: 'Approve a job in review' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(ApproveRequestSchema, 'ApproveRequest') })
  @ApiOkResponse({
    description: 'Job approved',
    schema: zodSchemaToOpenApi(JobResponseSchema, 'JobResponse'),
  })
  async approve(
    @Param('job_id') jobId: string,
    @Body() body: ApproveRequest
  ): Promise<JobResponse> {
    return this.jobsService.approve(jobId, body);
  }

  @RequirePermission('jobs:write')
  @Post('jobs/:job_id/reject')
  @ApiOperation({ summary: 'Reject a job in review' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(RejectRequestSchema, 'RejectRequest') })
  @ApiOkResponse({
    description: 'Job rejected',
    schema: zodSchemaToOpenApi(JobResponseSchema, 'JobResponse'),
  })
  async reject(
    @Param('job_id') jobId: string,
    @Body() body: RejectRequest
  ): Promise<JobResponse> {
    return this.jobsService.reject(jobId, body);
  }
}
