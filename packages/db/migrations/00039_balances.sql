-- 00039_balances.sql
-- Balance ledger for prepaid credits + charges (Phase 8)

CREATE TABLE IF NOT EXISTS org_balances (
  org_id        TEXT PRIMARY KEY REFERENCES orgs(id),
  balance       NUMERIC NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  lifetime_in   NUMERIC NOT NULL DEFAULT 0,
  lifetime_out  NUMERIC NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balance_transactions (
  id            TEXT PRIMARY KEY,      -- bt_xxx (TypeID)
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  type          TEXT NOT NULL,         -- credit | charge | refund | adjustment
  amount        NUMERIC NOT NULL,
  currency      TEXT NOT NULL,
  description   TEXT,
  source_type   TEXT NOT NULL,         -- receipt | payment | manual | promo
  source_id     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_balance_transactions_org
  ON balance_transactions(org_id, created_at DESC);
