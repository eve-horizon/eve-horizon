import type { FxSnapshot } from './types.js';

export function buildFxSnapshot(
  billingCurrency: string,
  row: { from_currency: string; to_currency: string; rate: string; source: string; fetched_at: Date } | null,
): FxSnapshot | null {
  const currency = billingCurrency.toLowerCase();
  if (currency === 'usd') return null;
  if (!row) return null;

  return {
    from_currency: 'usd',
    to_currency: row.to_currency,
    rate: row.rate,
    fetched_at: row.fetched_at.toISOString(),
    source: row.source,
  };
}

