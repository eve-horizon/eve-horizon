-- 00068_org_fs_events_storage_key.sql
-- Add optional storage_key column to org_fs_events.
-- Present for file.created / file.updated events when using S3-backed transfer mode.

ALTER TABLE org_fs_events
  ADD COLUMN IF NOT EXISTS storage_key TEXT;
