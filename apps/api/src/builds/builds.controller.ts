import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  BuildArtifactListResponseSchema,
  BuildLogsResponseSchema,
  BuildRunListResponseSchema,
  BuildRunResponseSchema,
  BuildSpecListResponseSchema,
  BuildSpecResponseSchema,
  CancelBuildRunRequestSchema,
  CreateBuildRunRequestSchema,
  CreateBuildSpecRequestSchema,
  type BuildArtifactListResponse,
  type BuildLogsResponse,
  type BuildRunListResponse,
  type BuildRunResponse,
  type BuildSpecListResponse,
  type BuildSpecResponse,
  type CancelBuildRunRequest,
  type CreateBuildRunRequest,
  type CreateBuildSpecRequest,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { BuildsService } from './builds.service.js';
import { RequirePermission } from '../auth/permission.decorator.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';

@ApiTags('builds')
@ApiBearerAuth()
@Controller()
export class BuildsController {
  constructor(private readonly buildsService: BuildsService) {}

  @RequirePermission('builds:write')
  @Post('projects/:project_id/builds')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a build spec' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateBuildSpecRequestSchema, 'CreateBuildSpecRequest') })
  @ApiCreatedResponse({
    description: 'Build spec created',
    schema: zodSchemaToOpenApi(BuildSpecResponseSchema, 'BuildSpecResponse'),
  })
  async createSpec(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateBuildSpecRequestSchema)) body: CreateBuildSpecRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<BuildSpecResponse> {
    return this.buildsService.createSpec(projectId, body, caller?.user_id);
  }

  @RequirePermission('builds:read')
  @Get('projects/:project_id/builds')
  @ApiOperation({ summary: 'List build specs for a project' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Build spec list',
    schema: zodSchemaToOpenApi(BuildSpecListResponseSchema, 'BuildSpecListResponse'),
  })
  async listSpecs(
    @Param('project_id') projectId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<BuildSpecListResponse> {
    return this.buildsService.listSpecs(projectId, { limit, offset });
  }

  @RequirePermission('builds:read')
  @Get('builds/:build_id')
  @ApiOperation({ summary: 'Get a build spec' })
  @ApiOkResponse({
    description: 'Build spec',
    schema: zodSchemaToOpenApi(BuildSpecResponseSchema, 'BuildSpecResponse'),
  })
  async getSpec(@Param('build_id') buildId: string): Promise<BuildSpecResponse> {
    return this.buildsService.getSpec(buildId);
  }

  @RequirePermission('builds:write')
  @Post('builds/:build_id/runs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a build run' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateBuildRunRequestSchema, 'CreateBuildRunRequest') })
  @ApiCreatedResponse({
    description: 'Build run created',
    schema: zodSchemaToOpenApi(BuildRunResponseSchema, 'BuildRunResponse'),
  })
  async createRun(
    @Param('build_id') buildId: string,
    @Body(new ZodValidationPipe(CreateBuildRunRequestSchema)) body: CreateBuildRunRequest,
  ): Promise<BuildRunResponse> {
    return this.buildsService.createRun(buildId, body);
  }

  @RequirePermission('builds:read')
  @Get('builds/:build_id/runs')
  @ApiOperation({ summary: 'List build runs for a build spec' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Build run list',
    schema: zodSchemaToOpenApi(BuildRunListResponseSchema, 'BuildRunListResponse'),
  })
  async listRuns(
    @Param('build_id') buildId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<BuildRunListResponse> {
    return this.buildsService.listRuns(buildId, { limit, offset });
  }

  @RequirePermission('builds:read')
  @Get('builds/:build_id/artifacts')
  @ApiOperation({ summary: 'List build artifacts' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Build artifact list',
    schema: zodSchemaToOpenApi(BuildArtifactListResponseSchema, 'BuildArtifactListResponse'),
  })
  async listArtifacts(
    @Param('build_id') buildId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<BuildArtifactListResponse> {
    return this.buildsService.listArtifacts(buildId, { limit, offset });
  }

  @RequirePermission('builds:read')
  @Get('builds/:build_id/logs')
  @ApiOperation({ summary: 'Get build logs (optionally after a sequence)' })
  @ApiQuery({ name: 'run_id', required: false })
  @ApiQuery({ name: 'after', required: false })
  @ApiOkResponse({
    description: 'Build logs',
    schema: zodSchemaToOpenApi(BuildLogsResponseSchema, 'BuildLogsResponse'),
  })
  async getLogs(
    @Param('build_id') buildId: string,
    @Query('run_id') runId?: string,
    @Query('after') after?: string,
  ): Promise<BuildLogsResponse> {
    const afterSequence = after ? parseInt(after, 10) : undefined;
    return this.buildsService.getLogs(buildId, { run_id: runId, after: afterSequence });
  }

  @RequirePermission('builds:admin')
  @Delete('builds/:build_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a build spec and all associated runs/artifacts/logs' })
  @ApiNoContentResponse({ description: 'Build deleted' })
  async delete(@Param('build_id') buildId: string): Promise<void> {
    return this.buildsService.delete(buildId);
  }

  @RequirePermission('builds:admin')
  @Post('projects/:project_id/builds/prune')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Prune old builds, keeping the most recent N' })
  @ApiBody({ schema: { type: 'object', properties: { keep: { type: 'number', default: 10 } } } })
  @ApiOkResponse({ description: 'Prune result' })
  async prune(
    @Param('project_id') projectId: string,
    @Body() body: { keep?: number },
  ): Promise<{ deleted: number }> {
    return this.buildsService.prune(projectId, body.keep ?? 10);
  }

  @RequirePermission('builds:write')
  @Post('builds/:build_id/cancel')
  @ApiOperation({ summary: 'Cancel a build run' })
  @ApiBody({ schema: zodSchemaToOpenApi(CancelBuildRunRequestSchema, 'CancelBuildRunRequest') })
  @ApiOkResponse({
    description: 'Build run cancelled',
    schema: zodSchemaToOpenApi(BuildRunResponseSchema, 'BuildRunResponse'),
  })
  async cancel(
    @Param('build_id') buildId: string,
    @Body(new ZodValidationPipe(CancelBuildRunRequestSchema)) body: CancelBuildRunRequest,
  ): Promise<BuildRunResponse> {
    return this.buildsService.cancelRun(buildId, body);
  }
}
