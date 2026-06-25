import { z } from 'zod';
import { PaginationSchema } from './common.js';

export const SecretTypeSchema = z.enum(['env_var', 'file', 'github_token', 'ssh_key']);
export type SecretType = z.infer<typeof SecretTypeSchema>;

export const CreateSecretRequestSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  type: SecretTypeSchema.optional().default('env_var'),
});

export type CreateSecretRequest = z.infer<typeof CreateSecretRequestSchema>;

export const UpdateSecretRequestSchema = z.object({
  value: z.string().min(1).optional(),
  type: SecretTypeSchema.optional(),
});

export type UpdateSecretRequest = z.infer<typeof UpdateSecretRequestSchema>;

export const SecretResponseSchema = z.object({
  id: z.string(),
  scope_type: z.enum(['user', 'org', 'project', 'system']),
  scope_id: z.string(),
  key: z.string(),
  type: SecretTypeSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export type SecretResponse = z.infer<typeof SecretResponseSchema>;

export const SecretMaskedResponseSchema = SecretResponseSchema.extend({
  masked_value: z.string(),
});

export type SecretMaskedResponse = z.infer<typeof SecretMaskedResponseSchema>;

export const SecretListResponseSchema = z.object({
  data: z.array(SecretResponseSchema),
  pagination: PaginationSchema,
});

export type SecretListResponse = z.infer<typeof SecretListResponseSchema>;

export const SecretResolveRequestSchema = z.object({
  project_id: z.string(),
  user_id: z.string().optional(),
});

export type SecretResolveRequest = z.infer<typeof SecretResolveRequestSchema>;

export const SecretResolveItemSchema = z.object({
  key: z.string(),
  value: z.string(),
  type: SecretTypeSchema,
  scope_type: z.enum(['user', 'org', 'project', 'system']).optional(),
  scope_id: z.string().optional(),
});

export type SecretResolveItem = z.infer<typeof SecretResolveItemSchema>;

export const SecretResolveResponseSchema = z.object({
  data: z.array(SecretResolveItemSchema),
});

export type SecretResolveResponse = z.infer<typeof SecretResolveResponseSchema>;

export const SecretMissingItemSchema = z.object({
  key: z.string(),
  hints: z.array(z.string()),
  suggestion: z.string().optional(),
});

export type SecretMissingItem = z.infer<typeof SecretMissingItemSchema>;

export const SecretValidationResultSchema = z.object({
  missing: z.array(SecretMissingItemSchema),
});

export type SecretValidationResult = z.infer<typeof SecretValidationResultSchema>;

export const SecretValidateRequestSchema = z.object({
  keys: z.array(z.string()).min(1).optional(),
  manifest_yaml: z.string().min(1).optional(),
});

export type SecretValidateRequest = z.infer<typeof SecretValidateRequestSchema>;

export const SecretEnsureRequestSchema = z.object({
  keys: z.array(z.string()).min(1),
});

export type SecretEnsureRequest = z.infer<typeof SecretEnsureRequestSchema>;

export const SecretEnsureResponseSchema = z.object({
  created: z.array(z.string()),
  existing: z.array(z.string()),
});

export type SecretEnsureResponse = z.infer<typeof SecretEnsureResponseSchema>;

export const SecretExportRequestSchema = z.object({
  keys: z.array(z.string()).min(1),
});

export type SecretExportRequest = z.infer<typeof SecretExportRequestSchema>;

export const SecretExportItemSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export type SecretExportItem = z.infer<typeof SecretExportItemSchema>;

export const SecretExportResponseSchema = z.object({
  data: z.array(SecretExportItemSchema),
});

export type SecretExportResponse = z.infer<typeof SecretExportResponseSchema>;
