-- Make a project hard delete (DELETE FROM projects) succeed and remove the
-- rows the project owns in one statement.
--
-- 00081 set ON DELETE SET NULL on two NOT NULL columns (events.project_id,
-- managed_db_snapshots.project_id), so every hard delete of a project with
-- events failed with a not-null violation. Several tables below the cascade
-- also kept NO ACTION references to rows the cascade removes, which would have
-- been the next failures.

-- Project-owned rows: delete them with the project.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_project_id_fkey,
  ADD CONSTRAINT events_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE managed_db_snapshots DROP CONSTRAINT IF EXISTS managed_db_snapshots_project_id_fkey,
  ADD CONSTRAINT managed_db_snapshots_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- A NULL project_id means "org-wide" for webhook subscriptions and "every
-- project" for replays, so SET NULL widened a project-scoped subscription to
-- the whole org. Remove them with the project instead.
ALTER TABLE webhook_subscriptions DROP CONSTRAINT IF EXISTS webhook_subscriptions_project_id_fkey,
  ADD CONSTRAINT webhook_subscriptions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE webhook_replays DROP CONSTRAINT IF EXISTS webhook_replays_project_id_fkey,
  ADD CONSTRAINT webhook_replays_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Children of rows the project cascade already deletes (build_specs and
-- pipeline_step_runs) must follow their parents.
ALTER TABLE build_runs DROP CONSTRAINT IF EXISTS build_runs_build_id_fkey,
  ADD CONSTRAINT build_runs_build_id_fkey
    FOREIGN KEY (build_id) REFERENCES build_specs(id) ON DELETE CASCADE;

ALTER TABLE build_artifacts DROP CONSTRAINT IF EXISTS build_artifacts_build_id_fkey,
  ADD CONSTRAINT build_artifacts_build_id_fkey
    FOREIGN KEY (build_id) REFERENCES build_specs(id) ON DELETE CASCADE;

ALTER TABLE build_logs DROP CONSTRAINT IF EXISTS build_logs_build_run_id_fkey,
  ADD CONSTRAINT build_logs_build_run_id_fkey
    FOREIGN KEY (build_run_id) REFERENCES build_runs(id) ON DELETE CASCADE;

ALTER TABLE execution_logs DROP CONSTRAINT IF EXISTS execution_logs_step_run_id_fkey,
  ADD CONSTRAINT execution_logs_step_run_id_fkey
    FOREIGN KEY (step_run_id) REFERENCES pipeline_step_runs(id) ON DELETE CASCADE;

-- Usage records are billing history and outlive the project (project_id is
-- already SET NULL); do the same for the environment reference.
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_env_id_fkey,
  ADD CONSTRAINT usage_records_env_id_fkey
    FOREIGN KEY (env_id) REFERENCES environments(id) ON DELETE SET NULL;
