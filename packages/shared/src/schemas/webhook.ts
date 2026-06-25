import { z } from 'zod';
import { createApiListResponseSchema } from './common.js';

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateWebhookRequestSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  filter: z.record(z.unknown()).optional(),
  secret: z.string().min(16).max(256),
});

export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

export const WebhookReplayRequestSchema = z.object({
  from: z
    .object({
      event_id: z.string(),
    })
    .optional(),
  to: z
    .object({
      time: z.string(),
    })
    .optional(),
  max_events: z.number().int().positive().max(10000).optional(),
  dry_run: z.boolean().optional(),
});

export type WebhookReplayRequest = z.infer<typeof WebhookReplayRequestSchema>;

// ============================================================================
// Response Schemas
// ============================================================================

export const WebhookResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string().nullable().optional(),
  url: z.string(),
  events: z.array(z.string()),
  filter: z.record(z.unknown()).optional(),
  active: z.boolean(),
  created_by: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WebhookResponse = z.infer<typeof WebhookResponseSchema>;

export const WebhookListResponseSchema = createApiListResponseSchema(WebhookResponseSchema);

export type WebhookListResponse = z.infer<typeof WebhookListResponseSchema>;

export const WebhookDeliveryResponseSchema = z.object({
  id: z.string(),
  subscription_id: z.string(),
  event_id: z.string().nullable().optional(),
  event_type: z.string(),
  status: z.string(),
  attempts: z.number(),
  last_attempt_at: z.string().nullable().optional(),
  response_status: z.number().nullable().optional(),
  created_at: z.string(),
});

export type WebhookDeliveryResponse = z.infer<typeof WebhookDeliveryResponseSchema>;

export const WebhookDeliveryListResponseSchema = createApiListResponseSchema(WebhookDeliveryResponseSchema);

export type WebhookDeliveryListResponse = z.infer<typeof WebhookDeliveryListResponseSchema>;

export const WebhookReplayDryRunResponseSchema = z.object({
  event_count: z.number().int(),
  earliest: z.string().nullable().optional(),
  latest: z.string().nullable().optional(),
  would_deduplicate: z.number().int(),
});

export type WebhookReplayDryRunResponse = z.infer<typeof WebhookReplayDryRunResponseSchema>;

export const WebhookReplayResponseSchema = z.object({
  replay_id: z.string(),
  status: z.string(),
  requested: z.number().int(),
  deduplicated: z.number().int(),
  enqueued_at: z.string(),
});

export type WebhookReplayResponse = z.infer<typeof WebhookReplayResponseSchema>;

export const WebhookReplayStatusResponseSchema = z.object({
  replay_id: z.string(),
  subscription_id: z.string(),
  status: z.string(),
  requested: z.number().int(),
  processed: z.number().int(),
  replayed: z.number().int(),
  deduplicated: z.number().int(),
  failed: z.number().int(),
  started_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

export type WebhookReplayStatusResponse = z.infer<typeof WebhookReplayStatusResponseSchema>;

// ============================================================================
// CloudEvents Envelope
// ============================================================================

export const CloudEventPayloadSchema = z.object({
  specversion: z.literal('1.0'),
  type: z.string(),
  source: z.string(),
  id: z.string(),
  time: z.string(),
  data: z.record(z.unknown()),
});

export type CloudEventPayload = z.infer<typeof CloudEventPayloadSchema>;
