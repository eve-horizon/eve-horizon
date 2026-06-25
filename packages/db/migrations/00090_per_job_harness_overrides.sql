-- Per-job harness profile and env overrides
-- See docs/plans/per-job-harness-override-plan.md

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS harness_profile_override JSONB,
  ADD COLUMN IF NOT EXISTS env_overrides JSONB,
  ADD COLUMN IF NOT EXISTS harness_profile_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS harness_profile_hash VARCHAR(64);

ALTER TABLE job_attempts
  ADD COLUMN IF NOT EXISTS harness_profile_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS harness_profile_hash VARCHAR(64);

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_harness_profile_source_chk;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_harness_profile_source_chk CHECK (
    harness_profile_source IS NULL
    OR harness_profile_source IN ('agent_default','string_ref','inline_override','workflow_template')
  );

ALTER TABLE job_attempts
  DROP CONSTRAINT IF EXISTS job_attempts_harness_profile_source_chk;
ALTER TABLE job_attempts
  ADD CONSTRAINT job_attempts_harness_profile_source_chk CHECK (
    harness_profile_source IS NULL
    OR harness_profile_source IN ('agent_default','string_ref','inline_override','workflow_template')
  );

COMMENT ON COLUMN jobs.harness_profile_override IS 'Inline profile bundle from job request (raw, pre-projection)';
COMMENT ON COLUMN jobs.env_overrides IS 'Env overrides with ${secret.KEY} placeholders intact; resolved at spawn time';
COMMENT ON COLUMN jobs.harness_profile_source IS 'Provenance: agent_default|string_ref|inline_override|workflow_template';
COMMENT ON COLUMN jobs.harness_profile_hash IS 'Stable hash over normalized profile + env override keys + placeholders (no plaintext secrets)';
COMMENT ON COLUMN job_attempts.harness_profile_source IS 'Snapshot of jobs.harness_profile_source at attempt start';
COMMENT ON COLUMN job_attempts.harness_profile_hash IS 'Snapshot of jobs.harness_profile_hash at attempt start';
