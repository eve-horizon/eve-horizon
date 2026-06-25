-- 00035_add_agent_description.sql
-- Add optional agent description for directory listings

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS description TEXT;
