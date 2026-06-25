-- Add resolved git metadata to jobs table
-- When a job attempt succeeds, the resolved git metadata (SHA, branch, etc.)
-- is promoted from the attempt to the job for easy client access.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resolved_git_json JSONB;
