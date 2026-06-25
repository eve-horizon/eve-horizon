-- Add x_eve_yaml column to project_agent_configs for storing resolved x-eve
-- profiles/config from agent packs. This enables harness profile resolution
-- during chat dispatch without relying on the manifest table.
ALTER TABLE project_agent_configs
  ADD COLUMN IF NOT EXISTS x_eve_yaml TEXT;
