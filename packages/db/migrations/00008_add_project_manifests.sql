-- 00008_add_project_manifests.sql
-- Add project_manifests table for storing .beads.yaml manifest data

-- ============================================================================
-- PROJECT MANIFESTS
-- ============================================================================
-- Tracks parsed .beads.yaml manifests from project repositories.
-- Each row represents a version of the manifest with content hash for deduplication.

CREATE TABLE project_manifests (
  id TEXT PRIMARY KEY,                              -- manifest_xxx (TypeID)
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  manifest_yaml TEXT NOT NULL,                      -- raw YAML content
  manifest_hash VARCHAR(64) NOT NULL,               -- SHA256 of manifest content
  git_sha VARCHAR(40),                              -- commit SHA when synced (nullable)
  branch TEXT,                                      -- branch name when synced (nullable)
  parsed_defaults JSONB,                            -- extracted defaults for quick access (nullable)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevent duplicate manifests for same project
  UNIQUE(project_id, manifest_hash)
);

-- Index for finding manifests by project
CREATE INDEX idx_project_manifests_project ON project_manifests(project_id);

-- Index for finding manifests by git SHA (for sync operations)
CREATE INDEX idx_project_manifests_git_sha ON project_manifests(git_sha) WHERE git_sha IS NOT NULL;

-- ============================================================================
-- End of Migration
-- ============================================================================
