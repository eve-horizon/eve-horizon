import { z } from 'zod';

export const NotificationProviderSchema = z.enum(['slack']);

export const NotificationSendRequestSchema = z.object({
  provider: NotificationProviderSchema.default('slack'),
  channel: z.string().min(1),
  message: z.string().min(1).max(40000),
  thread_id: z.string().min(1).optional(),
  integration_id: z.string().min(1).optional(),
});

export type NotificationSendRequest = z.infer<typeof NotificationSendRequestSchema>;

export const NotificationSendResponseSchema = z.object({
  delivered: z.boolean(),
  provider: NotificationProviderSchema,
  integration_id: z.string(),
  channel: z.string(),
  channel_id: z.string(),
  message_ts: z.string().optional(),
});

export type NotificationSendResponse = z.infer<typeof NotificationSendResponseSchema>;
