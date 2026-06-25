import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import {
  AnalyticsSummarySchema,
  AnalyticsJobStatsSchema,
  AnalyticsPipelineStatsSchema,
  AnalyticsEnvHealthSchema,
  type AnalyticsSummary,
  type AnalyticsJobStats,
  type AnalyticsPipelineStats,
  type AnalyticsEnvHealth,
} from '@eve/shared';
import { AnalyticsService } from './analytics.service.js';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('orgs/:org_id/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @RequirePermission('orgs:read')
  @Get('summary')
  @ApiOperation({ summary: 'Get org-wide analytics summary' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'window', required: false, enum: ['1d', '7d', '30d', '90d'], description: 'Time window (default 7d)' })
  @ApiOkResponse({
    description: 'Org-wide analytics summary',
    schema: zodSchemaToOpenApi(AnalyticsSummarySchema, 'AnalyticsSummary'),
  })
  async summary(
    @Param('org_id') orgId: string,
    @Query('window') window?: string,
  ): Promise<AnalyticsSummary> {
    return this.analytics.getSummary(orgId, window);
  }

  @RequirePermission('orgs:read')
  @Get('jobs')
  @ApiOperation({ summary: 'Get org-wide job statistics' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'window', required: false, enum: ['1d', '7d', '30d', '90d'], description: 'Time window (default 7d)' })
  @ApiOkResponse({
    description: 'Job statistics',
    schema: zodSchemaToOpenApi(AnalyticsJobStatsSchema, 'AnalyticsJobStats'),
  })
  async jobs(
    @Param('org_id') orgId: string,
    @Query('window') window?: string,
  ): Promise<AnalyticsJobStats & { as_of: string }> {
    return this.analytics.getJobStatsForOrg(orgId, window);
  }

  @RequirePermission('orgs:read')
  @Get('pipelines')
  @ApiOperation({ summary: 'Get org-wide pipeline statistics' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'window', required: false, enum: ['1d', '7d', '30d', '90d'], description: 'Time window (default 7d)' })
  @ApiOkResponse({
    description: 'Pipeline statistics',
    schema: zodSchemaToOpenApi(AnalyticsPipelineStatsSchema, 'AnalyticsPipelineStats'),
  })
  async pipelines(
    @Param('org_id') orgId: string,
    @Query('window') window?: string,
  ): Promise<AnalyticsPipelineStats & { as_of: string }> {
    return this.analytics.getPipelineStatsForOrg(orgId, window);
  }

  @RequirePermission('orgs:read')
  @Get('env-health')
  @ApiOperation({ summary: 'Get org-wide environment health' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiOkResponse({
    description: 'Environment health',
    schema: zodSchemaToOpenApi(AnalyticsEnvHealthSchema, 'AnalyticsEnvHealth'),
  })
  async envHealth(
    @Param('org_id') orgId: string,
  ): Promise<AnalyticsEnvHealth & { as_of: string }> {
    return this.analytics.getEnvHealthForOrg(orgId);
  }

  @RequirePermission('orgs:read')
  @Get('cost-by-agent')
  @ApiOperation({ summary: 'Get cost breakdown by agent' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'window', required: false, enum: ['1d', '7d', '30d', '90d'], description: 'Time window (default 7d)' })
  async costByAgent(
    @Param('org_id') orgId: string,
    @Query('window') window?: string,
  ) {
    return this.analytics.getCostByAgent(orgId, window);
  }
}
