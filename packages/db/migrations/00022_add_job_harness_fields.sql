-- Add top-level harness fields to jobs

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS harness VARCHAR(50);

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS harness_profile VARCHAR(100);

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS harness_options JSONB;

COMMENT ON COLUMN jobs.harness IS 'Preferred harness for job execution';
COMMENT ON COLUMN jobs.harness_profile IS 'Agent profile name for orchestration';
COMMENT ON COLUMN jobs.harness_options IS 'Harness options (variant, model, reasoning)';
