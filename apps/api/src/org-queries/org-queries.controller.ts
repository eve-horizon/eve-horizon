import {
  Controller,
  Get,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  Req,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import {
  OrgJobListResponseSchema,
  OrgJobStatsResponseSchema,
  OrgEventListResponseSchema,
  OrgAgentsListResponseSchema,
  type OrgJobListResponse,
  type OrgJobStatsResponse,
  type OrgEventListResponse,
  type OrgAgentsListResponse,
} from '@eve/shared';
import { OrgQueriesService } from './org-queries.service.js';

@ApiTags('org-queries')
@ApiBearerAuth()
@Controller('orgs/:org_id')
export class OrgQueriesController {
  constructor(private readonly orgQueriesService: OrgQueriesService) {}

  // --------------------------------------------------------------------------
  // Jobs across all projects
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:read')
  @Get('jobs')
  @ApiOperation({ summary: 'List jobs across all projects in an org (permission-filtered)' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by job phase (e.g. active, ready, done)' })
  @ApiQuery({ name: 'agent_slug', required: false, description: 'Filter by agent slug (glob with *)' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Filter to a specific project' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max items per page (1-100, default 50)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Pagination cursor from previous response' })
  @ApiOkResponse({
    description: 'Paginated list of jobs across projects',
    schema: zodSchemaToOpenApi(OrgJobListResponseSchema, 'OrgJobListResponse'),
  })
  async listJobs(
    @Param('org_id') orgId: string,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
    @Query('status') status?: string,
    @Query('agent_slug') agentSlug?: string,
    @Query('project_id') projectId?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('cursor') cursor?: string,
  ): Promise<OrgJobListResponse> {
    return this.orgQueriesService.findJobs(
      orgId,
      { status, agent_slug: agentSlug, project_id: projectId, limit, cursor },
      request.user?.is_admin ? undefined : request.user?.user_id,
    );
  }

  // --------------------------------------------------------------------------
  // Job stats (aggregate counts)
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:read')
  @Get('jobs/stats')
  @ApiOperation({ summary: 'Get aggregate job stats for an org (by phase and project)' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiOkResponse({
    description: 'Aggregate job statistics',
    schema: zodSchemaToOpenApi(OrgJobStatsResponseSchema, 'OrgJobStatsResponse'),
  })
  async jobStats(
    @Param('org_id') orgId: string,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<OrgJobStatsResponse> {
    return this.orgQueriesService.jobStats(
      orgId,
      request.user?.is_admin ? undefined : request.user?.user_id,
    );
  }

  // --------------------------------------------------------------------------
  // Events across all projects
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:read')
  @Get('events')
  @ApiOperation({ summary: 'List events across all projects in an org (permission-filtered)' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by event type (glob with *, e.g. system.job.*)' })
  @ApiQuery({ name: 'since', required: false, description: 'Filter events created at or after this ISO timestamp' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max items per page (1-100, default 50)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Pagination cursor from previous response' })
  @ApiOkResponse({
    description: 'Paginated list of events across projects',
    schema: zodSchemaToOpenApi(OrgEventListResponseSchema, 'OrgEventListResponse'),
  })
  async listEvents(
    @Param('org_id') orgId: string,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
    @Query('type') type?: string,
    @Query('since') since?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('cursor') cursor?: string,
  ): Promise<OrgEventListResponse> {
    return this.orgQueriesService.findEvents(
      orgId,
      { type, since, limit, cursor },
      request.user?.is_admin ? undefined : request.user?.user_id,
    );
  }

  // --------------------------------------------------------------------------
  // Agents across all projects
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:read')
  @Get('agents/all')
  @ApiOperation({ summary: 'List all agents across all projects in an org (permission-filtered)' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiOkResponse({
    description: 'All agents across accessible projects',
    schema: zodSchemaToOpenApi(OrgAgentsListResponseSchema, 'OrgAgentsListResponse'),
  })
  async listAgents(
    @Param('org_id') orgId: string,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<OrgAgentsListResponse> {
    return this.orgQueriesService.findAgents(
      orgId,
      request.user?.is_admin ? undefined : request.user?.user_id,
    );
  }
}
