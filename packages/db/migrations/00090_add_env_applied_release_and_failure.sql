-- Phase 4 of deploy-error-surfacing-plan: close the silent-drift hole.
--
-- Previously, when applyManifest succeeded but a later step failed,
-- environments.current_release_id remained the last successful release while
-- the cluster had already moved to the failed release. Operators could not
-- tell from the CLI that the DB state and live cluster had diverged.
--
-- Two new columns:
--   last_applied_release_id  — the release the cluster is currently running
--                              (always mirrors the most recent applyManifest
--                              call, regardless of success/failure)
--   last_deploy_failure_json — structured context about the last failed deploy
--                              (DeployFailure kind, affected service/pod,
--                              message, timestamp, namespace)
--
-- current_release_id continues to mean "last ready / rollback base" — we do
-- NOT advance it on partial failures. This preserves existing rollback/reset
-- semantics while making the applied-but-unhealthy state explicit.
ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS last_applied_release_id TEXT,
  ADD COLUMN IF NOT EXISTS last_deploy_failure_json JSONB;
