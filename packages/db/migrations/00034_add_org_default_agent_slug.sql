-- 00034_add_org_default_agent_slug.sql
-- Add default agent slug per org

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS default_agent_slug TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'valid_org_default_agent_slug'
      AND conrelid = 'orgs'::regclass
  ) THEN
    ALTER TABLE orgs
      ADD CONSTRAINT valid_org_default_agent_slug
      CHECK (default_agent_slug IS NULL OR default_agent_slug ~ '^[a-z0-9][a-z0-9-]*$');
  END IF;
END $$;
