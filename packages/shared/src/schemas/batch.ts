import { z } from 'zod';

// ============================================================================
// Batch Job Graph Schemas
//
// Enables atomic creation of an entire job tree (epic + children + dependencies)
// in a single API call.
// ============================================================================

export const BatchNodeSchema = z.object({
  key: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  type: z.enum(['epic', 'task']).optional(),
  parent: z.string().optional(),
  target: z.object({
    agent_slug: z.string().optional(),
    team: z.string().optional(),
  }).optional(),
  resource_refs: z.array(z.object({
    uri: z.string(),
    label: z.string().optional(),
    required: z.boolean().optional().default(true),
    mount_path: z.string().optional(),
  })).optional(),
  git: z.object({
    branch: z.string().optional(),
    commit: z.string().optional(),
    push: z.string().optional(),
  }).optional(),
  hints: z.record(z.unknown()).optional(),
});

export const BatchDependencySchema = z.object({
  job: z.string(),
  depends_on: z.array(z.string()),
});

export const CreateBatchRequestSchema = z.object({
  idempotency_key: z.string().optional(),
  nodes: z.array(BatchNodeSchema).min(1).max(50),
  dependencies: z.array(BatchDependencySchema).optional().default([]),
});

export const BatchJobResultSchema = z.object({
  job_id: z.string(),
  phase: z.string(),
  blocked_by: z.array(z.string()).optional(),
});

export const CreateBatchResponseSchema = z.object({
  batch_id: z.string(),
  idempotency_key: z.string().nullable(),
  jobs: z.record(BatchJobResultSchema),
});

export const BatchValidationErrorSchema = z.object({
  code: z.string(),
  node_key: z.string().optional(),
  field: z.string().optional(),
  message: z.string(),
  hint: z.string().optional(),
});

export const BatchValidateResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(BatchValidationErrorSchema),
});

// Type exports
export type BatchNode = z.infer<typeof BatchNodeSchema>;
export type BatchDependency = z.infer<typeof BatchDependencySchema>;
export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;
export type BatchJobResult = z.infer<typeof BatchJobResultSchema>;
export type CreateBatchResponse = z.infer<typeof CreateBatchResponseSchema>;
export type BatchValidationError = z.infer<typeof BatchValidationErrorSchema>;
export type BatchValidateResponse = z.infer<typeof BatchValidateResponseSchema>;
