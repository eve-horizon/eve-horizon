import { z } from 'zod';
import { createApiListResponseSchema } from './common.js';

export const ResolveResourcesRequestSchema = z.object({
  uris: z.array(z.string().min(1)),
  include_content: z.boolean().optional().default(false),
});

export type ResolveResourcesRequest = z.infer<typeof ResolveResourcesRequestSchema>;

export const ResolvedResourceSchema = z.object({
  uri: z.string(),
  content: z.string().optional(),
  content_hash: z.string(),
  mime_type: z.string(),
  version: z.number().int().optional(),
  resolved_at: z.string(),
});

export type ResolvedResource = z.infer<typeof ResolvedResourceSchema>;

export const ResolveResourcesListResponseSchema = createApiListResponseSchema(ResolvedResourceSchema);

export type ResolveResourcesListResponse = z.infer<typeof ResolveResourcesListResponseSchema>;
