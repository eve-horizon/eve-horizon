-- 00070_storage_buckets.sql
-- Per-environment app storage buckets provisioned from manifest x-eve.object_store

CREATE TABLE storage_buckets (
  id              TEXT PRIMARY KEY,               -- sbkt_xxx
  org_id          TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  env_name        TEXT,
  service_name    TEXT NOT NULL,                  -- component name in manifest
  name            TEXT NOT NULL,                  -- logical bucket name: 'uploads'
  physical_name   TEXT NOT NULL,                  -- actual bucket name in MinIO/S3
  visibility      TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'public')),
  cors_json       JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, env_name, service_name, name)
);

CREATE INDEX idx_storage_buckets_org ON storage_buckets(org_id);
CREATE INDEX idx_storage_buckets_project_env ON storage_buckets(project_id, env_name);
