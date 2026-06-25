-- 00063_agent_memory_platform.sql
-- Agent memory platform foundations:
--   - agent KV store with TTL
--   - org document lifecycle fields
--   - search indexes for thread messages and job attachments
--   - optional embedding metadata columns (model-bound)

CREATE TABLE IF NOT EXISTS agent_kv (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_slug TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  ttl_seconds INTEGER,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, agent_slug, namespace, key)
);

-- The UNIQUE constraint on (org_id, agent_slug, namespace, key) already creates
-- a btree index, so no separate lookup index is needed.

CREATE INDEX IF NOT EXISTS idx_agent_kv_expiry
  ON agent_kv(expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE org_documents
  ADD COLUMN IF NOT EXISTS review_due TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'stale', 'archived', 'expired')),
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS embedding_json JSONB,
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_org_docs_review_due
  ON org_documents(review_due)
  WHERE review_due IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_org_docs_expires
  ON org_documents(expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE thread_messages
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_thread_messages_search
  ON thread_messages USING GIN(search_vector);

ALTER TABLE job_attachments
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_job_attachments_search
  ON job_attachments USING GIN(search_vector);
