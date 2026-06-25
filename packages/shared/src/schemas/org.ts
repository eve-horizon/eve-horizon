import { z } from 'zod';
import { PaginationSchema } from './common.js';

export const OrgIdSchema = z.string().regex(/^org_[a-zA-Z0-9]+$/, 'Invalid org_id format');

export const OrgSlugSchema = z.string().regex(
  /^[a-z][a-z0-9]{1,11}$/,
  'Slug must be 2-12 lowercase alphanumeric characters starting with a letter',
);

export const CreateOrgRequestSchema = z.object({
  id: OrgIdSchema.optional(),
  name: z.string().min(1),
  slug: OrgSlugSchema.optional(),  // Auto-generated from name if not provided
  owner_user_id: z.string().optional(),
});

export type CreateOrgRequest = z.infer<typeof CreateOrgRequestSchema>;

export const UpdateOrgRequestSchema = z.object({
  name: z.string().min(1).optional(),
  deleted: z.boolean().optional(),
  default_agent_slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).nullable().optional(),
  // Billing + budgets (Phase 1/7/8). Stored as JSONB on orgs.billing_config.
  billing_config: z.record(z.unknown()).nullable().optional(),
});

export type UpdateOrgRequest = z.infer<typeof UpdateOrgRequestSchema>;

export const OrgResponseSchema = z.object({
  id: OrgIdSchema,
  name: z.string(),
  slug: z.string(),
  default_agent_slug: z.string().nullable().optional(),
  billing_config: z.record(z.unknown()).nullable().optional(),
  deleted: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type OrgResponse = z.infer<typeof OrgResponseSchema>;

export const OrgListResponseSchema = z.object({
  data: z.array(OrgResponseSchema),
  pagination: PaginationSchema,
});

export type OrgListResponse = z.infer<typeof OrgListResponseSchema>;

export const OrgMemberRoleSchema = z.enum(['owner', 'admin', 'member']);

export const OrgMemberRequestSchema = z.object({
  user_id: z.string().optional(),
  email: z.string().email().optional(),
  role: OrgMemberRoleSchema,
}).refine((value) => Boolean(value.user_id || value.email), {
  message: 'user_id or email is required',
});

export type OrgMemberRequest = z.infer<typeof OrgMemberRequestSchema>;

export const OrgMemberResponseSchema = z.object({
  org_id: OrgIdSchema,
  user_id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  role: OrgMemberRoleSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export type OrgMemberResponse = z.infer<typeof OrgMemberResponseSchema>;

export const OrgMemberListResponseSchema = z.object({
  data: z.array(OrgMemberResponseSchema),
});

export type OrgMemberListResponse = z.infer<typeof OrgMemberListResponseSchema>;
