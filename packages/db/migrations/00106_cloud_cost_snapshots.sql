-- Bill-backed cloud cost snapshots.
-- Written by provider adapters (AWS Cost Explorer first). Read by the daily
-- Sentinel summary, admin API, and CLI. Kept separate from OpenCost
-- environment_cost_snapshots, which remain in-cluster allocation estimates.

CREATE TABLE IF NOT EXISTS cloud_cost_snapshots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  account_id TEXT,
  billing_account_id TEXT,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope_label TEXT NOT NULL,
  org_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  mtd_through DATE,
  amount NUMERIC NOT NULL,
  projected_amount NUMERIC,
  currency TEXT NOT NULL DEFAULT 'USD',
  confidence TEXT NOT NULL DEFAULT 'estimate',
  coverage TEXT NOT NULL DEFAULT 'undercount',
  filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  breakdown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (scope_type IN ('cluster', 'environment', 'account', 'project')),
  CHECK (confidence IN ('estimate', 'reconciled', 'unavailable')),
  CHECK (coverage IN ('undercount', 'complete', 'partial', 'unknown')),
  CHECK (amount >= 0),
  CHECK (projected_amount IS NULL OR projected_amount >= 0),
  UNIQUE(provider, source, scope_type, scope_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_cloud_cost_scope_window
  ON cloud_cost_snapshots(provider, scope_type, scope_key, window_start);

CREATE INDEX IF NOT EXISTS idx_cloud_cost_source_window
  ON cloud_cost_snapshots(source, window_start);
