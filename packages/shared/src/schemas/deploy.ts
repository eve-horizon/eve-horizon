import { z } from 'zod';
import { ReleaseResponseSchema } from './release.js';
import {
  EnvironmentResponseSchema,
  EnvDeploymentConditionSchema,
} from './environment.js';
import { PipelineRunDetailResponseSchema } from './pipeline-run.js';

export const DeploymentStatusSchema = z.object({
  env_id: z.string(),
  current_release_id: z.string().nullable().optional(),
  state: z.enum(['pending', 'deploying', 'ready', 'failed', 'unknown']),
  message: z.string().nullable().optional(),
  namespace: z.string().nullable().optional(),
  k8s_status: z.object({
    ready: z.boolean(),
    available_replicas: z.number(),
    desired_replicas: z.number(),
    conditions: z.array(EnvDeploymentConditionSchema),
  }).nullable().optional(),
});

export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

// Direct deploy response
export const DirectDeployResponseSchema = z.object({
  release: ReleaseResponseSchema,
  environment: EnvironmentResponseSchema,
  deployment_status: DeploymentStatusSchema.optional(),
  warnings: z.array(z.string()).optional(),
});

// Pipeline deploy response
export const PipelineDeployResponseSchema = z.object({
  pipeline_run: PipelineRunDetailResponseSchema,
  environment: EnvironmentResponseSchema,
  warnings: z.array(z.string()).optional(),
  poll_url: z.string().optional(),
});

// Union type for deploy response
export const DeployResponseSchema = z.union([
  DirectDeployResponseSchema,
  PipelineDeployResponseSchema,
]);

export type DeployResponse = z.infer<typeof DeployResponseSchema>;
