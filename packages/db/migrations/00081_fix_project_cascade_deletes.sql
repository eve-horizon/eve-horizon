-- Fix FK cascades for project deletion
-- Tables that should CASCADE (data owned by the project)
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_project_id_fkey,
  ADD CONSTRAINT jobs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_project_id_fkey,
  ADD CONSTRAINT pipeline_runs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE releases DROP CONSTRAINT IF EXISTS releases_project_id_fkey,
  ADD CONSTRAINT releases_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE build_specs DROP CONSTRAINT IF EXISTS build_specs_project_id_fkey,
  ADD CONSTRAINT build_specs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_project_id_fkey,
  ADD CONSTRAINT events_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE managed_db_tenants DROP CONSTRAINT IF EXISTS managed_db_tenants_project_id_fkey,
  ADD CONSTRAINT managed_db_tenants_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ingest_records DROP CONSTRAINT IF EXISTS ingest_records_project_id_fkey,
  ADD CONSTRAINT ingest_records_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Nullable FKs — SET NULL on delete (audit trail / org-scoped records)
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_project_id_fkey,
  ADD CONSTRAINT usage_records_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE org_documents DROP CONSTRAINT IF EXISTS org_documents_project_id_fkey,
  ADD CONSTRAINT org_documents_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE webhook_subscriptions DROP CONSTRAINT IF EXISTS webhook_subscriptions_project_id_fkey,
  ADD CONSTRAINT webhook_subscriptions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE managed_db_snapshots DROP CONSTRAINT IF EXISTS managed_db_snapshots_project_id_fkey,
  ADD CONSTRAINT managed_db_snapshots_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
