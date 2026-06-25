-- Migration: Add scheduling hints to jobs
--
-- The hints column stores optional scheduling preferences that the scheduler
-- uses when claiming jobs. These are "hints" not requirements - the scheduler
-- may override based on availability or policy.
--
-- Example hints:
-- {
--   "harness": "mclaude:fast",        -- preferred harness (with optional :variant)
--   "worker_type": "default",         -- worker type preference
--   "permission_policy": "auto_edit", -- permission policy for execution
--   "timeout_seconds": 3600           -- execution timeout
-- }

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hints JSONB DEFAULT '{}';

-- Index for querying jobs by specific hints (e.g., find all jobs wanting gpu workers)
CREATE INDEX IF NOT EXISTS idx_jobs_hints ON jobs USING gin(hints);

COMMENT ON COLUMN jobs.hints IS 'Scheduling hints: harness, worker_type, permission_policy, timeout_seconds';
