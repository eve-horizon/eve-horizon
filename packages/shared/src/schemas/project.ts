import { z } from 'zod';
import { PaginationSchema, MemberRoleSchema } from './common.js';
import { EnvironmentResponseSchema } from './environment.js';

const SSH_GIT_URL_RE = /^[\w.-]+@[\w.-]+:[\w./-]+$/;

const RepoUrlSchema = z.string().refine((value) => {
  // Accept SSH git URLs (e.g. git@github.com:org/repo.git)
  if (SSH_GIT_URL_RE.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'file:';
  } catch {
    return false;
  }
}, 'repo_url must be an http(s), file://, or SSH git URL');
const RepoUrlOrUnsetSchema = z.union([RepoUrlSchema, z.literal('')]);

// Slug: 4-8 chars, starts with letter, alphanumeric only
const SlugSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9]{3,7}$/,
  'slug must be 4-8 alphanumeric characters starting with a letter'
);

export const CreateProjectRequestSchema = z.object({
  org_id: z.string().regex(/^org_[a-zA-Z0-9]+$/, 'Invalid org_id format'),
  name: z.string().min(1),
  slug: SlugSchema.optional(),  // Auto-generated from name if not provided
  repo_url: RepoUrlSchema,
  branch: z.string().min(1).default('main'),
});

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

// Ensure schema - same as create but with ensure semantics (find-or-create)
// Optional force flag allows updating repo_url/branch if they differ
export const EnsureProjectRequestSchema = CreateProjectRequestSchema.extend({
  repo_url: RepoUrlSchema.optional(),
  force: z.boolean().optional(),
});
export type EnsureProjectRequest = z.infer<typeof EnsureProjectRequestSchema>;

export const UpdateProjectRequestSchema = z.object({
  name: z.string().min(1).optional(),
  repo_url: RepoUrlSchema.optional(),
  branch: z.string().min(1).optional(),
  deleted: z.boolean().optional(),
});

export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ProjectResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  name: z.string(),
  slug: z.string(),
  repo_url: RepoUrlOrUnsetSchema,
  branch: z.string(),
  deleted: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const ProjectListResponseSchema = z.object({
  data: z.array(ProjectResponseSchema),
  pagination: PaginationSchema,
});

export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

// ── Project member schemas ─────────────────────────────────────────

export const ProjectMemberRoleSchema = MemberRoleSchema;

export const ProjectMemberRequestSchema = z.object({
  user_id: z.string().optional(),
  email: z.string().email().optional(),
  role: ProjectMemberRoleSchema,
}).refine((value) => Boolean(value.user_id || value.email), {
  message: 'user_id or email is required',
});

export type ProjectMemberRequest = z.infer<typeof ProjectMemberRequestSchema>;

export const ProjectMemberResponseSchema = z.object({
  project_id: z.string(),
  user_id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  role: ProjectMemberRoleSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export type ProjectMemberResponse = z.infer<typeof ProjectMemberResponseSchema>;

export const ProjectMemberListResponseSchema = z.object({
  data: z.array(ProjectMemberResponseSchema),
});

export type ProjectMemberListResponse = z.infer<typeof ProjectMemberListResponseSchema>;

// ── Project bootstrap schemas ─────────────────────────────────────

export const BootstrapProjectRequestSchema = z.object({
  org_id: z.string().regex(/^org_[a-zA-Z0-9]+$/, 'Invalid org_id format'),
  name: z.string().min(1),
  slug: SlugSchema.optional(),
  repo_url: RepoUrlSchema,
  branch: z.string().min(1).default('main'),
  description: z.string().optional(),
  template: z.string().optional(),
  packs: z.array(z.string()).optional(),
  environments: z.array(z.string()).optional().default(['staging']),
  created_by: z.string().optional(),
});

export type BootstrapProjectRequest = z.infer<typeof BootstrapProjectRequestSchema>;

export const BootstrapProjectResponseSchema = z.object({
  project: ProjectResponseSchema,
  environments: z.array(EnvironmentResponseSchema),
  status: z.enum(['created', 'existing']),
  next_steps: z.array(z.string()),
});

export type BootstrapProjectResponse = z.infer<typeof BootstrapProjectResponseSchema>;
