-- 00025_add_environment_labels.sql
-- Add labels (JSONB) and kind (enum) columns to environments table for PR preview support
--
-- PR preview environments will be named `pr-<number>` and have labels:
--   pr_number, pr_branch, pr_sha, pr_url, base_branch, repo

-- ============================================================================
-- ADD LABELS AND KIND COLUMNS
-- ============================================================================

-- Add labels_json column for arbitrary key-value metadata
-- Used by PR preview environments to store PR-specific information
ALTER TABLE environments
ADD COLUMN labels_json JSONB;

-- Add kind column to distinguish standard environments from preview environments
-- 'standard' = regular persistent/temporary environments (staging, production, etc.)
-- 'preview' = PR preview environments (auto-created, auto-destroyed with PR lifecycle)
ALTER TABLE environments
ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';

-- Add constraint to validate kind values
ALTER TABLE environments
ADD CONSTRAINT valid_environment_kind CHECK (kind IN ('standard', 'preview'));

-- Index for finding environments by kind (useful for cleanup operations)
CREATE INDEX idx_environments_kind ON environments(kind);

-- GIN index for efficient label queries (e.g., find all envs for a PR number)
CREATE INDEX idx_environments_labels ON environments USING GIN (labels_json);

-- ============================================================================
-- End of Migration
-- ============================================================================
