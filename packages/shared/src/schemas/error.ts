import { z } from 'zod';

export const ApiErrorDetailSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export const ApiErrorResponseSchema = z.object({
  error: ApiErrorDetailSchema,
  request_id: z.string().optional(),
});

export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
