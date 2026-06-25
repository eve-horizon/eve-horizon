-- Per-org OAuth app credentials (BYOA — Bring Your Own App).
-- Stores the OAuth application client_id + client_secret that each org
-- registers in their own GCP project / Slack app dashboard.
-- Separate from `integrations` which holds per-connection OAuth *tokens*.

CREATE TABLE IF NOT EXISTS oauth_app_configs (
  id              TEXT PRIMARY KEY,                              -- oac_xxx (TypeID)
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,                                 -- google_drive, slack, etc.

  -- OAuth application credentials
  client_id       TEXT NOT NULL,
  client_secret   TEXT NOT NULL,

  -- Provider-specific additional config (e.g. signing_secret for Slack)
  config_json     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Metadata
  label           TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive', 'revoked')),
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_oauth_app_configs_org ON oauth_app_configs(org_id);
CREATE INDEX IF NOT EXISTS idx_oauth_app_configs_provider ON oauth_app_configs(provider);
