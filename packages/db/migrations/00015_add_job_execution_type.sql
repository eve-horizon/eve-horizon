-- Migration: Add job execution type support and pipeline run grouping
-- Description: Extends the jobs table to support different execution types (agent, script, action)
--              and adds pipeline run grouping with related metadata fields

-- Add new columns to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS execution_type TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS run_id TEXT REFERENCES pipeline_runs(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS step_name TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS action_type TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS action_input JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS script_command TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS script_timeout_seconds INTEGER;

-- Add CHECK constraint to validate execution_type values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_execution_type_check'
  ) THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_execution_type_check
      CHECK (execution_type IN ('agent', 'script', 'action'));
  END IF;
END
$$;

-- Create index on run_id for efficient pipeline run queries
CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id) WHERE run_id IS NOT NULL;

-- Create index on execution_type for filtering by job type
CREATE INDEX IF NOT EXISTS idx_jobs_execution_type ON jobs(execution_type);

-- Add composite index for pipeline run queries (run_id + created_at)
CREATE INDEX IF NOT EXISTS idx_jobs_run_id_created_at ON jobs(run_id, created_at) WHERE run_id IS NOT NULL;

-- Comments for documentation
COMMENT ON COLUMN jobs.execution_type IS 'Type of job execution: agent (AI agent), script (shell command), or action (predefined action)';
COMMENT ON COLUMN jobs.run_id IS 'Groups jobs belonging to the same pipeline run';
COMMENT ON COLUMN jobs.step_name IS 'Human-readable name of the step within a pipeline';
COMMENT ON COLUMN jobs.action_type IS 'Type of action for action jobs: build, release, deploy, run, notify';
COMMENT ON COLUMN jobs.action_input IS 'Configuration and parameters for action jobs';
COMMENT ON COLUMN jobs.script_command IS 'Shell command to execute for script jobs';
COMMENT ON COLUMN jobs.script_timeout_seconds IS 'Optional timeout in seconds for script execution';
