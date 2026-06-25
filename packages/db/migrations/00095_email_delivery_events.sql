-- Durable record of outbound mail delivery events (bounces, complaints, deliveries, rejects)
-- emitted by AWS SES and routed to POST /webhooks/ses-feedback via SNS.
--
-- Closes the silent-drop visibility gap from docs/plans/magic-link-email-silent-drop-plan.md.
-- One row per (SNS MessageId, SES eventType, recipient) so SNS retries do not duplicate
-- and SES events that affect multiple recipients are stored per-recipient.

CREATE TABLE IF NOT EXISTS email_delivery_events (
  id              TEXT PRIMARY KEY,
  recipient       TEXT NOT NULL,
  ses_message_id  TEXT,
  rfc_message_id  TEXT,
  event_type      TEXT NOT NULL,
  bounce_type     TEXT,
  bounce_subtype  TEXT,
  diagnostic      TEXT,
  raw_payload     JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_delivery_events_recipient_idx
  ON email_delivery_events (recipient, received_at DESC);

CREATE INDEX IF NOT EXISTS email_delivery_events_ses_message_id_idx
  ON email_delivery_events (ses_message_id);
