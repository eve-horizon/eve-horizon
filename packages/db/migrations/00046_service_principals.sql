-- 00046_service_principals.sql
-- Service principals (machine identity) and scoped tokens for app backends

-- ============================================================================
-- SERVICE PRINCIPALS
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_principals (
  id            TEXT PRIMARY KEY,  -- sp_xxx (TypeID format)
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_service_principals_org ON service_principals(org_id);

-- ============================================================================
-- SERVICE PRINCIPAL TOKENS
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_principal_tokens (
  id              TEXT PRIMARY KEY,  -- spt_xxx (TypeID format)
  principal_id    TEXT NOT NULL REFERENCES service_principals(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  scopes          TEXT[] NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_principal_tokens_principal ON service_principal_tokens(principal_id);
CREATE INDEX IF NOT EXISTS idx_service_principal_tokens_hash ON service_principal_tokens(token_hash);
