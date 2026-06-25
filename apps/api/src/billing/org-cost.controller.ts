import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { AppCostService } from './app-cost.service.js';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:org_id/cost')
export class OrgCostController {
  constructor(private readonly appCost: AppCostService) {}

  @RequirePermission('orgs:read')
  @Get('apps')
  @ApiOperation({ summary: 'Per-app cost report for an org (cloud allocation + LLM spend)' })
  @ApiQuery({ name: 'month', required: false, description: 'UTC month in YYYY-MM format' })
  async getAppCosts(
    @Param('org_id') orgId: string,
    @Query('month') month?: string,
  ) {
    return this.appCost.getAppCosts({ orgId, month });
  }
}
