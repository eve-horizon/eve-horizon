-- 00019_add_release_version_tag.sql
-- Add version and tag fields to releases

ALTER TABLE releases
  ADD COLUMN version VARCHAR(64),
  ADD COLUMN tag VARCHAR(128);

CREATE INDEX idx_releases_project_tag ON releases(project_id, tag);
