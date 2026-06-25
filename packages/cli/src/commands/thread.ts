import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';

// ── Response shapes ────────────────────────────────────────────────

type ThreadResponse = {
  id: string;
  project_id?: string | null;
  org_id: string | null;
  key: string;
  scope: string;
  created_at: string;
  updated_at: string;
};

type ThreadListResponse = {
  threads: ThreadResponse[];
  total?: number;
};

type ThreadMessageResponse = {
  id: string;
  thread_id: string;
  direction: 'inbound' | 'outbound';
  actor_type: string | null;
  actor_id: string | null;
  body: string;
  job_id: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  delivered_at: string | null;
  created_at: string;
};

type ThreadMessageListResponse = {
  messages: ThreadMessageResponse[];
  total?: number;
};

type ThreadStreamSnapshot = {
  thread: ThreadResponse;
  messages: ThreadMessageResponse[];
};

type ConversationEventResponse = {
  id: string;
  cursor: string;
  seq: number;
  thread_id: string;
  project_id?: string | null;
  org_id?: string | null;
  kind: string;
  source: string;
  actor_type?: string | null;
  actor_id?: string | null;
  job_id?: string | null;
  attempt_id?: string | null;
  agent_id?: string | null;
  workflow_step?: string | null;
  run_id?: string | null;
  message_id?: string | null;
  event_id?: string | null;
  log_id?: string | null;
  attachment_id?: string | null;
  text?: string | null;
  delivery_status?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

type ConversationEventListResponse = {
  events: ConversationEventResponse[];
  total?: number;
};

type ConversationEventStreamSnapshot = {
  thread: ThreadResponse;
  events: ConversationEventResponse[];
};

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Build the base path for thread message endpoints.
 * When an orgId is provided, routes through the org-scoped controller;
 * otherwise falls back to the project-scoped controller.
 */
function messagesPath(threadId: string, orgId?: string): string {
  if (orgId) {
    return `/orgs/${orgId}/threads/${threadId}/messages`;
  }
  return `/threads/${threadId}/messages`;
}

function streamPath(threadId: string): string {
  return `/threads/${threadId}/stream`;
}

function eventsPath(threadId: string): string {
  return `/threads/${threadId}/events`;
}

function eventStreamPath(threadId: string): string {
  return `/threads/${threadId}/events/stream`;
}

/**
 * Parse a human-friendly duration string into an ISO timestamp.
 * Supports: "5m", "1h", "30s", "2d", or an ISO timestamp directly.
 */
function parseSinceDuration(since: string): string {
  const match = since.match(/^(\d+)([smhd])$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const ms = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    }[unit] ?? 60_000;
    return new Date(Date.now() - value * ms).toISOString();
  }

  // Assume it's already an ISO timestamp
  return since;
}

function printThreadMessage(msg: ThreadMessageResponse): string {
  const actor = msg.actor_id ?? msg.actor_type ?? 'unknown';
  const dir = msg.direction === 'outbound' ? '\u2192' : '\u2190';
  const time = new Date(msg.created_at).toLocaleTimeString();
  const jobRef = msg.job_id ? ` [job:${msg.job_id}]` : '';
  const delivery = msg.delivery_status === 'delivered' ? ' \u2713'
    : msg.delivery_status === 'failed' ? ' \u2717'
    : '';
  process.stdout.write(`${dir} ${time} ${actor}${jobRef}${delivery}: `);

  try {
    const parsed = JSON.parse(msg.body);
    if (parsed.kind && parsed.body) {
      console.log(`[${parsed.kind}] ${parsed.body}`);
    } else {
      console.log(msg.body);
    }
  } catch {
    console.log(msg.body);
  }

  return msg.created_at;
}

function buildEventQuery(flags: Record<string, FlagValue>): string {
  const params = new URLSearchParams();
  const after = getStringFlag(flags, ['after']);
  const kind = getStringFlag(flags, ['kind']);
  const jobId = getStringFlag(flags, ['job', 'job-id', 'job_id']);
  const attemptId = getStringFlag(flags, ['attempt', 'attempt-id', 'attempt_id']);
  const workflowStep = getStringFlag(flags, ['workflow-step', 'workflow_step', 'step']);
  const source = getStringFlag(flags, ['source']);
  const limit = getStringFlag(flags, ['limit']);

  if (after) params.set('after', after);
  if (kind) params.set('kind', kind);
  if (jobId) params.set('job_id', jobId);
  if (attemptId) params.set('attempt_id', attemptId);
  if (workflowStep) params.set('workflow_step', workflowStep);
  if (source) params.set('source', source);
  if (limit) params.set('limit', limit);

  const query = params.toString();
  return query ? `?${query}` : '';
}

function parsePayloadFlag(payload: string | undefined): Record<string, unknown> {
  if (!payload) return {};
  const parsed = JSON.parse(payload) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function printConversationEvent(event: ConversationEventResponse): string {
  const time = new Date(event.created_at).toLocaleTimeString();
  const refs = [
    event.job_id ? `job:${event.job_id}` : null,
    event.attempt_id ? `attempt:${event.attempt_id}` : null,
    event.workflow_step ? `step:${event.workflow_step}` : null,
  ].filter(Boolean).join(' ');
  const text = event.text ?? (Object.keys(event.payload ?? {}).length ? JSON.stringify(event.payload) : '');
  console.log(`${time} ${event.kind} [${event.source}]${refs ? ` ${refs}` : ''}${text ? `: ${text}` : ''}`);
  return event.cursor;
}

function printConversationEventJsonl(event: ConversationEventResponse): string {
  console.log(JSON.stringify(event));
  return event.cursor;
}

async function followThreadByPolling(
  context: ResolvedContext,
  threadId: string,
  orgId?: string,
  initialLastSeen: string | null = null,
): Promise<never> {
  let lastSeen = initialLastSeen;
  const pollInterval = 3000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const params = new URLSearchParams();
      if (lastSeen) {
        params.set('since', lastSeen);
      }
      const qs = params.toString() ? `?${params.toString()}` : '';
      const result = await requestJson<ThreadMessageListResponse>(
        context,
        `${messagesPath(threadId, orgId)}${qs}`,
      );

      for (const msg of result.messages) {
        lastSeen = printThreadMessage(msg);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Poll error: ${message}`);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
}

async function followThreadBySse(
  context: ResolvedContext,
  threadId: string,
): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  if (context.token) {
    headers.Authorization = `Bearer ${context.token}`;
  }

  const response = await fetch(`${context.apiUrl}${streamPath(threadId)}`, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  if (!response.body) {
    throw new Error('No response body received');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastSeen: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) {
        break;
      }

      const rawEvent = buffer.slice(0, match.index).trim();
      buffer = buffer.slice(match.index + match[0].length);
      if (!rawEvent) {
        continue;
      }

      let eventType = 'message';
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('event:')) {
          eventType = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      const payloadText = dataLines.join('\n');
      let payload: unknown = payloadText;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        // Ignore parse failures and treat the payload as a raw string.
      }

      if (eventType === 'snapshot') {
        const snapshot = payload as ThreadStreamSnapshot;
        for (const msg of snapshot.messages ?? []) {
          lastSeen = printThreadMessage(msg);
        }
        continue;
      }

      if (eventType === 'message') {
        lastSeen = printThreadMessage(payload as ThreadMessageResponse);
      }
    }
  }

  return lastSeen;
}

async function followConversationEventsBySse(
  context: ResolvedContext,
  threadId: string,
  flags: Record<string, FlagValue>,
  jsonl: boolean,
): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  const after = getStringFlag(flags, ['after']);
  if (after) {
    headers['Last-Event-ID'] = after;
  }
  if (context.token) {
    headers.Authorization = `Bearer ${context.token}`;
  }

  const response = await fetch(`${context.apiUrl}${eventStreamPath(threadId)}${buildEventQuery(flags)}`, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  if (!response.body) {
    throw new Error('No response body received');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastSeen: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) {
        break;
      }

      const rawEvent = buffer.slice(0, match.index).trim();
      buffer = buffer.slice(match.index + match[0].length);
      if (!rawEvent) {
        continue;
      }

      let eventType = 'message';
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('event:')) {
          eventType = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart());
        }
      }

      if (dataLines.length === 0 || eventType === 'heartbeat') {
        continue;
      }

      const payload = JSON.parse(dataLines.join('\n')) as unknown;
      if (eventType === 'snapshot') {
        const snapshot = payload as ConversationEventStreamSnapshot;
        for (const event of snapshot.events ?? []) {
          lastSeen = jsonl ? printConversationEventJsonl(event) : printConversationEvent(event);
        }
        continue;
      }

      lastSeen = jsonl
        ? printConversationEventJsonl(payload as ConversationEventResponse)
        : printConversationEvent(payload as ConversationEventResponse);
    }
  }

  return lastSeen;
}

// ── Main handler ───────────────────────────────────────────────────

export async function handleThread(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'create': {
      const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const key = getStringFlag(flags, ['key']);
      if (!key) {
        throw new Error('Usage: eve thread create --org <org_id> --key <key>');
      }

      const result = await requestJson<ThreadResponse>(
        context,
        `/orgs/${orgId}/threads`,
        { method: 'POST', body: { key } },
      );

      if (json) {
        outputJson(result, true);
      } else {
        console.log(`Thread created: ${result.id}`);
        console.log(`  key: ${result.key}`);
      }
      return;
    }

    case 'list': {
      const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const scope = getStringFlag(flags, ['scope']);
      const keyPrefix = getStringFlag(flags, ['key-prefix', 'key_prefix']);

      const params = new URLSearchParams();
      if (scope) params.set('scope', scope);
      if (keyPrefix) params.set('key_prefix', keyPrefix);
      const qs = params.toString() ? `?${params.toString()}` : '';

      const result = await requestJson<ThreadListResponse>(
        context,
        `/orgs/${orgId}/threads${qs}`,
      );

      if (json) {
        outputJson(result, true);
        return;
      }

      if (result.threads.length === 0) {
        console.log('No threads found.');
        return;
      }

      console.log(`${result.threads.length} thread(s)${result.total ? ` (${result.total} total)` : ''}:\n`);
      for (const t of result.threads) {
        const updated = new Date(t.updated_at).toLocaleString();
        console.log(`  ${t.id}  ${t.key}  [${t.scope}]  updated: ${updated}`);
      }
      return;
    }

    case 'show': {
      const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const threadId = positionals[0];
      if (!threadId) {
        throw new Error('Usage: eve thread show <thread_id> --org <org_id>');
      }

      const result = await requestJson<ThreadResponse>(
        context,
        `/orgs/${orgId}/threads/${threadId}`,
      );

      if (json) {
        outputJson(result, true);
      } else {
        console.log(`Thread: ${result.id}`);
        console.log(`  key:     ${result.key}`);
        console.log(`  scope:   ${result.scope}`);
        console.log(`  org:     ${result.org_id}`);
        console.log(`  created: ${result.created_at}`);
        console.log(`  updated: ${result.updated_at}`);
      }
      return;
    }

    case 'messages': {
      const threadId = positionals[0];
      if (!threadId) {
        throw new Error('Usage: eve thread messages <thread-id> [--org <org>] [--since <duration>] [--limit <n>] [--json]');
      }

      const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;
      const since = getStringFlag(flags, ['since']);
      const limit = getStringFlag(flags, ['limit']);

      const params = new URLSearchParams();
      if (since) {
        params.set('since', parseSinceDuration(since));
      }
      if (limit) {
        params.set('limit', limit);
      }

      const qs = params.toString() ? `?${params.toString()}` : '';
      const result = await requestJson<ThreadMessageListResponse>(
        context,
        `${messagesPath(threadId, orgId)}${qs}`,
      );

      if (json) {
        outputJson(result, true);
      } else {
        if (result.messages.length === 0) {
          console.log('No messages found.');
          return;
        }
        console.log(`${result.messages.length} message(s)${result.total ? ` (${result.total} total)` : ''}:\n`);
        for (const msg of result.messages) {
          const actor = msg.actor_id ?? msg.actor_type ?? 'unknown';
          const dir = msg.direction === 'outbound' ? '\u2192' : '\u2190';
          const time = new Date(msg.created_at).toLocaleTimeString();
          const jobRef = msg.job_id ? ` [job:${msg.job_id}]` : '';
          const delivery = msg.delivery_status === 'delivered' ? ' \u2713 delivered'
            : msg.delivery_status === 'failed' ? ` \u2717 ${msg.delivery_error ?? 'delivery failed'}`
            : msg.delivery_status === 'pending' ? ' \u23f3 pending'
            : '';
          console.log(`  ${dir} ${time} ${actor}${jobRef}${delivery}`);

          // Try to parse as coordination message JSON
          try {
            const parsed = JSON.parse(msg.body);
            if (parsed.kind && parsed.body) {
              console.log(`    [${parsed.kind}] ${parsed.body}`);
            } else {
              console.log(`    ${msg.body}`);
            }
          } catch {
            console.log(`    ${msg.body}`);
          }
          console.log('');
        }
      }
      return;
    }

    case 'events': {
      const threadId = positionals[0];
      if (!threadId) {
        throw new Error('Usage: eve thread events <thread-id> [--after <cursor>] [--kind <kind>] [--job <id>] [--json|--jsonl] [--follow]');
      }

      const jsonl = Boolean(flags.jsonl);
      const follow = Boolean(flags.follow);

      if (follow) {
        if (!jsonl) {
          console.log(`Following conversation events for thread ${threadId}...`);
          console.log('(Using SSE stream - press Ctrl+C to stop)\n');
        }
        await followConversationEventsBySse(context, threadId, flags, jsonl);
        return;
      }

      const result = await requestJson<ConversationEventListResponse>(
        context,
        `${eventsPath(threadId)}${buildEventQuery(flags)}`,
      );

      if (json) {
        outputJson(result, true);
        return;
      }

      if (jsonl) {
        for (const event of result.events) {
          printConversationEventJsonl(event);
        }
        return;
      }

      if (result.events.length === 0) {
        console.log('No conversation events found.');
        return;
      }

      console.log(`${result.events.length} event(s)${result.total ? ` (${result.total} total)` : ''}:\n`);
      for (const event of result.events) {
        printConversationEvent(event);
      }
      return;
    }

    case 'emit-event': {
      const threadId = positionals[0];
      if (!threadId) {
        throw new Error('Usage: eve thread emit-event <thread-id> --kind <kind> [--payload <json>] [--text <text>]');
      }

      const kind = getStringFlag(flags, ['kind']);
      if (!kind) {
        throw new Error('Usage: eve thread emit-event <thread-id> --kind <kind> [--payload <json>] [--text <text>]');
      }

      const payload = parsePayloadFlag(getStringFlag(flags, ['payload']));
      const result = await requestJson<ConversationEventResponse>(
        context,
        eventsPath(threadId),
        {
          method: 'POST',
          body: {
            kind,
            source: getStringFlag(flags, ['source']) ?? 'app',
            actor_type: getStringFlag(flags, ['actor-type', 'actor_type']),
            actor_id: getStringFlag(flags, ['actor-id', 'actor_id']),
            job_id: getStringFlag(flags, ['job', 'job-id', 'job_id']),
            attempt_id: getStringFlag(flags, ['attempt', 'attempt-id', 'attempt_id']),
            agent_id: getStringFlag(flags, ['agent', 'agent-id', 'agent_id']),
            workflow_step: getStringFlag(flags, ['workflow-step', 'workflow_step', 'step']),
            run_id: getStringFlag(flags, ['run', 'run-id', 'run_id']),
            text: getStringFlag(flags, ['text']),
            payload,
          },
        },
      );

      outputJson(result, json, `Conversation event emitted: ${result.kind} (${result.cursor})`);
      return;
    }

    case 'post': {
      const threadId = positionals[0];
      if (!threadId) {
        throw new Error('Usage: eve thread post <thread-id> --body <text>');
      }

      const body = getStringFlag(flags, ['body']);
      if (!body) {
        throw new Error('Usage: eve thread post <thread-id> --body <text>');
      }

      const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;
      const actorType = getStringFlag(flags, ['actor-type']) ?? 'user';
      const actorId = getStringFlag(flags, ['actor-id']);
      const jobId = getStringFlag(flags, ['job-id']);

      const result = await requestJson<ThreadMessageResponse>(
        context,
        messagesPath(threadId, orgId),
        {
          method: 'POST',
          body: {
            direction: 'inbound',
            actor_type: actorType,
            actor_id: actorId,
            body,
            job_id: jobId,
          },
        },
      );

      outputJson(result, json, `Message posted to thread ${threadId}`);
      return;
    }

    case 'follow': {
      const threadId = positionals[0];
      if (!threadId) {
        throw new Error('Usage: eve thread follow <thread-id>');
      }

      const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;

      console.log(`Following thread ${threadId}...`);
      if (orgId) {
        console.log('(Polling every 3s \u2014 press Ctrl+C to stop)\n');
        await followThreadByPolling(context, threadId, orgId);
        return;
      }

      console.log('(Using SSE stream when available \u2014 press Ctrl+C to stop)\n');
      let lastSeen: string | null = null;
      try {
        lastSeen = await followThreadBySse(context, threadId);
        console.error('\nThread stream ended. Falling back to polling.\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`SSE unavailable: ${message}`);
        console.error('Falling back to polling.\n');
      }

      await followThreadByPolling(context, threadId, undefined, lastSeen);
      return;
    }

    case 'distill': {
      const threadId = positionals[0];
      if (!threadId) {
        throw new Error('Usage: eve thread distill <thread-id> --org <org_id> [--to <path>] [--agent <slug>] [--category <name>] [--key <key>] [--auto --threshold <n> --interval <duration>]');
      }

      const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const thresholdRaw = getStringFlag(flags, ['threshold']);
      const threshold = thresholdRaw ? Number.parseInt(thresholdRaw, 10) : undefined;
      if (thresholdRaw && (!Number.isFinite(threshold) || threshold! < 0)) {
        throw new Error(`Invalid --threshold value: ${thresholdRaw}`);
      }

      const auto = flags.auto === true || flags.auto === 'true';

      const result = await requestJson(
        context,
        `/orgs/${orgId}/threads/${encodeURIComponent(threadId)}/distill`,
        {
          method: 'POST',
          body: {
            to_path: getStringFlag(flags, ['to']),
            agent: getStringFlag(flags, ['agent', 'agent-slug', 'agent_slug']),
            category: getStringFlag(flags, ['category']),
            key: getStringFlag(flags, ['key']),
            prompt: getStringFlag(flags, ['prompt']),
            auto,
            threshold,
            interval: getStringFlag(flags, ['interval']),
          },
        },
      );
      outputJson(result, json, `Thread distilled: ${threadId}`);
      return;
    }

    case 'delete': {
      const threadId = positionals[0];
      if (!threadId) {
        throw new Error('Usage: eve thread delete <thread_id>');
      }
      await requestRaw(context, `/threads/${threadId}`, { method: 'DELETE' });
      outputJson({ id: threadId, deleted: true }, json, `Thread ${threadId} deleted`);
      return;
    }

    default:
      throw new Error(
        'Usage: eve thread <create|list|show|messages|events|emit-event|post|follow|distill|delete> [options]\n\n' +
        '  create    --org <org> --key <key>\n' +
        '  list      --org <org> [--scope org] [--key-prefix <prefix>]\n' +
        '  show      <thread_id> --org <org>\n' +
        '  messages  <thread_id> [--org <org>] [--since <duration>] [--limit <n>]\n' +
        '  events    <thread_id> [--after <cursor>] [--kind <kind>] [--job <id>] [--jsonl] [--follow]\n' +
        '  emit-event <thread_id> --kind <kind> [--payload <json>] [--text <text>]\n' +
        '  post      <thread_id> [--org <org>] --body <text> [--actor-type <type>] [--actor-id <id>]\n' +
        '  follow    <thread_id> [--org <org>]\n' +
        '  distill   <thread_id> --org <org> [--to <path>] [--agent <slug>] [--category <name>] [--key <key>]\n' +
        '  delete    <thread_id>',
      );
  }
}
