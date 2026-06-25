-- Job targeting: intent-level routing and resource references
ALTER TABLE jobs ADD COLUMN target JSONB;
ALTER TABLE jobs ADD COLUMN resource_refs JSONB DEFAULT '[]';

COMMENT ON COLUMN jobs.target IS 'Intent-level routing: agent_slug, team, or workflow';
COMMENT ON COLUMN jobs.resource_refs IS 'References to attachments or org docs available to the executing agent';
