-- org_fs_shares: share tokens for org filesystem files
-- org_fs_public_paths: permanently public path prefixes (no token required)

CREATE TABLE org_fs_shares (
  id            TEXT PRIMARY KEY,               -- share_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  label         TEXT,
  created_by    TEXT NOT NULL,
  expires_at    TIMESTAMPTZ,                    -- NULL = never expires
  accessed_at   TIMESTAMPTZ,
  access_count  INT NOT NULL DEFAULT 0,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_fs_shares_org ON org_fs_shares(org_id);
CREATE INDEX idx_org_fs_shares_active ON org_fs_shares(org_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE org_fs_public_paths (
  id            TEXT PRIMARY KEY,               -- fspub_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path_prefix   TEXT NOT NULL,                  -- '/assets/brand/'
  label         TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, path_prefix)
);

CREATE INDEX idx_org_fs_public_paths_org ON org_fs_public_paths(org_id);
