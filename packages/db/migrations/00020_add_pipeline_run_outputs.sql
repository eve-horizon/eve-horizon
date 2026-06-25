-- 00020_add_pipeline_run_outputs.sql
-- Store step outputs for pipeline runs (job graph mode)

ALTER TABLE pipeline_runs
  ADD COLUMN step_outputs_json JSONB;

CREATE INDEX idx_pipeline_runs_step_outputs ON pipeline_runs USING GIN (step_outputs_json);
