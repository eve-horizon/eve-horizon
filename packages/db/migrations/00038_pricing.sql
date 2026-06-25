-- 00038_pricing.sql
-- Pricing infrastructure for resource management + cost tracking (v2)

CREATE TABLE IF NOT EXISTS pricing_rate_cards (
  id            TEXT PRIMARY KEY,      -- rc_xxx (TypeID)
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  effective_at  TIMESTAMPTZ NOT NULL,
  rates_json    JSONB NOT NULL,        -- see RateCard schema in @eve/shared
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id            TEXT PRIMARY KEY,      -- xr_xxx (TypeID)
  from_currency TEXT NOT NULL,
  to_currency   TEXT NOT NULL,
  rate          NUMERIC NOT NULL,      -- 1 from_currency = rate to_currency
  source        TEXT NOT NULL,         -- manual | coingecko | ecb | ...
  fetched_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_latest
  ON exchange_rates(from_currency, to_currency, fetched_at DESC);

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS billing_config JSONB;

