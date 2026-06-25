-- 00052_org_document_versions.sql
-- Org document version history and mutation provenance

CREATE TABLE org_document_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        UUID NOT NULL REFERENCES org_documents(id) ON DELETE CASCADE,
  version       INT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED,
  metadata      JSONB DEFAULT '{}',
  created_by    TEXT,
  mutation_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(doc_id, version)
);

CREATE INDEX idx_doc_versions_doc ON org_document_versions(doc_id, version DESC);
