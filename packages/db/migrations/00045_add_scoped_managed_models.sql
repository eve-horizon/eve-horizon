-- Add managed_models JSONB column to orgs and projects
-- for org/project-scoped managed model registries.
-- Same shape as system_settings["managed_models"]: { [name]: ManagedModelConfig }

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS managed_models JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS managed_models JSONB;
