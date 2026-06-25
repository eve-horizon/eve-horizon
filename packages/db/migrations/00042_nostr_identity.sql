-- 00042_nostr_identity.sql
-- Nostr identity support, replay protection, and invite-gated provisioning

-- ============================================================================
-- AUTH CHALLENGES: add provider + metadata, allow null user_id
-- ============================================================================

ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'github_ssh';

ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Allow null user_id for Nostr challenges where the user doesn't exist yet
-- Existing SSH challenges always have user_id set
ALTER TABLE auth_challenges
  ALTER COLUMN user_id DROP NOT NULL;

-- ============================================================================
-- REPLAY PROTECTION for request-level auth (NIP-98 event.id dedup)
-- ============================================================================

CREATE TABLE IF NOT EXISTS auth_request_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  replay_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, replay_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_request_replays_expires_at
  ON auth_request_replays(expires_at);

-- ============================================================================
-- ORG INVITES for gated provisioning
-- ============================================================================

CREATE TABLE IF NOT EXISTS org_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  provider_hint TEXT,
  identity_hint TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invites(org_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_code ON org_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_org_invites_identity_hint
  ON org_invites(provider_hint, identity_hint) WHERE identity_hint IS NOT NULL AND used_at IS NULL;
