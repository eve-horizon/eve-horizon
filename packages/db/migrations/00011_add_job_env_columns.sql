-- Migration: Add environment targeting columns to jobs
--
-- The env_name column specifies which named environment a job should run in
-- (e.g., 'staging', 'production'). NULL means the default environment.
--
-- The execution_mode column controls the execution strategy:
-- - 'persistent': Run in a persistent environment namespace (default)
-- - 'ephemeral': Run in a job-scoped ephemeral namespace

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS env_name VARCHAR(100);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) DEFAULT 'persistent';

-- Add constraint to validate execution_mode values
ALTER TABLE jobs ADD CONSTRAINT valid_execution_mode
  CHECK (execution_mode IN ('persistent', 'ephemeral'));

-- Add index for querying jobs by environment
CREATE INDEX IF NOT EXISTS idx_jobs_env_name ON jobs(env_name) WHERE env_name IS NOT NULL;

COMMENT ON COLUMN jobs.env_name IS 'Target environment name (e.g., staging, production). NULL = default environment';
COMMENT ON COLUMN jobs.execution_mode IS 'Execution strategy: persistent (shared namespace) or ephemeral (job-scoped namespace)';
