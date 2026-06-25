-- 00058_add_inference_route_policies.sql
-- Per-scope preferred target policy for inference routing.

CREATE TABLE IF NOT EXISTS inference_route_policies (
  id TEXT PRIMARY KEY, -- inference_route_policy_xxx
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('platform', 'org', 'project')),
  scope_id TEXT, -- NULL for platform scope
  preferred_target_id TEXT NOT NULL REFERENCES inference_targets(id) ON DELETE RESTRICT,
  fallback_to_alias_target BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inference_route_policies_scope
  ON inference_route_policies (scope_kind, COALESCE(scope_id, ''));

CREATE INDEX IF NOT EXISTS idx_inference_route_policies_target
  ON inference_route_policies (preferred_target_id);
