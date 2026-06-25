-- Add deploy_status column to environments table
-- Tracks the current deployment lifecycle state (independent of environment status like suspended/active)
ALTER TABLE environments ADD COLUMN IF NOT EXISTS deploy_status TEXT NOT NULL DEFAULT 'unknown';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'environments_deploy_status_check'
  ) THEN
    ALTER TABLE environments ADD CONSTRAINT environments_deploy_status_check
      CHECK (deploy_status IN ('unknown', 'deployed', 'undeployed', 'deploying', 'undeploying', 'failed'));
  END IF;
END $$;
