-- Per-job token permission list (mirrors token_scope shape).
-- NULL means no per-job override: executors fall back to their default
-- permission set (DEFAULT_AGENT_PERMISSIONS / DEFAULT_SCRIPT_JOB_PERMISSIONS /
-- DEFAULT_ACTION_RUN_JOB_PERMISSIONS).

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS token_permissions TEXT[];

COMMENT ON COLUMN jobs.token_permissions IS 'Per-job token permission list; null = use executor default';
