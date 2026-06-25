-- 00059_org_fs_sync.sql
-- Org filesystem sync control-plane and durable event log.

CREATE TABLE org_sync_devices (
  id              TEXT PRIMARY KEY, -- fsdev_xxx
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_name     TEXT NOT NULL,
  platform        TEXT,
  client_version  TEXT,
  public_key      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_seen_at    TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, public_key)
);

CREATE INDEX idx_org_sync_devices_org ON org_sync_devices(org_id);
CREATE INDEX idx_org_sync_devices_org_status ON org_sync_devices(org_id, status);

CREATE TABLE org_sync_enrollment_tokens (
  token         TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL REFERENCES org_sync_devices(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_sync_enrollment_org_device ON org_sync_enrollment_tokens(org_id, device_id);
CREATE INDEX idx_org_sync_enrollment_expires ON org_sync_enrollment_tokens(expires_at);

CREATE TABLE org_sync_links (
  id                TEXT PRIMARY KEY, -- fslk_xxx
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_id         TEXT NOT NULL REFERENCES org_sync_devices(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL CHECK (mode IN ('two_way', 'push_only', 'pull_only')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  local_path        TEXT NOT NULL,
  remote_path       TEXT NOT NULL DEFAULT '/' CHECK (remote_path LIKE '/%'),
  includes_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  excludes_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_cursor       BIGINT NOT NULL DEFAULT 0,
  backlog           INTEGER NOT NULL DEFAULT 0,
  lag_ms            INTEGER,
  metrics_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at    TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, device_id, remote_path)
);

CREATE INDEX idx_org_sync_links_org ON org_sync_links(org_id);
CREATE INDEX idx_org_sync_links_org_status ON org_sync_links(org_id, status);
CREATE INDEX idx_org_sync_links_device ON org_sync_links(device_id);

CREATE TABLE org_fs_events (
  seq             BIGSERIAL PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE, -- fsev_xxx
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  link_id         TEXT REFERENCES org_sync_links(id) ON DELETE SET NULL,
  device_id       TEXT REFERENCES org_sync_devices(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  path            TEXT NOT NULL CHECK (path LIKE '/%'),
  content_hash    TEXT,
  size_bytes      BIGINT,
  source_side     TEXT NOT NULL CHECK (source_side IN ('local', 'remote', 'system')),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_fs_events_org_seq ON org_fs_events(org_id, seq);
CREATE INDEX idx_org_fs_events_org_created ON org_fs_events(org_id, created_at DESC);
CREATE INDEX idx_org_fs_events_org_path ON org_fs_events(org_id, path);
CREATE INDEX idx_org_fs_events_type ON org_fs_events(event_type);

CREATE TABLE org_fs_conflicts (
  id            TEXT PRIMARY KEY, -- fscf_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  link_id       TEXT REFERENCES org_sync_links(id) ON DELETE SET NULL,
  path          TEXT NOT NULL CHECK (path LIKE '/%'),
  local_hash    TEXT,
  remote_hash   TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution    TEXT CHECK (resolution IN ('pick_local', 'pick_remote', 'manual')),
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_fs_conflicts_org_status ON org_fs_conflicts(org_id, status);
CREATE INDEX idx_org_fs_conflicts_org_path ON org_fs_conflicts(org_id, path);
