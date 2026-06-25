import { parseSseStream } from './sse.js';
import type {
  ConversationClientOptions,
  ConversationEvent,
  ConversationEventListResponse,
  ConversationEventQueryOptions,
  ConversationEventStreamEvent,
  ConversationResponse,
  ConversationStreamEvent,
  ConversationTurnRequest,
  ConversationTurnResponse,
  CreateConversationEventInput,
  EnsureConversationRequest,
  StreamOptions,
  ThreadMessage,
  ThreadMessageListResponse,
} from './types.js';

export function createConversationClient(options: ConversationClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is required');

  async function headers(extra?: HeadersInit): Promise<Headers> {
    const h = new Headers(extra);
    const token = await options.getToken?.();
    if (token) h.set('Authorization', `Bearer ${token}`);
    return h;
  }

  async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const h = await headers(init?.headers);
    if (init?.body && !h.has('content-type')) h.set('content-type', 'application/json');
    const res = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: h });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Eve conversation request failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<T>;
  }

  const encodedAppKey = () => encodeURIComponent(options.appKey);
  const appIdQuery = (appId?: string) => {
    const effective = appId ?? options.appId;
    return effective ? `?app_id=${encodeURIComponent(effective)}` : '';
  };
  const eventQuery = (input: ConversationEventQueryOptions = {}) => {
    const params = new URLSearchParams();
    if (input.appId ?? options.appId) params.set('app_id', input.appId ?? options.appId ?? '');
    if (input.after) params.set('after', input.after);
    if (input.kind) params.set('kind', Array.isArray(input.kind) ? input.kind.join(',') : input.kind);
    if (input.jobId) params.set('job_id', input.jobId);
    if (input.attemptId) params.set('attempt_id', input.attemptId);
    if (input.workflowStep) params.set('workflow_step', input.workflowStep);
    if (input.source) params.set('source', input.source);
    if (input.limit) params.set('limit', String(input.limit));
    const query = params.toString();
    return query ? `?${query}` : '';
  };

  return {
    ensure(input: Omit<EnsureConversationRequest, 'app_key'> = {}): Promise<ConversationResponse> {
      return requestJson(`/projects/${options.projectId}/conversations`, {
        method: 'POST',
        body: JSON.stringify({
          ...input,
          app_key: options.appKey,
          app_id: input.app_id ?? options.appId,
        }),
      });
    },

    get(appId?: string): Promise<ConversationResponse> {
      return requestJson(`/projects/${options.projectId}/conversations/${encodedAppKey()}${appIdQuery(appId)}`);
    },

    send(input: string | ConversationTurnRequest): Promise<ConversationTurnResponse> {
      const body = typeof input === 'string' ? { text: input } : input;
      return requestJson(`/projects/${options.projectId}/conversations/${encodedAppKey()}/turns`, {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          app_id: body.app_id ?? options.appId,
        }),
      });
    },

    messages(input: { since?: string | Date; limit?: number; appId?: string } = {}): Promise<ThreadMessageListResponse> {
      const params = new URLSearchParams();
      if (input.appId ?? options.appId) params.set('app_id', input.appId ?? options.appId ?? '');
      if (input.since) params.set('since', input.since instanceof Date ? input.since.toISOString() : input.since);
      if (input.limit) params.set('limit', String(input.limit));
      const query = params.toString();
      return requestJson(`/projects/${options.projectId}/conversations/${encodedAppKey()}/messages${query ? `?${query}` : ''}`);
    },

    events(input: ConversationEventQueryOptions = {}): Promise<ConversationEventListResponse> {
      return requestJson(`/projects/${options.projectId}/conversations/${encodedAppKey()}/events${eventQuery(input)}`);
    },

    emitEvent(input: CreateConversationEventInput): Promise<ConversationEvent> {
      const { appId, ...body } = input;
      return requestJson(`/projects/${options.projectId}/conversations/${encodedAppKey()}/events${eventQuery({ appId })}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async *stream(input: StreamOptions = {}): AsyncGenerator<ConversationStreamEvent> {
      const h = await headers({ Accept: 'text/event-stream' });
      if (input.resumeFrom) h.set('Last-Event-ID', input.resumeFrom);
      const res = await fetchImpl(
        `${baseUrl}/projects/${options.projectId}/conversations/${encodedAppKey()}/stream${appIdQuery(input.appId)}`,
        { headers: h, signal: input.signal },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Eve conversation stream failed (${res.status}): ${body}`);
      }
      if (!res.body) throw new Error('Eve conversation stream response has no body');

      for await (const event of parseSseStream(res.body)) {
        if (event.event === 'snapshot' && isRecord(event.data)) {
          yield {
            kind: 'snapshot',
            eventId: event.id,
            thread: event.data.thread,
            messages: Array.isArray(event.data.messages) ? event.data.messages as ThreadMessage[] : [],
          };
        } else if (event.event === 'message') {
          yield { kind: 'message', eventId: event.id, message: event.data as ThreadMessage };
        } else if (event.event === 'progress') {
          yield { kind: 'progress', eventId: event.id, message: event.data as ThreadMessage };
        } else if (event.event === 'heartbeat') {
          yield { kind: 'heartbeat', eventId: event.id };
        } else {
          yield { kind: event.event, eventId: event.id, data: event.data };
        }
      }
    },

    async *streamEvents(input: ConversationEventQueryOptions = {}): AsyncGenerator<ConversationEventStreamEvent> {
      const h = await headers({ Accept: 'text/event-stream' });
      if (input.resumeFrom) h.set('Last-Event-ID', input.resumeFrom);
      const res = await fetchImpl(
        `${baseUrl}/projects/${options.projectId}/conversations/${encodedAppKey()}/events/stream${eventQuery(input)}`,
        { headers: h, signal: input.signal },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Eve conversation event stream failed (${res.status}): ${body}`);
      }
      if (!res.body) throw new Error('Eve conversation event stream response has no body');

      for await (const event of parseSseStream(res.body)) {
        if (event.event === 'snapshot' && isRecord(event.data)) {
          yield {
            kind: 'snapshot',
            eventId: event.id,
            thread: event.data.thread,
            events: Array.isArray(event.data.events) ? event.data.events as ConversationEvent[] : [],
          };
        } else if (event.event === 'heartbeat') {
          yield { kind: 'heartbeat', eventId: event.id };
        } else {
          yield { kind: event.event, eventId: event.id, event: event.data as ConversationEvent };
        }
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
