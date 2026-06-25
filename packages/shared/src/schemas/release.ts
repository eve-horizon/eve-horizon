import { z } from 'zod';
import { PaginationSchema, GitShaSchema } from './common.js';

export const DeployRequestSchema = z.object({
  git_sha: GitShaSchema.optional(),
  manifest_hash: z.string().min(1).optional(),
  release_tag: z.string().min(1).optional(),
  image_digests: z.record(z.string()).optional(),
  image_tag: z.string().optional(), // e.g., "local" for local dev, "sha-abc123" for CI
  skip_preflight: z.boolean().optional(),
  direct: z.boolean().optional(), // bypass pipeline and do direct deploy
  inputs: z.record(z.unknown()).optional(), // additional inputs to pass to pipeline
}).refine((value) => {
  if (value.release_tag) return true;
  return Boolean(value.git_sha && value.manifest_hash);
}, { message: 'Deploy request requires release_tag or both git_sha and manifest_hash' });

export type DeployRequest = z.infer<typeof DeployRequestSchema>;

export const ReleaseResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  git_sha: z.string(),
  manifest_hash: z.string(),
  image_digests: z.record(z.string()).nullable(),
  build_id: z.string().nullable(),
  version: z.string().nullable(),
  tag: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
});

export type ReleaseResponse = z.infer<typeof ReleaseResponseSchema>;

export const ReleaseListResponseSchema = z.object({
  data: z.array(ReleaseResponseSchema),
  pagination: PaginationSchema,
});

export type ReleaseListResponse = z.infer<typeof ReleaseListResponseSchema>;
