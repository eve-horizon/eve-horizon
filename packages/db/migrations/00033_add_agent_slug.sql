-- 00033_add_agent_slug.sql
-- Add optional agent slug for org-wide addressing

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_project_slug
  ON agents(project_id, slug)
  WHERE slug IS NOT NULL;
