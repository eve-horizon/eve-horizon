-- 00057_add_inference_foundation.sql
-- Foundation tables for managed/pooled inference (Phase 1 of Ollama managed-models migration).

CREATE TABLE IF NOT EXISTS inference_targets (
  id TEXT PRIMARY KEY, -- inference_tgt_xxx (platform-generated)
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('platform', 'org', 'project')),
  scope_id TEXT, -- NULL for platform scope
  name TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('ollama_pool', 'external_ollama', 'openai_compat')),
  transport_profile TEXT NOT NULL DEFAULT 'ollama_api',
  base_url TEXT NOT NULL,
  health_probe_url TEXT,
  capacity INTEGER NOT NULL DEFAULT 1,
  max_concurrent_inflight INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'healthy', 'unhealthy', 'draining', 'disabled')),
  transport_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inference_targets_scope_name
  ON inference_targets (scope_kind, COALESCE(scope_id, ''), name);

CREATE INDEX IF NOT EXISTS idx_inference_targets_scope
  ON inference_targets (scope_kind, scope_id);

CREATE INDEX IF NOT EXISTS idx_inference_targets_status
  ON inference_targets (status);

CREATE TABLE IF NOT EXISTS inference_models (
  id TEXT PRIMARY KEY, -- inference_model_xxx (platform-generated)
  canonical_model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_model_slug TEXT NOT NULL,
  max_context INTEGER,
  supports_json_schema BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (canonical_model_id),
  UNIQUE (provider, provider_model_slug)
);

CREATE TABLE IF NOT EXISTS inference_aliases (
  id TEXT PRIMARY KEY, -- inference_alias_xxx (platform-generated)
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('platform', 'org', 'project')),
  scope_id TEXT, -- NULL for platform scope
  alias TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES inference_targets(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL REFERENCES inference_models(id) ON DELETE RESTRICT,
  pin_model_id TEXT,
  pinned_at TIMESTAMPTZ,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inference_aliases_scope_alias
  ON inference_aliases (scope_kind, COALESCE(scope_id, ''), alias);

CREATE INDEX IF NOT EXISTS idx_inference_aliases_scope
  ON inference_aliases (scope_kind, COALESCE(scope_id, ''));

CREATE INDEX IF NOT EXISTS idx_inference_aliases_target
  ON inference_aliases (target_id);

CREATE INDEX IF NOT EXISTS idx_inference_aliases_model
  ON inference_aliases (model_id);

CREATE TABLE IF NOT EXISTS inference_installs (
  id TEXT PRIMARY KEY, -- inference_install_xxx (platform-generated)
  target_id TEXT NOT NULL REFERENCES inference_targets(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES inference_models(id) ON DELETE CASCADE,
  requires_warm_start BOOLEAN NOT NULL DEFAULT FALSE,
  min_target_capacity INTEGER NOT NULL DEFAULT 1,
  allowed_scopes JSONB NOT NULL DEFAULT '{}'::jsonb,
  route_hints JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, model_id)
);

CREATE TABLE IF NOT EXISTS inference_quotas (
  id TEXT PRIMARY KEY, -- inference_quota_xxx (platform-generated)
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('platform', 'org', 'project')),
  scope_id TEXT, -- NULL for platform scope
  target_id TEXT NOT NULL REFERENCES inference_targets(id) ON DELETE CASCADE,
  max_inflight INTEGER NOT NULL DEFAULT 1,
  max_tokens_per_hour BIGINT NOT NULL DEFAULT 0,
  max_requests_per_hour INTEGER NOT NULL DEFAULT 0,
  wfq_weight INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inference_quotas_scope_target
  ON inference_quotas (scope_kind, COALESCE(scope_id, ''), target_id);

CREATE INDEX IF NOT EXISTS idx_inference_quotas_scope
  ON inference_quotas (scope_kind, COALESCE(scope_id, ''));

CREATE INDEX IF NOT EXISTS idx_inference_quotas_target
  ON inference_quotas (target_id);
