-- 00028_add_builds.sql
-- Build specs, runs, artifacts, and release build references

CREATE TABLE build_specs (
  id VARCHAR(255) PRIMARY KEY,                  -- bld_xxx (TypeID)
  project_id TEXT NOT NULL REFERENCES projects(id),
  git_sha VARCHAR(40) NOT NULL,
  manifest_hash VARCHAR(64) NOT NULL,
  services_json JSONB,
  inputs_json JSONB,
  registry_json JSONB,
  cache_json JSONB,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_build_specs_project_id ON build_specs(project_id);
CREATE INDEX idx_build_specs_project_sha ON build_specs(project_id, git_sha);

CREATE TABLE build_runs (
  id VARCHAR(255) PRIMARY KEY,                  -- brun_xxx (TypeID)
  build_id VARCHAR(255) NOT NULL REFERENCES build_specs(id),
  status VARCHAR(64) NOT NULL,
  backend VARCHAR(64) NOT NULL,
  runner_ref TEXT,
  logs_ref TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_build_runs_build_id ON build_runs(build_id);
CREATE INDEX idx_build_runs_status ON build_runs(status);

CREATE TABLE build_artifacts (
  id VARCHAR(255) PRIMARY KEY,                  -- bart_xxx (TypeID)
  build_id VARCHAR(255) NOT NULL REFERENCES build_specs(id),
  service_name TEXT NOT NULL,
  image_ref TEXT NOT NULL,
  digest TEXT NOT NULL,
  platforms_json JSONB,
  size_bytes BIGINT,
  sbom_ref TEXT,
  provenance_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_build_artifacts_build_id ON build_artifacts(build_id);

CREATE TABLE build_logs (
  id BIGSERIAL PRIMARY KEY,
  build_run_id VARCHAR(255) NOT NULL REFERENCES build_runs(id),
  seq INTEGER NOT NULL,
  type VARCHAR(64) NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX idx_build_logs_run_seq ON build_logs(build_run_id, seq);
CREATE INDEX idx_build_logs_run_id ON build_logs(build_run_id);

ALTER TABLE releases
  ADD COLUMN build_id VARCHAR(255) REFERENCES build_specs(id);

CREATE INDEX idx_releases_build_id ON releases(build_id);
