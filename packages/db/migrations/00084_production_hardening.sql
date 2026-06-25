-- Migration: 00084_production_hardening.sql
-- Production Hardening Quick Wins: schema changes for content dedup + dead letter handling

-- Feature 1: Ingest content deduplication
-- ETag-based fingerprint to detect duplicate uploads within a project
ALTER TABLE ingest_records
  ADD COLUMN IF NOT EXISTS content_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_ingest_fingerprint
  ON ingest_records (project_id, content_fingerprint)
  WHERE content_fingerprint IS NOT NULL AND status != 'failed';

-- Feature 2: Dead letter disposition
-- Distinguishes intentional cancellation from exhausted-retry failure
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS failure_disposition TEXT
  CHECK (failure_disposition IN ('cancelled', 'failed', 'upstream_failed'));

-- Backfill: classify existing cancelled jobs by close_reason content
UPDATE jobs
SET failure_disposition = CASE
  WHEN close_reason ILIKE '%failed%' OR close_reason ILIKE '%error%' THEN 'failed'
  WHEN close_reason ILIKE '%upstream%' THEN 'upstream_failed'
  ELSE 'cancelled'
END
WHERE phase = 'cancelled' AND failure_disposition IS NULL;

-- Index for dead letter queries
CREATE INDEX IF NOT EXISTS idx_jobs_dead_letters
  ON jobs (project_id, failure_disposition)
  WHERE phase = 'cancelled' AND failure_disposition = 'failed';
