-- 00067_org_fs_objects.sql
-- Tracks current content state of org filesystem paths (one row per path,
-- upserted on every upload). Gives a queryable snapshot without walking S3.

CREATE TABLE org_fs_objects (
  id            TEXT PRIMARY KEY,               -- fsobj_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  storage_key   TEXT NOT NULL,                  -- S3 object key within the org bucket
  content_hash  TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  deleted_at    TIMESTAMPTZ,                    -- soft delete
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, path)
);

CREATE INDEX idx_org_fs_objects_org ON org_fs_objects(org_id);
CREATE INDEX idx_org_fs_objects_org_prefix ON org_fs_objects(org_id, path text_pattern_ops);
CREATE INDEX idx_org_fs_objects_active ON org_fs_objects(org_id, updated_at DESC)
  WHERE deleted_at IS NULL;
