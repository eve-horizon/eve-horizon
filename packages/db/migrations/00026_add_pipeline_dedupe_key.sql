-- ============================================================================
-- Add dedupe_key to pipeline_runs for deduplication
-- ============================================================================

-- Add dedupe_key column (nullable to support existing runs without dedupe keys)
ALTER TABLE pipeline_runs ADD COLUMN dedupe_key TEXT;

-- Create unique index to enforce deduplication for non-terminal runs
-- This prevents duplicate pipeline runs with the same dedupe_key in pending/running state
CREATE UNIQUE INDEX idx_pipeline_runs_dedupe_active
  ON pipeline_runs(dedupe_key)
  WHERE dedupe_key IS NOT NULL
    AND status NOT IN ('succeeded', 'failed', 'cancelled');

-- Create general index for lookup performance
CREATE INDEX idx_pipeline_runs_dedupe ON pipeline_runs(dedupe_key) WHERE dedupe_key IS NOT NULL;
