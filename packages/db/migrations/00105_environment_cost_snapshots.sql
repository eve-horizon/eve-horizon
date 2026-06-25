-- Environment cost snapshots: month-to-date allocation estimates per environment.
-- Written by the env-cost collector (OpenCost). Read by the daily Sentinel summary
-- and the admin cost API. One row per (aggregation_key, source, window).

CREATE TABLE IF NOT EXISTS environment_cost_snapshots (
  id TEXT PRIMARY KEY,
  aggregation_key TEXT NOT NULL,
  environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
  org_id TEXT,
  project_id TEXT,
  environment_slug TEXT,
  scope TEXT NOT NULL DEFAULT 'environment',
  source TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  amount_usd NUMERIC NOT NULL,
  shared_amount_usd NUMERIC,
  confidence TEXT NOT NULL DEFAULT 'estimate',
  breakdown_json JSONB,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (scope IN ('environment', 'shared_overhead')),
  CHECK (confidence IN ('estimate', 'reconciled', 'unavailable')),
  CHECK (amount_usd >= 0),
  CHECK (shared_amount_usd IS NULL OR shared_amount_usd >= 0),
  CHECK ((scope = 'environment' AND environment_id IS NOT NULL) OR (scope = 'shared_overhead' AND environment_id IS NULL)),
  UNIQUE(aggregation_key, source, window_start)
);

CREATE INDEX IF NOT EXISTS idx_env_cost_window_source ON environment_cost_snapshots(window_start, source);
CREATE INDEX IF NOT EXISTS idx_env_cost_env ON environment_cost_snapshots(environment_id);
CREATE INDEX IF NOT EXISTS idx_env_cost_amount ON environment_cost_snapshots(window_start, source, amount_usd DESC);
