-- 00060_org_fs_events_notify.sql
-- Realtime fanout via PostgreSQL NOTIFY when org_fs_events rows are inserted.

CREATE OR REPLACE FUNCTION notify_org_fs_event() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  payload := json_build_object(
    'seq', NEW.seq,
    'id', NEW.id,
    'org_id', NEW.org_id,
    'event_type', NEW.event_type,
    'path', NEW.path,
    'created_at', NEW.created_at
  )::text;

  PERFORM pg_notify('org_fs_events', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_org_fs_event ON org_fs_events;

CREATE TRIGGER trg_notify_org_fs_event
AFTER INSERT ON org_fs_events
FOR EACH ROW
EXECUTE FUNCTION notify_org_fs_event();
