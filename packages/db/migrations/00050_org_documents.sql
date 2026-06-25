-- 00050_org_documents.sql
-- Org Document Store: DB-backed knowledge base for org-level context documents
-- (architecture reports, risk assessments, product context, etc.)

CREATE TABLE org_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  project_id    TEXT REFERENCES projects(id),
  path          TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'text/markdown',
  content       TEXT NOT NULL,
  content_hash  TEXT GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB DEFAULT '{}',
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(path, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED,
  UNIQUE(org_id, path)
);

CREATE INDEX idx_org_docs_search ON org_documents USING GIN(search_vector);
CREATE INDEX idx_org_docs_project ON org_documents(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_org_docs_metadata ON org_documents USING GIN(metadata);
CREATE INDEX idx_org_docs_org_path ON org_documents(org_id, path);
