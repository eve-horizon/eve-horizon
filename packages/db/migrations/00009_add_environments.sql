-- 00008_add_environments.sql
-- Add environments table for persistent and temporary deployment environments

-- ============================================================================
-- ENVIRONMENTS (Deployment Targets)
-- ============================================================================
-- Represents deployment environments (staging, production, test, etc.)
-- Environments can be persistent (long-lived) or temporary (ephemeral).
-- Each environment can have its own database and configuration overrides.

CREATE TABLE environments (
  id TEXT PRIMARY KEY,                              -- env_xxx (TypeID)
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- e.g., 'staging', 'production', 'test'
  type TEXT NOT NULL,                               -- 'persistent' or 'temporary'
  namespace TEXT,                                   -- K8s namespace (e.g., 'myapp-staging')
  db_ref TEXT,                                      -- Reference to database definition in manifest
  overrides_json JSONB,                             -- Environment-specific config overrides
  current_release_id TEXT,                          -- FK to releases table (when added)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_environment_type CHECK (type IN ('persistent', 'temporary')),
  UNIQUE(project_id, name)
);

-- Index for finding environments by project
CREATE INDEX idx_environments_project_id ON environments(project_id);

-- Composite index for finding environments by project and name
CREATE INDEX idx_environments_project_name ON environments(project_id, name);

-- ============================================================================
-- End of Migration
-- ============================================================================
