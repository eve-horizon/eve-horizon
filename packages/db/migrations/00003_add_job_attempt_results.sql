-- Migration: Add result columns to job_attempts
--
-- These columns capture the outcome of each job attempt execution,
-- including process exit status, output content, performance metrics,
-- and error information for failed attempts.

ALTER TABLE job_attempts
  ADD COLUMN exit_code      SMALLINT,
  ADD COLUMN result_text    TEXT,
  ADD COLUMN result_json    JSONB,
  ADD COLUMN duration_ms    INTEGER,
  ADD COLUMN token_input    INTEGER,
  ADD COLUMN token_output   INTEGER,
  ADD COLUMN error_message  TEXT;

COMMENT ON COLUMN job_attempts.exit_code IS 'Harness process exit code';
COMMENT ON COLUMN job_attempts.result_text IS 'Final assistant message text';
COMMENT ON COLUMN job_attempts.result_json IS 'Structured JSON output if harness provides it';
COMMENT ON COLUMN job_attempts.duration_ms IS 'Total execution time in milliseconds';
COMMENT ON COLUMN job_attempts.token_input IS 'Total input tokens used';
COMMENT ON COLUMN job_attempts.token_output IS 'Total output tokens generated';
COMMENT ON COLUMN job_attempts.error_message IS 'Error message if job failed';
