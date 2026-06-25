import { z } from 'zod';

export const AppLinkGrantResponseSchema = z.object({
  id: z.string(),
  producer_project_id: z.string(),
  export_kind: z.enum(['api', 'events']),
  export_name: z.string(),
  consumer_project_id: z.string(),
  api_scopes: z.array(z.string()),
  event_types: z.array(z.string()),
  envs: z.array(z.string()),
  service_name: z.string().nullable(),
  cli_name: z.string().nullable(),
  cli_image: z.string().nullable(),
  cli_bin_path: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AppLinkGrantResponse = z.infer<typeof AppLinkGrantResponseSchema>;

export const AppLinkSubscriptionResponseSchema = z.object({
  id: z.string(),
  consumer_project_id: z.string(),
  local_alias: z.string(),
  api_grant_id: z.string().nullable(),
  event_grant_id: z.string().nullable(),
  requested_scopes: z.array(z.string()),
  event_types: z.array(z.string()),
  environment_strategy: z.enum(['same', 'fixed']),
  producer_env_name: z.string().nullable(),
  inject_into_services: z.array(z.string()),
  inject_into_jobs: z.boolean(),
  last_token_minted_at: z.string().nullable(),
  last_token_principal: z.string().nullable(),
  last_token_audience: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AppLinkSubscriptionResponse = z.infer<typeof AppLinkSubscriptionResponseSchema>;

export const AppLinksListResponseSchema = z.object({
  project_id: z.string(),
  exports: z.array(AppLinkGrantResponseSchema),
  consumes: z.array(AppLinkSubscriptionResponseSchema),
  grants_to_project: z.array(AppLinkGrantResponseSchema),
});

export type AppLinksListResponse = z.infer<typeof AppLinksListResponseSchema>;

export const AppLinksExplainRequestSchema = z.object({
  consumer_project: z.string().optional(),
  producer_project: z.string().optional(),
  api: z.string().optional(),
  events: z.string().optional(),
  alias: z.string().optional(),
  env: z.string().optional(),
}).strict();

export type AppLinksExplainRequest = z.infer<typeof AppLinksExplainRequestSchema>;

export const AppLinksPlanRequestSchema = z.object({
  manifest_yaml: z.string().optional(),
  env: z.string().optional(),
}).strict();

export type AppLinksPlanRequest = z.infer<typeof AppLinksPlanRequestSchema>;

export const AppLinkDiagnosticSchema = z.object({
  level: z.enum(['ok', 'warning', 'error']),
  message: z.string(),
});

export type AppLinkDiagnostic = z.infer<typeof AppLinkDiagnosticSchema>;

export const AppLinksExplainResponseSchema = z.object({
  status: z.enum(['OK', 'MISSING', 'REVOKED', 'INVALID']),
  diagnostics: z.array(AppLinkDiagnosticSchema),
  grant: AppLinkGrantResponseSchema.nullable(),
  subscription: AppLinkSubscriptionResponseSchema.nullable(),
});

export type AppLinksExplainResponse = z.infer<typeof AppLinksExplainResponseSchema>;

export const AppLinksPlanResponseSchema = z.object({
  valid: z.boolean(),
  diagnostics: z.array(AppLinkDiagnosticSchema),
});

export type AppLinksPlanResponse = z.infer<typeof AppLinksPlanResponseSchema>;
