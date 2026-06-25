import { z } from 'zod';
import { EnvOverridesSchema } from './job.js';
import { AccessBindingScopeSchema } from './access-scope.js';
import { JobGitSchema } from './git-controls.js';
import { ToolchainsSchema } from './agent-config.js';
import {
  PipelineStepRequiresSchema,
  StepHarnessProfileOverrideSchema,
  WorkflowInputsSchema,
  WorkflowResourceRefsPolicySchema,
  type WorkflowInputDeclaration,
} from './pipeline.js';

export const DbAccessSchema = z.enum(['read_only', 'read_write']).default('read_only');

const WorkflowWithApisSchema = z.array(z.union([z.string().min(1), z.record(z.unknown())]));

export const WorkflowStepSchema = z.object({
  name: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  condition: z.string().optional(),
  action: z.record(z.unknown()).optional(),
  script: z.record(z.unknown()).optional(),
  agent: z.record(z.unknown()).optional(),
  run: z.string().min(1).optional(),
  requires: PipelineStepRequiresSchema.optional(),
  harness_profile: z.string().optional(),
  harness_profile_override: StepHarnessProfileOverrideSchema.optional(),
  harness: z.string().optional(),
  harness_options: z.object({
    model: z.string().optional(),
    reasoning_effort: z.string().optional(),
    temperature: z.number().optional(),
  }).passthrough().optional(),
  git: JobGitSchema.partial().optional(),
  resource_refs: WorkflowResourceRefsPolicySchema.optional(),
  env_overrides: EnvOverridesSchema.optional(),
  scope: AccessBindingScopeSchema.optional(),
  permissions: z.array(z.string().min(1)).optional(),
  with_apis: WorkflowWithApisSchema.optional(),
  'with-apis': WorkflowWithApisSchema.optional(),
  toolchains: ToolchainsSchema.optional(),
}).superRefine((value, ctx) => {
  const keys = ['action', 'script', 'agent', 'run'] as const;
  if (keys.filter((key) => value[key] !== undefined).length !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Workflow step must define exactly one of action, script, agent, or run',
    });
  }

  const action = value.action && typeof value.action === 'object' && !Array.isArray(value.action)
    ? value.action
    : null;
  if (action && Object.prototype.hasOwnProperty.call(action, 'toolchains')) {
    ctx.addIssue({
      code: 'custom',
      path: ['action', 'toolchains'],
      message: 'Use top-level step toolchains instead of action.toolchains',
    });
  }
  if (value.action !== undefined && value.toolchains !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['toolchains'],
      message: 'Workflow action steps do not support toolchains because workflow actions are not implemented',
    });
  }
});

export const WorkflowDefinitionSchema = z.object({
  steps: z.array(WorkflowStepSchema).optional(),
  inputs: WorkflowInputsSchema.optional(),
  env: z.string().min(1).optional(),
  db_access: DbAccessSchema.optional(),
  env_overrides: EnvOverridesSchema.optional(),
  scope: AccessBindingScopeSchema.optional(),
  permissions: z.array(z.string().min(1)).optional(),
  resource_refs: WorkflowResourceRefsPolicySchema.optional(),
  git: JobGitSchema.partial().optional(),
  hints: z.record(z.unknown()).optional(),
  trigger: z.record(z.unknown()).optional(),
  with_apis: WorkflowWithApisSchema.optional(),
  'with-apis': WorkflowWithApisSchema.optional(),
  toolchains: ToolchainsSchema.optional(),
}).passthrough();

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type { WorkflowInputDeclaration };

export const WorkflowResponseSchema = z.object({
  project_id: z.string(),
  name: z.string(),
  definition: WorkflowDefinitionSchema,
  db_access: DbAccessSchema.optional(),
});

export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;

export const WorkflowListResponseSchema = z.object({
  data: z.array(WorkflowResponseSchema),
});

export type WorkflowListResponse = z.infer<typeof WorkflowListResponseSchema>;

// Workflow invoke request (body)
export const WorkflowInvokeRequestSchema = z.object({
  input: z.record(z.unknown()).optional(),  // User's workflow input payload
  env_overrides: EnvOverridesSchema.optional(),
  scope: AccessBindingScopeSchema.optional(),
  permissions: z.array(z.string().min(1)).optional(),
}).optional();

export type WorkflowInvokeRequest = z.infer<typeof WorkflowInvokeRequestSchema>;

// Summary of a single step job within a workflow invocation
export const WorkflowStepJobSchema = z.object({
  job_id: z.string(),
  step_name: z.string(),
  depends_on: z.array(z.string()).optional(),
  resource_refs: z.object({
    mode: z.enum(['inherit', 'none', 'selected']),
    source: z.enum(['default', 'workflow', 'step']),
    count: z.number().int().nonnegative(),
    inherited_count: z.number().int().nonnegative(),
    selectors: z.array(z.string()).optional(),
    missing_selectors: z.array(z.string()).optional(),
  }).optional(),
});

export type WorkflowStepJob = z.infer<typeof WorkflowStepJobSchema>;

// Workflow invoke response (immediate return when wait=false)
export const WorkflowInvokeResponseSchema = z.object({
  job_id: z.string(),
  status: z.string(),  // Job phase (root job)
  step_jobs: z.array(WorkflowStepJobSchema).optional(),  // Child step jobs in the DAG
});

export type WorkflowInvokeResponse = z.infer<typeof WorkflowInvokeResponseSchema>;

// Workflow invoke response with result (when wait=true and job completes)
export const WorkflowInvokeResultSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  result: z.record(z.unknown()).optional().nullable(),  // The result_json from attempt
  error: z.string().optional().nullable(),
});

export type WorkflowInvokeResult = z.infer<typeof WorkflowInvokeResultSchema>;

// Workflow retry request. Exactly one selector must be provided:
// - failed: retry the failed/upstream-failed current tail
// - from_step: retry the named current step and its downstream dependents
export const WorkflowRetryRequestSchema = z.object({
  root_job_id: z.string().min(1),
  failed: z.boolean().optional(),
  from_step: z.string().min(1).optional(),
}).refine(
  (value) => Boolean(value.failed) !== Boolean(value.from_step),
  { message: 'Provide exactly one retry selector: failed=true or from_step' },
);

export type WorkflowRetryRequest = z.infer<typeof WorkflowRetryRequestSchema>;

export const WorkflowRetriedStepSchema = z.object({
  step_name: z.string(),
  previous_job_id: z.string(),
  retry_job_id: z.string(),
  depends_on: z.array(z.string()).optional(),
});

export type WorkflowRetriedStep = z.infer<typeof WorkflowRetriedStepSchema>;

export const WorkflowRetryResponseSchema = z.object({
  root_job_id: z.string(),
  status: z.string(),
  mode: z.enum(['failed', 'from']),
  from_step: z.string().optional(),
  generation: z.number().int(),
  retried_steps: z.array(WorkflowRetriedStepSchema),
  superseded_job_ids: z.array(z.string()),
});

export type WorkflowRetryResponse = z.infer<typeof WorkflowRetryResponseSchema>;
