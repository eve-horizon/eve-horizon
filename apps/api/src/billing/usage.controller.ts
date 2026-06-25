import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { UsageService } from './usage.service.js';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('admin/orgs/:orgId/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @RequirePermission('system:admin')
  @Get()
  @ApiOperation({ summary: 'List usage records for an org (admin)' })
  @ApiParam({ name: 'orgId', required: true })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp filter (inclusive)' })
  @ApiQuery({ name: 'until', required: false, description: 'ISO timestamp filter (inclusive)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max rows (default 50)' })
  async listUsage(
    @Param('orgId') orgId: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const rows = await this.usage.listByOrg(orgId, { since, until, limit });
    return rows.map((r) => ({
      id: r.id,
      org_id: r.org_id,
      project_id: r.project_id,
      env_id: r.env_id,
      resource_type: r.resource_type,
      resource_class: r.resource_class,
      quantity: r.quantity,
      unit: r.unit,
      started_at: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
      ended_at: r.ended_at instanceof Date ? r.ended_at.toISOString() : r.ended_at,
      source_type: r.source_type,
      source_id: r.source_id,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    }));
  }

  @RequirePermission('system:admin')
  @Get('summary')
  @ApiOperation({ summary: 'Aggregated usage summary for an org (admin)' })
  @ApiParam({ name: 'orgId', required: true })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp filter (inclusive)' })
  @ApiQuery({ name: 'until', required: false, description: 'ISO timestamp filter (inclusive)' })
  async usageSummary(
    @Param('orgId') orgId: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    const aggregates = await this.usage.aggregateByOrg(orgId, { since, until });
    return {
      org_id: orgId,
      aggregates: aggregates.map((a) => ({
        resource_type: a.resource_type,
        unit: a.unit,
        total_quantity: a.total_quantity,
      })),
    };
  }
}
