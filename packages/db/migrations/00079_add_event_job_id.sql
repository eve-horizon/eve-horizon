-- Add job_id column to events table for event→job linkage.
-- When the orchestrator processes an event and creates a workflow/pipeline job,
-- the job_id is written back so callers can poll the event to discover the job.

ALTER TABLE events ADD COLUMN IF NOT EXISTS job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_job_id ON events(job_id) WHERE job_id IS NOT NULL;
