-- 00024_add_system_settings.sql
-- Add system_settings table for admin-configurable runtime settings

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT  -- user or agent identifier
);

-- Insert harness preference (intelligent selection based on credential availability)
INSERT INTO system_settings (key, value, description, updated_by)
VALUES (
  'harness_preference',
  'zai,claude,codex,gemini',
  'Comma-separated harness preference order. First available harness with valid credentials is selected.',
  'system'
)
ON CONFLICT (key) DO NOTHING;
