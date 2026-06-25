import { Injectable, Inject, BadRequestException, ConflictException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { exchangeRateQueries, pricingRateCardQueries } from '@eve/db';
import { generateExchangeRateId, generateRateCardId } from '@eve/shared';

@Injectable()
export class PricingService {
  private rateCards: ReturnType<typeof pricingRateCardQueries>;
  private exchangeRates: ReturnType<typeof exchangeRateQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.rateCards = pricingRateCardQueries(db);
    this.exchangeRates = exchangeRateQueries(db);
  }

  async createRateCard(input: {
    name: string;
    version: number;
    effective_at: string;
    rates_json: Record<string, unknown>;
    id?: string;
  }) {
    if (!input.name) throw new BadRequestException('name is required');
    if (!Number.isFinite(input.version) || input.version < 1) {
      throw new BadRequestException('version must be a positive integer');
    }
    const effectiveAt = new Date(input.effective_at);
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new BadRequestException('effective_at must be an ISO timestamp');
    }
    if (!input.rates_json || typeof input.rates_json !== 'object') {
      throw new BadRequestException('rates_json must be an object');
    }

    const id = input.id ?? generateRateCardId();

    try {
      const row = await this.rateCards.create({
        id,
        name: input.name,
        version: input.version,
        effective_at: effectiveAt,
        rates_json: input.rates_json,
      });
      return row;
    } catch (err) {
      // Unique(name, version) will surface here.
      throw new ConflictException(err instanceof Error ? err.message : String(err));
    }
  }

  async listRateCards(name: string) {
    if (!name) throw new BadRequestException('name is required');
    return this.rateCards.listByName(name);
  }

  async getEffectiveRateCard(name: string, at?: string) {
    if (!name) throw new BadRequestException('name is required');
    const atDate = at ? new Date(at) : new Date();
    if (at && Number.isNaN(atDate.getTime())) {
      throw new BadRequestException('at must be an ISO timestamp');
    }
    return this.rateCards.findLatestEffective(name, atDate);
  }

  async insertExchangeRate(input: {
    from_currency: string;
    to_currency: string;
    rate: string;
    source: string;
    fetched_at: string;
    id?: string;
  }) {
    const from = input.from_currency?.toLowerCase();
    const to = input.to_currency?.toLowerCase();
    if (!from) throw new BadRequestException('from_currency is required');
    if (!to) throw new BadRequestException('to_currency is required');
    if (!input.rate) throw new BadRequestException('rate is required');
    if (!input.source) throw new BadRequestException('source is required');
    const fetchedAt = new Date(input.fetched_at);
    if (Number.isNaN(fetchedAt.getTime())) {
      throw new BadRequestException('fetched_at must be an ISO timestamp');
    }

    const id = input.id ?? generateExchangeRateId();
    return this.exchangeRates.create({
      id,
      from_currency: from,
      to_currency: to,
      rate: input.rate,
      source: input.source,
      fetched_at: fetchedAt,
    });
  }

  async getLatestExchangeRate(fromCurrency: string, toCurrency: string) {
    const from = fromCurrency?.toLowerCase();
    const to = toCurrency?.toLowerCase();
    if (!from) throw new BadRequestException('from is required');
    if (!to) throw new BadRequestException('to is required');
    return this.exchangeRates.findLatest(from, to);
  }
}
