-- 00013_add_project_api_sources.sql
-- Add project_api_sources table for cached API source metadata/specs

CREATE TABLE project_api_sources (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env_name TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  spec_url TEXT,
  auth_mode TEXT,
  cached_schema_json JSONB,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(project_id, env_name, name)
);

CREATE INDEX idx_project_api_sources_project ON project_api_sources(project_id);
CREATE INDEX idx_project_api_sources_project_env ON project_api_sources(project_id, env_name);
