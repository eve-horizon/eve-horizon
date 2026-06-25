-- 00004_add_secrets.sql
-- Multi-level secrets storage

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,                          -- secr_xxx (TypeID)
  scope_type VARCHAR(20) NOT NULL,              -- user | org | project | system
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'env_var',  -- env_var | file | github_token | ssh_key
  value_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT valid_scope_type CHECK (scope_type IN ('user', 'org', 'project')),
  CONSTRAINT valid_secret_type CHECK (type IN ('env_var', 'file', 'github_token', 'ssh_key')),
  UNIQUE(scope_type, scope_id, key)
);

CREATE INDEX idx_secrets_scope ON secrets(scope_type, scope_id);
