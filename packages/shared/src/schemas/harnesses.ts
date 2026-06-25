import { z } from 'zod';
import { EnvOverridesSchema, InlineProfileBundleSchema } from './job.js';

export const HarnessVariantResponseSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(['default', 'config']).optional(),
});

export const HarnessAuthStatusResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string(),
  instructions: z.array(z.string()),
});

export const HarnessReasoningCapabilitySchema = z.object({
  supported: z.boolean(),
  levels: z.array(z.string()).optional(),
  mode: z.enum(['effort', 'thinking_tokens', 'level', 'unknown']).optional(),
  notes: z.string().optional(),
});

export const HarnessCapabilityResponseSchema = z.object({
  supports_model: z.boolean(),
  model_notes: z.string().optional(),
  model_examples: z.array(z.string()).optional(),
  reasoning: HarnessReasoningCapabilitySchema.optional(),
});

export const HarnessInfoResponseSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  description: z.string(),
  variants: z.array(HarnessVariantResponseSchema),
  auth: HarnessAuthStatusResponseSchema,
  capabilities: HarnessCapabilityResponseSchema.optional(),
});

export const HarnessListResponseSchema = z.object({
  data: z.array(HarnessInfoResponseSchema),
});

export type HarnessVariantResponse = z.infer<typeof HarnessVariantResponseSchema>;
export type HarnessAuthStatusResponse = z.infer<typeof HarnessAuthStatusResponseSchema>;
export type HarnessCapabilityResponse = z.infer<typeof HarnessCapabilityResponseSchema>;
export type HarnessInfoResponse = z.infer<typeof HarnessInfoResponseSchema>;
export type HarnessListResponse = z.infer<typeof HarnessListResponseSchema>;

// --------------------------------------------------------------------------
// Validation endpoint (Phase 2 of per-job harness override plan §3.5)
// --------------------------------------------------------------------------

export const HarnessProfileValidateRequestSchema = z.object({
  harness_profile_override: InlineProfileBundleSchema.optional(),
  env_overrides: EnvOverridesSchema.optional(),
}).refine(
  (v) => v.harness_profile_override || v.env_overrides,
  { message: 'at least one of harness_profile_override or env_overrides is required' },
);

export type HarnessProfileValidateRequest = z.infer<typeof HarnessProfileValidateRequestSchema>;

export const SecretRefStatusSchema = z.enum(['resolved', 'missing']);
export type SecretRefStatus = z.infer<typeof SecretRefStatusSchema>;

export const SecretRefScopeSchema = z.enum(['system', 'org', 'user', 'project']);
export type SecretRefScope = z.infer<typeof SecretRefScopeSchema>;

export const SecretRefReportSchema = z.object({
  key: z.string(),
  status: SecretRefStatusSchema,
  resolved_at: SecretRefScopeSchema.optional(),
  hint: z.string().optional(),
});

export type SecretRefReport = z.infer<typeof SecretRefReportSchema>;

export const HarnessValidateWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type HarnessValidateWarning = z.infer<typeof HarnessValidateWarningSchema>;

export const HarnessProfileValidateResponseSchema = z.object({
  ok: z.boolean(),
  harness: z.object({
    requested: z.string(),
    canonical: z.string().nullable(),
    auth: HarnessAuthStatusResponseSchema.nullable(),
  }),
  env_overrides: z.array(SecretRefReportSchema),
  warnings: z.array(HarnessValidateWarningSchema),
});

export type HarnessProfileValidateResponse = z.infer<typeof HarnessProfileValidateResponseSchema>;
