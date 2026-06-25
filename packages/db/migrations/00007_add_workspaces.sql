-- 00007_add_workspaces.sql
-- Add workspaces table for pooled environment management

-- ============================================================================
-- WORKSPACES (Pooled Environments)
-- ============================================================================
-- Per-project pool of workspaces for reuse.
-- Each workspace = PVC + metadata row in DB.
-- Runner pod mounts PVC and runs jobs.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,                              -- workspace_xxx (TypeID)
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'idle',               -- idle | acquired | teardown
  last_job_id VARCHAR(64) REFERENCES jobs(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- K8s resource tracking
  pvc_name TEXT,                                    -- Name of the PersistentVolumeClaim
  namespace TEXT,                                   -- K8s namespace where PVC exists

  CONSTRAINT valid_workspace_state CHECK (state IN ('idle', 'acquired', 'teardown')),
  UNIQUE(project_id, id)
);

-- Index for finding available workspaces
CREATE INDEX idx_workspaces_project_state ON workspaces(project_id, state);

-- Index for finding stale workspaces (heartbeat-based cleanup)
CREATE INDEX idx_workspaces_heartbeat ON workspaces(heartbeat_at) WHERE state = 'acquired';

-- ============================================================================
-- End of Migration
-- ============================================================================
