-- Migration: Add actor_user_id to jobs table
-- Description: Tracks which user initiated or triggered the job for audit and filtering purposes

-- Add actor_user_id column to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actor_user_id VARCHAR(255);

-- Create index on actor_user_id for efficient querying of jobs by user
CREATE INDEX IF NOT EXISTS idx_jobs_actor_user_id ON jobs(actor_user_id) WHERE actor_user_id IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN jobs.actor_user_id IS 'User ID of the actor who initiated or triggered this job';
