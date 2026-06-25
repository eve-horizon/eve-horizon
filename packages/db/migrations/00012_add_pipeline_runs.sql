-- ============================================================================
-- Pipeline runs and step runs
-- ============================================================================

CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  pipeline_name TEXT NOT NULL,
  env_name TEXT,
  git_sha TEXT,
  manifest_hash TEXT,
  inputs_json JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  requested_by TEXT,
  run_mode TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_pipeline_runs_project ON pipeline_runs(project_id, pipeline_name, created_at DESC);

CREATE TABLE pipeline_step_runs (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  logs_ref TEXT,
  input_json JSONB,
  output_json JSONB,
  result_text TEXT,
  result_json JSONB,
  exit_code INTEGER,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_pipeline_step_runs_run ON pipeline_step_runs(pipeline_run_id, step_index);

-- Extend execution logs to support pipeline step logs
ALTER TABLE execution_logs ADD COLUMN step_run_id TEXT REFERENCES pipeline_step_runs(id);
ALTER TABLE execution_logs ALTER COLUMN attempt_id DROP NOT NULL;
CREATE INDEX idx_execution_logs_step_run ON execution_logs(step_run_id, seq);
