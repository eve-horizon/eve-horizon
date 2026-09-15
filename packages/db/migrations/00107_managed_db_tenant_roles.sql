-- Migration: managed_db_tenant_roles
-- Created: 2026-09-15

-- Declarable managed DB tenant roles (least-privilege runtime logins).
-- desired_roles stores normalized manifest intent: [{ "name": ..., "grants": "readwrite" | "readonly" }].
-- Existing tenants default to no declared roles and keep their single owner credential.

ALTER TABLE managed_db_tenants
  ADD COLUMN IF NOT EXISTS desired_roles JSONB NOT NULL DEFAULT '[]'::jsonb;

-- One row per provisioned role. Credentials are stored the same way as
-- managed_db_tenants.credential_secret_ref (connection URL for the role login).
CREATE TABLE IF NOT EXISTS managed_db_tenant_roles (
  id                    TEXT PRIMARY KEY,                    -- mdbr_xxx (TypeID)
  tenant_id             TEXT NOT NULL REFERENCES managed_db_tenants(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,                       -- manifest role name
  grants                TEXT NOT NULL,                       -- readwrite | readonly
  db_user               TEXT NOT NULL,                       -- <tenant db_user>-<name>, 63-char safe
  credential_secret_ref TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT managed_db_tenant_roles_valid_grants CHECK (grants IN ('readwrite', 'readonly')),
  UNIQUE(tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_managed_db_tenant_roles_tenant ON managed_db_tenant_roles(tenant_id);
