-- 00006_add_job_gates.sql
-- Add job_gates table for atomic concurrency control

-- ============================================================================
-- JOB GATES (Atomic Locks with TTL)
-- ============================================================================
-- Single primitive for all concurrency control.
-- Usage: acquire via INSERT ... ON CONFLICT DO NOTHING
-- If any gate is held, job remains 'ready' with blocked_on_gates info.

CREATE TABLE job_gates (
  gate_key TEXT PRIMARY KEY,                          -- e.g., 'env:staging', 'project:myproj'
  job_id VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_expires_at TIMESTAMPTZ NOT NULL,

  -- Metadata for debugging/monitoring
  context JSONB DEFAULT '{}'                          -- optional: reason, requester, etc.
);

-- Index for finding expired gates (for cleanup)
CREATE INDEX idx_job_gates_expires ON job_gates(ttl_expires_at);

-- Index for finding gates held by a job
CREATE INDEX idx_job_gates_job ON job_gates(job_id);

-- ============================================================================
-- Add blocked_on_gates column to jobs table
-- ============================================================================
-- Array of gate keys that this job is waiting to acquire
-- Populated when a job cannot proceed due to locked gates

ALTER TABLE jobs ADD COLUMN blocked_on_gates TEXT[] DEFAULT '{}';

-- ============================================================================
-- End of Migration
-- ============================================================================
