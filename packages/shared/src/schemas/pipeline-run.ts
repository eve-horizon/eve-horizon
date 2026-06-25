import { z } from 'zod';
import { PaginationSchema, GitShaSchema } from './common.js';

export const PipelineRunStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'awaiting_approval',
]);

export const PipelineStepStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
]);

export const PipelineStepTypeSchema = z.enum(['build', 'release', 'deploy', 'run', 'create-pr']);

export const PipelineRunRequestSchema = z.object({
  ref: GitShaSchema,
  env: z.string().min(1).optional(),
  inputs: z.record(z.unknown()).optional(),
});

export type PipelineRunRequest = z.infer<typeof PipelineRunRequestSchema>;

export const PipelineRunResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  pipeline_name: z.string(),
  env_name: z.string().nullable(),
  git_sha: z.string().nullable(),
  manifest_hash: z.string().nullable(),
  inputs: z.record(z.unknown()).nullable(),
  step_outputs: z.record(z.unknown()).nullable(),
  status: PipelineRunStatusSchema,
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
  requested_by: z.string().nullable(),
  run_mode: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type PipelineRunResponse = z.infer<typeof PipelineRunResponseSchema>;

export const PipelineStepRunResponseSchema = z.object({
  id: z.string(),
  pipeline_run_id: z.string(),
  step_index: z.number().int(),
  step_name: z.string(),
  step_type: PipelineStepTypeSchema,
  status: PipelineStepStatusSchema,
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
  logs_ref: z.string().nullable(),
  input_json: z.record(z.unknown()).nullable(),
  output_json: z.record(z.unknown()).nullable(),
  result_text: z.string().nullable(),
  result_json: z.record(z.unknown()).nullable(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type PipelineStepRunResponse = z.infer<typeof PipelineStepRunResponseSchema>;

export const PipelineRunDetailResponseSchema = z.object({
  run: PipelineRunResponseSchema,
  steps: z.array(PipelineStepRunResponseSchema),
});

export type PipelineRunDetailResponse = z.infer<typeof PipelineRunDetailResponseSchema>;

export const PipelineRunListResponseSchema = z.object({
  data: z.array(PipelineRunResponseSchema),
  pagination: PaginationSchema,
});

export type PipelineRunListResponse = z.infer<typeof PipelineRunListResponseSchema>;
