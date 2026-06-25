import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { AppCostService } from './app-cost.service.js';
import { CostService } from './cost.service.js';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('admin/cost')
export class CostController {
  constructor(
    private readonly cost: CostService,
    private readonly appCost: AppCostService,
  ) {}

  @RequirePermission('system:admin')
  @Get('apps')
  @ApiOperation({ summary: 'Per-app cost report across all orgs (admin)' })
  @ApiQuery({ name: 'month', required: false, description: 'UTC month in YYYY-MM format' })
  async getAppCosts(@Query('month') month?: string) {
    return this.appCost.getAppCosts({ month });
  }

  @RequirePermission('system:admin')
  @Get('environments')
  @ApiOperation({ summary: 'List environment cost estimates (admin)' })
  @ApiQuery({ name: 'month', required: false, description: 'UTC month in YYYY-MM format' })
  @ApiQuery({ name: 'source', required: false, description: 'Snapshot source (default opencost)' })
  async listEnvironmentCosts(
    @Query('month') month?: string,
    @Query('source') source?: string,
  ) {
    return this.cost.listEnvironmentCosts({ month, source });
  }

  @RequirePermission('system:admin')
  @Get('cloud')
  @ApiOperation({ summary: 'Get bill-backed cloud cost snapshot (admin)' })
  @ApiQuery({ name: 'scope_type', required: false, description: 'Scope type (default cluster)' })
  @ApiQuery({ name: 'scope_key', required: false, description: 'Scope key (default configured cluster)' })
  @ApiQuery({ name: 'month', required: false, description: 'UTC month in YYYY-MM format' })
  @ApiQuery({ name: 'provider', required: false, description: 'Cloud provider (for example aws)' })
  @ApiQuery({ name: 'source', required: false, description: 'Snapshot source (for example aws_cost_explorer)' })
  async getCloudCost(
    @Query('scope_type') scopeType?: string,
    @Query('scope_key') scopeKey?: string,
    @Query('month') month?: string,
    @Query('provider') provider?: string,
    @Query('source') source?: string,
  ) {
    return this.cost.getCloudCost({ scopeType, scopeKey, month, provider, source });
  }
}
