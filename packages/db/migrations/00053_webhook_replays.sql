-- 00053_webhook_replays.sql
-- Webhook replay tracking + event_id dedupe for deliveries

-- Add event_id for delivery deduplication and replay tracking
ALTER TABLE webhook_deliveries
  ADD COLUMN event_id VARCHAR(50);

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_subscription_event_unique
  UNIQUE (subscription_id, event_id);

CREATE INDEX idx_webhook_deliveries_event_id
  ON webhook_deliveries(event_id)
  WHERE event_id IS NOT NULL;

-- Replay requests
CREATE TABLE webhook_replays (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  project_id      TEXT REFERENCES projects(id),
  status          TEXT NOT NULL DEFAULT 'queued',
  requested       INT NOT NULL DEFAULT 0,
  processed       INT NOT NULL DEFAULT 0,
  replayed        INT NOT NULL DEFAULT 0,
  deduplicated    INT NOT NULL DEFAULT 0,
  failed          INT NOT NULL DEFAULT 0,
  from_event_id   VARCHAR(50),
  from_time       TIMESTAMPTZ,
  to_time         TIMESTAMPTZ,
  max_events      INT NOT NULL DEFAULT 5000,
  dry_run         BOOLEAN NOT NULL DEFAULT false,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_webhook_replays_sub_status ON webhook_replays(subscription_id, status);
CREATE INDEX idx_webhook_replays_org ON webhook_replays(org_id);
