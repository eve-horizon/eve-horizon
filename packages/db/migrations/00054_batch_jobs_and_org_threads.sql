-- Batch jobs: atomic batch job creation with idempotency
CREATE TABLE batch_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key TEXT,
  node_count INT NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, idempotency_key)
);

CREATE INDEX idx_batch_jobs_project ON batch_jobs(project_id);

-- Link jobs to their parent batch
ALTER TABLE jobs ADD COLUMN batch_id UUID REFERENCES batch_jobs(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN batch_key TEXT;

-- Org-scoped threads: add org_id and scope columns
ALTER TABLE threads ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE threads ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'
  CHECK (scope IN ('project', 'org'));

CREATE INDEX idx_threads_org ON threads(org_id) WHERE scope = 'org';

-- Allow project_id to be NULL for org-scoped threads
ALTER TABLE threads ALTER COLUMN project_id DROP NOT NULL;

-- Replace the old unique index with scope-aware partial indexes
DROP INDEX IF EXISTS idx_threads_project_key;
CREATE UNIQUE INDEX idx_threads_project_key ON threads(project_id, key) WHERE scope = 'project';
CREATE UNIQUE INDEX idx_threads_org_key ON threads(org_id, key) WHERE scope = 'org';
