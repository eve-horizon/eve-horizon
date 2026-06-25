-- Store app-scoped auth policy parsed from .eve/manifest.yaml x-eve.auth.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS auth_config JSONB;
