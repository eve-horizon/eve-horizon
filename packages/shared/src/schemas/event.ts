import { z } from 'zod';
import { PaginationSchema } from './common.js';

// Event source enum.
// 'auth' formalizes the existing auth.domain_signup.* and the new
// auth.action_link.wrap_redeemed event from the magic-link interstitial.
const EventSourceSchema = z.enum(['github', 'slack', 'cron', 'manual', 'app', 'app_link', 'system', 'runner', 'chat', 'auth']);

// Event status enum
const EventStatusSchema = z.enum(['pending', 'processing', 'completed', 'failed']);

// Actor type enum
const ActorTypeSchema = z.enum(['user', 'system', 'app']);

// Trigger evaluation entry — records whether a specific trigger matched and why
const TriggerEvaluationEntrySchema = z.object({
  type: z.string(),
  name: z.string(),
  matched: z.boolean(),
  reason: z.string().optional(),
  subscription_id: z.string().optional(),
  delivery_id: z.string().optional(),
});

// Base event schema
export const EventSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  type: z.string(),
  source: EventSourceSchema,
  env_name: z.string().nullable(),
  ref_sha: z.string().nullable(),
  ref_branch: z.string().nullable(),
  actor_type: ActorTypeSchema.nullable(),
  actor_id: z.string().nullable(),
  payload_json: z.record(z.unknown()).nullable(),
  dedupe_key: z.string().nullable(),
  job_id: z.string().nullable(),
  trigger_match_count: z.number().int().nullable(),
  triggers_evaluated: z.array(TriggerEvaluationEntrySchema).nullable(),
  status: EventStatusSchema,
  processed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Event = z.infer<typeof EventSchema>;

// Create event request schema
// Accepts both `payload_json` (canonical) and `payload` (convenience alias for app developers)
export const CreateEventRequestSchema = z.object({
  type: z.string().min(1, 'Event type is required'),
  source: EventSourceSchema,
  env_name: z.string().optional().nullable(),
  ref_sha: z.string().optional().nullable(),
  ref_branch: z.string().optional().nullable(),
  actor_type: ActorTypeSchema.optional().nullable(),
  actor_id: z.string().optional().nullable(),
  payload_json: z.record(z.unknown()).optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
  dedupe_key: z.string().optional().nullable(),
}).transform((data) => {
  // Merge payload into payload_json if payload_json is not set
  const { payload, ...rest } = data;
  return {
    ...rest,
    payload_json: rest.payload_json ?? payload ?? null,
  };
});

export type CreateEventRequest = z.infer<typeof CreateEventRequestSchema>;

// Event response schema (same as EventSchema)
export const EventResponseSchema = EventSchema;

export type EventResponse = z.infer<typeof EventResponseSchema>;

// Event list response schema
export const EventListResponseSchema = z.object({
  data: z.array(EventResponseSchema),
  pagination: PaginationSchema,
});

export type EventListResponse = z.infer<typeof EventListResponseSchema>;

// Export enums as types
export type EventSource = z.infer<typeof EventSourceSchema>;
export type EventStatus = z.infer<typeof EventStatusSchema>;
export type ActorType = z.infer<typeof ActorTypeSchema>;
