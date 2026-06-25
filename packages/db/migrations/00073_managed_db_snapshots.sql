-- Migration: managed_db_snapshots
-- Created: 2026-03-05

-- Create managed_db_snapshots table
CREATE TABLE IF NOT EXISTS managed_db_snapshots (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES managed_db_tenants(id),
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  project_id    TEXT NOT NULL REFERENCES projects(id),
  env_id        TEXT NOT NULL REFERENCES environments(id),
  instance_id   TEXT NOT NULL REFERENCES managed_db_instances(id),
  created_by    TEXT,

  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'in_progress',
  s3_bucket     TEXT,
  s3_key        TEXT,
  size_bytes    BIGINT,
  db_size_bytes BIGINT,
  pg_version    TEXT,
  error_message TEXT,

  retention     TEXT NOT NULL DEFAULT '30d',
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,

  CONSTRAINT valid_trigger CHECK (trigger IN ('manual', 'scheduled', 'pre_delete', 'pre_reset')),
  CONSTRAINT valid_status CHECK (status IN ('in_progress', 'completed', 'failed'))
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_snapshots_tenant ON managed_db_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_expires ON managed_db_snapshots(expires_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_snapshots_tenant_created ON managed_db_snapshots(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_org ON managed_db_snapshots(org_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_status ON managed_db_snapshots(status) WHERE status = 'in_progress';

-- Add backup-related columns to managed_db_tenants
ALTER TABLE managed_db_tenants
  ADD COLUMN IF NOT EXISTS backup_schedule TEXT,
  ADD COLUMN IF NOT EXISTS backup_retention TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_on_delete BOOLEAN,
  ADD COLUMN IF NOT EXISTS snapshot_on_reset BOOLEAN,
  ADD COLUMN IF NOT EXISTS last_snapshot_at TIMESTAMPTZ;
