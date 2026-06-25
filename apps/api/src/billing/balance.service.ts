import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { balanceLedgerQueries, orgQueries } from '@eve/db';
import { generateBalanceTransactionId } from '@eve/shared';

import type { OrgBalance, BalanceTransaction, BalanceTransactionType, BalanceSourceType } from '@eve/db';

@Injectable()
export class BalanceService {
  private readonly ledger: ReturnType<typeof balanceLedgerQueries>;
  private readonly orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.ledger = balanceLedgerQueries(db);
    this.orgs = orgQueries(db);
  }

  async getBalance(orgId: string): Promise<OrgBalance | null> {
    await this.assertOrgExists(orgId);
    return this.ledger.getBalance(orgId);
  }

  async listTransactions(
    orgId: string,
    opts?: { since?: string; until?: string; limit?: number },
  ): Promise<BalanceTransaction[]> {
    await this.assertOrgExists(orgId);

    const since = opts?.since ? this.parseIso(opts.since, 'since') : undefined;
    const until = opts?.until ? this.parseIso(opts.until, 'until') : undefined;
    const limit = opts?.limit ? Math.max(1, Math.floor(opts.limit)) : 50;

    return this.ledger.listTransactions(orgId, { since, until, limit });
  }

  async addCredit(
    orgId: string,
    input: {
      amount: string;
      currency: string;
      reason?: string;
      source_type?: string;
    },
  ): Promise<BalanceTransaction> {
    await this.assertOrgExists(orgId);

    const amount = input.amount;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      throw new BadRequestException('amount must be a positive numeric string');
    }

    const currency = (input.currency ?? 'usd').toLowerCase();
    if (!currency) {
      throw new BadRequestException('currency is required');
    }

    const sourceType = (input.source_type ?? 'manual') as BalanceSourceType;
    const validSourceTypes: BalanceSourceType[] = ['receipt', 'payment', 'manual', 'promo', 'usage_record'];
    if (!validSourceTypes.includes(sourceType)) {
      throw new BadRequestException(`source_type must be one of: ${validSourceTypes.join(', ')}`);
    }

    // Ensure balance row exists with the correct currency.
    await this.ledger.ensureBalance(orgId, currency);

    const txId = generateBalanceTransactionId();
    return this.ledger.createTransaction({
      id: txId,
      org_id: orgId,
      type: 'credit',
      amount,
      currency,
      description: input.reason ?? null,
      source_type: sourceType,
      source_id: txId, // Self-referencing for manual credits (unique per transaction).
    });
  }

  private async assertOrgExists(orgId: string): Promise<void> {
    const org = await this.orgs.findById(orgId);
    if (!org) {
      throw new NotFoundException(`Org not found: ${orgId}`);
    }
  }

  private parseIso(value: string, field: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`${field} must be a valid ISO timestamp`);
    }
    return d;
  }
}
