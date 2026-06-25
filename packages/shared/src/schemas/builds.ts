import { z } from 'zod';
import { PaginationSchema, GitShaSchema } from './common.js';
import { LogEntrySchema } from './attempt.js';

export const CreateBuildSpecRequestSchema = z.object({
  git_sha: GitShaSchema,
  manifest_hash: z.string().min(1),
  services: z.array(z.string()).optional(),
  inputs: z.record(z.unknown()).optional(),
  registry: z.record(z.unknown()).optional(),
  cache: z.record(z.unknown()).optional(),
});

export type CreateBuildSpecRequest = z.infer<typeof CreateBuildSpecRequestSchema>;

export const BuildSpecResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  git_sha: z.string(),
  manifest_hash: z.string(),
  services: z.array(z.string()).nullable(),
  inputs: z.record(z.unknown()).nullable(),
  registry: z.record(z.unknown()).nullable(),
  cache: z.record(z.unknown()).nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
});

export type BuildSpecResponse = z.infer<typeof BuildSpecResponseSchema>;

export const BuildSpecListResponseSchema = z.object({
  data: z.array(BuildSpecResponseSchema),
  pagination: PaginationSchema,
});

export type BuildSpecListResponse = z.infer<typeof BuildSpecListResponseSchema>;

export const CreateBuildRunRequestSchema = z.object({
  backend: z.string().min(1).optional(),
  runner_ref: z.string().optional(),
});

export type CreateBuildRunRequest = z.infer<typeof CreateBuildRunRequestSchema>;

export const CancelBuildRunRequestSchema = z.object({
  run_id: z.string().optional(),
  reason: z.string().optional(),
});

export type CancelBuildRunRequest = z.infer<typeof CancelBuildRunRequestSchema>;

export const BuildRunResponseSchema = z.object({
  id: z.string(),
  build_id: z.string(),
  status: z.string(),
  backend: z.string(),
  runner_ref: z.string().nullable(),
  logs_ref: z.string().nullable(),
  error_message: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type BuildRunResponse = z.infer<typeof BuildRunResponseSchema>;

export const BuildRunListResponseSchema = z.object({
  data: z.array(BuildRunResponseSchema),
  pagination: PaginationSchema,
});

export type BuildRunListResponse = z.infer<typeof BuildRunListResponseSchema>;

export const BuildArtifactResponseSchema = z.object({
  id: z.string(),
  build_id: z.string(),
  service_name: z.string(),
  image_ref: z.string(),
  digest: z.string(),
  platforms: z.array(z.string()).nullable(),
  size_bytes: z.number().int().nullable(),
  sbom_ref: z.string().nullable(),
  provenance_ref: z.string().nullable(),
  created_at: z.string(),
});

export type BuildArtifactResponse = z.infer<typeof BuildArtifactResponseSchema>;

export const BuildArtifactListResponseSchema = z.object({
  data: z.array(BuildArtifactResponseSchema),
  pagination: PaginationSchema,
});

export type BuildArtifactListResponse = z.infer<typeof BuildArtifactListResponseSchema>;

export const BuildLogsResponseSchema = z.object({
  logs: z.array(LogEntrySchema),
});

export type BuildLogsResponse = z.infer<typeof BuildLogsResponseSchema>;
