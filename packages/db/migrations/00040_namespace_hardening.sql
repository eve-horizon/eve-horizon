-- 00040_namespace_hardening.sql
-- Phase 10: Namespace Hardening + Phase 11 environment status columns
-- Adds environment status tracking for suspension/termination lifecycle.

ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- status: 'active' | 'suspended' | 'terminated'
-- Combining Phase 10 (namespace hardening) and Phase 11 (environment suspension)
-- status columns here avoids a separate 00041 migration.

-- Index for listing active environments efficiently
CREATE INDEX IF NOT EXISTS idx_environments_status ON environments(status);

-- Partial index for quickly finding suspended environments
CREATE INDEX IF NOT EXISTS idx_environments_suspended ON environments(status)
  WHERE status = 'suspended';
