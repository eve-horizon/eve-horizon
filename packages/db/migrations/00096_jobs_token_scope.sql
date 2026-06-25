-- Per-job token scope claim.
-- NULL means no narrowing: legacy job tokens keep permission-name-only behavior.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS token_scope JSONB;

COMMENT ON COLUMN jobs.token_scope IS 'Per-job token scope claim; null = no narrowing (legacy behavior)';
