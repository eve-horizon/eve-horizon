-- 00051_webhooks.sql
-- Webhook subscriptions and delivery tracking for outbound event delivery

-- ============================================================================
-- WEBHOOK SUBSCRIPTIONS
-- ============================================================================

CREATE TABLE webhook_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  project_id    TEXT REFERENCES projects(id),  -- NULL = org-wide
  url           TEXT NOT NULL,
  events        TEXT[] NOT NULL,
  filter        JSONB DEFAULT '{}',
  secret        TEXT NOT NULL,                 -- TODO: encrypt at rest (pre-deployment, plain text for now)
  active        BOOLEAN NOT NULL DEFAULT true,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- WEBHOOK DELIVERIES
-- ============================================================================

CREATE TABLE webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INT NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ,
  next_retry_at     TIMESTAMPTZ,
  response_status   INT,
  response_body     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX idx_webhook_subs_org ON webhook_subscriptions(org_id);
CREATE INDEX idx_webhook_subs_project ON webhook_subscriptions(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(next_retry_at)
  WHERE status IN ('pending', 'retrying');
CREATE INDEX idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id);
