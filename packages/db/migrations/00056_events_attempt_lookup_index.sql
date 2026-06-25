-- Speed up runner completion polling lookups by project + attemptId.
CREATE INDEX idx_events_project_attempt_created
  ON events (project_id, (payload_json->>'attemptId'), created_at DESC)
  WHERE payload_json ? 'attemptId';
