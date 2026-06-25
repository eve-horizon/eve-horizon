-- 00069_org_fs_index_queue.sql
-- Async queue for indexing org-fs text files into org_documents

CREATE TABLE org_fs_index_queue (
  id           TEXT PRIMARY KEY,               -- queue_xxx TypeID
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  storage_key  TEXT NOT NULL,                  -- S3 object key
  content_hash TEXT NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT 'text/plain',
  attempts     INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,                    -- set during processing
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, path)
);

-- Simple index for polling — query filters locked_until at runtime
CREATE INDEX idx_org_fs_index_queue_created ON org_fs_index_queue(created_at ASC);
CREATE INDEX idx_org_fs_index_queue_locked ON org_fs_index_queue(locked_until)
  WHERE locked_until IS NULL;

-- Add source field to org_documents to track how content arrived
ALTER TABLE org_documents
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'api'
    CHECK (source IN ('api', 'orgfs'));
