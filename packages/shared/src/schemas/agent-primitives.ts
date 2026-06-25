import { z } from 'zod';
import { EnvOverridesSchema, InlineProfileBundleSchema } from './job.js';

export const TeamResponseSchema = z.object({
  id: z.string(),
  lead_agent_id: z.string().nullable().optional(),
  dispatch: z.record(z.unknown()).nullable().optional(),
  members: z.array(z.string()),
});

export type TeamResponse = z.infer<typeof TeamResponseSchema>;

export const TeamListResponseSchema = z.object({
  teams: z.array(TeamResponseSchema),
});

export type TeamListResponse = z.infer<typeof TeamListResponseSchema>;

export const RouteResponseSchema = z.object({
  id: z.string(),
  match: z.string(),
  target: z.string(),
  providers: z.array(z.string()).optional(),
  account_ids: z.array(z.string()).optional(),
  permissions: z.record(z.unknown()).optional(),
});

export type RouteResponse = z.infer<typeof RouteResponseSchema>;

export const RouteListResponseSchema = z.object({
  routes: z.array(RouteResponseSchema),
});

export type RouteListResponse = z.infer<typeof RouteListResponseSchema>;

export const ThreadResponseSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  org_id: z.string().nullable().optional(),
  scope: z.string().optional(),
  key: z.string(),
  channel: z.string().nullable().optional(),
  peer: z.string().nullable().optional(),
  policy: z.record(z.unknown()).nullable().optional(),
  summary: z.string().nullable().optional(),
  workspace_key: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ThreadResponse = z.infer<typeof ThreadResponseSchema>;

export const ThreadListResponseSchema = z.object({
  threads: z.array(ThreadResponseSchema),
});

export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;

export const ThreadMessageResponseSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  kind: z.enum(['message', 'progress']).default('message'),
  actor_type: z.string().nullable().optional(),
  actor_id: z.string().nullable().optional(),
  body: z.string(),
  job_id: z.string().nullable().optional(),
  delivery_status: z.string().nullable().optional(),
  delivery_error: z.string().nullable().optional(),
  delivered_at: z.string().nullable().optional(),
  created_at: z.string(),
});

export type ThreadMessageResponse = z.infer<typeof ThreadMessageResponseSchema>;

export const ThreadMessageListResponseSchema = z.object({
  messages: z.array(ThreadMessageResponseSchema),
  total: z.number().optional(),
});

export type ThreadMessageListResponse = z.infer<typeof ThreadMessageListResponseSchema>;

export const CreateThreadMessageRequestSchema = z.object({
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
  kind: z.enum(['message', 'progress']).optional(),
  actor_type: z.string().nullable().optional(),
  actor_id: z.string().nullable().optional(),
  body: z.string().min(1),
  job_id: z.string().nullable().optional(),
});

export type CreateThreadMessageRequest = z.infer<typeof CreateThreadMessageRequestSchema>;

export const ConversationStandardEventKindSchema = z.enum([
  'user.message',
  'assistant.message',
  'text.delta',
  'tool.call',
  'tool.result',
  'status.changed',
  'progress',
  'error',
  'attachment.added',
  'file.change',
  'delivery.status',
  'final.result',
]);

export type ConversationStandardEventKind = z.infer<typeof ConversationStandardEventKindSchema>;

export const ConversationEventKindSchema = z.string()
  .min(1)
  .max(150)
  .regex(/^[a-z][a-z0-9_.-]*$/);

export type ConversationEventKind = z.infer<typeof ConversationEventKindSchema>;

export const ConversationEventResponseSchema = z.object({
  id: z.string(),
  cursor: z.string(),
  seq: z.number(),
  thread_id: z.string(),
  project_id: z.string().nullable().optional(),
  org_id: z.string().nullable().optional(),
  kind: ConversationEventKindSchema,
  source: z.string(),
  actor_type: z.string().nullable().optional(),
  actor_id: z.string().nullable().optional(),
  job_id: z.string().nullable().optional(),
  attempt_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  workflow_step: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  message_id: z.string().nullable().optional(),
  event_id: z.string().nullable().optional(),
  log_id: z.string().nullable().optional(),
  attachment_id: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  delivery_status: z.string().nullable().optional(),
  payload: z.record(z.unknown()),
  created_at: z.string(),
});

export type ConversationEventResponse = z.infer<typeof ConversationEventResponseSchema>;

export const ConversationEventListResponseSchema = z.object({
  events: z.array(ConversationEventResponseSchema),
  total: z.number().optional(),
});

export type ConversationEventListResponse = z.infer<typeof ConversationEventListResponseSchema>;

export const CreateConversationEventRequestSchema = z.object({
  kind: ConversationEventKindSchema,
  source: z.string().min(1).max(100).optional(),
  actor_type: z.string().nullable().optional(),
  actor_id: z.string().nullable().optional(),
  job_id: z.string().nullable().optional(),
  attempt_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  workflow_step: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  delivery_status: z.string().nullable().optional(),
  payload: z.record(z.unknown()).optional(),
});

export type CreateConversationEventRequest = z.infer<typeof CreateConversationEventRequestSchema>;

/**
 * Per-message overrides a caller can attach to a chat dispatch, threaded
 * through to every lead + member job the chat dispatch creates. See
 * docs/plans/per-job-harness-override-plan.md §3.4 / Phase 3.
 *
 * Gateways MUST NOT interpolate secret refs — placeholders flow through
 * intact and resolve at job spawn time inside the invoke module.
 */
export const ChatHintsSchema = z.object({
  harness_profile_override: InlineProfileBundleSchema.optional(),
  env_overrides: EnvOverridesSchema.optional(),
}).strict();

export type ChatHints = z.infer<typeof ChatHintsSchema>;

export const ThreadChatRequestSchema = z.object({
  text: z.string().min(1),
  actor_id: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  hints: ChatHintsSchema.optional(),
});

export type ThreadChatRequest = z.infer<typeof ThreadChatRequestSchema>;

export const ScheduleResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  cron: z.string(),
  event_type: z.string(),
  payload: z.record(z.unknown()).nullable().optional(),
  enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;

export const ScheduleListResponseSchema = z.object({
  schedules: z.array(ScheduleResponseSchema),
});

export type ScheduleListResponse = z.infer<typeof ScheduleListResponseSchema>;

export const CreateScheduleRequestSchema = z.object({
  cron: z.string().min(1),
  event_type: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const ChatRouteRequestSchema = z.object({
  provider: z.string().min(1),
  account_id: z.string().min(1),
  channel_id: z.string().optional(),
  user_id: z.string().optional(),
  text: z.string().min(1),
  thread_key: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  hints: ChatHintsSchema.optional(),
});

export type ChatRouteRequest = z.infer<typeof ChatRouteRequestSchema>;

export const ChatSimulateRequestSchema = z.object({
  provider: z.string().min(1),
  team_id: z.string().min(1),
  channel_id: z.string().optional(),
  user_id: z.string().optional(),
  text: z.string().min(1),
  thread_key: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  hints: ChatHintsSchema.optional(),
});

export type ChatSimulateRequest = z.infer<typeof ChatSimulateRequestSchema>;

export const ChatRouteResponseSchema = z.object({
  thread_id: z.string(),
  thread_key: z.string().nullable(),
  route_id: z.string().nullable(),
  target: z.string().nullable(),
  job_ids: z.array(z.string()),
  event_id: z.string().nullable(),
  denied: z.boolean().optional(),
  denial_reason: z.string().optional(),
});

export type ChatRouteResponse = z.infer<typeof ChatRouteResponseSchema>;

export const ConversationTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('route'),
    route_id: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('agent'),
    agent_slug: z.string().min(1),
  }),
  z.object({
    kind: z.literal('team'),
    team_id: z.string().min(1),
  }),
]);

export type ConversationTarget = z.infer<typeof ConversationTargetSchema>;

export const EnsureConversationRequestSchema = z.object({
  app_key: z.string().min(1),
  app_id: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  text: z.string().min(1).optional(),
  actor_id: z.string().nullable().optional(),
  target: ConversationTargetSchema.optional(),
  hints: ChatHintsSchema.optional(),
});

export type EnsureConversationRequest = z.infer<typeof EnsureConversationRequestSchema>;

export const ConversationResponseSchema = z.object({
  thread_id: z.string(),
  key: z.string(),
  app_key: z.string(),
  app_id: z.string(),
  metadata: z.record(z.unknown()),
  current_target: z.object({
    kind: z.enum(['route', 'agent', 'team']),
    target: z.string(),
    route_id: z.string().nullable().optional(),
    agent_slug: z.string().nullable().optional(),
  }).nullable(),
  last_message: ThreadMessageResponseSchema.nullable().optional(),
});

export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

export const ConversationTurnRequestSchema = z.object({
  text: z.string().min(1),
  app_id: z.string().min(1).optional(),
  actor_id: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  target: ConversationTargetSchema.optional(),
  hints: ChatHintsSchema.optional(),
});

export type ConversationTurnRequest = z.infer<typeof ConversationTurnRequestSchema>;

export const ConversationTurnResponseSchema = ChatRouteResponseSchema.extend({
  app_key: z.string(),
  app_id: z.string(),
  dispatch_status: z.enum(['queued', 'denied', 'no_route']),
});

export type ConversationTurnResponse = z.infer<typeof ConversationTurnResponseSchema>;

export const ChatRouteBySlugRequestSchema = ChatRouteRequestSchema.extend({
  agent_slug_hint: z.string().min(1),
  command_text: z.string().optional(),
  raw_text: z.string().min(1),
});

export type ChatRouteBySlugRequest = z.infer<typeof ChatRouteBySlugRequestSchema>;

export const ChatListenerScopeSchema = z.enum(['channel', 'thread']);

export type ChatListenerScope = z.infer<typeof ChatListenerScopeSchema>;

export const ChatListenRequestSchema = z.object({
  provider: z.string().min(1),
  account_id: z.string().min(1),
  channel_id: z.string().optional(),
  thread_key: z.string().min(1),
  scope: ChatListenerScopeSchema,
  agent_slug: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export type ChatListenRequest = z.infer<typeof ChatListenRequestSchema>;

export const ChatListenResponseSchema = z.object({
  thread_id: z.string(),
  thread_key: z.string(),
  scope: ChatListenerScopeSchema,
  agent_id: z.string(),
  agent_slug: z.string().min(1),
  project_id: z.string(),
  project_slug: z.string(),
});

export type ChatListenResponse = z.infer<typeof ChatListenResponseSchema>;

export const ChatUnlistenResponseSchema = z.object({
  removed: z.boolean(),
  scope: ChatListenerScopeSchema,
  agent_slug: z.string().min(1),
  project_slug: z.string(),
});

export type ChatUnlistenResponse = z.infer<typeof ChatUnlistenResponseSchema>;

export const ChatListenersRequestSchema = z.object({
  channel_key: z.string().optional(),
  thread_key: z.string().optional(),
});

export type ChatListenersRequest = z.infer<typeof ChatListenersRequestSchema>;

export const ChatListenerEntrySchema = z.object({
  project_id: z.string(),
  project_slug: z.string(),
  project_name: z.string(),
  agent_id: z.string(),
  agent_slug: z.string().nullable(),
  agent_name: z.string().nullable(),
  agent_description: z.string().nullable(),
});

export type ChatListenerEntry = z.infer<typeof ChatListenerEntrySchema>;

export const ChatListenersResponseSchema = z.object({
  channel_key: z.string().nullable(),
  thread_key: z.string().nullable(),
  channel_listeners: z.array(ChatListenerEntrySchema),
  thread_listeners: z.array(ChatListenerEntrySchema),
});

export type ChatListenersResponse = z.infer<typeof ChatListenersResponseSchema>;

export const ChatDispatchRequestSchema = ChatRouteRequestSchema.extend({
  thread_key: z.string().min(1),
  channel_key: z.string().optional(),
});

export type ChatDispatchRequest = z.infer<typeof ChatDispatchRequestSchema>;

export const ChatDispatchResponseSchema = z.object({
  job_ids: z.array(z.string()),
});

export type ChatDispatchResponse = z.infer<typeof ChatDispatchResponseSchema>;

export const ChatDeliverRequestSchema = z.object({
  job_id: z.string().min(1).optional(),   // optional for progress messages
  thread_id: z.string().min(1),
  text: z.string().min(1),
  agent_id: z.string().optional(),
  progress: z.boolean().optional(),       // marks this as a progress update (not final result)
});

export type ChatDeliverRequest = z.infer<typeof ChatDeliverRequestSchema>;
