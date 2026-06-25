-- Platform Sentinel: environment health monitoring
-- Stores latest health check result per environment (upsert pattern).
-- No history table — event log + Slack channel are the audit trail.

CREATE TABLE IF NOT EXISTS environment_health_checks (
  environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  environment_slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  issue_signature TEXT NOT NULL DEFAULT '',
  issues_json JSONB,
  pod_count INTEGER NOT NULL DEFAULT 0,
  healthy_pod_count INTEGER NOT NULL DEFAULT 0,
  degraded_since TIMESTAMPTZ,
  consecutive_degraded_ticks INTEGER NOT NULL DEFAULT 0,
  actions_taken_json JSONB,
  notified_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_env_health_status ON environment_health_checks(status);
CREATE INDEX IF NOT EXISTS idx_env_health_checked_at ON environment_health_checks(checked_at);
