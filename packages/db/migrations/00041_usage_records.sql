-- Usage records: tracks non-job resource consumption (environment services, PVCs, etc.)
CREATE TABLE IF NOT EXISTS usage_records (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  project_id    TEXT REFERENCES projects(id),
  env_id        TEXT REFERENCES environments(id),
  resource_type TEXT NOT NULL,
  resource_class TEXT,
  quantity      NUMERIC NOT NULL,
  unit          TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_type, source_id, resource_type)
);
CREATE INDEX IF NOT EXISTS idx_usage_records_org_time ON usage_records(org_id, started_at DESC);
