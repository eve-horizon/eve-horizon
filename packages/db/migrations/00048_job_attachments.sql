-- Job attachments: structured documents attached to jobs by agents
CREATE TABLE job_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'text/plain',
  content       TEXT NOT NULL,
  content_hash  TEXT GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(job_id, name)
);

CREATE INDEX idx_job_attachments_job ON job_attachments(job_id);
