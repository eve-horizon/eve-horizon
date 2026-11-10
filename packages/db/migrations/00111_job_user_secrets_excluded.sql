-- Migration: mark jobs that must not resolve the actor's user-scope secrets
-- Description: Work started with an org-bound user token (a bot), or by a job
-- token for such work, records the bot as its actor but must never resolve the
-- account's user-scope secrets, even if a person later adopts the account. The
-- API sets this column; clients never do.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS user_secrets_excluded BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN jobs.user_secrets_excluded IS 'When true, the job never resolves its actor''s user-scope secrets (set by the API for work started with an org-bound token)';
