-- Add settings_json column to integrations table.
-- Separates configuration (admin_channel_id, etc.) from auth credentials (tokens_json).
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}'::jsonb;
