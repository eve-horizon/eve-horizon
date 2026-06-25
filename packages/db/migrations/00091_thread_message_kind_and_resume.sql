-- Thread message kinds and id-based SSE resume.
--
-- Progress updates are persisted as first-class thread messages so clients can
-- distinguish transient progress from final chat messages without parsing text.
-- The final-result idempotency guard remains scoped to normal message rows.

ALTER TABLE thread_messages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message'
  CHECK (kind IN ('message', 'progress'));

UPDATE thread_messages
SET kind = 'message'
WHERE kind IS NULL;

DROP INDEX IF EXISTS idx_thread_messages_job_outbound_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_job_outbound_unique
  ON thread_messages(job_id)
  WHERE direction = 'outbound'
    AND kind = 'message'
    AND job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created_id
  ON thread_messages(thread_id, created_at, id);
