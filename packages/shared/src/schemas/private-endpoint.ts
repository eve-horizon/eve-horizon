import { z } from 'zod';
import { PaginationSchema } from './common.js';

export const PrivateEndpointProviderSchema = z.enum(['tailscale']);
export type PrivateEndpointProvider = z.infer<typeof PrivateEndpointProviderSchema>;

export const PrivateEndpointStatusSchema = z.enum(['pending', 'ready', 'error']);
export type PrivateEndpointStatus = z.infer<typeof PrivateEndpointStatusSchema>;

// DNS-safe name: lowercase alphanumeric + hyphens, max 53 chars
const DNS_SAFE_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const CreatePrivateEndpointRequestSchema = z.object({
  name: z.string()
    .min(1)
    .max(53)
    .regex(DNS_SAFE_REGEX, 'Name must be DNS-safe: lowercase alphanumeric and hyphens, cannot start or end with a hyphen'),
  provider: PrivateEndpointProviderSchema.optional().default('tailscale'),
  hostname: z.string().min(1, 'Tailscale hostname is required'),
  port: z.number().int().min(1).max(65535),
  health_path: z.string().nullable().optional().default('/v1/models'),
  metadata: z.record(z.unknown()).optional(),
});

export type CreatePrivateEndpointRequest = z.infer<typeof CreatePrivateEndpointRequestSchema>;

export const PrivateEndpointResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  org_id: z.string(),
  provider: z.string(),
  hostname: z.string(),
  port: z.number(),
  protocol: z.string(),
  status: PrivateEndpointStatusSchema,
  status_msg: z.string().nullable(),
  k8s_svc_name: z.string(),
  k8s_namespace: z.string(),
  k8s_dns: z.string().nullable(),
  health_path: z.string().nullable(),
  cluster_url: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type PrivateEndpointResponse = z.infer<typeof PrivateEndpointResponseSchema>;

export const PrivateEndpointListResponseSchema = z.object({
  data: z.array(PrivateEndpointResponseSchema),
  pagination: PaginationSchema,
});

export type PrivateEndpointListResponse = z.infer<typeof PrivateEndpointListResponseSchema>;

export const PrivateEndpointHealthSchema = z.object({
  endpoint: PrivateEndpointResponseSchema,
  health: z.object({
    checked_at: z.string(),
    reachable: z.boolean(),
    http_status: z.number().nullable(),
    response_time_ms: z.number().nullable(),
    error: z.string().nullable(),
  }),
});

export type PrivateEndpointHealth = z.infer<typeof PrivateEndpointHealthSchema>;

export const PrivateEndpointDiagnoseSchema = z.object({
  endpoint: PrivateEndpointResponseSchema,
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    detail: z.string().nullable(),
  })),
});

export type PrivateEndpointDiagnose = z.infer<typeof PrivateEndpointDiagnoseSchema>;
