-- Cross-project app links: producer grants, consumer subscriptions, event deliveries.

CREATE TABLE IF NOT EXISTS project_app_link_grants (
  id                    VARCHAR(50)  PRIMARY KEY,
  producer_project_id   VARCHAR(50)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  export_kind           VARCHAR(20)  NOT NULL CHECK (export_kind IN ('api', 'events')),
  export_name           VARCHAR(100) NOT NULL,
  consumer_project_id   VARCHAR(50)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  api_scopes            JSONB        NOT NULL DEFAULT '[]'::jsonb,
  event_types           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  envs                  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  service_name          VARCHAR(100),
  cli_name              VARCHAR(100),
  cli_image             VARCHAR(255),
  cli_bin_path          VARCHAR(255),
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (producer_project_id, export_kind, export_name, consumer_project_id)
);

CREATE INDEX IF NOT EXISTS idx_app_link_grants_consumer
  ON project_app_link_grants (consumer_project_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_app_link_grants_producer
  ON project_app_link_grants (producer_project_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_app_link_grants_lookup
  ON project_app_link_grants (producer_project_id, export_kind, export_name, consumer_project_id, revoked_at);

CREATE TABLE IF NOT EXISTS project_app_link_subscriptions (
  id                       VARCHAR(50)  PRIMARY KEY,
  consumer_project_id      VARCHAR(50)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  local_alias              VARCHAR(100) NOT NULL,
  api_grant_id             VARCHAR(50)  REFERENCES project_app_link_grants(id) ON DELETE CASCADE,
  event_grant_id           VARCHAR(50)  REFERENCES project_app_link_grants(id) ON DELETE CASCADE,
  requested_scopes         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  event_types              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  environment_strategy     VARCHAR(20)  NOT NULL DEFAULT 'same',
  producer_env_name        VARCHAR(100),
  inject_into_services     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  inject_into_jobs         BOOLEAN      NOT NULL DEFAULT FALSE,
  last_token_minted_at     TIMESTAMPTZ,
  last_token_principal     VARCHAR(255),
  last_token_audience      VARCHAR(255),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (consumer_project_id, local_alias),
  CHECK (api_grant_id IS NOT NULL OR event_grant_id IS NOT NULL),
  CHECK (environment_strategy IN ('same', 'fixed'))
);

CREATE INDEX IF NOT EXISTS idx_app_link_subscriptions_consumer
  ON project_app_link_subscriptions (consumer_project_id);
CREATE INDEX IF NOT EXISTS idx_app_link_subscriptions_api_grant
  ON project_app_link_subscriptions (api_grant_id)
  WHERE api_grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_link_subscriptions_event_grant
  ON project_app_link_subscriptions (event_grant_id)
  WHERE event_grant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_link_event_deliveries (
  id                       VARCHAR(50)  PRIMARY KEY,
  subscription_id          VARCHAR(50)  NOT NULL REFERENCES project_app_link_subscriptions(id) ON DELETE CASCADE,
  source_event_id          VARCHAR(50)  NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  consumer_event_id        VARCHAR(50)  REFERENCES events(id) ON DELETE SET NULL,
  status                   VARCHAR(20)  NOT NULL CHECK (status IN ('pending', 'retrying', 'success', 'failed', 'skipped')),
  attempts                 INT          NOT NULL DEFAULT 0,
  last_attempt_at          TIMESTAMPTZ,
  next_retry_at            TIMESTAMPTZ,
  last_error               TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (subscription_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_app_link_event_deliveries_pending
  ON app_link_event_deliveries (next_retry_at)
  WHERE status IN ('pending', 'retrying');
CREATE INDEX IF NOT EXISTS idx_app_link_event_deliveries_source
  ON app_link_event_deliveries (source_event_id);
