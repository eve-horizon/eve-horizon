import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { PricingService } from './pricing.service.js';
import { RateCardRefreshService } from './rate-card-refresh.service.js';

@ApiTags('pricing')
@ApiBearerAuth()
@Controller('admin/pricing')
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly refresh: RateCardRefreshService,
  ) {}

  @RequirePermission('system:admin')
  @Post('rate-cards')
  @ApiOperation({ summary: 'Create a new pricing rate card version (immutable)' })
  async createRateCard(@Body() body: {
    name: string;
    version: number;
    effective_at: string;
    rates_json: Record<string, unknown>;
  }) {
    const row = await this.pricing.createRateCard(body);
    return {
      ...row,
      effective_at: row.effective_at.toISOString(),
      created_at: row.created_at.toISOString(),
      superseded_at: row.superseded_at?.toISOString() ?? null,
    };
  }

  @RequirePermission('system:admin')
  @Get('rate-cards')
  @ApiOperation({ summary: 'List rate cards by name (admin)' })
  @ApiQuery({ name: 'name', required: true })
  async listRateCards(@Query('name') name: string) {
    const rows = await this.pricing.listRateCards(name);
    return rows.map((row) => ({
      ...row,
      effective_at: row.effective_at.toISOString(),
      created_at: row.created_at.toISOString(),
      superseded_at: row.superseded_at?.toISOString() ?? null,
    }));
  }

  @RequirePermission('system:admin')
  @Get('rate-cards/effective')
  @ApiOperation({ summary: 'Get the effective rate card for a name at a point in time (admin)' })
  @ApiQuery({ name: 'name', required: true })
  @ApiQuery({ name: 'at', required: false, description: 'ISO timestamp (defaults to now)' })
  async getEffectiveRateCard(
    @Query('name') name: string,
    @Query('at') at?: string,
  ) {
    const row = await this.pricing.getEffectiveRateCard(name, at);
    if (!row) return null;
    return {
      ...row,
      effective_at: row.effective_at.toISOString(),
      created_at: row.created_at.toISOString(),
      superseded_at: row.superseded_at?.toISOString() ?? null,
    };
  }

  @RequirePermission('system:admin')
  @Post('exchange-rates')
  @ApiOperation({ summary: 'Insert an exchange rate snapshot (admin)' })
  async insertExchangeRate(@Body() body: {
    from_currency: string;
    to_currency: string;
    rate: string;
    source: string;
    fetched_at: string;
  }) {
    const row = await this.pricing.insertExchangeRate(body);
    return {
      ...row,
      fetched_at: row.fetched_at.toISOString(),
      created_at: row.created_at.toISOString(),
    };
  }

  @RequirePermission('system:admin')
  @Get('exchange-rates/latest')
  @ApiOperation({ summary: 'Get the latest exchange rate snapshot (admin)' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  async getLatestExchangeRate(
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const row = await this.pricing.getLatestExchangeRate(from, to);
    if (!row) return null;
    return {
      ...row,
      fetched_at: row.fetched_at.toISOString(),
      created_at: row.created_at.toISOString(),
    };
  }

  @RequirePermission('system:admin')
  @Post('refresh-openrouter')
  @ApiOperation({ summary: 'Refresh rate card pricing from OpenRouter model catalog' })
  async refreshFromOpenRouter(@Body() body: {
    dry_run?: boolean;
    name?: string;
    effective_at?: string;
  }) {
    return this.refresh.refreshFromOpenRouter({
      dry_run: body.dry_run ?? true,
      name: body.name,
      effective_at: body.effective_at,
    });
  }
}
