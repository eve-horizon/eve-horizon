-- Migration: Extend project_api_sources table with additional fields
--
-- This migration adds:
-- - component_name: identifies which component this API source belongs to
-- - internal_base_url: the internal/private URL for the API (if different from public base_url)
-- - spec_source: tracks whether the spec came from 'url', 'file', or 'inline'

ALTER TABLE project_api_sources ADD COLUMN IF NOT EXISTS component_name TEXT;
ALTER TABLE project_api_sources ADD COLUMN IF NOT EXISTS internal_base_url TEXT;
ALTER TABLE project_api_sources ADD COLUMN IF NOT EXISTS spec_source TEXT DEFAULT 'url';

-- Add constraint to validate spec_source values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'valid_spec_source'
  ) THEN
    ALTER TABLE project_api_sources ADD CONSTRAINT valid_spec_source
      CHECK (spec_source IN ('url', 'file', 'inline'));
  END IF;
END $$;

COMMENT ON COLUMN project_api_sources.component_name IS 'Component identifier this API source belongs to';
COMMENT ON COLUMN project_api_sources.internal_base_url IS 'Internal/private base URL for the API (if different from public base_url)';
COMMENT ON COLUMN project_api_sources.spec_source IS 'Source of the API spec: url (fetched from URL), file (loaded from file), or inline (provided directly)';
