import { z } from 'zod';

export const IntegrationResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  provider: z.string(),
  account_id: z.string(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type IntegrationResponse = z.infer<typeof IntegrationResponseSchema>;

export const IntegrationListResponseSchema = z.object({
  integrations: z.array(IntegrationResponseSchema),
});

export type IntegrationListResponse = z.infer<typeof IntegrationListResponseSchema>;

export const SlackConnectRequestSchema = z.object({
  team_id: z.string().min(1),
  tokens_json: z.record(z.unknown()).optional(),
  status: z.string().optional(),
});

export type SlackConnectRequest = z.infer<typeof SlackConnectRequestSchema>;

export const IntegrationTestResponseSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
});

export type IntegrationTestResponse = z.infer<typeof IntegrationTestResponseSchema>;

export const IntegrationResolveRequestSchema = z.object({
  provider: z.string().min(1),
  account_id: z.string().min(1),
});

export type IntegrationResolveRequest = z.infer<typeof IntegrationResolveRequestSchema>;

export const IntegrationResolveResponseSchema = z.object({
  integration_id: z.string(),
  org_id: z.string(),
});

export type IntegrationResolveResponse = z.infer<typeof IntegrationResolveResponseSchema>;

export const ExternalIdentityResolveRequestSchema = z.object({
  provider: z.string().min(1),
  account_id: z.string().min(1),
  external_user_id: z.string().min(1),
  org_id: z.string().min(1),
  external_email: z.string().email().optional(),
});

export type ExternalIdentityResolveRequest = z.infer<typeof ExternalIdentityResolveRequestSchema>;

export const ExternalIdentityResolveResponseSchema = z.object({
  external_identity_id: z.string(),
  eve_user_id: z.string().nullable(),
  membership_request_id: z.string().nullable(),
});

export type ExternalIdentityResolveResponse = z.infer<typeof ExternalIdentityResolveResponseSchema>;

// ---------------------------------------------------------------------------
// Membership requests
// ---------------------------------------------------------------------------

export const MembershipRequestResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  external_identity_id: z.string(),
  status: z.string(),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type MembershipRequestResponse = z.infer<typeof MembershipRequestResponseSchema>;

export const MembershipRequestListResponseSchema = z.object({
  requests: z.array(MembershipRequestResponseSchema),
});

export type MembershipRequestListResponse = z.infer<typeof MembershipRequestListResponseSchema>;

export const MembershipRequestApproveRequestSchema = z.object({
  role: z.string().default('member'),
  email: z.string().email().optional(),
});

export type MembershipRequestApproveRequest = z.infer<typeof MembershipRequestApproveRequestSchema>;

// ---------------------------------------------------------------------------
// Identity link tokens
// ---------------------------------------------------------------------------

export const IdentityLinkTokenRequestSchema = z.object({
  provider: z.string().min(1),
  org_id: z.string().min(1),
});

export type IdentityLinkTokenRequest = z.infer<typeof IdentityLinkTokenRequestSchema>;

export const IdentityLinkTokenResponseSchema = z.object({
  token: z.string(),
  expires_in: z.number(),
  instructions: z.string(),
});

export type IdentityLinkTokenResponse = z.infer<typeof IdentityLinkTokenResponseSchema>;

export const IdentityLinkRedeemRequestSchema = z.object({
  token: z.string().min(1),
  provider: z.string().min(1),
  account_id: z.string().min(1),
  external_user_id: z.string().min(1),
});

export type IdentityLinkRedeemRequest = z.infer<typeof IdentityLinkRedeemRequestSchema>;

export const IdentityLinkRedeemResponseSchema = z.object({
  ok: z.boolean(),
  external_identity_id: z.string().optional(),
  error: z.string().optional(),
});

export type IdentityLinkRedeemResponse = z.infer<typeof IdentityLinkRedeemResponseSchema>;

// ---------------------------------------------------------------------------
// Integration settings
// ---------------------------------------------------------------------------

export const IntegrationSettingsUpdateRequestSchema = z.object({
  settings: z.record(z.unknown()),
});

export type IntegrationSettingsUpdateRequest = z.infer<typeof IntegrationSettingsUpdateRequestSchema>;

// ---------------------------------------------------------------------------
// OAuth app configs (per-org BYOA credentials)
// ---------------------------------------------------------------------------

export const CreateOAuthAppConfigRequestSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  label: z.string().optional(),
});

export type CreateOAuthAppConfigRequest = z.infer<typeof CreateOAuthAppConfigRequestSchema>;

export const OAuthAppConfigResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  provider: z.string(),
  client_id: z.string(),
  label: z.string().nullable(),
  status: z.string(),
  has_signing_secret: z.boolean().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type OAuthAppConfigResponse = z.infer<typeof OAuthAppConfigResponseSchema>;

export const ProviderSetupInfoResponseSchema = z.object({
  provider: z.string(),
  callback_url: z.string().nullable(),
  webhook_url: z.string().nullable(),
  required_scopes: z.array(z.string()),
  setup_instructions: z.string(),
});

export type ProviderSetupInfoResponse = z.infer<typeof ProviderSetupInfoResponseSchema>;
