-- Document ingestion records: immutable audit trail for file ingestion
-- One row per ingestion. Most fields are immutable after creation.
-- Status updates allowed only for lifecycle fields.

CREATE TABLE IF NOT EXISTS ingest_records (
  id              TEXT PRIMARY KEY,        -- TypeID: ing_xxx
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- File metadata
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  storage_key     TEXT NOT NULL,           -- S3 key: ingest/{id}/{file_name}

  -- Audit: who submitted, from where
  actor_type      TEXT NOT NULL,           -- 'user' | 'service_principal' | 'agent'
  actor_id        TEXT,                    -- nullable for anonymous/system
  source_channel  TEXT NOT NULL DEFAULT 'upload',  -- 'upload' | 'cli' | 'slack' | 'api'

  -- User-supplied context (travels with the file to the agent)
  title           TEXT,                    -- display name (defaults to file_name)
  description     TEXT,                    -- what the file is ("Q4 board deck")
  instructions    TEXT,                    -- how to process ("extract action items")
  tags            TEXT[],                  -- initial tags
  callback_url    TEXT,                    -- optional callback target for status updates

  -- Processing state
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error_message   TEXT,                    -- failure details (if failed)
  event_id        TEXT,                    -- the system.doc.ingest event that was fired
  job_id          TEXT,                    -- the workflow job that processed this

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingest_records_org ON ingest_records(org_id);
CREATE INDEX IF NOT EXISTS idx_ingest_records_project ON ingest_records(project_id);
CREATE INDEX IF NOT EXISTS idx_ingest_records_status ON ingest_records(status);
CREATE INDEX IF NOT EXISTS idx_ingest_records_project_status ON ingest_records(project_id, status);
