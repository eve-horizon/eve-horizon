import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UsePipes,
  NotFoundException,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ProjectsService } from './projects.service.js';
import {
  CreateProjectRequestSchema,
  EnsureProjectRequestSchema,
  UpdateProjectRequestSchema,
  ProjectResponseSchema,
  ProjectListResponseSchema,
  SyncManifestRequestSchema,
  ManifestResponseSchema,
  ManifestValidateRequestSchema,
  ManifestValidateResponseSchema,
  AgentsSyncRequestSchema,
  AgentsSyncResponseSchema,
  AgentsConfigResponseSchema,
  TeamListResponseSchema,
  RouteListResponseSchema,
  ThreadListResponseSchema,
  ScheduleListResponseSchema,
  CreateScheduleRequestSchema,
  ScheduleResponseSchema,
  ReleaseResponseSchema,
  ReleaseListResponseSchema,
  type CreateProjectRequest,
  type EnsureProjectRequest,
  type UpdateProjectRequest,
  type ProjectListResponse,
  type ProjectResponse,
  type SyncManifestRequest,
  type ManifestResponse,
  type ManifestValidateRequest,
  type ManifestValidateResponse,
  type AgentsSyncRequest,
  type AgentsSyncResponse,
  type AgentsConfigResponse,
  type TeamListResponse,
  type RouteListResponse,
  type ThreadListResponse,
  type ScheduleListResponse,
  type CreateScheduleRequest,
  type ScheduleResponse,
  type ReleaseResponse,
  type ReleaseListResponse,
  ProjectMemberRequestSchema,
  ProjectMemberResponseSchema,
  ProjectMemberListResponseSchema,
  type ProjectMemberRequest,
  type ProjectMemberResponse,
  type ProjectMemberListResponse,
  ProjectSpendResponseSchema,
  type ProjectSpendResponse,
  BootstrapProjectRequestSchema,
  BootstrapProjectResponseSchema,
  type BootstrapProjectRequest,
  type BootstrapProjectResponse,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { RequirePermission } from '../auth/permission.decorator.js';

function parseBoolean(value?: string): boolean {
  if (!value) return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function parseOptionalDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return d;
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @RequirePermission('projects:create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(CreateProjectRequestSchema))
  @ApiOperation({ summary: 'Create a project' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateProjectRequestSchema, 'CreateProjectRequest') })
  @ApiCreatedResponse({
    description: 'Project created',
    schema: zodSchemaToOpenApi(ProjectResponseSchema, 'ProjectResponse'),
  })
  async create(
    @Body() body: CreateProjectRequest,
    @Req() request: { user?: { user_id?: string } },
  ): Promise<ProjectResponse> {
    return this.projectsService.create(body, request.user?.user_id);
  }

  @RequirePermission('projects:create')
  @Post('ensure')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(EnsureProjectRequestSchema))
  @ApiOperation({ summary: 'Ensure a project exists (find or create)' })
  @ApiBody({ schema: zodSchemaToOpenApi(EnsureProjectRequestSchema, 'EnsureProjectRequest') })
  @ApiOkResponse({
    description: 'Project ensured',
    schema: zodSchemaToOpenApi(ProjectResponseSchema, 'ProjectResponse'),
  })
  async ensure(
    @Body() body: EnsureProjectRequest,
    @Req() request: { user?: { user_id?: string } },
  ): Promise<ProjectResponse> {
    return this.projectsService.ensure(body, request.user?.user_id);
  }

  @RequirePermission('projects:create')
  @Post('bootstrap')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(BootstrapProjectRequestSchema))
  @ApiOperation({ summary: 'Bootstrap a project (create project + environments in one call)' })
  @ApiBody({ schema: zodSchemaToOpenApi(BootstrapProjectRequestSchema, 'BootstrapProjectRequest') })
  @ApiOkResponse({
    description: 'Project bootstrapped',
    schema: zodSchemaToOpenApi(BootstrapProjectResponseSchema, 'BootstrapProjectResponse'),
  })
  async bootstrap(
    @Body() body: BootstrapProjectRequest,
    @Req() request: { user?: { user_id?: string } },
  ): Promise<BootstrapProjectResponse> {
    return this.projectsService.bootstrap(body, request.user?.user_id);
  }

  @RequirePermission('projects:read')
  @Get()
  @ApiOperation({ summary: 'List projects' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'include_deleted', required: false })
  @ApiQuery({ name: 'org_id', required: false })
  @ApiQuery({ name: 'name', required: false })
  @ApiOkResponse({
    description: 'Project list',
    schema: zodSchemaToOpenApi(ProjectListResponseSchema, 'ProjectListResponse'),
  })
  async list(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Req() request: { user?: { user_id?: string } },
    @Query('include_deleted') includeDeleted?: string,
    @Query('org_id') orgId?: string,
    @Query('name') name?: string,
  ): Promise<ProjectListResponse> {
    return this.projectsService.list({
      limit,
      offset,
      include_deleted: parseBoolean(includeDeleted),
      org_id: orgId,
      name,
      user_id: request.user?.user_id,
    });
  }

  @RequirePermission('projects:read')
  @Get(':project_id')
  @ApiOperation({ summary: 'Get project by id' })
  @ApiQuery({ name: 'include_deleted', required: false })
  @ApiOkResponse({
    description: 'Project details',
    schema: zodSchemaToOpenApi(ProjectResponseSchema, 'ProjectResponse'),
  })
  async findById(
    @Param('project_id') projectId: string,
    @Query('include_deleted') includeDeleted?: string,
  ): Promise<ProjectResponse> {
    const project = await this.projectsService.findById(projectId, parseBoolean(includeDeleted));
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return project;
  }

  @RequirePermission('projects:read')
  @Get(':project_id/spend')
  @ApiOperation({ summary: 'Get spend aggregation for a project' })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp (inclusive)' })
  @ApiQuery({ name: 'until', required: false, description: 'ISO timestamp (inclusive)' })
  @ApiQuery({ name: 'currency', required: false, description: 'Billing currency (e.g. usd)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Top jobs limit (default: 10)' })
  @ApiOkResponse({
    description: 'Project spend summary',
    schema: zodSchemaToOpenApi(ProjectSpendResponseSchema, 'ProjectSpendResponse'),
  })
  async spend(
    @Param('project_id') projectId: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('currency') currency?: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit?: number,
  ): Promise<ProjectSpendResponse> {
    return this.projectsService.getSpend(projectId, {
      since: parseOptionalDate(since),
      until: parseOptionalDate(until),
      currency,
      limit,
    });
  }

  @RequirePermission('projects:write')
  @Patch(':project_id')
  @ApiOperation({ summary: 'Update project' })
  @ApiBody({ schema: zodSchemaToOpenApi(UpdateProjectRequestSchema, 'UpdateProjectRequest') })
  @ApiOkResponse({
    description: 'Project updated',
    schema: zodSchemaToOpenApi(ProjectResponseSchema, 'ProjectResponse'),
  })
  async update(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(UpdateProjectRequestSchema)) body: UpdateProjectRequest
  ): Promise<ProjectResponse> {
    return this.projectsService.update(projectId, body);
  }

  @RequirePermission('projects:admin')
  @Delete(':project_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a project (soft or hard delete)' })
  @ApiQuery({ name: 'hard', required: false, description: 'Hard delete — physically removes all data' })
  @ApiQuery({ name: 'force', required: false, description: 'Continue on partial failures' })
  @ApiNoContentResponse({ description: 'Project deleted' })
  async delete(
    @Param('project_id') projectId: string,
    @Query('hard') hard?: string,
    @Query('force') force?: string,
  ): Promise<void> {
    return this.projectsService.deleteProject(projectId, {
      hard: hard === 'true',
      force: force === 'true',
    });
  }

  @RequirePermission('projects:write')
  @Post(':project_id/manifest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync project manifest from CLI' })
  @ApiBody({ schema: zodSchemaToOpenApi(SyncManifestRequestSchema, 'SyncManifestRequest') })
  @ApiOkResponse({
    description: 'Manifest synced',
    schema: zodSchemaToOpenApi(ManifestResponseSchema, 'ManifestResponse'),
  })
  async syncManifest(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(SyncManifestRequestSchema)) body: SyncManifestRequest
  ): Promise<ManifestResponse> {
    return this.projectsService.syncManifest(projectId, body);
  }

  @RequirePermission('projects:write')
  @Post(':project_id/agents/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync project agents config from CLI' })
  @ApiBody({ schema: zodSchemaToOpenApi(AgentsSyncRequestSchema, 'AgentsSyncRequest') })
  @ApiOkResponse({
    description: 'Agents config synced',
    schema: zodSchemaToOpenApi(AgentsSyncResponseSchema, 'AgentsSyncResponse'),
  })
  async syncAgentsConfig(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(AgentsSyncRequestSchema)) body: AgentsSyncRequest
  ): Promise<AgentsSyncResponse> {
    return this.projectsService.syncAgentsConfig(projectId, body);
  }

  @RequirePermission('projects:read')
  @Get(':project_id/manifest')
  @ApiOperation({ summary: 'Get latest manifest for project' })
  @ApiOkResponse({
    description: 'Latest manifest',
    schema: zodSchemaToOpenApi(ManifestResponseSchema, 'ManifestResponse'),
  })
  async getLatestManifest(
    @Param('project_id') projectId: string
  ): Promise<ManifestResponse | null> {
    return this.projectsService.getLatestManifest(projectId);
  }

  @RequirePermission('projects:read')
  @Post(':project_id/manifest/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a project manifest (schema + secrets)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ManifestValidateRequestSchema, 'ManifestValidateRequest') })
  @ApiOkResponse({
    description: 'Manifest validation result',
    schema: zodSchemaToOpenApi(ManifestValidateResponseSchema, 'ManifestValidateResponse'),
  })
  async validateManifest(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(ManifestValidateRequestSchema)) body: ManifestValidateRequest,
  ): Promise<ManifestValidateResponse> {
    return this.projectsService.validateManifest(projectId, body);
  }

  @RequirePermission('projects:read')
  @Get(':project_id/agents')
  @ApiOperation({ summary: 'Get agent policy and harness availability for project' })
  @ApiQuery({ name: 'include_harnesses', required: false })
  @ApiOkResponse({
    description: 'Agent policy + harness availability',
    schema: zodSchemaToOpenApi(AgentsConfigResponseSchema, 'AgentsConfigResponse'),
  })
  async getAgentsConfig(
    @Param('project_id') projectId: string,
    @Query('include_harnesses') includeHarnesses?: string,
  ): Promise<AgentsConfigResponse> {
    return this.projectsService.getAgentsConfig(projectId, parseBoolean(includeHarnesses));
  }

  @RequirePermission('projects:read')
  @Get(':project_id/teams')
  @ApiOperation({ summary: 'List teams for project' })
  @ApiOkResponse({
    description: 'Team list',
    schema: zodSchemaToOpenApi(TeamListResponseSchema, 'TeamListResponse'),
  })
  async listTeams(
    @Param('project_id') projectId: string,
  ): Promise<TeamListResponse> {
    return this.projectsService.listTeams(projectId);
  }

  @RequirePermission('projects:read')
  @Get(':project_id/routes')
  @ApiOperation({ summary: 'List chat routes for project' })
  @ApiOkResponse({
    description: 'Route list',
    schema: zodSchemaToOpenApi(RouteListResponseSchema, 'RouteListResponse'),
  })
  async listRoutes(
    @Param('project_id') projectId: string,
  ): Promise<RouteListResponse> {
    return this.projectsService.listRoutes(projectId);
  }

  @RequirePermission('projects:read')
  @Get(':project_id/threads')
  @ApiOperation({ summary: 'List threads for project' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Thread list',
    schema: zodSchemaToOpenApi(ThreadListResponseSchema, 'ThreadListResponse'),
  })
  async listThreads(
    @Param('project_id') projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ): Promise<ThreadListResponse> {
    return this.projectsService.listThreads(projectId, { limit, offset });
  }

  @RequirePermission('projects:read')
  @Get(':project_id/schedules')
  @ApiOperation({ summary: 'List schedules for project' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Schedule list',
    schema: zodSchemaToOpenApi(ScheduleListResponseSchema, 'ScheduleListResponse'),
  })
  async listSchedules(
    @Param('project_id') projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ): Promise<ScheduleListResponse> {
    return this.projectsService.listSchedules(projectId, { limit, offset });
  }

  @RequirePermission('projects:write')
  @Post(':project_id/schedules')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create schedule for project' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateScheduleRequestSchema, 'CreateScheduleRequest') })
  @ApiOkResponse({
    description: 'Schedule created',
    schema: zodSchemaToOpenApi(ScheduleResponseSchema, 'ScheduleResponse'),
  })
  async createSchedule(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateScheduleRequestSchema)) body: CreateScheduleRequest,
  ): Promise<ScheduleResponse> {
    return this.projectsService.createSchedule(projectId, body);
  }

  @RequirePermission('projects:read')
  @Get(':project_id/releases')
  @ApiOperation({ summary: 'List releases for a project' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max results (default 20)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Offset for pagination' })
  @ApiOkResponse({
    description: 'List of releases',
    schema: zodSchemaToOpenApi(ReleaseListResponseSchema, 'ReleaseListResponse'),
  })
  async listReleases(
    @Param('project_id') projectId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<ReleaseListResponse> {
    return this.projectsService.listReleases(projectId, { limit, offset });
  }

  @RequirePermission('projects:read')
  @Get(':project_id/releases/by-tag/:tag')
  @ApiOperation({ summary: 'Get release by tag' })
  @ApiOkResponse({
    description: 'Release found',
    schema: zodSchemaToOpenApi(ReleaseResponseSchema, 'ReleaseResponse'),
  })
  async getReleaseByTag(
    @Param('project_id') projectId: string,
    @Param('tag') tag: string,
  ): Promise<ReleaseResponse> {
    const release = await this.projectsService.getReleaseByTag(projectId, tag);
    if (!release) {
      throw new NotFoundException(`Release with tag "${tag}" not found for project ${projectId}`);
    }
    return release;
  }

  @RequirePermission('releases:admin')
  @Delete(':project_id/releases/by-tag/:tag')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a release by tag' })
  @ApiNoContentResponse({ description: 'Release deleted' })
  async deleteRelease(
    @Param('project_id') projectId: string,
    @Param('tag') tag: string,
  ): Promise<void> {
    return this.projectsService.deleteRelease(projectId, tag);
  }

  @RequirePermission('releases:admin')
  @Post(':project_id/releases/prune')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Prune old releases, keeping the most recent N' })
  async pruneReleases(
    @Param('project_id') projectId: string,
    @Body() body: { keep?: number },
  ): Promise<{ deleted: number }> {
    return this.projectsService.pruneReleases(projectId, body.keep ?? 10);
  }

  // ── Agents / Teams delete ──────────────────────────────────────────

  @RequirePermission('agents:admin')
  @Delete(':project_id/agents/:slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an agent by slug' })
  @ApiNoContentResponse({ description: 'Agent deleted' })
  async deleteAgent(
    @Param('project_id') projectId: string,
    @Param('slug') slug: string,
  ): Promise<void> {
    return this.projectsService.deleteAgent(projectId, slug);
  }

  @RequirePermission('agents:admin')
  @Delete(':project_id/teams/:team_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a team' })
  @ApiNoContentResponse({ description: 'Team deleted' })
  async deleteTeam(
    @Param('project_id') projectId: string,
    @Param('team_id') teamId: string,
  ): Promise<void> {
    return this.projectsService.deleteTeam(projectId, teamId);
  }

  // ── Project members ────────────────────────────────────────────────

  @RequirePermission('projects:write')
  @Post(':project_id/members')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add or update a project member' })
  @ApiBody({ schema: zodSchemaToOpenApi(ProjectMemberRequestSchema, 'ProjectMemberRequest') })
  @ApiOkResponse({
    description: 'Member added/updated',
    schema: zodSchemaToOpenApi(ProjectMemberResponseSchema, 'ProjectMemberResponse'),
  })
  async addMember(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(ProjectMemberRequestSchema)) body: ProjectMemberRequest,
  ): Promise<ProjectMemberResponse> {
    return this.projectsService.addMember(projectId, body);
  }

  @RequirePermission('projects:read')
  @Get(':project_id/members')
  @ApiOperation({ summary: 'List project members' })
  @ApiOkResponse({
    description: 'Member list',
    schema: zodSchemaToOpenApi(ProjectMemberListResponseSchema, 'ProjectMemberListResponse'),
  })
  async listMembers(
    @Param('project_id') projectId: string,
  ): Promise<ProjectMemberListResponse> {
    return this.projectsService.listMembers(projectId);
  }

  @RequirePermission('projects:admin')
  @Delete(':project_id/members/:user_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a project member' })
  @ApiOkResponse({ description: 'Member removed' })
  async removeMember(
    @Param('project_id') projectId: string,
    @Param('user_id') userId: string,
  ): Promise<void> {
    await this.projectsService.removeMember(projectId, userId);
  }
}
