-- Durable, typed conversation event stream.
--
-- This table gives product UIs and CLIs a replayable conversation timeline
-- without replacing raw job logs or plain thread messages.

CREATE OR REPLACE FUNCTION eve_generate_conversation_event_id()
RETURNS TEXT
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'cevt_' || replace(gen_random_uuid()::text, '-', '')
$$;

CREATE TABLE IF NOT EXISTS conversation_events (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE DEFAULT eve_generate_conversation_event_id(),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  job_id VARCHAR(64) REFERENCES jobs(id) ON DELETE SET NULL,
  attempt_id TEXT,
  agent_id TEXT,
  workflow_step TEXT,
  run_id TEXT,
  message_id UUID REFERENCES thread_messages(id) ON DELETE SET NULL,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  log_id UUID REFERENCES execution_logs(id) ON DELETE SET NULL,
  attachment_id UUID REFERENCES job_attachments(id) ON DELETE SET NULL,
  text TEXT,
  delivery_status TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_thread_seq
  ON conversation_events(thread_id, seq);

CREATE INDEX IF NOT EXISTS idx_conversation_events_thread_kind_seq
  ON conversation_events(thread_id, kind, seq);

CREATE INDEX IF NOT EXISTS idx_conversation_events_thread_job_seq
  ON conversation_events(thread_id, job_id, seq)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_events_thread_step_seq
  ON conversation_events(thread_id, workflow_step, seq)
  WHERE workflow_step IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_thread_message_unique
  ON conversation_events(message_id, kind)
  WHERE source = 'thread.message' AND message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_event_unique
  ON conversation_events(event_id)
  WHERE event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_log_unique
  ON conversation_events(log_id)
  WHERE log_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_attachment_unique
  ON conversation_events(attachment_id)
  WHERE attachment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION eve_conversation_thread_id_from_hints(hints JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(COALESCE(
    COALESCE(hints, '{}'::jsonb)->>'thread_id',
    COALESCE(hints, '{}'::jsonb)#>>'{conversation,thread_id}',
    COALESCE(hints, '{}'::jsonb)#>>'{conversation,threadId}',
    COALESCE(hints, '{}'::jsonb)#>>'{coordination,thread_id}',
    COALESCE(hints, '{}'::jsonb)#>>'{coordination,threadId}'
  ), '')
$$;

CREATE OR REPLACE FUNCTION eve_conversation_thread_id_from_payload(payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(COALESCE(
    COALESCE(payload, '{}'::jsonb)->>'thread_id',
    COALESCE(payload, '{}'::jsonb)->>'threadId',
    COALESCE(payload, '{}'::jsonb)#>>'{conversation,thread_id}',
    COALESCE(payload, '{}'::jsonb)#>>'{conversation,threadId}'
  ), '')
$$;

CREATE OR REPLACE FUNCTION eve_conversation_event_kind_for_log(log_type TEXT, content JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  normalized_kind TEXT := COALESCE(content, '{}'::jsonb)->>'kind';
  raw_type TEXT := COALESCE(content, '{}'::jsonb)#>>'{raw,type}';
  raw_item_type TEXT := COALESCE(content, '{}'::jsonb)#>>'{raw,item,type}';
  exit_code INTEGER;
BEGIN
  IF log_type LIKE 'lifecycle_%' THEN
    RETURN 'status.changed';
  END IF;

  IF log_type IN ('system_error', 'parse_error') THEN
    RETURN 'error';
  END IF;

  IF log_type = 'system' AND COALESCE(content, '{}'::jsonb)->>'event' = 'completed' THEN
    exit_code := COALESCE(NULLIF(COALESCE(content, '{}'::jsonb)->>'exitCode', '')::integer, 0);
    IF exit_code = 0 THEN
      RETURN 'final.result';
    END IF;
    RETURN 'error';
  END IF;

  IF normalized_kind = 'assistant'
    OR raw_type = 'assistant'
    OR raw_item_type = 'agent_message' THEN
    RETURN 'assistant.message';
  END IF;

  IF normalized_kind IN ('assistant_delta', 'message_delta', 'text_delta')
    OR raw_type IN ('response.output_text.delta', 'output_text.delta') THEN
    RETURN 'text.delta';
  END IF;

  IF normalized_kind = 'tool_use'
    OR (raw_item_type = 'command_execution' AND raw_type = 'item.started') THEN
    RETURN 'tool.call';
  END IF;

  IF normalized_kind = 'tool_result'
    OR (raw_item_type = 'command_execution' AND raw_type = 'item.completed') THEN
    RETURN 'tool.result';
  END IF;

  IF raw_item_type = 'file_change' THEN
    RETURN 'file.change';
  END IF;

  IF normalized_kind = 'error' OR raw_type = 'error' THEN
    RETURN 'error';
  END IF;

  IF log_type = 'llm.call' THEN
    RETURN 'progress';
  END IF;

  IF log_type = 'event' AND normalized_kind IN ('status', 'lifecycle') THEN
    RETURN 'status.changed';
  END IF;

  RETURN NULL;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN 'error';
END;
$$;

CREATE OR REPLACE FUNCTION eve_conversation_event_text_for_log(kind TEXT, log_type TEXT, content JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  exit_code TEXT := COALESCE(content, '{}'::jsonb)->>'exitCode';
  phase TEXT := COALESCE(content, '{}'::jsonb)->>'phase';
  action TEXT := COALESCE(content, '{}'::jsonb)->>'action';
BEGIN
  IF kind IN ('assistant.message', 'text.delta') THEN
    RETURN COALESCE(
      COALESCE(content, '{}'::jsonb)->>'message',
      COALESCE(content, '{}'::jsonb)->>'text',
      COALESCE(content, '{}'::jsonb)#>>'{raw,msg,text}',
      COALESCE(content, '{}'::jsonb)#>>'{raw,item,text}',
      COALESCE(content, '{}'::jsonb)#>>'{raw,message,content,0,text}'
    );
  END IF;

  IF kind = 'tool.call' THEN
    RETURN COALESCE(
      COALESCE(content, '{}'::jsonb)->>'tool_input',
      COALESCE(content, '{}'::jsonb)->>'toolInput',
      COALESCE(content, '{}'::jsonb)#>>'{raw,item,command}',
      COALESCE(content, '{}'::jsonb)->>'tool',
      COALESCE(content, '{}'::jsonb)->>'name'
    );
  END IF;

  IF kind = 'tool.result' THEN
    RETURN COALESCE(
      COALESCE(content, '{}'::jsonb)->>'message',
      CASE WHEN exit_code IS NOT NULL THEN 'exit ' || exit_code ELSE NULL END
    );
  END IF;

  IF kind = 'file.change' THEN
    RETURN COALESCE(
      COALESCE(content, '{}'::jsonb)->>'message',
      COALESCE(content, '{}'::jsonb)#>>'{raw,item,changes,0,path}',
      'file changed'
    );
  END IF;

  IF kind = 'status.changed' THEN
    RETURN COALESCE(
      COALESCE(content, '{}'::jsonb)->>'message',
      CASE
        WHEN phase IS NOT NULL AND action IS NOT NULL THEN phase || ':' || action
        ELSE NULL
      END,
      log_type
    );
  END IF;

  IF kind = 'final.result' THEN
    RETURN COALESCE(
      COALESCE(content, '{}'::jsonb)->>'result_text',
      COALESCE(content, '{}'::jsonb)->>'message',
      CASE WHEN exit_code IS NOT NULL THEN 'Job completed with exit code ' || exit_code ELSE 'Job completed' END
    );
  END IF;

  IF kind = 'error' THEN
    RETURN COALESCE(
      COALESCE(content, '{}'::jsonb)->>'error',
      COALESCE(content, '{}'::jsonb)->>'message',
      COALESCE(content, '{}'::jsonb)#>>'{raw,error}',
      COALESCE(content, '{}'::jsonb)#>>'{raw,content}',
      CASE WHEN exit_code IS NOT NULL THEN 'Job exited with code ' || exit_code ELSE NULL END
    );
  END IF;

  RETURN COALESCE(
    COALESCE(content, '{}'::jsonb)->>'message',
    COALESCE(content, '{}'::jsonb)->>'text'
  );
END;
$$;

CREATE OR REPLACE FUNCTION eve_conversation_event_payload_for_log(log_type TEXT, content JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'log_type', log_type,
    'harness_kind', COALESCE(content, '{}'::jsonb)->>'kind',
    'raw_type', COALESCE(content, '{}'::jsonb)#>>'{raw,type}',
    'item_type', COALESCE(content, '{}'::jsonb)#>>'{raw,item,type}',
    'tool', COALESCE(COALESCE(content, '{}'::jsonb)->>'tool', COALESCE(content, '{}'::jsonb)->>'name'),
    'tool_input', COALESCE(
      COALESCE(content, '{}'::jsonb)->>'tool_input',
      COALESCE(content, '{}'::jsonb)->>'toolInput',
      COALESCE(content, '{}'::jsonb)#>>'{raw,item,command}'
    ),
    'status', COALESCE(content, '{}'::jsonb)->>'status',
    'event', COALESCE(content, '{}'::jsonb)->>'event',
    'phase', COALESCE(content, '{}'::jsonb)->>'phase',
    'action', COALESCE(content, '{}'::jsonb)->>'action',
    'success', COALESCE(content, '{}'::jsonb)->'success',
    'duration_ms', COALESCE(content, '{}'::jsonb)->'duration_ms',
    'exit_code', COALESCE(content, '{}'::jsonb)->'exitCode',
    'error', COALESCE(
      COALESCE(content, '{}'::jsonb)->>'error',
      COALESCE(content, '{}'::jsonb)#>>'{raw,error}'
    )
  ))
$$;

CREATE OR REPLACE FUNCTION eve_insert_conversation_event_for_thread_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  thread_row threads%ROWTYPE;
  event_kind TEXT;
BEGIN
  SELECT * INTO thread_row FROM threads WHERE id = NEW.thread_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  event_kind := CASE
    WHEN NEW.kind = 'progress' THEN 'progress'
    WHEN NEW.direction = 'inbound' THEN 'user.message'
    ELSE 'assistant.message'
  END;

  INSERT INTO conversation_events (
    thread_id,
    project_id,
    org_id,
    kind,
    source,
    actor_type,
    actor_id,
    job_id,
    agent_id,
    message_id,
    text,
    delivery_status,
    payload_json,
    created_at
  )
  VALUES (
    NEW.thread_id,
    thread_row.project_id,
    thread_row.org_id,
    event_kind,
    'thread.message',
    NEW.actor_type,
    NEW.actor_id,
    NEW.job_id,
    CASE WHEN NEW.actor_type = 'agent' THEN NEW.actor_id ELSE NULL END,
    NEW.id,
    NEW.body,
    NEW.delivery_status,
    jsonb_strip_nulls(jsonb_build_object(
      'message_id', NEW.id::text,
      'direction', NEW.direction,
      'message_kind', NEW.kind,
      'delivery_status', NEW.delivery_status,
      'delivery_error', NEW.delivery_error,
      'delivered_at', NEW.delivered_at
    )),
    NEW.created_at
  )
  ON CONFLICT (message_id, kind) WHERE source = 'thread.message' AND message_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eve_insert_conversation_event_for_delivery_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  thread_row threads%ROWTYPE;
BEGIN
  IF NEW.delivery_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO thread_row FROM threads WHERE id = NEW.thread_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO conversation_events (
    thread_id,
    project_id,
    org_id,
    kind,
    source,
    actor_type,
    actor_id,
    job_id,
    agent_id,
    message_id,
    text,
    delivery_status,
    payload_json,
    created_at
  )
  VALUES (
    NEW.thread_id,
    thread_row.project_id,
    thread_row.org_id,
    'delivery.status',
    'thread.delivery',
    NEW.actor_type,
    NEW.actor_id,
    NEW.job_id,
    CASE WHEN NEW.actor_type = 'agent' THEN NEW.actor_id ELSE NULL END,
    NEW.id,
    'Message delivery ' || NEW.delivery_status,
    NEW.delivery_status,
    jsonb_strip_nulls(jsonb_build_object(
      'message_id', NEW.id::text,
      'status', NEW.delivery_status,
      'error', NEW.delivery_error,
      'delivered_at', NEW.delivered_at
    )),
    now()
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eve_insert_conversation_event_for_job_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  thread_id TEXT;
  org_id TEXT;
BEGIN
  thread_id := eve_conversation_thread_id_from_hints(NEW.hints);
  IF thread_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.org_id INTO org_id FROM projects p WHERE p.id = NEW.project_id;

  INSERT INTO conversation_events (
    thread_id,
    project_id,
    org_id,
    kind,
    source,
    job_id,
    agent_id,
    workflow_step,
    run_id,
    text,
    payload_json,
    created_at
  )
  VALUES (
    thread_id,
    NEW.project_id,
    org_id,
    'status.changed',
    'job',
    NEW.id,
    NEW.assignee,
    NEW.step_name,
    NEW.run_id,
    'Job ' || NEW.id || ' is ' || NEW.phase,
    jsonb_strip_nulls(jsonb_build_object(
      'job_id', NEW.id,
      'phase', NEW.phase,
      'previous_phase', CASE WHEN TG_OP = 'UPDATE' THEN OLD.phase ELSE NULL END,
      'title', NEW.title,
      'issue_type', NEW.issue_type
    )),
    now()
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eve_insert_conversation_event_for_attempt_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  job_row jobs%ROWTYPE;
  thread_id TEXT;
  org_id TEXT;
  terminal_kind TEXT;
  terminal_text TEXT;
BEGIN
  SELECT * INTO job_row FROM jobs WHERE id = NEW.job_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  thread_id := eve_conversation_thread_id_from_hints(job_row.hints);
  IF thread_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.org_id INTO org_id FROM projects p WHERE p.id = job_row.project_id;

  INSERT INTO conversation_events (
    thread_id,
    project_id,
    org_id,
    kind,
    source,
    job_id,
    attempt_id,
    agent_id,
    workflow_step,
    run_id,
    text,
    payload_json,
    created_at
  )
  VALUES (
    thread_id,
    job_row.project_id,
    org_id,
    'status.changed',
    'job.attempt',
    NEW.job_id,
    NEW.id::text,
    NEW.agent_id,
    job_row.step_name,
    job_row.run_id,
    'Attempt ' || NEW.attempt_number || ' is ' || NEW.status,
    jsonb_strip_nulls(jsonb_build_object(
      'job_id', NEW.job_id,
      'attempt_id', NEW.id::text,
      'attempt_number', NEW.attempt_number,
      'status', NEW.status,
      'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
      'exit_code', NEW.exit_code,
      'result_summary', NEW.result_summary,
      'error_message', NEW.error_message
    )),
    now()
  );

  IF NEW.status IN ('succeeded', 'failed', 'cancelled') THEN
    terminal_kind := CASE WHEN NEW.status = 'succeeded' THEN 'final.result' ELSE 'error' END;
    terminal_text := COALESCE(
      NEW.result_text,
      NEW.result_summary,
      NEW.error_message,
      'Attempt ' || NEW.attempt_number || ' ' || NEW.status
    );

    INSERT INTO conversation_events (
      thread_id,
      project_id,
      org_id,
      kind,
      source,
      job_id,
      attempt_id,
      agent_id,
      workflow_step,
      run_id,
      text,
      payload_json,
      created_at
    )
    VALUES (
      thread_id,
      job_row.project_id,
      org_id,
      terminal_kind,
      'job.attempt',
      NEW.job_id,
      NEW.id::text,
      NEW.agent_id,
      job_row.step_name,
      job_row.run_id,
      terminal_text,
      jsonb_strip_nulls(jsonb_build_object(
        'job_id', NEW.job_id,
        'attempt_id', NEW.id::text,
        'attempt_number', NEW.attempt_number,
        'status', NEW.status,
        'exit_code', NEW.exit_code,
        'result_json', NEW.result_json,
        'result_summary', NEW.result_summary,
        'duration_ms', NEW.duration_ms,
        'token_input', NEW.token_input,
        'token_output', NEW.token_output,
        'error_message', NEW.error_message
      )),
      now()
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eve_insert_conversation_event_for_execution_log()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  event_kind TEXT;
  event_text TEXT;
  thread_id TEXT;
  job_id TEXT;
  project_id TEXT;
  org_id TEXT;
  agent_id TEXT;
  workflow_step TEXT;
  run_id TEXT;
  attempt_number SMALLINT;
BEGIN
  IF NEW.attempt_id IS NULL THEN
    RETURN NEW;
  END IF;

  event_kind := eve_conversation_event_kind_for_log(NEW.type, NEW.content);
  IF event_kind IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    j.id,
    j.project_id,
    p.org_id,
    eve_conversation_thread_id_from_hints(j.hints),
    ja.agent_id,
    j.step_name,
    j.run_id,
    ja.attempt_number
  INTO
    job_id,
    project_id,
    org_id,
    thread_id,
    agent_id,
    workflow_step,
    run_id,
    attempt_number
  FROM job_attempts ja
  JOIN jobs j ON j.id = ja.job_id
  LEFT JOIN projects p ON p.id = j.project_id
  WHERE ja.id = NEW.attempt_id;

  IF thread_id IS NULL THEN
    RETURN NEW;
  END IF;

  event_text := eve_conversation_event_text_for_log(event_kind, NEW.type, NEW.content);

  INSERT INTO conversation_events (
    thread_id,
    project_id,
    org_id,
    kind,
    source,
    job_id,
    attempt_id,
    agent_id,
    workflow_step,
    run_id,
    log_id,
    text,
    payload_json,
    created_at
  )
  VALUES (
    thread_id,
    project_id,
    org_id,
    event_kind,
    'execution.log',
    job_id,
    NEW.attempt_id::text,
    agent_id,
    workflow_step,
    run_id,
    NEW.id,
    event_text,
    eve_conversation_event_payload_for_log(NEW.type, NEW.content)
      || jsonb_strip_nulls(jsonb_build_object(
        'log_id', NEW.id::text,
        'log_seq', NEW.seq,
        'attempt_number', attempt_number
      )),
    NEW.created_at
  )
  ON CONFLICT (log_id) WHERE log_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eve_insert_conversation_event_for_project_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  payload JSONB := COALESCE(NEW.payload_json, '{}'::jsonb);
  thread_id TEXT;
  thread_row threads%ROWTYPE;
BEGIN
  IF NEW.source = 'chat' AND NEW.type LIKE 'chat.message.%' THEN
    RETURN NEW;
  END IF;

  thread_id := eve_conversation_thread_id_from_payload(payload);
  IF thread_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO thread_row FROM threads WHERE id = thread_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO conversation_events (
    thread_id,
    project_id,
    org_id,
    kind,
    source,
    actor_type,
    actor_id,
    job_id,
    attempt_id,
    agent_id,
    workflow_step,
    run_id,
    event_id,
    text,
    payload_json,
    created_at
  )
  VALUES (
    thread_id,
    thread_row.project_id,
    thread_row.org_id,
    NEW.type,
    NEW.source,
    NEW.actor_type,
    NEW.actor_id,
    COALESCE(NEW.job_id, payload->>'job_id', payload->>'jobId'),
    COALESCE(payload->>'attempt_id', payload->>'attemptId'),
    COALESCE(payload->>'agent_id', payload->>'agentId'),
    COALESCE(payload->>'workflow_step', payload->>'workflowStep'),
    COALESCE(payload->>'run_id', payload->>'runId'),
    NEW.id,
    COALESCE(payload->>'text', payload->>'message'),
    payload,
    NEW.created_at
  )
  ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eve_insert_conversation_event_for_job_attachment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  job_row jobs%ROWTYPE;
  thread_id TEXT;
  org_id TEXT;
BEGIN
  SELECT * INTO job_row FROM jobs WHERE id = NEW.job_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  thread_id := eve_conversation_thread_id_from_hints(job_row.hints);
  IF thread_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.org_id INTO org_id FROM projects p WHERE p.id = job_row.project_id;

  INSERT INTO conversation_events (
    thread_id,
    project_id,
    org_id,
    kind,
    source,
    actor_type,
    actor_id,
    job_id,
    agent_id,
    workflow_step,
    run_id,
    attachment_id,
    text,
    payload_json,
    created_at
  )
  VALUES (
    thread_id,
    job_row.project_id,
    org_id,
    'attachment.added',
    'job.attachment',
    CASE WHEN NEW.created_by IS NOT NULL THEN 'agent' ELSE NULL END,
    NEW.created_by,
    NEW.job_id,
    job_row.assignee,
    job_row.step_name,
    job_row.run_id,
    NEW.id,
    NEW.name,
    jsonb_strip_nulls(jsonb_build_object(
      'attachment_id', NEW.id::text,
      'name', NEW.name,
      'mime_type', NEW.mime_type,
      'content_hash', NEW.content_hash,
      'created_by', NEW.created_by
    )),
    NEW.created_at
  )
  ON CONFLICT (attachment_id) WHERE attachment_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_event_thread_message_insert ON thread_messages;
CREATE TRIGGER trg_conversation_event_thread_message_insert
  AFTER INSERT ON thread_messages
  FOR EACH ROW
  EXECUTE FUNCTION eve_insert_conversation_event_for_thread_message();

DROP TRIGGER IF EXISTS trg_conversation_event_delivery_status ON thread_messages;
CREATE TRIGGER trg_conversation_event_delivery_status
  AFTER UPDATE OF delivery_status, delivery_error, delivered_at ON thread_messages
  FOR EACH ROW
  WHEN (
    OLD.delivery_status IS DISTINCT FROM NEW.delivery_status
    OR OLD.delivery_error IS DISTINCT FROM NEW.delivery_error
    OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at
  )
  EXECUTE FUNCTION eve_insert_conversation_event_for_delivery_status();

DROP TRIGGER IF EXISTS trg_conversation_event_job_status_insert ON jobs;
CREATE TRIGGER trg_conversation_event_job_status_insert
  AFTER INSERT ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION eve_insert_conversation_event_for_job_status();

DROP TRIGGER IF EXISTS trg_conversation_event_job_status_update ON jobs;
CREATE TRIGGER trg_conversation_event_job_status_update
  AFTER UPDATE OF phase ON jobs
  FOR EACH ROW
  WHEN (OLD.phase IS DISTINCT FROM NEW.phase)
  EXECUTE FUNCTION eve_insert_conversation_event_for_job_status();

DROP TRIGGER IF EXISTS trg_conversation_event_attempt_status_insert ON job_attempts;
CREATE TRIGGER trg_conversation_event_attempt_status_insert
  AFTER INSERT ON job_attempts
  FOR EACH ROW
  EXECUTE FUNCTION eve_insert_conversation_event_for_attempt_status();

DROP TRIGGER IF EXISTS trg_conversation_event_attempt_status_update ON job_attempts;
CREATE TRIGGER trg_conversation_event_attempt_status_update
  AFTER UPDATE OF status ON job_attempts
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION eve_insert_conversation_event_for_attempt_status();

DROP TRIGGER IF EXISTS trg_conversation_event_execution_log ON execution_logs;
CREATE TRIGGER trg_conversation_event_execution_log
  AFTER INSERT ON execution_logs
  FOR EACH ROW
  EXECUTE FUNCTION eve_insert_conversation_event_for_execution_log();

DROP TRIGGER IF EXISTS trg_conversation_event_project_event ON events;
CREATE TRIGGER trg_conversation_event_project_event
  AFTER INSERT ON events
  FOR EACH ROW
  EXECUTE FUNCTION eve_insert_conversation_event_for_project_event();

DROP TRIGGER IF EXISTS trg_conversation_event_job_attachment ON job_attachments;
CREATE TRIGGER trg_conversation_event_job_attachment
  AFTER INSERT ON job_attachments
  FOR EACH ROW
  EXECUTE FUNCTION eve_insert_conversation_event_for_job_attachment();

INSERT INTO conversation_events (
  thread_id,
  project_id,
  org_id,
  kind,
  source,
  actor_type,
  actor_id,
  job_id,
  agent_id,
  message_id,
  text,
  delivery_status,
  payload_json,
  created_at
)
SELECT
  tm.thread_id,
  t.project_id,
  t.org_id,
  CASE
    WHEN tm.kind = 'progress' THEN 'progress'
    WHEN tm.direction = 'inbound' THEN 'user.message'
    ELSE 'assistant.message'
  END,
  'thread.message',
  tm.actor_type,
  tm.actor_id,
  tm.job_id,
  CASE WHEN tm.actor_type = 'agent' THEN tm.actor_id ELSE NULL END,
  tm.id,
  tm.body,
  tm.delivery_status,
  jsonb_strip_nulls(jsonb_build_object(
    'message_id', tm.id::text,
    'direction', tm.direction,
    'message_kind', tm.kind,
    'delivery_status', tm.delivery_status,
    'delivery_error', tm.delivery_error,
    'delivered_at', tm.delivered_at
  )),
  tm.created_at
FROM thread_messages tm
JOIN threads t ON t.id = tm.thread_id
ORDER BY tm.created_at ASC, tm.id ASC
ON CONFLICT (message_id, kind) WHERE source = 'thread.message' AND message_id IS NOT NULL DO NOTHING;

INSERT INTO conversation_events (
  thread_id,
  project_id,
  org_id,
  kind,
  source,
  actor_type,
  actor_id,
  job_id,
  attempt_id,
  agent_id,
  workflow_step,
  run_id,
  event_id,
  text,
  payload_json,
  created_at
)
SELECT
  thread_ref.thread_id,
  t.project_id,
  t.org_id,
  e.type,
  e.source,
  e.actor_type,
  e.actor_id,
  COALESCE(e.job_id, e.payload_json->>'job_id', e.payload_json->>'jobId'),
  COALESCE(e.payload_json->>'attempt_id', e.payload_json->>'attemptId'),
  COALESCE(e.payload_json->>'agent_id', e.payload_json->>'agentId'),
  COALESCE(e.payload_json->>'workflow_step', e.payload_json->>'workflowStep'),
  COALESCE(e.payload_json->>'run_id', e.payload_json->>'runId'),
  e.id,
  COALESCE(e.payload_json->>'text', e.payload_json->>'message'),
  COALESCE(e.payload_json, '{}'::jsonb),
  e.created_at
FROM events e
CROSS JOIN LATERAL (
  SELECT eve_conversation_thread_id_from_payload(e.payload_json) AS thread_id
) thread_ref
JOIN threads t ON t.id = thread_ref.thread_id
WHERE thread_ref.thread_id IS NOT NULL
  AND NOT (e.source = 'chat' AND e.type LIKE 'chat.message.%')
ORDER BY e.created_at ASC, e.id ASC
ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING;
