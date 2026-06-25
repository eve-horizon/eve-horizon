-- Managed DB declarable extensions.
-- desired_extensions stores normalized manifest intent.
-- enabled_extensions stores normalized manifest names successfully ensured in the tenant DB.

ALTER TABLE managed_db_tenants
  ADD COLUMN IF NOT EXISTS desired_extensions TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS enabled_extensions TEXT[] NOT NULL DEFAULT '{}';
