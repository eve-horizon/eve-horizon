ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS last_failed_release_id TEXT;

CREATE INDEX IF NOT EXISTS idx_environments_last_failed_release_id
  ON environments(last_failed_release_id);
