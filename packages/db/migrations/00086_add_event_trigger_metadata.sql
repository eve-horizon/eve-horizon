-- 00086_add_event_trigger_metadata.sql
-- Add trigger evaluation metadata to events so operators can tell whether
-- an event matched triggers or not (and why).

ALTER TABLE events ADD COLUMN trigger_match_count integer DEFAULT NULL;
ALTER TABLE events ADD COLUMN triggers_evaluated jsonb DEFAULT NULL;
