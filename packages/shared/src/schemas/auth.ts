import { z } from 'zod';
import { createApiListResponseSchema, MemberRoleSchema, OrgProjectScopeSchema } from './common.js';
import { ProjectAuthConfigSchema, ProjectBrandingSchema } from './manifest.js';
import { AccessBindingScopeSchema } from './access-scope.js';
export {
  AccessScopePrefixesSchema,
  AccessScopeEnvDbSchema,
  AccessScopeCloudFsSchema,
  AccessBindingScopeSchema,
  type AccessBindingScope,
} from './access-scope.js';

export const AuthStatusResponseSchema = z.object({
  auth_enabled: z.boolean(),
  authenticated: z.boolean(),
  type: z.enum(['user', 'job', 'service', 'service_principal', 'app_link']).optional(),
  user_id: z.string().optional(),
  email: z.string().optional(),
  org_id: z.string().nullable().optional(),
  project_id: z.string().optional(),
  job_id: z.string().optional(),
  service_name: z.string().optional(),
  env_name: z.string().optional(),
  subscription_id: z.string().optional(),
  consumer_project_id: z.string().optional(),
  producer_project_id: z.string().optional(),
  consumer_principal: z.string().optional(),
  consumer_env: z.string().nullable().optional(),
  producer_env: z.string().optional(),
  api_name: z.string().optional(),
  role: z.string().optional(),
  is_admin: z.boolean().optional(),
  is_job_token: z.boolean().optional(),
  is_service_token: z.boolean().optional(),
  is_service_principal: z.boolean().optional(),
  is_app_link_token: z.boolean().optional(),
  permissions: z.array(z.string()).optional(),
  memberships: z.array(z.object({
    org_id: z.string(),
    role: z.string(),
    org_name: z.string().optional(),
    org_slug: z.string().optional(),
  })).optional(),
  /** Project-level role when X-Eve-Project-Id header is provided */
  project_role: MemberRoleSchema.nullable().optional(),
});

export type AuthStatusResponse = z.infer<typeof AuthStatusResponseSchema>;

export const AuthChallengeRequestSchema = z.object({
  provider: z.enum(['github_ssh', 'nostr']).default('github_ssh'),
  email: z.string().email().optional(),
  user_id: z.string().optional(),
  pubkey: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.provider === 'github_ssh') {
    if (!value.email && !value.user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'email or user_id is required for github_ssh' });
    }
  }
  if (value.provider === 'nostr') {
    if (!value.pubkey && !value.email && !value.user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pubkey or (email/user_id) is required for nostr' });
    }
  }
});

export type AuthChallengeRequest = z.infer<typeof AuthChallengeRequestSchema>;

export const AuthChallengeResponseSchema = z.object({
  challenge_id: z.string(),
  nonce: z.string(),
  expires_at: z.string(),
});

export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponseSchema>;

export const AuthVerifyRequestSchema = z.object({
  challenge_id: z.string(),
  signature: z.string(),
  ttl_days: z.coerce.number().int().min(1).max(90).optional(),
  invite_code: z.string().optional(),
});

export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;

export const AuthVerifyResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().default('bearer'),
  expires_at: z.number(),
  user_id: z.string(),
});

export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponseSchema>;

export const AuthBootstrapRequestSchema = z.object({
  token: z.string().optional(),
  email: z.string().email(),
  public_key: z.string(),
  display_name: z.string().optional(),
});

export type AuthBootstrapRequest = z.infer<typeof AuthBootstrapRequestSchema>;

export const BootstrapModeSchema = z.enum(['auto-open', 'recovery', 'secure', 'closed']);
export type BootstrapMode = z.infer<typeof BootstrapModeSchema>;

export const AuthBootstrapStatusResponseSchema = z.object({
  completed: z.boolean(),
  window_open: z.boolean(),
  window_closes_at: z.string().nullable(),
  requires_token: z.boolean(),
  mode: BootstrapModeSchema,
});

export type AuthBootstrapStatusResponse = z.infer<typeof AuthBootstrapStatusResponseSchema>;

export const AuthBootstrapResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().default('bearer'),
  expires_at: z.number(),
  user_id: z.string(),
});

export type AuthBootstrapResponse = z.infer<typeof AuthBootstrapResponseSchema>;

export const AuthIdentityRequestSchema = z.object({
  user_id: z.string().optional(),
  email: z.string().email().optional(),
  public_key: z.string(),
  label: z.string().optional(),
});

export type AuthIdentityRequest = z.infer<typeof AuthIdentityRequestSchema>;

export const AuthIdentityResponseSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  provider: z.enum(['github_ssh', 'nostr']),
  fingerprint: z.string(),
  label: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AuthIdentityResponse = z.infer<typeof AuthIdentityResponseSchema>;

export const AuthMintRequestSchema = z.object({
  email: z.string().email(),
  org_id: z.string().optional(),
  project_id: z.string().optional(),
  role: z.enum(['admin', 'member']).default('member'),
  ttl_days: z.coerce.number().int().min(1).max(90).optional(),
}).refine((value) => Boolean(value.org_id || value.project_id), {
  message: 'org_id or project_id is required',
});

export type AuthMintRequest = z.infer<typeof AuthMintRequestSchema>;

export const AuthMintResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().default('bearer'),
  expires_at: z.number(),
  user_id: z.string(),
  created: z.boolean(),
  org_id: z.string(),
  project_id: z.string().nullable(),
  role: MemberRoleSchema,
});

export type AuthMintResponse = z.infer<typeof AuthMintResponseSchema>;

// ---------------------------------------------------------------------------
// Token Exchange (Supabase → Eve RS256)
// ---------------------------------------------------------------------------

export const AuthExchangeResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().default('bearer'),
  expires_at: z.number(),
  user_id: z.string(),
  invite_redirect_to: z.string().optional(),
  invite_org_id: z.string().optional(),
  invite_app_context: z.record(z.unknown()).optional(),
});

export type AuthExchangeResponse = z.infer<typeof AuthExchangeResponseSchema>;

export const AppAuthContextRequestSchema = z.object({
  project_id: z.string().min(1),
});

export type AppAuthContextRequest = z.infer<typeof AppAuthContextRequestSchema>;

export const AppAuthContextOrgAccessSchema = z.object({
  mode: z.enum(['project_org', 'allowlist']),
  multi_org: z.boolean(),
  invite_enabled: z.boolean(),
  /**
   * True if `x-eve.auth.org_access.domain_signup.enabled` is set on the manifest.
   * The raw domain list is NEVER exposed publicly — the SSO UI can use the bool
   * to render a generic hint ("Use your work email to sign in") without leaking
   * which companies the app onboards.
   */
  domain_signup_enabled: z.boolean().default(false),
}).strict();

export const AppAuthContextAuthConfigSchema = ProjectAuthConfigSchema.innerType()
  .omit({ org_access: true, allowed_redirect_origins: true })
  .extend({
    org_access: AppAuthContextOrgAccessSchema.optional(),
    /**
     * Origins (scheme://host[:port]) the SSO broker will accept as `redirect_to`
     * targets and as CORS origins for /session and /logout. This is the union of:
     *   - explicit manifest `x-eve.auth.allowed_redirect_origins`
     *   - eligible custom domains owned by the project
     *   - eligible custom domains owned by projects in `org_access.allowed_orgs`
     */
    allowed_redirect_origins: z.array(z.string()).default([]),
  })
  .strict();

export const AppAuthContextResponseSchema = z.object({
  project_id: z.string(),
  org_id: z.string(),
  branding: ProjectBrandingSchema.nullable(),
  auth: AppAuthContextAuthConfigSchema.nullable(),
});

export type AppAuthContextResponse = z.infer<typeof AppAuthContextResponseSchema>;

/**
 * Admin reveal of the full app-context, including secret-ish fields like the
 * resolved `domain_signup` domain list and target org. Requires project admin
 * (or system admin) to call. Never surfaced via the unauthenticated endpoint.
 */
export const AppAuthContextAdminDomainSignupRuleSchema = z.object({
  domain: z.string(),
  target_org: z.string(),
  role: z.literal('member'),
}).strict();

export type AppAuthContextAdminDomainSignupRule = z.infer<typeof AppAuthContextAdminDomainSignupRuleSchema>;

export const AppAuthContextAdminDomainSignupSchema = z.object({
  enabled: z.boolean(),
  domains: z.array(AppAuthContextAdminDomainSignupRuleSchema),
}).strict();

export const AppAuthContextAdminOrgAccessSchema = AppAuthContextOrgAccessSchema.extend({
  allowed_orgs: z.array(z.string()),
  domain_signup: AppAuthContextAdminDomainSignupSchema,
}).strict();

export const AppAuthContextAdminAuthConfigSchema = AppAuthContextAuthConfigSchema
  .omit({ org_access: true })
  .extend({
    org_access: AppAuthContextAdminOrgAccessSchema.optional(),
  });

export const AppAuthContextAdminResponseSchema = z.object({
  project_id: z.string(),
  org_id: z.string(),
  branding: ProjectBrandingSchema.nullable(),
  auth: AppAuthContextAdminAuthConfigSchema.nullable(),
});

export type AppAuthContextAdminResponse = z.infer<typeof AppAuthContextAdminResponseSchema>;

export const AppAccessOrgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  role: MemberRoleSchema,
  capabilities: z.object({
    enter_app: z.boolean(),
    invite_members: z.boolean(),
  }).strict(),
}).strict();

export const AppAccessAdminOrgSchema = AppAccessOrgSchema.omit({ capabilities: true });

export const AppAccessResponseSchema = z.object({
  project_id: z.string(),
  orgs: z.array(AppAccessOrgSchema),
  admin_orgs: z.array(AppAccessAdminOrgSchema),
}).strict();

export type AppAccessResponse = z.infer<typeof AppAccessResponseSchema>;

export const AppInviteRequestSchema = z.object({
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  email: z.string().email(),
  redirect_to: z.string().optional(),
  resend: z.boolean().default(false),
}).strict();

export type AppInviteRequest = z.infer<typeof AppInviteRequestSchema>;

export const AppInviteResponseSchema = z.object({
  status: z.enum(['invited', 'pending', 'already_member']),
  org_id: z.string(),
  email: z.string().email(),
  role: z.literal('member'),
  invite_id: z.string().optional(),
});

export type AppInviteResponse = z.infer<typeof AppInviteResponseSchema>;

export const MagicLinkRequestSchema = z.object({
  email: z.string().email(),
  project_id: z.string().min(1),
  redirect_to: z.string().optional(),
});

export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

export const MagicLinkResponseSchema = z.object({
  sent: z.boolean(),
});

export type MagicLinkResponse = z.infer<typeof MagicLinkResponseSchema>;

// ---------------------------------------------------------------------------
// Org Invites
// ---------------------------------------------------------------------------

export const OrgInviteCreateRequestSchema = z.object({
  org_id: z.string(),
  role: MemberRoleSchema.default('member'),
  provider_hint: z.string().optional(),
  identity_hint: z.string().optional(),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});

export type OrgInviteCreateRequest = z.infer<typeof OrgInviteCreateRequestSchema>;

export const OrgScopedInviteRequestSchema = z.object({
  email: z.string().email(),
  role: MemberRoleSchema.default('member'),
  send_email: z.boolean().default(true),
  redirect_to: z.string().optional(),
  app_context: z.record(z.unknown()).optional(),
  project_id: z.string().min(1).optional(),
});

export type OrgScopedInviteRequest = z.infer<typeof OrgScopedInviteRequestSchema>;

export const OrgInviteResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  invite_code: z.string(),
  provider_hint: z.string().nullable(),
  identity_hint: z.string().nullable(),
  role: z.string(),
  redirect_to: z.string().nullable().optional(),
  app_context: z.record(z.unknown()).nullable().optional(),
  expires_at: z.string().nullable(),
  used_at: z.string().nullable(),
  created_at: z.string(),
});

export type OrgInviteResponse = z.infer<typeof OrgInviteResponseSchema>;

export const OrgInviteListResponseSchema = createApiListResponseSchema(OrgInviteResponseSchema);

export type OrgInviteListResponse = z.infer<typeof OrgInviteListResponseSchema>;

export const AccessRequestResponseSchema = z.object({
  id: z.string(),
  provider: z.string(),
  fingerprint: z.string(),
  email: z.string().nullable(),
  desired_org_name: z.string(),
  desired_org_slug: z.string().nullable(),
  status: z.string(),
  reviewed_at: z.string().nullable(),
  review_notes: z.string().nullable(),
  user_id: z.string().nullable(),
  org_id: z.string().nullable(),
  created_at: z.string(),
});

export type AccessRequestResponse = z.infer<typeof AccessRequestResponseSchema>;

export const AccessRequestListResponseSchema = createApiListResponseSchema(AccessRequestResponseSchema);

export type AccessRequestListResponse = z.infer<typeof AccessRequestListResponseSchema>;

// ---------------------------------------------------------------------------
// Service Principals
// ---------------------------------------------------------------------------

export const CreateServicePrincipalRequestSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/),
  description: z.string().max(500).optional(),
});

export type CreateServicePrincipalRequest = z.infer<typeof CreateServicePrincipalRequestSchema>;

export const MintServicePrincipalTokenRequestSchema = z.object({
  scopes: z.array(z.string()).min(1),
  ttl_hours: z.coerce.number().min(1).max(8760).default(1),
});

export type MintServicePrincipalTokenRequest = z.infer<typeof MintServicePrincipalTokenRequestSchema>;

export const ServicePrincipalResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ServicePrincipalResponse = z.infer<typeof ServicePrincipalResponseSchema>;

export const ServicePrincipalListResponseSchema = createApiListResponseSchema(ServicePrincipalResponseSchema);

export type ServicePrincipalListResponse = z.infer<typeof ServicePrincipalListResponseSchema>;

export const ServicePrincipalTokenResponseSchema = z.object({
  id: z.string(),
  principal_id: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.string(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
});

export type ServicePrincipalTokenResponse = z.infer<typeof ServicePrincipalTokenResponseSchema>;

export const ServicePrincipalTokenListResponseSchema = createApiListResponseSchema(ServicePrincipalTokenResponseSchema);

export type ServicePrincipalTokenListResponse = z.infer<typeof ServicePrincipalTokenListResponseSchema>;

export const MintServicePrincipalTokenResponseSchema = z.object({
  token_id: z.string(),
  access_token: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.string(),
});

export type MintServicePrincipalTokenResponse = z.infer<typeof MintServicePrincipalTokenResponseSchema>;

// ---------------------------------------------------------------------------
// Custom Access Roles & Bindings
// ---------------------------------------------------------------------------

export const CreateAccessRoleRequestSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/),
  scope: OrgProjectScopeSchema,
  permissions: z.array(z.string()).min(1),
  description: z.string().max(500).optional(),
});

export type CreateAccessRoleRequest = z.infer<typeof CreateAccessRoleRequestSchema>;

export const UpdateAccessRoleRequestSchema = z.object({
  permissions: z.array(z.string()).min(1).optional(),
  description: z.string().max(500).optional(),
});

export type UpdateAccessRoleRequest = z.infer<typeof UpdateAccessRoleRequestSchema>;

export const AccessRoleResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  name: z.string(),
  scope: OrgProjectScopeSchema,
  permissions: z.array(z.string()),
  description: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AccessRoleResponse = z.infer<typeof AccessRoleResponseSchema>;

export const AccessRoleListResponseSchema = createApiListResponseSchema(AccessRoleResponseSchema);

export type AccessRoleListResponse = z.infer<typeof AccessRoleListResponseSchema>;

export const AccessPrincipalTypeSchema = z.enum(['user', 'service_principal', 'group']);
export type AccessPrincipalType = z.infer<typeof AccessPrincipalTypeSchema>;

export const AccessGroupMemberPrincipalTypeSchema = z.enum(['user', 'service_principal']);
export type AccessGroupMemberPrincipalType = z.infer<typeof AccessGroupMemberPrincipalTypeSchema>;

export const CreateAccessBindingRequestSchema = z.object({
  role_name: z.string().min(1),
  principal_type: AccessPrincipalTypeSchema,
  principal_id: z.string().min(1),
  project_id: z.string().optional(),
  scope_json: AccessBindingScopeSchema.optional(),
});

export type CreateAccessBindingRequest = z.infer<typeof CreateAccessBindingRequestSchema>;

export const AccessBindingResponseSchema = z.object({
  id: z.string(),
  role_id: z.string(),
  role_name: z.string(),
  principal_type: AccessPrincipalTypeSchema,
  principal_id: z.string(),
  project_id: z.string().nullable(),
  scope_json: AccessBindingScopeSchema.nullable().optional(),
  created_by: z.string().nullable(),
  created_at: z.string(),
});

export type AccessBindingResponse = z.infer<typeof AccessBindingResponseSchema>;

export const AccessBindingListResponseSchema = createApiListResponseSchema(AccessBindingResponseSchema);

export type AccessBindingListResponse = z.infer<typeof AccessBindingListResponseSchema>;

export const CreateAccessGroupRequestSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-_]*$/).optional(),
  description: z.string().max(500).optional(),
});

export type CreateAccessGroupRequest = z.infer<typeof CreateAccessGroupRequestSchema>;

export const UpdateAccessGroupRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-_]*$/).optional(),
  description: z.string().max(500).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required',
});

export type UpdateAccessGroupRequest = z.infer<typeof UpdateAccessGroupRequestSchema>;

export const AccessGroupResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AccessGroupResponse = z.infer<typeof AccessGroupResponseSchema>;

export const AccessGroupListResponseSchema = createApiListResponseSchema(AccessGroupResponseSchema);
export type AccessGroupListResponse = z.infer<typeof AccessGroupListResponseSchema>;

export const CreateAccessGroupMemberRequestSchema = z.object({
  principal_type: AccessGroupMemberPrincipalTypeSchema,
  principal_id: z.string().min(1),
});

export type CreateAccessGroupMemberRequest = z.infer<typeof CreateAccessGroupMemberRequestSchema>;

export const AccessGroupMemberResponseSchema = z.object({
  group_id: z.string(),
  principal_type: AccessGroupMemberPrincipalTypeSchema,
  principal_id: z.string(),
  added_by: z.string().nullable(),
  created_at: z.string(),
});

export type AccessGroupMemberResponse = z.infer<typeof AccessGroupMemberResponseSchema>;

export const AccessGroupMemberListResponseSchema = createApiListResponseSchema(AccessGroupMemberResponseSchema);
export type AccessGroupMemberListResponse = z.infer<typeof AccessGroupMemberListResponseSchema>;

// ---------------------------------------------------------------------------
// Access Visibility (can / explain)
// ---------------------------------------------------------------------------

export const AccessCanResponseSchema = z.object({
  allowed: z.boolean(),
  source: z.string(),
  resource: z.object({
    type: z.enum(['orgfs', 'orgdocs', 'envdb', 'cloud_fs']),
    id: z.string(),
    action: z.enum(['read', 'write', 'admin']),
    scope_required: z.boolean(),
    scope_matched: z.boolean(),
  }).optional(),
});

export type AccessCanResponse = z.infer<typeof AccessCanResponseSchema>;

export const AccessExplainGrantSchema = z.object({
  source: z.string(),
  role: z.string().optional(),
  permissions: z.array(z.string()),
  has_permission: z.boolean(),
  scope_json: AccessBindingScopeSchema.nullable().optional(),
  scope_match: z.boolean().optional(),
  scope_reason: z.string().optional(),
});

export type AccessExplainGrant = z.infer<typeof AccessExplainGrantSchema>;

export const AccessExplainResponseSchema = z.object({
  permission: z.string(),
  result: z.enum(['ALLOWED', 'DENIED']),
  grants: z.array(AccessExplainGrantSchema),
  missing_reason: z.string().optional(),
  resource: z.object({
    type: z.enum(['orgfs', 'orgdocs', 'envdb', 'cloud_fs']),
    id: z.string(),
    action: z.enum(['read', 'write', 'admin']),
    scope_required: z.boolean(),
    scope_matched: z.boolean(),
  }).optional(),
});

export type AccessExplainResponse = z.infer<typeof AccessExplainResponseSchema>;

export const AccessMembershipBaseSchema = z.object({
  org_role: MemberRoleSchema.nullable(),
  project_roles: z.array(z.object({
    project_id: z.string(),
    role: MemberRoleSchema,
  })),
  token_scopes: z.array(z.string()),
});

export type AccessMembershipBase = z.infer<typeof AccessMembershipBaseSchema>;

export const AccessGroupSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export type AccessGroupSummary = z.infer<typeof AccessGroupSummarySchema>;

export const AccessResolvedBindingSchema = AccessBindingResponseSchema.extend({
  role_permissions: z.array(z.string()),
  matched_via: z.enum(['direct', 'group']).optional(),
  matched_group_id: z.string().nullable().optional(),
  matched_group_slug: z.string().nullable().optional(),
});

export type AccessResolvedBinding = z.infer<typeof AccessResolvedBindingSchema>;

export const AccessEffectiveScopeSummarySchema = z.object({
  orgfs: z.object({
    allow_prefixes: z.array(z.string()),
    read_only_prefixes: z.array(z.string()),
  }),
  orgdocs: z.object({
    allow_prefixes: z.array(z.string()),
    read_only_prefixes: z.array(z.string()),
  }),
  envdb: z.object({
    schemas: z.array(z.string()),
    tables: z.array(z.string()),
  }),
});

export type AccessEffectiveScopeSummary = z.infer<typeof AccessEffectiveScopeSummarySchema>;

export const AccessPrincipalMembershipsResponseSchema = z.object({
  org_id: z.string(),
  principal_type: AccessPrincipalTypeSchema,
  principal_id: z.string(),
  base: AccessMembershipBaseSchema,
  groups: z.array(AccessGroupSummarySchema),
  direct_bindings: z.array(AccessBindingResponseSchema),
  effective_bindings: z.array(AccessResolvedBindingSchema),
  effective_permissions: z.array(z.string()),
  effective_scopes: AccessEffectiveScopeSummarySchema,
});

export type AccessPrincipalMembershipsResponse = z.infer<typeof AccessPrincipalMembershipsResponseSchema>;

// ---------------------------------------------------------------------------
// Policy-as-Code: .eve/access.yaml schema
// ---------------------------------------------------------------------------

export const AccessYamlRoleSchema = z.object({
  scope: OrgProjectScopeSchema,
  description: z.string().optional(),
  permissions: z.array(z.string()).min(1),
});

export type AccessYamlRole = z.infer<typeof AccessYamlRoleSchema>;

export const AccessYamlGroupMemberSchema = z.object({
  type: AccessGroupMemberPrincipalTypeSchema,
  id: z.string().min(1),
});

export type AccessYamlGroupMember = z.infer<typeof AccessYamlGroupMemberSchema>;

export const AccessYamlGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  members: z.array(AccessYamlGroupMemberSchema).optional(),
});

export type AccessYamlGroup = z.infer<typeof AccessYamlGroupSchema>;

export const AccessYamlBindingSchema = z.object({
  project_id: z.string().optional(),
  subject: z.object({
    type: AccessPrincipalTypeSchema,
    id: z.string(),
  }),
  roles: z.array(z.string()).min(1),
  scope: AccessBindingScopeSchema.optional(),
});

export type AccessYamlBinding = z.infer<typeof AccessYamlBindingSchema>;

export const AccessYamlSchema = z.object({
  version: z.literal(2),
  access: z.object({
    groups: z.record(
      z.string().regex(/^[a-z0-9][a-z0-9-_]*$/),
      AccessYamlGroupSchema,
    ).optional(),
    roles: z.record(z.string(), AccessYamlRoleSchema).optional(),
    bindings: z.array(AccessYamlBindingSchema).optional(),
  }),
});

export type AccessYaml = z.infer<typeof AccessYamlSchema>;

// ---------------------------------------------------------------------------
// Token Verification (for external apps)
// ---------------------------------------------------------------------------

export const AuthTokenVerifyResponseSchema = z.object({
  valid: z.literal(true),
  type: z.enum(['user', 'job', 'service', 'service_principal', 'app_link']),
  user_id: z.string(),
  email: z.string().optional(),
  org_id: z.string().nullable().optional(),
  project_id: z.string().optional(),
  job_id: z.string().optional(),
  agent_slug: z.string().optional(),
  service_name: z.string().optional(),
  env_name: z.string().optional(),
  subscription_id: z.string().optional(),
  consumer_project_id: z.string().optional(),
  producer_project_id: z.string().optional(),
  consumer_principal: z.string().optional(),
  consumer_env: z.string().nullable().optional(),
  producer_env: z.string().optional(),
  api_name: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  is_admin: z.boolean().optional(),
  role: z.string().optional(),
});

export type AuthTokenVerifyResponse = z.infer<typeof AuthTokenVerifyResponseSchema>;
