-- 00037_receipts_foundation.sql
-- Receipt foundation for resource management + cost tracking (v2)

-- Jobs: track the last time a job entered the ready phase (for queue wait receipts)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;

-- Attempts: track when execution actually started (vs claim time), and store receipts
ALTER TABLE job_attempts
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receipt_json JSONB,
  ADD COLUMN IF NOT EXISTS receipt_base_total_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS receipt_billed_total NUMERIC,
  ADD COLUMN IF NOT EXISTS receipt_billed_currency TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_ready_at ON jobs(ready_at);
CREATE INDEX IF NOT EXISTS idx_job_attempts_receipt_currency ON job_attempts(receipt_billed_currency);
CREATE INDEX IF NOT EXISTS idx_job_attempts_receipt_billed_total ON job_attempts(receipt_billed_total);

-- Backfill: jobs created in ready phase should have ready_at for queue wait computation.
UPDATE jobs
SET ready_at = created_at
WHERE phase = 'ready' AND ready_at IS NULL;

