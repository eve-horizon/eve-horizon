-- Add parsed_agents to project manifests

ALTER TABLE project_manifests
  ADD COLUMN IF NOT EXISTS parsed_agents JSONB;

COMMENT ON COLUMN project_manifests.parsed_agents IS 'Parsed x-eve.agents policy from manifest';
