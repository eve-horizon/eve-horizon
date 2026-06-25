-- 00043_access_requests.sql
-- Self-service access requests: agents submit pubkey + desired org, admin approves

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,                          -- areq_xxx (TypeID)
  provider TEXT NOT NULL,                       -- 'github_ssh' | 'nostr'
  public_key TEXT NOT NULL,                     -- full public key text
  fingerprint TEXT NOT NULL,                    -- SSH fingerprint or nostr hex pubkey
  email TEXT,                                   -- optional contact email
  desired_org_name TEXT NOT NULL,               -- "Acme Corp"
  desired_org_slug TEXT,                        -- "acme" (auto-derived if omitted)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  -- populated on approval
  user_id TEXT REFERENCES users(id),
  org_id TEXT REFERENCES orgs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One pending request per fingerprint
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_pending_fingerprint
  ON access_requests (fingerprint) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_access_requests_status
  ON access_requests (status);
