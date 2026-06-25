-- 00008_add_releases.sql
-- Releases table for tracking project releases

CREATE TABLE releases (
  id VARCHAR(255) PRIMARY KEY,                  -- rel_xxx (TypeID)
  project_id TEXT NOT NULL REFERENCES projects(id),
  git_sha VARCHAR(40) NOT NULL,                 -- commit being released
  manifest_hash VARCHAR(64) NOT NULL,           -- hash of manifest at release time
  image_digests_json JSONB,                     -- map of component -> image digest
  created_by VARCHAR(255),                      -- user/system that created the release
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_releases_project_id ON releases(project_id);
CREATE INDEX idx_releases_project_sha ON releases(project_id, git_sha);
