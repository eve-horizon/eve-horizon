-- Chat Outbound Delivery
-- Adds delivery tracking to thread_messages and provider metadata to threads
-- for routing agent replies back through the originating chat provider.

-- Add delivery tracking to thread_messages
ALTER TABLE thread_messages
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS delivery_error TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Add provider metadata to threads for outbound routing
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS metadata_json JSONB;

-- Index for pending deliveries (gateway polling fallback)
CREATE INDEX IF NOT EXISTS idx_thread_messages_pending_delivery
  ON thread_messages(thread_id, job_id, delivery_status)
  WHERE delivery_status = 'pending';

-- Prevent duplicate outbound rows per job (idempotency guard)
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_job_outbound_unique
  ON thread_messages(job_id)
  WHERE direction = 'outbound' AND job_id IS NOT NULL;
