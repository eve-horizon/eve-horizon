import type { Db } from '../client.js';

export interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: string; // NUMERIC; postgres.js returns string by default
  source: string;
  fetched_at: Date;
  created_at: Date;
}

export function exchangeRateQueries(db: Db) {
  return {
    async create(rate: Omit<ExchangeRate, 'created_at'>): Promise<ExchangeRate> {
      const [row] = await db<ExchangeRate[]>`
        INSERT INTO exchange_rates (id, from_currency, to_currency, rate, source, fetched_at)
        VALUES (
          ${rate.id},
          ${rate.from_currency},
          ${rate.to_currency},
          ${rate.rate},
          ${rate.source},
          ${rate.fetched_at}
        )
        RETURNING *
      `;
      return row;
    },

    async findLatest(fromCurrency: string, toCurrency: string): Promise<ExchangeRate | null> {
      const [row] = await db<ExchangeRate[]>`
        SELECT *
        FROM exchange_rates
        WHERE from_currency = ${fromCurrency} AND to_currency = ${toCurrency}
        ORDER BY fetched_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },
  };
}

