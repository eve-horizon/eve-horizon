import { z } from 'zod';
import { JobGitSchema } from './git-controls.js';
import { EnvOverridesSchema } from './job.js';
import { AccessBindingScopeSchema } from './access-scope.js';
import { ToolchainsSchema } from './agent-config.js';

export const PipelineStepRequiresSchema = z.object({
  secrets: z.array(z.string()).optional(),
}).passthrough();

export type WorkflowResourceRefsPolicy =
  | 'inherit'
  | 'all'
  | 'none'
  | string[]
  | {
      mode?: 'inherit' | 'all' | 'none' | 'selected';
      include?: string[];
      [key: string]: unknown;
    };

export const WorkflowResourceRefsPolicySchema: z.ZodType<WorkflowResourceRefsPolicy> = z.union([
  z.enum(['inherit', 'all', 'none']),
  z.array(z.string().min(1)),
  z.object({
    mode: z.enum(['inherit', 'all', 'none', 'selected']).optional(),
    include: z.array(z.string().min(1)).optional(),
  }).passthrough(),
]);

/**
 * Step-level harness_profile_override for workflows.
 *
 * Fields are typed as strings (not enums) because Phase 4 allows per-field
 * `${inputs.<key>}` template expressions. The expression engine validates
 * template structure at manifest-sync time; the runtime resolver re-validates
 * resolved values against stricter job-DTO schemas before dispatch.
 */
export const StepHarnessProfileOverrideSchema = z.object({
  harness: z.string().min(1),
  model: z.string().optional(),
  reasoning_effort: z.string().optional(),
  variant: z.string().optional(),
  temperature: z.union([z.number(), z.string()]).optional(),
}).strict();

export const PipelineStepSchema = z.object({
  name: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  action: z.record(z.unknown()).optional(),
  script: z.record(z.unknown()).optional(),
  agent: z.record(z.unknown()).optional(),
  run: z.string().min(1).optional(),
  requires: PipelineStepRequiresSchema.optional(),
  // Step-level harness overrides (take precedence over agent-resolved values).
  // `harness_profile` is a string name that may carry a template, e.g. `${inputs.model}`.
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
  toolchains: ToolchainsSchema.optional(),
}).superRefine((value, ctx) => {
  const keys = ['action', 'script', 'agent', 'run'] as const;
  if (!keys.some((key) => value[key] !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Pipeline step must define action, script, agent, or run',
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
  if (value.toolchains !== undefined && action && action.type !== 'run') {
    ctx.addIssue({
      code: 'custom',
      path: ['toolchains'],
      message: 'Pipeline action steps support toolchains only for action.type=run',
    });
  }
});

/**
 * Workflow-level input declaration. Phase 4 lets workflows bind named inputs
 * either to explicit caller-supplied values (the existing `WorkflowInvokeRequest.input`
 * body) or to a path into the triggering event's payload.
 *
 *   workflows:
 *     classify:
 *       inputs:
 *         model:
 *           from: event.payload.meta.brand
 *           default: claude
 *       steps: [ ... ]
 */
export const WorkflowInputDeclarationSchema = z.object({
  from: z.string().optional(),
  default: z.unknown().optional(),
}).passthrough();

export const WorkflowInputsSchema = z.record(WorkflowInputDeclarationSchema);

export type StepHarnessProfileOverride = z.infer<typeof StepHarnessProfileOverrideSchema>;
export type WorkflowInputDeclaration = z.infer<typeof WorkflowInputDeclarationSchema>;

export const PipelineDefinitionSchema = z.object({
  steps: z.array(PipelineStepSchema).optional(),
  resource_refs: WorkflowResourceRefsPolicySchema.optional(),
  env_overrides: EnvOverridesSchema.optional(),
  scope: AccessBindingScopeSchema.optional(),
  permissions: z.array(z.string().min(1)).optional(),
  toolchains: ToolchainsSchema.optional(),
}).passthrough();

export const PipelineResponseSchema = z.object({
  project_id: z.string(),
  name: z.string(),
  definition: PipelineDefinitionSchema,
});

export type PipelineResponse = z.infer<typeof PipelineResponseSchema>;

export const PipelineListResponseSchema = z.object({
  data: z.array(PipelineResponseSchema),
});

export type PipelineListResponse = z.infer<typeof PipelineListResponseSchema>;
