-- Cloud FS Mounts: Maps external cloud storage (Google Drive, Dropbox, etc.) into
-- the org filesystem. Each mount links an integration's credentials to a specific
-- provider folder, with optional change-tracking cursor and webhook watch channel.

CREATE TABLE IF NOT EXISTS cloud_fs_mounts (
  id               TEXT PRIMARY KEY,                              -- cfm_xxx (TypeID)
  org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE,
  integration_id   TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,                                 -- google_drive, dropbox, etc.
  root_folder_id   TEXT NOT NULL,                                 -- provider-specific folder ID
  root_folder_path TEXT,                                          -- human-readable path hint
  mode             TEXT NOT NULL DEFAULT 'read_write'
                   CHECK (mode IN ('read_only', 'write_only', 'read_write')),
  auto_index       BOOLEAN NOT NULL DEFAULT true,
  changes_cursor   TEXT,                                          -- provider change-tracking cursor
  watch_channel_id TEXT,                                          -- webhook channel for push notifications
  watch_expiry     TIMESTAMPTZ,                                   -- when the watch channel expires
  label            TEXT,                                          -- user-friendly display name
  metadata_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, project_id, provider, root_folder_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_fs_mounts_org ON cloud_fs_mounts(org_id);
CREATE INDEX IF NOT EXISTS idx_cloud_fs_mounts_project ON cloud_fs_mounts(project_id);
CREATE INDEX IF NOT EXISTS idx_cloud_fs_mounts_integration ON cloud_fs_mounts(integration_id);
