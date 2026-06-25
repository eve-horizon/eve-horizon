-- 00065_add_inference_target_waking_status.sql
-- Allow inference target status transitions to include 'waking' for wake-on-demand flows.

ALTER TABLE inference_targets
  DROP CONSTRAINT IF EXISTS inference_targets_status_check;

ALTER TABLE inference_targets
  ADD CONSTRAINT inference_targets_status_check
  CHECK (status IN ('unknown', 'healthy', 'unhealthy', 'waking', 'draining', 'disabled'));
