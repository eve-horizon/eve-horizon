-- 00031_add_chat_integrations.sql
-- Chat gateway integrations, external identities, and membership requests

-- ============================================================================
-- INTEGRATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tokens_json JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, account_id)
);

CREATE INDEX IF NOT EXISTS idx_integrations_org_id ON integrations(org_id);

-- ============================================================================
-- EXTERNAL IDENTITIES
-- ============================================================================

CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  eve_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, account_id, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_external_identities_account
  ON external_identities(provider, account_id);
CREATE INDEX IF NOT EXISTS idx_external_identities_user
  ON external_identities(eve_user_id);

-- ============================================================================
-- MEMBERSHIP REQUESTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS membership_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  external_identity_id TEXT NOT NULL REFERENCES external_identities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_membership_request_status CHECK (status IN ('pending', 'approved', 'denied'))
);

CREATE INDEX IF NOT EXISTS idx_membership_requests_org_id ON membership_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_membership_requests_identity ON membership_requests(external_identity_id);
CREATE INDEX IF NOT EXISTS idx_membership_requests_status ON membership_requests(status);
