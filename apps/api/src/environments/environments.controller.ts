import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  DefaultValuePipe,
  ParseIntPipe,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { EnvironmentsService } from './environments.service.js';
import { EnvLogsService, type EnvLogsResponse } from './env-logs.service.js';
import { EnvDiagnosticsService } from './env-diagnostics.service.js';
import {
  DeployRequestSchema,
  DeployResponseSchema,
  CreateEnvironmentRequestSchema,
  UpdateEnvironmentRequestSchema,
  EnvironmentResponseSchema,
  EnvironmentListResponseSchema,
  EnvLogsResponseSchema,
  EnvHealthResponseSchema,
  EnvDiagnoseResponseSchema,
  EnvRequestDiagnoseResponseSchema,
  SuspendEnvironmentRequestSchema,
  SuspendEnvironmentResponseSchema,
  ResumeEnvironmentResponseSchema,
  DeleteEnvironmentRequestSchema,
  UndeployEnvironmentRequestSchema,
  type DeployRequest,
  type DeployResponse,
  type CreateEnvironmentRequest,
  type UpdateEnvironmentRequest,
  type EnvironmentListResponse,
  type EnvironmentResponse,
  type EnvHealthResponse,
  type EnvDiagnoseResponse,
  type EnvRequestDiagnoseResponse,
  type SuspendEnvironmentRequest,
  type SuspendEnvironmentResponse,
  type ResumeEnvironmentResponse,
  type DeleteEnvironmentRequest,
  type UndeployEnvironmentRequest,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { RequirePermission } from '../auth/permission.decorator.js';

@ApiTags('environments')
@ApiBearerAuth()
@Controller('projects/:id/envs')
export class EnvironmentsController {
  constructor(
    private readonly environmentsService: EnvironmentsService,
    private readonly envLogsService: EnvLogsService,
    private readonly envDiagnosticsService: EnvDiagnosticsService,
  ) {}

  @RequirePermission('envs:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an environment for a project (admin)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(CreateEnvironmentRequestSchema, 'CreateEnvironmentRequest'),
  })
  @ApiCreatedResponse({
    description: 'Environment created',
    schema: zodSchemaToOpenApi(EnvironmentResponseSchema, 'EnvironmentResponse'),
  })
  async create(
    @Param('id') projectId: string,
    @Body(new ZodValidationPipe(CreateEnvironmentRequestSchema)) body: CreateEnvironmentRequest,
  ): Promise<EnvironmentResponse> {
    return this.environmentsService.create(projectId, body);
  }

  @RequirePermission('envs:read')
  @Get()
  @ApiOperation({ summary: 'List environments for a project' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Environment list',
    schema: zodSchemaToOpenApi(EnvironmentListResponseSchema, 'EnvironmentListResponse'),
  })
  async list(
    @Param('id') projectId: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<EnvironmentListResponse> {
    return this.environmentsService.list(projectId, {
      limit,
      offset,
    });
  }

  @RequirePermission('envs:read')
  @Get(':name')
  @ApiOperation({ summary: 'Get environment by name' })
  @ApiOkResponse({
    description: 'Environment details',
    schema: zodSchemaToOpenApi(EnvironmentResponseSchema, 'EnvironmentResponse'),
  })
  async findByName(
    @Param('id') projectId: string,
    @Param('name') name: string,
  ): Promise<EnvironmentResponse> {
    const environment = await this.environmentsService.findByName(projectId, name);
    if (!environment) {
      throw new NotFoundException(
        `Environment "${name}" not found for project ${projectId}`
      );
    }
    return environment;
  }

  @RequirePermission('envs:write')
  @Put(':name')
  @ApiOperation({ summary: 'Update environment (admin)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(UpdateEnvironmentRequestSchema, 'UpdateEnvironmentRequest'),
  })
  @ApiOkResponse({
    description: 'Environment updated',
    schema: zodSchemaToOpenApi(EnvironmentResponseSchema, 'EnvironmentResponse'),
  })
  async update(
    @Param('id') projectId: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateEnvironmentRequestSchema)) body: UpdateEnvironmentRequest,
  ): Promise<EnvironmentResponse> {
    return this.environmentsService.update(projectId, name, body);
  }

  @RequirePermission('envs:admin')
  @Delete(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete environment (admin)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(DeleteEnvironmentRequestSchema, 'DeleteEnvironmentRequest'),
  })
  @ApiNoContentResponse({
    description: 'Environment deleted',
  })
  async delete(
    @Param('id') projectId: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(DeleteEnvironmentRequestSchema))
    body: DeleteEnvironmentRequest = {},
  ): Promise<void> {
    return this.environmentsService.delete(projectId, name, body);
  }

  @RequirePermission('envs:admin')
  @Post(':name/undeploy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Undeploy an environment (tear down K8s, keep config)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(UndeployEnvironmentRequestSchema, 'UndeployEnvironmentRequest'),
  })
  @ApiOkResponse({
    description: 'Environment undeployed',
    schema: zodSchemaToOpenApi(EnvironmentResponseSchema, 'EnvironmentResponse'),
  })
  async undeploy(
    @Param('id') projectId: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UndeployEnvironmentRequestSchema))
    body: UndeployEnvironmentRequest = {},
  ): Promise<EnvironmentResponse> {
    return this.environmentsService.undeploy(projectId, name, body);
  }

  @RequirePermission('envs:write')
  @Post(':name/deploy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deploy a release to an environment' })
  @ApiBody({
    schema: zodSchemaToOpenApi(DeployRequestSchema, 'DeployRequest'),
  })
  @ApiOkResponse({
    description: 'Deployment successful',
    schema: zodSchemaToOpenApi(DeployResponseSchema, 'DeployResponse'),
  })
  async deploy(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Body(new ZodValidationPipe(DeployRequestSchema)) body: DeployRequest,
  ): Promise<DeployResponse> {
    return this.environmentsService.deploy(projectId, envName, body);
  }

  @RequirePermission('envs:write')
  @Post(':name/rollback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rollback environment to a specified release' })
  async rollback(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Body() body: { release?: string; skip_preflight?: boolean },
  ): Promise<DeployResponse> {
    if (!body?.release) {
      throw new BadRequestException('release is required');
    }
    return this.environmentsService.rollback(projectId, envName, {
      release: body.release,
      skip_preflight: body.skip_preflight,
    });
  }

  @RequirePermission('envs:write')
  @Post(':name/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset environment by tearing down workloads and redeploying release' })
  async reset(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Body() body: {
      release?: string;
      force?: boolean;
      danger_reset_production?: boolean;
      skip_preflight?: boolean;
    },
  ): Promise<DeployResponse> {
    return this.environmentsService.reset(projectId, envName, {
      release: body?.release,
      force: body?.force,
      danger_reset_production: body?.danger_reset_production,
      skip_preflight: body?.skip_preflight,
    });
  }

  @RequirePermission('envs:read')
  @Get(':name/recover')
  @ApiOperation({ summary: 'Analyze environment state and suggest next recovery action' })
  async recover(
    @Param('id') projectId: string,
    @Param('name') envName: string,
  ): Promise<Record<string, unknown>> {
    return this.environmentsService.recover(projectId, envName);
  }

  @RequirePermission('envs:read')
  @Get(':name/services/:service/logs')
  @ApiOperation({ summary: 'Get logs for a service in an environment (k8s-only)' })
  @ApiQuery({ name: 'since', required: false, description: 'Seconds since now' })
  @ApiQuery({ name: 'tail', required: false, description: 'Tail line count' })
  @ApiQuery({ name: 'grep', required: false, description: 'Filter lines containing text' })
  @ApiQuery({ name: 'filter', required: false, description: 'Repeatable structured JSON filter as k=v' })
  @ApiQuery({ name: 'pod', required: false, description: 'Specific pod name' })
  @ApiQuery({ name: 'container', required: false, description: 'Specific container name' })
  @ApiQuery({ name: 'previous', required: false, description: 'Use previous container logs (true/false)' })
  @ApiQuery({ name: 'all_pods', required: false, description: 'Return logs for all matching pods (true/false)' })
  @ApiOkResponse({
    description: 'Service logs',
    schema: zodSchemaToOpenApi(EnvLogsResponseSchema, 'EnvLogsResponse'),
  })
  async logs(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Param('service') service: string,
    @Query('since') since?: string,
    @Query('tail') tail?: string,
    @Query('grep') grep?: string,
    @Query('filter') filter?: string | string[],
    @Query('pod') pod?: string,
    @Query('container') container?: string,
    @Query('previous') previous?: string,
    @Query('all_pods') allPods?: string,
  ): Promise<EnvLogsResponse> {
    const sinceSeconds = since ? Math.floor(parseFloat(since)) : undefined;
    const namespace = await this.environmentsService.resolveNamespace(projectId, envName);
    let tailLines: number | undefined;
    if (tail !== undefined) {
      const parsed = Number.parseInt(tail, 10);
      if (Number.isNaN(parsed)) {
        throw new BadRequestException('tail must be an integer');
      }
      tailLines = parsed;
    }
    return this.envLogsService.getServiceLogs(projectId, envName, service, {
      sinceSeconds: Number.isFinite(sinceSeconds) ? sinceSeconds : undefined,
      tailLines,
      grep,
      filters: EnvLogsService.parseFilters(filter),
      pod,
      container,
      previous: previous === 'true' || previous === '1',
      allPods: allPods === 'true' || allPods === '1',
      namespace,
    });
  }

  @RequirePermission('envs:read')
  @Get(':name/services/:service/logs/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream logs for a service in an environment (k8s-only)' })
  @ApiQuery({ name: 'since', required: false, description: 'Seconds since now for initial backfill' })
  @ApiQuery({ name: 'tail', required: false, description: 'Initial tail line count' })
  @ApiQuery({ name: 'grep', required: false, description: 'Filter lines containing text' })
  @ApiQuery({ name: 'filter', required: false, description: 'Repeatable structured JSON filter as k=v' })
  @ApiQuery({ name: 'pod', required: false, description: 'Specific pod name' })
  @ApiQuery({ name: 'container', required: false, description: 'Specific container name' })
  @ApiQuery({ name: 'all_pods', required: false, description: 'Stream logs for all matching pods (true/false)' })
  async streamLogs(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Param('service') service: string,
    @Query('since') since?: string,
    @Query('tail') tail?: string,
    @Query('grep') grep?: string,
    @Query('filter') filter?: string | string[],
    @Query('pod') pod?: string,
    @Query('container') container?: string,
    @Query('all_pods') allPods?: string,
  ): Promise<Observable<MessageEvent>> {
    const sinceSeconds = since ? Math.floor(parseFloat(since)) : undefined;
    const namespace = await this.environmentsService.resolveNamespace(projectId, envName);
    let tailLines: number | undefined;
    if (tail !== undefined) {
      const parsed = Number.parseInt(tail, 10);
      if (Number.isNaN(parsed)) {
        throw new BadRequestException('tail must be an integer');
      }
      tailLines = parsed;
    }

    return this.envLogsService.streamServiceLogs(projectId, envName, service, {
      sinceSeconds: Number.isFinite(sinceSeconds) ? sinceSeconds : undefined,
      tailLines,
      grep,
      filters: EnvLogsService.parseFilters(filter),
      pod,
      container,
      allPods: allPods === 'true' || allPods === '1',
      namespace,
    });
  }

  @RequirePermission('envs:read')
  @Get(':name/health')
  @ApiOperation({ summary: 'Get deployment health for an environment (k8s-only)' })
  @ApiOkResponse({
    description: 'Environment health status',
    schema: zodSchemaToOpenApi(EnvHealthResponseSchema, 'EnvHealthResponse'),
  })
  async health(
    @Param('id') projectId: string,
    @Param('name') envName: string,
  ): Promise<EnvHealthResponse> {
    const namespace = await this.environmentsService.resolveNamespace(projectId, envName);
    const health = await this.envDiagnosticsService.getHealth(projectId, envName, namespace);

    // Check for active pipeline runs — if one is in-flight, env isn't truly "ready"
    const activePipelineRun = await this.environmentsService.findActivePipelineRunForEnv(projectId, envName);
    if (activePipelineRun) {
      health.active_pipeline_run = activePipelineRun;
      if (health.status === 'ready') {
        health.status = 'deploying';
        health.ready = false;
      }
      const warnings = health.warnings ?? [];
      warnings.push(`Pipeline run ${activePipelineRun.id} is ${activePipelineRun.status} (${activePipelineRun.pipeline_name})`);
      health.warnings = warnings;
    }

    return health;
  }

  @RequirePermission('envs:read')
  @Get(':name/diagnose')
  @ApiOperation({ summary: 'Diagnose environment deployments (k8s-only)' })
  @ApiQuery({ name: 'events', required: false, description: 'Limit recent events' })
  @ApiQuery({ name: 'request_id', required: false, description: 'Request ID for request-level diagnostics' })
  @ApiQuery({ name: 'window_seconds', required: false, description: 'Request diagnostic window in seconds' })
  @ApiOkResponse({
    description: 'Environment diagnostics',
    schema: zodSchemaToOpenApi(EnvDiagnoseResponseSchema, 'EnvDiagnoseResponse'),
  })
  @ApiOkResponse({
    description: 'Request diagnostics',
    schema: zodSchemaToOpenApi(EnvRequestDiagnoseResponseSchema, 'EnvRequestDiagnoseResponse'),
  })
  async diagnose(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Query('events') events?: string,
    @Query('request_id') requestId?: string,
    @Query('window_seconds') windowSeconds?: string,
  ): Promise<EnvDiagnoseResponse | EnvRequestDiagnoseResponse> {
    const namespace = await this.environmentsService.resolveNamespace(projectId, envName);
    if (requestId) {
      const parsedWindow = windowSeconds ? Number.parseInt(windowSeconds, 10) : undefined;
      return this.envDiagnosticsService.diagnoseRequest(projectId, envName, namespace, requestId, {
        windowSeconds: Number.isFinite(parsedWindow) ? parsedWindow : undefined,
      });
    }
    const eventLimit = events ? Math.floor(parseInt(events, 10)) : undefined;
    return this.envDiagnosticsService.diagnose(projectId, envName, namespace, {
      eventLimit: Number.isFinite(eventLimit) ? eventLimit : undefined,
    });
  }

  @RequirePermission('envs:admin')
  @Post(':name/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend an environment (admin/org-owner)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(SuspendEnvironmentRequestSchema, 'SuspendEnvironmentRequest'),
  })
  @ApiOkResponse({
    description: 'Environment suspended',
    schema: zodSchemaToOpenApi(SuspendEnvironmentResponseSchema, 'SuspendEnvironmentResponse'),
  })
  async suspend(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Body(new ZodValidationPipe(SuspendEnvironmentRequestSchema)) body: SuspendEnvironmentRequest,
  ): Promise<SuspendEnvironmentResponse> {
    return this.environmentsService.suspend(projectId, envName, body.reason);
  }

  @RequirePermission('envs:admin')
  @Post(':name/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a suspended environment (admin/org-owner)' })
  @ApiOkResponse({
    description: 'Environment resumed',
    schema: zodSchemaToOpenApi(ResumeEnvironmentResponseSchema, 'ResumeEnvironmentResponse'),
  })
  async resume(
    @Param('id') projectId: string,
    @Param('name') envName: string,
  ): Promise<ResumeEnvironmentResponse> {
    return this.environmentsService.resume(projectId, envName);
  }
}
