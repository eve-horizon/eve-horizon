import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { BalanceService } from './balance.service.js';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('admin/orgs/:orgId/balance')
export class BalanceController {
  constructor(private readonly balance: BalanceService) {}

  @RequirePermission('system:admin')
  @Get()
  @ApiOperation({ summary: 'Get current balance for an org (admin)' })
  @ApiParam({ name: 'orgId', required: true })
  async getBalance(@Param('orgId') orgId: string) {
    const row = await this.balance.getBalance(orgId);
    if (!row) {
      return {
        org_id: orgId,
        balance: '0',
        currency: null,
        lifetime_in: '0',
        lifetime_out: '0',
        updated_at: null,
      };
    }
    return {
      org_id: row.org_id,
      balance: row.balance,
      currency: row.currency,
      lifetime_in: row.lifetime_in,
      lifetime_out: row.lifetime_out,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  @RequirePermission('system:admin')
  @Get('transactions')
  @ApiOperation({ summary: 'List balance transactions for an org (admin)' })
  @ApiParam({ name: 'orgId', required: true })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp filter (inclusive)' })
  @ApiQuery({ name: 'until', required: false, description: 'ISO timestamp filter (inclusive)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max rows (default 50)' })
  async listTransactions(
    @Param('orgId') orgId: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const rows = await this.balance.listTransactions(orgId, { since, until, limit });
    return rows.map((tx) => ({
      id: tx.id,
      org_id: tx.org_id,
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      description: tx.description,
      source_type: tx.source_type,
      source_id: tx.source_id,
      created_at: tx.created_at instanceof Date ? tx.created_at.toISOString() : tx.created_at,
    }));
  }

  @RequirePermission('system:admin')
  @Post('credit')
  @ApiOperation({ summary: 'Add credit to an org balance (admin)' })
  @ApiParam({ name: 'orgId', required: true })
  async addCredit(
    @Param('orgId') orgId: string,
    @Body() body: {
      amount: string;
      currency: string;
      reason?: string;
      source_type?: string;
    },
  ) {
    const tx = await this.balance.addCredit(orgId, body);
    return {
      id: tx.id,
      org_id: tx.org_id,
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      description: tx.description,
      source_type: tx.source_type,
      source_id: tx.source_id,
      created_at: tx.created_at instanceof Date ? tx.created_at.toISOString() : tx.created_at,
    };
  }
}
