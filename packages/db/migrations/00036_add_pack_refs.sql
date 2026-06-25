-- Add pack_refs column to project_agent_configs for AgentPack provenance tracking.
-- Stores an array of {id, source, ref} objects from resolved packs.
ALTER TABLE project_agent_configs
  ADD COLUMN pack_refs JSONB DEFAULT NULL;
