ALTER TABLE agents ADD COLUMN IF NOT EXISTS alias TEXT;

-- Project-scoped uniqueness (DB safety net; org-scoped checks happen during sync)
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_project_alias
  ON agents(project_id, alias) WHERE alias IS NOT NULL;

-- Fast lookup for chat routing (joined with projects for org scoping)
CREATE INDEX IF NOT EXISTS idx_agents_alias
  ON agents(alias) WHERE alias IS NOT NULL;
