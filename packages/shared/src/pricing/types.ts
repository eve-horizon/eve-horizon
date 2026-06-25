export type Money = {
  currency: string;   // 'usd' | 'sats' | 'credits' | ...
  amount: string;     // decimal string (avoid float)
};

export type TokenRate = {
  input_per_million_usd: string;
  output_per_million_usd: string;
  cache_read_per_million_usd: string | null;
  cache_write_per_million_usd: string | null;
  // If null, reasoning defaults to the output rate for cost estimation.
  reasoning_per_million_usd: string | null;
};

export type ComputeRate = {
  vcpu_hour_usd: string;
  memory_gib_hour_usd: string;
};

export type StorageRate = {
  gb_hour_usd: string;
};

// RateCard v1 (denomination-agnostic; base rates always USD)
export type RateCardV1 = {
  llm: {
    byok: Record<string, Record<string, TokenRate>>;
    managed: Record<string, Record<string, TokenRate>>;
  };
  compute: Record<string, ComputeRate>;
  storage?: Record<string, StorageRate>;
};

export type BillingDefaultsV1 = {
  billing_currency: string; // typically 'usd'
  markup_pct: number;       // 0-100+
  rate_card_name: string;   // e.g. 'default'
};

export type OrgBillingConfigV1 = Partial<BillingDefaultsV1>;

export type FxSnapshot = {
  from_currency: 'usd';
  to_currency: string;
  rate: string;         // decimal string
  fetched_at: string;   // ISO
  source: string;
};

