-- Track whether a custom domain row is declarative manifest state or an
-- imperative/manual reservation so project sync can prune only its own rows.

ALTER TABLE custom_domains
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manifest', 'manual'));

CREATE INDEX idx_custom_domains_project_source
  ON custom_domains(project_id, source);
