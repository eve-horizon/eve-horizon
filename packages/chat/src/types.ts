export type ConversationTarget =
  | { kind: 'route'; route_id?: string }
  | { kind: 'agent'; agent_slug: string }
  | { kind: 'team'; team_id: string };

export interface EnsureConversationRequest {
  app_key?: string;
  app_id?: string;
  metadata?: Record<string, unknown>;
  text?: string;
  actor_id?: string | null;
  target?: ConversationTarget;
  hints?: Record<string, unknown>;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  direction: 'inbound' | 'outbound';
  kind: 'message' | 'progress';
  actor_type?: string | null;
  actor_id?: string | null;
  body: string;
  job_id?: string | null;
  delivery_status?: string | null;
  delivery_error?: string | null;
  delivered_at?: string | null;
  created_at: string;
}

export interface ThreadMessageListResponse {
  messages: ThreadMessage[];
  total?: number;
}

export interface ConversationEvent {
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
}

export interface ConversationEventListResponse {
  events: ConversationEvent[];
  total?: number;
}

export interface CreateConversationEventRequest {
  kind: string;
  source?: string;
  actor_type?: string | null;
  actor_id?: string | null;
  job_id?: string | null;
  attempt_id?: string | null;
  agent_id?: string | null;
  workflow_step?: string | null;
  run_id?: string | null;
  text?: string | null;
  delivery_status?: string | null;
  payload?: Record<string, unknown>;
}

export interface ConversationResponse {
  thread_id: string;
  key: string;
  app_key: string;
  app_id: string;
  metadata: Record<string, unknown>;
  current_target: {
    kind: 'route' | 'agent' | 'team';
    target: string;
    route_id?: string | null;
    agent_slug?: string | null;
  } | null;
  last_message?: ThreadMessage | null;
}

export interface ConversationTurnRequest {
  text: string;
  app_id?: string;
  actor_id?: string | null;
  metadata?: Record<string, unknown>;
  target?: ConversationTarget;
  hints?: Record<string, unknown>;
}

export interface ConversationTurnResponse {
  thread_id: string;
  thread_key: string | null;
  route_id: string | null;
  target: string | null;
  job_ids: string[];
  event_id: string | null;
  denied?: boolean;
  denial_reason?: string;
  app_key: string;
  app_id: string;
  dispatch_status: 'queued' | 'denied' | 'no_route';
}

export type ConversationStreamEvent =
  | { kind: 'snapshot'; eventId?: string; thread: unknown; messages: ThreadMessage[] }
  | { kind: 'message'; eventId?: string; message: ThreadMessage }
  | { kind: 'progress'; eventId?: string; message: ThreadMessage }
  | { kind: 'heartbeat'; eventId?: string }
  | { kind: string; eventId?: string; data: unknown };

export type ConversationEventStreamEvent =
  | { kind: 'snapshot'; eventId?: string; thread: unknown; events: ConversationEvent[] }
  | { kind: 'heartbeat'; eventId?: string }
  | { kind: string; eventId?: string; event: ConversationEvent };

export interface ConversationClientOptions {
  baseUrl: string;
  projectId: string;
  appKey: string;
  appId?: string;
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: typeof fetch;
}

export interface StreamOptions {
  appId?: string;
  resumeFrom?: string;
  signal?: AbortSignal;
}

export interface ConversationEventQueryOptions extends StreamOptions {
  after?: string;
  kind?: string | string[];
  jobId?: string;
  attemptId?: string;
  workflowStep?: string;
  source?: string;
  limit?: number;
}

export type CreateConversationEventInput = CreateConversationEventRequest & {
  appId?: string;
};
