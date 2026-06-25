-- 00014_add_events.sql
-- Event-driven architecture: central event log for all triggers

CREATE TABLE events (
  id VARCHAR(50) PRIMARY KEY,              -- evt_xxx (TypeID format)
  project_id VARCHAR(50) NOT NULL REFERENCES projects(id),
  type VARCHAR(100) NOT NULL,              -- e.g., 'github.push', 'cron.tick', 'manual.pipeline.run', 'app.event'
  source VARCHAR(50) NOT NULL,             -- 'github' | 'cron' | 'manual' | 'app' | 'system'
  env_name VARCHAR(100),                   -- Target environment (optional)
  ref_sha VARCHAR(100),                    -- Git SHA (optional)
  ref_branch VARCHAR(255),                 -- Git branch (optional)
  actor_type VARCHAR(50),                  -- 'user' | 'system' | 'app'
  actor_id VARCHAR(50),                    -- User/app ID
  payload_json JSONB,                      -- Event-specific payload
  dedupe_key VARCHAR(255),                 -- For deduplication
  status VARCHAR(20) DEFAULT 'pending',    -- 'pending' | 'processing' | 'completed' | 'failed'
  processed_at TIMESTAMPTZ,                -- When processing completed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX idx_events_project ON events(project_id);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_dedupe ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_events_created ON events(created_at DESC);
CREATE INDEX idx_events_project_status ON events(project_id, status);
