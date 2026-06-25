import { Injectable, Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import { pricingRateCardQueries } from '@eve/db';
import {
  type RateCardV1,
  type TokenRate,
  generateRateCardId,
  DEFAULT_RATE_CARD_V1,
  type OpenRouterModel,
  processOpenRouterModels,
  computePricingDiff,
  type PricingDiff,
  type OraclePricingEntry,
} from '@eve/shared';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const REQUEST_TIMEOUT_MS = 15_000;

export interface RefreshResult {
  diff: PricingDiff;
  dry_run: boolean;
  rate_card?: {
    id: string;
    name: string;
    version: number;
    effective_at: string;
  };
}

@Injectable()
export class RateCardRefreshService {
  constructor(@Inject('DB') private readonly db: Db) {}

  async refreshFromOpenRouter(options: {
    dry_run: boolean;
    name?: string;
    effective_at?: string;
  }): Promise<RefreshResult> {
    const cardName = options.name ?? 'default';
    const effectiveAt = options.effective_at ?? new Date().toISOString();

    // 1. Fetch OpenRouter models (no auth required)
    const orModels = await this.fetchOpenRouterModels();

    // 2. Process into oracle pricing entries
    const oracleEntries = processOpenRouterModels(orModels);

    // 3. Get current rate card
    const rateCards = pricingRateCardQueries(this.db);
    const currentCard = await rateCards.findLatestEffective(cardName, new Date());
    const currentRates = (currentCard?.rates_json as RateCardV1) ?? DEFAULT_RATE_CARD_V1;

    // 4. Compute diff
    const diff = computePricingDiff(currentRates.llm.byok, oracleEntries);

    if (options.dry_run) {
      return { diff, dry_run: true };
    }

    // 5. Build new rate card by merging oracle entries into current
    const newRates = this.mergeOracleIntoRateCard(currentRates, oracleEntries);
    const nextVersion = currentCard ? currentCard.version + 1 : 1;

    const id = generateRateCardId();
    const row = await rateCards.create({
      id,
      name: cardName,
      version: nextVersion,
      effective_at: new Date(effectiveAt),
      rates_json: newRates as unknown as Record<string, unknown>,
    });

    return {
      diff,
      dry_run: false,
      rate_card: {
        id: row.id,
        name: row.name,
        version: row.version,
        effective_at: row.effective_at.toISOString(),
      },
    };
  }

  private async fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API returned HTTP ${response.status}`);
      }

      const body = await response.json() as { data?: unknown[] };
      if (!Array.isArray(body.data)) {
        throw new Error('Unexpected OpenRouter response format');
      }

      return body.data as OpenRouterModel[];
    } finally {
      clearTimeout(timeout);
    }
  }

  private mergeOracleIntoRateCard(
    current: RateCardV1,
    entries: OraclePricingEntry[],
  ): RateCardV1 {
    const byok = JSON.parse(JSON.stringify(current.llm.byok)) as Record<string, Record<string, TokenRate>>;

    for (const entry of entries) {
      if (!byok[entry.provider]) {
        byok[entry.provider] = {};
      }
      byok[entry.provider][entry.normalized_model] = {
        input_per_million_usd: entry.input_per_million_usd,
        output_per_million_usd: entry.output_per_million_usd,
        cache_read_per_million_usd: null,
        cache_write_per_million_usd: null,
        reasoning_per_million_usd: null,
      };
    }

    return {
      ...current,
      llm: {
        ...current.llm,
        byok,
      },
    };
  }
}
