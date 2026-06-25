import type { Db } from '../client.js';

export interface PricingRateCard {
  id: string;
  name: string;
  version: number;
  effective_at: Date;
  rates_json: Record<string, unknown>;
  created_at: Date;
  superseded_at: Date | null;
}

export function pricingRateCardQueries(db: Db) {
  return {
    async create(card: Omit<PricingRateCard, 'created_at' | 'superseded_at'>): Promise<PricingRateCard> {
      const [row] = await db<PricingRateCard[]>`
        INSERT INTO pricing_rate_cards (id, name, version, effective_at, rates_json)
        VALUES (
          ${card.id},
          ${card.name},
          ${card.version},
          ${card.effective_at},
          ${db.json(card.rates_json as never)}::jsonb
        )
        RETURNING *
      `;
      return row;
    },

    async listByName(name: string, options?: { limit?: number; offset?: number }): Promise<PricingRateCard[]> {
      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;
      return db<PricingRateCard[]>`
        SELECT *
        FROM pricing_rate_cards
        WHERE name = ${name}
        ORDER BY version DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async findLatestEffective(name: string, at: Date = new Date()): Promise<PricingRateCard | null> {
      const [row] = await db<PricingRateCard[]>`
        SELECT *
        FROM pricing_rate_cards
        WHERE name = ${name}
          AND effective_at <= ${at}
          AND superseded_at IS NULL
        ORDER BY version DESC
        LIMIT 1
      `;
      return row ?? null;
    },
  };
}

