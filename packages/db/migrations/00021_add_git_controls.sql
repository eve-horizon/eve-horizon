-- Migration: Add git controls and workspace columns to jobs and job_attempts
--
-- These columns enable per-job git configuration for ref selection, branch creation,
-- commit/push behavior, and workspace modes. See docs/system/job-git-controls.md.
--
-- jobs.git_json: Job-level git controls (ref, branch, commit, push policies)
-- jobs.workspace_json: Workspace configuration (mode, key)
-- job_attempts.git_json: Audit fields storing resolved refs, SHAs, and push status

-- Add git controls and workspace columns to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS git_json JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workspace_json JSONB;

-- Add git audit column to job_attempts table
ALTER TABLE job_attempts ADD COLUMN IF NOT EXISTS git_json JSONB;

-- Create GIN index on jobs.git_json for efficient JSONB querying
CREATE INDEX IF NOT EXISTS idx_jobs_git_json ON jobs USING GIN (git_json);

-- Document the new columns
COMMENT ON COLUMN jobs.git_json IS 'Git controls: ref, ref_policy, branch, create_branch, commit, push, remote';
COMMENT ON COLUMN jobs.workspace_json IS 'Workspace config: mode (job|session|isolated), key';
COMMENT ON COLUMN job_attempts.git_json IS 'Git audit: resolved_ref, resolved_sha, resolved_branch, ref_source, pushed';
